# dsh-mcp-jetbrains

中文 | [English](README.en.md) · [安全](SAFETY.md) · [路线规划](文档/软件工程/0.项目管理/路线规划.md)

DeepSeek Harness（DSH）插件：把 JetBrains IDE 内置的 MCP Server 接成 DSH 的工具，让智能体直接用 IDE 的能力——诊断、构建、读文件、数据库、终端、调试。

DSH 侧只做连接管理器，**不往 IDE 里装任何东西**：IDE 自 2025.2 起内置 `MCP Server` 插件并默认启用。名字里带 jetbrains 而不是 idea，因为它同样连 CLion、PyCharm。

> **先读[安全说明](SAFETY.md)。** 接了 IDE 的 MCP，等于把 IDE 能做的事交给了模型，其中包括执行终端命令与操作数据库。

## 为什么做

同一个项目里存在两份互相不认账的真相：

| | 看什么 |
|---|---|
| IDE | 内存缓冲区 + 自己的 inspection 引擎 |
| DSH | 磁盘上的字节 |

于是会出现「IDE 报错而 DSH 查完说没异常」，以及「IDE 重启后工具还在列表里，但每次调用都报 session not found」。

据此定的**第一原则**：

> **读不到 ≠ 没问题。** 取不到 IDE 结论时必须显式报「未知/不可用」，不得降级成「检查通过」。

## 提供什么

| 能力 | 说明 |
|---|---|
| 多 IDE 连接管理 | 每条连接挂一个 MCP 客户端子插件；配置存在插件自有存储，不写 profile 的 `cordis.patch.yml`，改完不用重启 DSH |
| 健康探测 | 后台定期探测，区分「TCP 连不上（IDE 没开）」与「会话 404 / 工具面变了（失效）」 |
| 自动重连 | 发现失效后只重挂受影响的那一条连接，其它连接与配置不动 |
| 调用失败的自诊断 | 失败后先取服务端工具清单，判断是「工具名问题」还是「连接问题」；只有传输类失败才就地重挂并**重试一次** |
| 读写走 IDE | 一个开关，强制把 `read` / `write` / `edit` 交给 IDE 执行，路由不到就失败而非落盘 |
| 诊断面板 | Host 保留最近 50 条自动动作，设置页显示前 5 条，能回答「它为什么自己重连了」 |

## 安装

前提：IDE 2025.2+（内置 MCP Server，默认启用），且 IDE 侧 MCP Server 可访问。

```text
plugin_manager install_bundle  target = <本仓库根目录>
```

**重装必须先 `remove_bundle` 再 `install_bundle`**：linked 插件不热更新，改源码不会自动生效。

安装后进入 **设置 → JetBrains IDE 连接**。

连接配置存在：

```text
$DSH_HOME/storages/dsh-mcp-jetbrains.connections.json
```

结构为 `{ version: 1, ideIo: { enabled }, connections: [...] }`。若存在旧插件（`@local/dsh-mcp-idea`）留下的 `dsh-mcp-idea.connections.json`，首次启动会自动迁移，**旧文件保留以便回滚**。

## 配置一条连接

| 字段 | 含义 |
|---|---|
| 连接 ID | 只用于日志与诊断，界面上认这一行，同一份配置里不能重复 |
| 服务名 `serverName` | 工具名前缀，形如 `^[A-Za-z0-9_-]{1,32}$`；工具以 `mcp__<serverName>__*` 暴露，改名等于给工具改名 |
| MCP 地址 | IDE 里 MCP Server 监听地址，DSH 以 `streamable-http` 连过去，例如 `http://127.0.0.1:64342/stream` |
| 项目路径 | 可选。作为 `U_MCP_SERVER_PROJECT_PATH` 请求头发给 IDE，留空则由 IDE 自己挑项目 |
| 启用 / 自动重载 | 分别控制是否挂载、是否允许后台自动重连 |

端口**没有公式**：本机实测 IDEA 64342、CLion 64362、PyCharm 64462，各 IDE 各自配置，请以 IDE 显示为准。

### 路由模式 vs 全量模式（必读）

IDE 的 MCP Server 有一个「工具暴露」开关。**仅路由模式**下，`tools/list` 只返回 1 个工具 `execute_tool`，其余全部藏在它后面，参数是字符串形式的 `--name value`，不是结构化 JSON：

```text
mcp__idea__execute_tool  →  get_file_problems --filePath src/main.ts
```

本机实测该模式下 IDE 实际有 66 个工具。**这是连接建立时的快照**：切换模式后必须重新连接才能看到新工具面。

## 读写走 IDE

设置页顶部的开关，存 `ideIo.enabled`（**默认开**）。开启后插件在工具调用层拦截 `read` / `write` / `edit`，改走 IDE 的 `read_file` / `create_new_file` / `apply_patch`。

路由规则：把目标文件绝对路径与各已启用连接的 `projectPath` 做**最长前缀匹配**；并列即失败；无匹配但恰好只有一条启用连接则用它（诊断里记 `fallback: true`）。

**核心语义：无法路由时明确失败，绝不静默回落磁盘。** 报错会给出三种解法——关掉开关 / 启用一条覆盖该文件的连接 / 修正 `projectPath`。

