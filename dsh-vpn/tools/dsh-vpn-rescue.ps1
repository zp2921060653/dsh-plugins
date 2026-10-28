# dsh-vpn 救援脚本（用户手动运行，不需要 DSH 在线）
# 用途：如果 dsh-vpn 接管进程代理后 DSH 会话异常（例如 API 不通、无响应），先运行本脚本再重启 DeepSeek Harness。
# 本脚本只做三件事：写 disable.flag（让插件下次启动强制 disabled）、停掉插件自己启动的 mihomo、打印当前状态。
# 它不会改系统代理、不会动注册表、不会杀不是插件的进程。
param(
  [string]$DshHome = $(if ($env:DSH_HOME) { $env:DSH_HOME } else { 'D:\DSH-Home' })
)
$ErrorActionPreference = 'Continue'

Write-Host "== dsh-vpn rescue =="
Write-Host "DSH home: $DshHome"

# 1) 在插件可能使用的所有 profile vpn 目录写 disable.flag
#    （插件的 dataDir 默认是 <DSH_PROFILE_DIR>/vpn；宿主进程里该变量可能缺失，
#     此时会落在 <DSH_HOME>/profiles/<profile>/vpn 或 profiles/default/vpn，所以全部覆盖）
$flags = @()
$profilesRoot = Join-Path $DshHome 'profiles'
if (Test-Path $profilesRoot) {
  Get-ChildItem $profilesRoot -Directory -ErrorAction SilentlyContinue | ForEach-Object {
    $dir = Join-Path $_.FullName 'vpn'
    if (Test-Path $dir) {
      $flag = Join-Path $dir 'disable.flag'
      Set-Content -Path $flag -Value ("disabled at " + (Get-Date).ToString('o')) -Encoding UTF8 -ErrorAction SilentlyContinue
      if (Test-Path $flag) { $flags += $flag }
    }
  }
}
if ($flags.Count -eq 0) {
  # 插件还没创建过 dataDir：至少写 desktop/default 两个候选
  foreach ($name in @('desktop', 'default')) {
    $dir = Join-Path $profilesRoot (Join-Path $name 'vpn')
    New-Item -ItemType Directory -Force -Path $dir -ErrorAction SilentlyContinue | Out-Null
    $flag = Join-Path $dir 'disable.flag'
    Set-Content -Path $flag -Value ("disabled at " + (Get-Date).ToString('o')) -Encoding UTF8 -ErrorAction SilentlyContinue
    if (Test-Path $flag) { $flags += $flag }
  }
}
Write-Host "[1/3] 已写入 disable.flag:"
$flags | ForEach-Object { Write-Host "      $_" }
Write-Host "      （插件下次 apply 时会强制保持 disabled；要重新启用请删除这些文件）"

# 2) 停掉插件自己启动的 mihomo（只认插件 bin 路径下的可执行文件，绝不动用户的 Clash/mihomo）
$pluginMihomo = Get-Process -ErrorAction SilentlyContinue | Where-Object {
  $_.ProcessName -match '(?i)mihomo' -and $_.Path -and ($_.Path -like '*dsh-vpn*bin*')
}
if ($pluginMihomo) {
  foreach ($p in $pluginMihomo) {
    try { Stop-Process -Id $p.Id -Force -ErrorAction Stop; Write-Host "[2/3] 已停止插件 mihomo pid=$($p.Id)" }
    catch { Write-Host "[2/3] 停止失败 pid=$($p.Id): $($_.Exception.Message)" }
  }
} else {
  Write-Host "[2/3] 未发现插件自己启动的 mihomo 进程（路径含 dsh-vpn\bin 的）"
}
# 兜底：插件数据目录里的 mihomo.log 提到过的 pid（当前可能已退出）
Get-ChildItem $profilesRoot -Recurse -Filter 'mihomo.log' -ErrorAction SilentlyContinue | ForEach-Object {
  $tail = Get-Content $_.FullName -Tail 40 -ErrorAction SilentlyContinue
  $pids = [regex]::Matches(($tail -join "`n"), 'mihomo pid=(\d+)') | ForEach-Object { $_.Groups[1].Value }
  foreach ($pidText in ($pids | Select-Object -Unique)) {
    $proc = Get-Process -Id ([int]$pidText) -ErrorAction SilentlyContinue
    if ($proc -and $proc.Path -like '*dsh-vpn*bin*') {
      try { Stop-Process -Id $proc.Id -Force -ErrorAction Stop; Write-Host "[2/3] 已停止日志中的插件 mihomo pid=$($proc.Id)" } catch {}
    }
  }
}

# 3) 状态
Write-Host "[3/3] 当前状态："
Get-ChildItem $profilesRoot -Recurse -Filter 'state.json' -ErrorAction SilentlyContinue | Where-Object { $_.FullName -match '\\vpn\\' } | ForEach-Object {
  Write-Host "      $($_.FullName):"
  Get-Content $_.FullName -Raw -ErrorAction SilentlyContinue | ForEach-Object { "        $_" }
}
$listen = & netstat -ano 2>$null | Select-String -Pattern '127\.0\.0\.1:(18\d{3}|19\d{3})\s+.*LISTENING'
if ($listen) { Write-Host "      插件端口监听:"; $listen | ForEach-Object { "        $($_.Line.Trim())" } } else { Write-Host "      无插件端口监听" }
Write-Host ""
Write-Host "下一步：关闭并重新打开 DeepSeek Harness。重启后 dsh-vpn 会保持禁用，DSH API 使用原有网络策略。"
