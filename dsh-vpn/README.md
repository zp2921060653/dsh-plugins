# dsh-vpn —— DSH 自带的 VPN/代理能力（mihomo 内核）

给 DSH（DeepSeek Harness）装一个**自己的代理内核**：粘贴一份 Clash 订阅地址，DSH 用插件内置的
[mihomo](https://github.com/MetaCubeX/mihomo) 独立出网，**不再依赖本机的 Clash Verge / 系统代理**。
本机 VPN 挂掉、端口变了、或者用户根本没开 VPN 时，DSH 的模型请求和工具网络访问仍然可用。

- Host 侧：Cordis 插件 `dsh-vpn`（本包 `index.js` + `lib/host/`）
- 引擎侧：纯 Node ESM 的 mihomo 生命周期/订阅解析层（`lib/engine/`，无 npm 依赖）
- 客户端：Settings 里的「VPN」设置页（`client.js` + `locale/` + `icon.svg`）

> 默认 `enabled: false`：装上不会自动接管任何流量；只有你显式启用（或持久化状态里 `enabled=true`
> 且通过健康门控）才会把**进程级** proxy dispatcher 切到插件自己的 mihomo。

---

## 1. 它做了什么（以及不做什么）

**做**：

- 用插件自带的 `bin/mihomo.exe` 起一个**只监听 127.0.0.1** 的 mixed 代理（HTTP/SOCKS 同端口）
- 拉取并解析 Clash 订阅（订阅缓存落盘，离线也能启动上次成功的配置）
- 通过 DSH 自带的 `@deepseek-ai/dsh-http-proxy` 把**当前 DSH 进程**的全局 undici dispatcher 指向
  `http://127.0.0.1:<mixed-port>`，于是进程内所有 `fetch`（含 LLM API、`web_fetch`、插件网络请求）都走插件内核
- 看门狗：连续健康检查失败时**先恢复 DSH 启动时的原始 dispatcher，再覆盖为「直连」安全网**
  （`fallbackToDirect` 默认开），保证 DSH 至少能直连出网；随后自动重试恢复接管
- 提供 Agent 工具 `vpn`、HTTP API `/dsh-vpn/api/*` 和设置页 UI 三套等价入口

**不做**：

- 默认不修改系统代理：只切当前 Node 进程的 dispatcher 与 `http_proxy` 等进程环境变量；只有用户显式打开
  **系统代理开关**（§4.5）才写 Windows WinINET 注册表（HKCU Internet Settings），关闭/停用/退出自动精确还原
- 不动用户已有的 Clash Verge / 其它 VPN 进程（端口都是自动挑的空闲端口；不 kill 非自己启动的进程）
- 不把订阅或状态写到插件目录：全部在 `<DSH_PROFILE_DIR>/vpn/`（可用 Config 的 `dataDir` 覆盖）
- 不是「全局系统 VPN」：只对 DSH 进程（及其按需继承环境变量的子进程）生效

---

## 2. 端口与数据目录拓扑

```
DSH Host 进程 ──(process-wide undici global dispatcher / http_proxy env)──▶ 127.0.0.1:<mixed-port>
                                                                              │ mihomo
                                                                              ▼
                                                                        订阅节点（ss/vless/vmess/trojan…）
mihomo external-controller: 127.0.0.1:<controller-port>（Bearer secret，仅本机）
```

| 项 | 默认值 | 说明 |
|---|---|---|
| mixed 代理端口 | 自动 18000–18999 | `proxyPort` 可固定；只监听 127.0.0.1（`allow-lan: false`, `bind-address: '127.0.0.1'`） |
| external-controller | 自动 19000–19999 | 仅 127.0.0.1，随机 secret，用于 health/节点切换/测速/reload |
| 数据目录 | 自动探测（见下） | 可用 `dataDir` 覆盖；不建议放插件目录（可能只读） |

**数据目录自动探测顺序**（真实 DOM/桌面宿主进程里可能只有 `DSH_HOME`，没有 `DSH_PROFILE_DIR/DSH_PROFILE`）：

1. Config `dataDir` 显式指定 → 直接用（`status.dataDirSource = "config"`）
2. 环境变量 `DSH_PROFILE_DIR` 存在 → `<DSH_PROFILE_DIR>/vpn`（`"env"`）
3. `DSH_PROFILE` 存在且 `<DSH_HOME>/profiles/<profile>` 确实是目录 → 用它（`"env"`）
4. 扫描 `<DSH_HOME>/profiles/*`，找**包含 `node_modules/dsh-vpn` 的那个 profile**（插件实际安装位置）→ 用它（`"profile-scan"`）
5. 以上都没有 → `<DSH_HOME>/profiles/<profile|default>/vpn` 或 `~/.dsh-vpn`（`"fallback"`）

实际路径与来源看 `GET /dsh-vpn/api/status` 的 `dataDir` / `dataDirSource`（`vpn status` 工具同样可见）。

数据目录内容：

| 文件 | 作用 |
|---|---|
| `state.json` | 持久化 `enabled / subscriptionUrl / preferredNode / mode` + 系统代理意图与快照（`systemProxy / systemProxyApplied / systemProxyOriginal`）；原子写，损坏自动回退 disabled |
| `subscription.yaml` | 最近一次成功拉取的原始 Clash YAML 缓存（离线启动用） |
| `runtime.yaml` | 由订阅 YAML + 覆盖项生成的实际运行配置（mihomo `-f` 使用；含 `profile: {store-selected: false, store-fake-ip: false}`，不写 cache.db） |
| `mihomo.log` | mihomo stdout/stderr（故障排查第一现场） |
| `Country.mmdb` | 启动时从插件 `data/` 复制过来，避免 mihomo 联网下载 geo 数据 |
| `disable.flag` | **kill-switch**：存在即强制 disabled、不自动启用（救援用，删掉即恢复） |

---

## 3. 安装

插件安装/卸载由 DSH 的 Plugin Manager（`plugin_manager install_bundle`，target 为本目录的绝对路径）负责；
本包是标准 bundle（`package.json` 的 `dsh.bundle.patch` + `cordis.patch.yml`），Host 行 id 为 `dsh-vpn`。

安装后可：

1. 打开 Web UI → Settings → 找到 **VPN** 设置页（`dsh.client` 段已声明 Settings slot/`locale` 依赖）；
2. 或在 `cordis.patch.yml`（profile 层，不是本包）里覆盖插件行配置：

```yaml
- id: dsh-vpn
  name: dsh-vpn
  config:
    subscriptionUrl: 'https://你的订阅地址'
    enabled: false        # 首次建议保持 false，确认订阅拉取成功后再开
    mode: rule
    logLevel: warning
```

> 注意：`dsh-http-proxy` 是 DSH 自带包，**不要**在 `package.json` 里声明依赖；
> 插件在被 DSH 加载时由宿主解析，普通 `node` 下 import 会 `ERR_MODULE_NOT_FOUND`（预期行为）。

---

## 4. 使用

### 4.1 设置页 UI

订阅地址 → 「保存并拉取」→ 连接开关 → 节点列表/测速/切换 → 模式（rule/global）→ 刷新订阅。
UI 每 5s 轮询一次 `GET /dsh-vpn/api/status`（响应已做轻量化：默认不带 logs）。

### 4.2 Agent 工具 `vpn`

模型可直接调用（工具与 UI/HTTP 共用同一批 service 方法）：

| action | 参数 | 说明 |
|---|---|---|
| `status` | — | 状态/端口/节点/订阅摘要/策略诊断 |
| `enable` | — | 启动 mihomo → 健康门控 → 接管 → 进程内 fetch 自测；失败自动回滚 |
| `disable` | — | 先恢复原始 dispatcher，再停 mihomo |
| `subscription` | `url` | 校验 https、拉取、写缓存（失败保留原配置） |
| `update` | — | 重新拉取当前订阅并热应用 |
| `nodes` | — | 列出节点（运行中实时读 mihomo，否则读缓存） |
| `select` | `node` | 切换节点（运行中立即生效，否则记为下次首选） |
| `test` | — | 并发 8 测速全部节点（ms / 超时） |
| `mode` | `mode` | `rule` / `global` |
| `system-proxy` | `enabled` | 开关 Windows 系统代理：`true` 把系统代理指向插件 mixed 端口（浏览器/Electron 等生效）；`false` 精确还原用户原系统代理。不改路由/TUN、不动 Clash 配置 |

### 4.3 HTTP API（同源，`cache-control: no-store`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/dsh-vpn/api/status` | `{ ok, status: { state, port, controllerPort, nodeName, mode, lastError, lastHealthMs, startedAt, subscription: { url, urlMasked, nodeCount, remainingTraffic, expireDate, totalBytes, expireAtIso, updateIntervalHours, fromCache, error }, systemProxy: { supported, enabled, applied, target, proxyEnable, proxyServer, proxyOverride, original, drift, lastError }, policy, engine, dataDir, dataDirSource, ... } }`；`?debug=1` 附带 logs |
| GET | `/dsh-vpn/api/nodes` | `{ ok, nodes:[{name,type,delay}], current, mode, running, source }` |
| POST | `/dsh-vpn/api/enable` | `{ ok, status }`；失败 `400 { ok:false, error, status }` |
| POST | `/dsh-vpn/api/disable` | 同上 |
| POST | `/dsh-vpn/api/subscription` | body `{ url }` → `{ ok, summary:{nodeCount,...}, subscription, applied, status }` |
| POST | `/dsh-vpn/api/update` | 同 subscription 的响应 |
| POST | `/dsh-vpn/api/mode` | body `{ mode: 'rule'\|'global' }` |
| POST | `/dsh-vpn/api/select` | body `{ node }` |
| POST | `/dsh-vpn/api/test` | `{ ok, delays:{ "<节点名>": ms\|null }, nodes, available, total }` |
| POST | `/dsh-vpn/api/system-proxy` | body `{ enabled: boolean }` → 成功 `{ ok, systemProxy:{...}, status }`；失败 `4xx { ok:false, error, systemProxy, status }`（`enabled=true` 要求 VPN running；`enabled=false` 任何状态都可还原） |

错误统一 `{ ok:false, error }`（HTTP 4xx/5xx；请求体上限 64KB，非 JSON 对象返回 400）。

### 4.4 典型 PowerShell 调用

```powershell
Invoke-RestMethod http://127.0.0.1:49993/dsh-vpn/api/status | ConvertTo-Json -Depth 6
Invoke-RestMethod -Method Post http://127.0.0.1:49993/dsh-vpn/api/subscription `
  -ContentType 'application/json' -Body '{"url":"https://你的订阅地址"}'
Invoke-RestMethod -Method Post http://127.0.0.1:49993/dsh-vpn/api/enable -ContentType 'application/json' -Body '{}'
Invoke-RestMethod -Method Post http://127.0.0.1:49993/dsh-vpn/api/test -ContentType 'application/json' -Body '{}'
Invoke-RestMethod -Method Post http://127.0.0.1:49993/dsh-vpn/api/system-proxy -ContentType 'application/json' -Body '{"enabled":true}'
Invoke-RestMethod -Method Post http://127.0.0.1:49993/dsh-vpn/api/system-proxy -ContentType 'application/json' -Body '{"enabled":false}'
Invoke-RestMethod -Method Post http://127.0.0.1:49993/dsh-vpn/api/disable -ContentType 'application/json' -Body '{}'
```

### 4.5 给本机其他软件用（系统代理开关）

默认**关闭**。VPN 处于 `running` 后，打开“系统代理”开关（UI 卡片 / `vpn action=system-proxy enabled=true` /
`POST /dsh-vpn/api/system-proxy {enabled:true}`）会把 **Windows 应用层系统代理（WinINET，HKCU Internet Settings）**
指向插件 mihomo 的 mixed 端口，效果类似 Clash 的“系统代理”：

- **影响范围**：读系统代理的应用 —— Chrome/Edge/Firefox（默认）、Electron 应用、大部分桌面软件；
  `ProxyServer` 写成 `127.0.0.1:<mixed-port>`，`ProxyEnable=1`；`ProxyOverride` 在保留用户原条目的基础上
  补齐 `localhost;127.*;::1;<local>`（保证 DSH Web GUI 等 loopback 流量不被代理）。
- **不影响**：路由表/TUN/防火墙、Clash 的配置与进程；不读系统代理的程序（部分 CLI/游戏）需要自行
  `curl -x http://127.0.0.1:<mixed-port>` 或设置 `HTTP_PROXY/HTTPS_PROXY` 环境变量。
- **可手动随时开关**：关掉开关 / `vpn disable` / 看门狗降级 / 插件卸载 / DSH 退出时都会**自动还原**；
  精度到值级别：`ProxyEnable/ProxyServer/ProxyOverride` 按开启前的快照写回，开启前没有的值重新删除；
  开启时若存在 PAC（`AutoConfigURL`）会临时清空并在还原时写回。
- **绝不指死端口**：应用前先快照；任一写入/通知/读回校验失败即回滚；停用/降级时**先还原系统代理再停引擎**；
  如果精确还原失败会退化为“安全关闭”（`ProxyEnable=0`）；若连安全关闭也失败，`disable` 会中止并保持 VPN
  运行（避免浏览器指向已停止的端口）。
- **外部改动不抢回**：如果你在 Clash Verge 里重新点了它自己的“系统代理”，`status.systemProxy.applied`
  会实时变成 `false`（`enabled=true` 表示你的开关意图仍在），UI 提示“未生效/已被其他程序改动”，
  再点一次开关即可重新指向插件；插件不会自动抢回。

```powershell
# 当前是否真的指向插件端口（applied 来自实时读取注册表，不是内存标记）
(Invoke-RestMethod http://127.0.0.1:49993/dsh-vpn/api/status).systemProxy | ConvertTo-Json -Depth 5
# 浏览器之外手动验证：让 curl 走插件端口
curl.exe -x http://127.0.0.1:<mixed-port> https://www.gstatic.com/generate_204 -I
```

---

## 5. 配置项（`cordis.patch.yml` 的 `config`）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `subscriptionUrl` | string | `''` | Clash 订阅地址（https）；也可之后在 UI/工具里设置 |
| `enabled` | boolean | `false` | 是否 DSH 启动后自动启用（仍会走健康门控；持久化状态优先） |
| `mode` | `rule`\|`global` | `rule` | rule=按订阅规则分流；global=全部走选中节点 |
| `preferredNode` | string | `''` | 首选节点名（启用时尝试选中） |
| `proxyPort` / `controllerPort` | number | `0` | 0=自动挑空闲端口 |
| `healthIntervalMs` | number | `30000` | 看门狗间隔（最小 1000） |
| `failureThreshold` | number | `3` | 连续失败多少次进入 degraded（最小 1） |
| `retryIntervalMs` | number | `60000` | 降级后重试间隔（最小 2000） |
| `probeUrl` | string | `http://www.gstatic.com/generate_204` | 经代理的健康探测 URL |
| `selfTestUrl` | string | `https://www.gstatic.com/generate_204` | **接管后进程内 fetch 自测** URL |
| `selfTestTimeoutMs` | number | `10000` | 自测超时 |
| `binaryPath` | string | `''` | mihomo 路径（空=插件 `bin/mihomo.exe`） |
| `dataDir` | string | `''` | 数据目录（空=自动探测，见 §2；`status.dataDirSource` 显示来源） |
| `fallbackToDirect` | boolean | `true` | 降级时安装直连安全网 |
| `logLevel` | `info`\|`warning`\|`error` | `warning` | 插件日志；引擎侧细节见 `mihomo.log` |
| `fetchTimeoutMs` | number | `30000` | 订阅拉取超时 |
| `autoStartDelayMs` | number | `3000` | 启动后延迟多久自动接管 |
| `systemProxy` | boolean | `false` | 接管成功后是否同时把 Windows 系统代理指向插件 mixed 端口（见 §4.5；默认关） |
| `systemProxyRestoreOnStop` | boolean | `true` | 停用/卸载/退出时是否精确还原原系统代理；`false` 时退化为安全关闭（`ProxyEnable=0`，同样不会指向死端口） |

持久化状态（`state.json`）在用户手动启用/停用/切节点/切模式/开关系统代理后写入，下一次启动**状态优先于 patch 里的静态值**；
`enabled`、`systemProxy` 也一样（即使用 patch 写 `true`，用户 UI 里关掉后下次不会自己再开）。
若上次异常退出没来得及还原系统代理，`state.json` 里的 `systemProxyApplied/systemProxyOriginal` 会让插件在
**启动时先精确还原**（见 §6 安全模型）。

---

## 6. 安全模型（重要）

1. **默认关闭**：`apply()` 不安装任何代理策略、不启动 mihomo、不阻塞；只有 `enable` 路径才可能接管。
2. **健康门控**：先启动 mihomo，再通过本地 mixed 端口（不依赖全局 dispatcher）探测成功，才允许 `installPolicy`。
3. **接管后自测**：`installPolicy(port)` 之后立即用**进程内全局 `fetch`** 请求
   `https://www.gstatic.com/generate_204`；失败/超时 → **立即回滚**（`restorePolicy()`，再按
   `fallbackToDirect` 装直连）→ 停引擎 → 状态 `failed`。绝不在「策略已装但通道不通」时返回成功。
4. **恢复语义**：`disable()`/卸载时先 `restorePolicy()` 回到 DSH 启动时的原始 dispatcher，再停引擎；
   所以「用户 Clash Verge 原本可用」的场景停用后行为与装插件前一致。
5. **看门狗安全网**：连续 `failureThreshold` 次探测失败 → `restorePolicy()`（可能指回用户已死的旧代理）→
   **紧接着** `installDirectPolicy()` 覆盖为直连（`fallbackToDirect: true` 时），记录 degraded 原因，
   之后每 `retryIntervalMs` 重拉订阅/重启引擎/重新接管；恢复健康后重新装上代理策略。
6. **kill-switch 救援**：
   - 建文件 `<实际 dataDir>/disable.flag`（内容任意），或设环境变量 `DSH_VPN_DISABLED=1`；
     实际 dataDir 见 `status.dataDir`（自动探测逻辑见 §2，桌面宿主通常是 `<DSH_HOME>/profiles/<装插件的 profile>/vpn`）；
   - 插件启动时发现即强制 disabled，且拒绝自动/手动 enable；删文件（或重启 DSH 去掉环境变量）即恢复。
   - 适用场景：实时接管万一导致会话网络异常，用户无需改任何配置，建个文件重启 DSH 即可回到「不接管」。
7. **状态损坏容错**：`state.json` 读到坏 JSON → 回退默认 `disabled`，插件照常加载。
8. **进程边界**：只 kill 自己 `spawn` 的 mihomo PID（兜底 `process.kill`，失败才 `taskkill /PID … /T /F`）；
   绝不停止非自己启动的进程。**注册表只写一处**：用户显式开启系统代理时的
   `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`（见第 9 条），其它时间不碰系统代理。
9. **系统代理安全网**（§4.5）：默认 `systemProxy:false`；开启前先快照原值并持久化到 `state.json`，
   写入后做读回校验；任一失败（写/通知/校验）立即回滚到操作前值；停用/降级/卸载/退出都**先还原系统代理、
   再停引擎**（降级时即时有安全关闭兜底）；进程退出还有同步 exit guard；启动时用持久化快照做 stale 清理。
   因此任何情况下系统代理都不会停留在指向已停止插件端口的状态。

**关于与 launcher 代理的关系**：DSH 启动时若环境里已有 `HTTPS_PROXY`（例如用户 Clash Verge 的 7897），
launcher 会先安装一层 env proxy dispatcher。插件接管时在它之上叠加自己的策略；`restorePolicy()` 的 disposer
链会逐层回退，最终回到 launcher 那一层（这正是「恢复原始 dispatcher」）。降级时如果 launcher 那层指向死代理，
`installDirectPolicy()` 会再覆盖一层显式直连 dispatcher 作为安全网。

---

## 7. 状态机与看门狗

```
disabled --enable--> starting --(health ok + installPolicy + fetch 自测 ok)--> running
                        │                                                        │
                        └──(任一步失败)──> failed          (watchdog 连续失败)   ▼
                                                              degraded <---- restore + direct
                                                                   │
                                                       每 retryIntervalMs 重试
                                                                   │
                                                            starting → running
disable: 任意状态 → disabled（先 restore，再停引擎）
```

- `starting` 期间的并发 `enable` 会被拒绝（「正在启动中」），所有写操作串行化。
- `degraded` 期间 `GET status` 有 `degradedReason`、`lastError`、`retry.{count,nextRetryAt}`；
  `nodes/test` 会提示 VPN 未运行（此时只有直连安全网在线）。
- 恢复成功会重新开始看门狗；恢复失败继续保持 degraded 并安排下一次重试。

---

## 8. 故障排查

| 现象 | 可能原因 / 处理 |
|---|---|
| `无法接管进程代理：@deepseek-ai/dsh-http-proxy 与 undici 均不可用` | 在**普通 node** 里跑（宿主进程内有解析挂载，普通 node 没有）。若宿主里也出现：检查 DSH 版本/包完整性；插件会保持直连不崩 |
| `订阅拉取失败且没有本地缓存` | 订阅地址不可达/失效；Host 会用 `subscription.yaml` 缓存兜底，缓存也没有才失败。先 `vpn subscription <url>` 或检查网络 |
| `mihomo 启动失败` / `健康检查未通过` | 看 `<dataDir>/mihomo.log`；常见：端口被占用（改用自动端口或换 `proxyPort`）、订阅节点全挂、geo 数据损坏（删 dataDir 里 `*.mmdb` 会重新复制） |
| 启用后 DSH 网络异常 | 先 `vpn disable`（恢复原始 dispatcher）；或建 `<dataDir>/disable.flag` 后重启 DSH。看 `status.policy` 判断当前是代理/直连/无 |
| 降级后一直是 `degraded` | 看 `status.lastError`；确认订阅节点可用（`vpn test` 需要在 running 状态；degraded 下会重启引擎重试）。网络恢复后最多等 `retryIntervalMs` |
| 遗留 mihomo 进程 | 只可能是宿主被强杀的场景。用 `Get-Process mihomo \| Select Id,Path` 确认 Path 指向本插件 `bin\mihomo.exe` 后 `taskkill /PID <pid> /T /F`；不要杀用户自己的 Clash |
| 端口冲突（用户 Clash 也监听） | 插件默认只在 18000-18999/19000-19999 自动选端口，不会占用用户 Clash 的 7890/7897；如固定了 `proxyPort` 请避开 |
| `state.json` 损坏 | 已自动回退 disabled；可删掉 state.json 重新配置（订阅缓存保留） |
| 系统代理开关打不开（`enabled=true` 但 `applied=false`） | ① VPN 未 running（必须 running 才能指向插件端口）；② 被其他程序（Clash Verge）改回去了 → 再点一次开关；③ 看 `status.systemProxy.lastError` / `readError`；④ 非 Windows 平台 `supported=false` |
| 浏览器不走插件代理 | 看 `status.systemProxy.applied` 是否为 true；部分应用有自己的代理设置；检查 `AutoConfigURL`（PAC，插件开启时会临时清空并在关闭时还原）；某些应用需重启才感知 WinINET 变更（插件已调用 InternetSetOption 通知） |
| 关闭系统代理后想手动恢复 | 正常关闭会自动还原；若曾异常退出，重启 DSH 时插件会按 `state.json` 快照做启动期还原；也可手动把 `ProxyEnable/ProxyServer` 改回原值（`status.systemProxy.original` 里有原值） |

---

## 9. 开发与自检

```powershell
# 语法检查（全部 Host/客户端文件）
node --check index.js
node --check lib/host/service.mjs
node --check lib/host/policy.mjs
node --check lib/host/state.mjs
node --check lib/host/engine-bridge.mjs
node --check lib/host/routes.mjs
node --check lib/host/system-proxy.mjs
node --check lib/host/selftest.mjs
node --check client.js

# 纯逻辑自检（不装插件、不需要 dsh 包、不启动 mihomo）
node lib/host/selftest.mjs
```

`lib/host/selftest.mjs` 覆盖：Config 归一化、state 原子写/损坏容错/kill-switch、订阅摘要解析、
URL 掩码、探测归一化、policy 在两条通路都不可用时的优雅降级、HTTP API 契约（含 404/405/400/413）、
VpnService 安全失败路径、引擎门面契约校验、节点解析、dataDir 自动探测，以及**系统代理**的
快照/bypass 合并/幂等/失败回滚/精确还原/PAC/启动期 stale 清理/disable-abort（全部用内存 runner，
**不会读写真实注册表**）。

还有一份**集成冒烟**（会真实启动一次 mihomo，结束自动清理；普通 node 下预期「策略接管不可用 → 回滚」）：

```powershell
node lib/host/selftest-integration.mjs <一份 Clash YAML 路径>
```

> 需要真实宿主才能验证的项：进程级 dispatcher 实际接管/恢复、`installProxyFromEnvironment` 首选通路、
> 接管后进程内 `fetch` 自测成功路径、webServer 路由注册与 Settings slot 渲染。这些由插件安装后实测。

---

## 10. 已知限制

- 平台：当前只附带 **Windows x64** 的 `mihomo.exe`（MetaCubeX mihomo v1.19.33，GPL-3.0，见 `LICENSE-NOTICE.md`）。
- 接管范围是**进程级**：默认只影响 DSH Host 进程及其按需继承 `http_proxy` 等环境变量的子进程；
  只有你显式打开**系统代理开关**（§4.5）才把 Windows WinINET 系统代理指向插件端口，关闭/停用会自动还原。
- 系统代理只覆盖读 WinINET 的应用；TUN/路由表/防火墙不碰，也不改 Clash Verge 的配置与进程。
  存在 PAC 的应用在开启期间以手动代理为准（PAC 会被临时清空、关闭时还原）。
- 健康/测速依赖订阅节点本身可用；rule 模式下探测 URL 的走向由订阅规则决定。
- 订阅解析支持 Clash YAML 与 base64 分享链接（ss/vmess/vless/trojan，转成最小 Clash 配置）；
  更复杂的分享链接字段（如部分插件参数）可能只解析不投递。
- mihomo 的 UDP/QUIC 能力取决于节点与订阅配置；宿主侧不做额外保证。
- 若 DSH 被强杀（来不及走插件 unload），mihomo 子进程可能残留；见「故障排查」。
- `bin/mihomo.exe` 约 58MB；安装/打包时注意体积。

## 11. 许可

- 本插件代码：MIT（见 `package.json`）。
- 附带二进制/数据：见 `LICENSE-NOTICE.md`（mihomo GPL-3.0；Country.mmdb 来源 MetaCubeX/meta-rules-dat）。

---

## 12. 救援脚本与“重启后生效”说明

### 救援脚本（会话异常时由用户手动运行）

```powershell
# 不需要 DSH 在线；只写 kill-switch、停插件自己的 mihomo、打印状态
powershell -ExecutionPolicy Bypass -File <插件目录>\tools\dsh-vpn-rescue.ps1
# 然后关闭并重新打开 DeepSeek Harness（重启后插件会强制保持 disabled）
```

脚本不会修改系统代理/注册表，也不会停止用户自己的 Clash Verge —— 只处理路径在
`...\dsh-vpn\bin\` 下的 mihomo 进程。恢复使用：删掉脚本写入的 `disable.flag`
（在 `status.dataDir` 指向的目录里），再在设置页或 `vpn action=enable` 启用。

### kill-switch 语义

`<dataDir>/disable.flag` 或 `DSH_VPN_DISABLED=1` 是**启动期**开关：插件 apply 时检测到就强制保持
`disabled` 且拒绝自动接管；运行期不会拦截手动 `enable`。救援流程因此是“写 flag → 重启 DSH”。

### 代码更新何时生效

本插件以本地目录 link 安装：**替换/修改插件源码后，需要重启 DSH 才能加载新的 JS 模块
生成**（Cordis 加载器按模块 URL 缓存，运行中的进程不会热替换 Host 代码；client.js 的
UI 侧会随 client bundle 重新构建而更新）。

### dataDir 迁移（升级到带 dataDir 自动探测的版本时）

老版本在宿主环境缺少 `DSH_PROFILE_DIR` 时可能把状态写到 `<DSH_HOME>/profiles/default/vpn`；
新版本会扫描 `<DSH_HOME>/profiles/*` 找到安装了 `dsh-vpn` 的 profile（通常是 `desktop`）。
若要从旧目录沿用状态：

```powershell
$old = "$env:DSH_HOME\profiles\default\vpn"
$new = "$env:DSH_HOME\profiles\desktop\vpn"
New-Item -ItemType Directory -Force $new | Out-Null
Copy-Item "$old\state.json","$old\subscription.yaml" $new -Force
```

`status.dataDir` / `status.dataDirSource`（`?debug=1`）可确认实际目录与来源。