### 还没有任何连接时

开关可以开着，插件不会因此拒绝工作，但也不会替你做决定。第一次 `read` / `write` / `edit` 会**先向你提问**：

| 选项 | 结果 |
|---|---|
| 粘贴 JetBrains 配置 | 把 IDE「复制配置」的 JSON 填进自定义回答，插件自动建一条连接并**用同一次调用重试** |
| 让这次不代执行 | 插件**不写任何东西**，并明确告诉模型：要读写磁盘就自己走 shell，或先启用连接再重试 |
| 取消本次操作 | 什么都不做 |

第二条是刻意的：成功结果里的附加说明会被框架丢弃，若插件替你写了磁盘，模型会误以为数据来自 IDE——**这正是本项目要消灭的那种错觉**。多一轮对话，换掉一次静默的认知错误。

`edit` 不整读文件：先用 `search_text` 定位，再用 `apply_patch` 应用，有预算上限（上下文 3 行、候选上限 10、单次累计读取 200 行、patch 最多 2 次）。

## 已知限制与边界

这一节是项目的诚实之处，装之前请读完。完整风险说明见[安全](SAFETY.md)。

| 限制 | 说明 |
|---|---|
| shell 删除不受约束 | 「读写走 IDE」只拦工具层的 `read`/`write`/`edit`。模型若用 `Remove-Item` / `rm` 删除，IDE 不知情，Local History 也救不了 |
| 终端与 SQL 不受该开关约束 | IDE 的 `execute_terminal_command`、`execute_sql_query` 照常可用，不受路由策略影响 |
| 写入的 EOL 由 IDE 决定 | 实测本机经 IDE 写入得到 **CRLF**，而 DSH 原生写入是 LF |
| 读到的是 IDE 缓冲区 | 文件在 IDE 里打开且有未保存修改时，读到的是缓冲区内容（实测 640 行 vs 磁盘 763 行） |
| `apply_patch` 不查歧义 | 多处相同文本时它**静默修改第一处**并报成功（实测确认）。因此 `edit` 必须先搜索定位 |
| 文档与本机实现不一致 | 官方文档写 `read_file` 用 `mode`/`start_line`；本机 2026.2.3 实际是 `(file_path, offset, limit)` |
| `apply_patch` 批量非原子 | 合法操作照做、非法操作逐条报错、**不回滚**：`1 out of 2 operations applied` |
| `write` 内部仍读一次 | 为生成原生 `before`，内部读 offset 1 / limit 5000；>5000 行的文件会带截断标记 |

## 构建

源码是 TypeScript / TSX，`tsc` 1:1 编译，**不打包**：

```text
pnpm build      # tsc -p tsconfig.host.json && tsc -p tsconfig.client.json
```

| 源码 | 产物 | 说明 |
|---|---|---|
| `src/index.ts` | `lib/index.js` | Host 半，Node ESM，允许裸 `import` |
| `src/client.tsx` | `client.js` | 客户端半（设置页），**产物里不许出现任何 `import`** |

Host 与客户端用两份配置分别编译（`tsconfig.host.json` / `tsconfig.client.json`），共用 `tsconfig.json` 里的编译选项：宿主产物进 `lib/`，客户端产物留在根——这是 DSH 插件的通行布局。静态资源放 `assets/`（`icon.svg`）；`locale/*.json` 必须留在根，DSH 既按目录约定读它、也要求它出现在 `exports` 里。

JSX 用经典运行时（`jsx: "react"` + `jsxFactory: "h"`）：浏览器侧是裸 ESM 工厂脚本，解析不了 `react/jsx-runtime`。

`@deepseek-ai/*` 是 peer 依赖，工程内没有 node_modules 供解析，类型由 `src/env.d.ts` 的模块 shim 顶上。

`pnpm-lock.yaml` **不入库**：本目录 `pnpm install` 会因上游尚未发布的包而 404，lock 无法再生成/校验；`pnpm-workspace.yaml` 里因此关了 `verifyDepsBeforeRun`。

## 兼容性

| 项 | 值 |
|---|---|
| IDE | 2025.2+ 内置 MCP Server（默认启用） |
| 本机实测 | **2026.2.3（IU-262.10968.63）**，`since-build = 262` |
| DSH 侧传输 | `stdio`、`streamable-http`（**不支持 SSE**） |
| 向下兼容 | 未测试，交社区反馈 |

## 路线

技术判断、实测记录与后续计划在[路线规划](文档/软件工程/0.项目管理/路线规划.md)，按主题分节记录了「为什么是这样做」以及踩过的坑。下一轮计划把删除、移动、符号改名也接到 IDE（`apply_patch` 的 Delete / move-to 与 `rename_refactoring`）。

## 支持作者

如果这个插件帮到了你，可以扫码请我喝杯咖啡。

<img src="assets/wechat-reward.png" alt="微信赞赏码" width="220">

赞助完全自愿，**不影响** [MIT 许可](LICENSE) 授予的任何权利：不赞助也一样可以用、改、分发。

## License

[MIT](LICENSE) © 2026 极下少主 (darkwithlight)
