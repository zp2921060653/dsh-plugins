# dsh-dumper7

把 [Dumper-7](https://github.com/Encryqed/Dumper-7)（UE4/UE5 SDK 生成器，一个裸 DLL）接进 DSH，
让 agent 能「注入 → 等 SDK 生成 → 读 SDK」一条龙，不用手动开注入器。

## 工具

| 工具 | 作用 |
|---|---|
| `dumper7_status` | 环境自检：DLL 路径、Python、输出目录、当前像 UE 游戏的进程 |
| `dumper7_dump` | 把 DLL 注入指定进程（进程名或 PID），等 SDK 落盘并返回目录 |
| `dumper7_sdk` | 列 SDK 结构：文件数、头文件、类/结构体名 |
| `dumper7_class` | 取出某个类/结构体的完整声明（含偏移注释） |

## 依赖

- `Dumper-7.dll`（默认 `C:\tools\Dumper-7\Dumper-7.dll`）
- Python 3.13（默认自动找 `%LOCALAPPDATA%\Programs\Python\Python313\python.exe`）
- 目标游戏以普通权限运行，且位数与注入器一致（x64 Python → x64 游戏）

## 配置（profile `cordis.patch.yml` 按 id 覆盖）

```yaml
- id: dumper7-bridge
  name: dsh-dumper7
  config:
    dllPath: 'C:\tools\Dumper-7\Dumper-7.dll'
    pythonBin: ''
    outputDir: 'C:\Dumper-7'
    defaultTimeoutMs: 180000
```

## 说明

注入用的是 `lib/inject_dll.py`（ctypes + `CreateRemoteThread(LoadLibraryW)`），
不依赖第三方注入器。Dumper-7 的 SDK 默认写到 `C:\Dumper-7`（可在 `Dumper-7.ini` 里改）。
