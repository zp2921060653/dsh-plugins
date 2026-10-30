# dsh-mcp-jetbrains（内置副本 / vendored）

- 上游仓库：https://github.com/darkwithlight/dsh-mcp-jetbrains
- npm 包：`dsh-mcp-jetbrains@0.10.0`（MIT，版权归原作者 极下少主 / darkwithlight，见 [LICENSE](LICENSE)）
- 本目录是原样内置（vendor），便于从本仓库离线安装；未做代码改动。

## 作用

把 JetBrains IDE 内置的 **MCP Server** 接成 DSH 工具（工具名前缀 `mcp__idea__*`，也支持 CLion / PyCharm）：
IDE 诊断（inspection）、构建、代码搜索与符号、调用链、重命名重构、run configuration、调试器、终端、数据库、Git 等。

## IDEA 侧准备

1. IntelliJ IDEA 2025.2+（本机实测 2026.2.3）自带 **MCP Server** 插件，默认启用；
2. `Settings → Tools → MCP Server` → 勾选 **Enable MCP Server** → `Apply`；
3. 记下监听端口（默认 `64342`），MCP 地址为 `http://127.0.0.1:64342/stream`。

## 在 DSH 桌面版安装

```powershell
# 在仓库根目录执行（profile 按实际使用 desktop）
& "$env:APPDATA\DSH Desktop\host-commands\desktop\bin\dsh.cmd" plugin --profile desktop add .\mcp-jetbrains
```

安装后重启 DSH，然后 `设置 → JetBrains IDE 连接` 新增一条连接：

| 字段 | 值 |
| --- | --- |
| 服务名 | `idea` |
| MCP 地址 | `http://127.0.0.1:64342/stream`（端口以 IDE 显示为准） |
| 项目路径 | IDE 项目绝对路径；留空则每次调用需传 projectPath |
| 启用 / 自动重载 | 勾选 |

## 中文项目路径的坑（本机实测，重要）

插件会把 `projectPath` 原样写进 HTTP 请求头 `IJ_MCP_SERVER_PROJECT_PATH`，而 Node 的 fetch 不允许非 Latin-1 字符；
项目路径含中文时连接会失败，或工具调用报 `Unable to determine the target project`。

三种解法（任选）：

1. **项目放在纯英文路径**（推荐，最省心）；
2. 把 projectPath 的 UTF-8 字节按 Latin-1 写入连接存储 `$DSH_HOME/storages/dsh-mcp-jetbrains.connections.json`
   （IDE 服务端会按 UTF-8 解码，能正确匹配中文项目；缺点是设置页里该栏显示为乱码，不要手动编辑它）；
3. 不填 projectPath，每次调用工具时显式传 `projectPath` 参数（需要模型/调用方自己带）。

## 验证

- 重启 DSH 后，让 agent 调用 `mcp__idea__get_project_modules` 或 `mcp__idea__build_project`；
- 或直接看 `设置 → JetBrains IDE 连接` 里连接是否「已挂载」。
