# dsh-browser

> ⚠️ **未验证（unverified）**
>
> 这个插件只在本机（Windows / DSH desktop profile / Playwright Chromium 156）跑通过下面列出的路径；
> 没有在 macOS、Linux、其它 Chromium 版本、无窗口长跑或别人的 profile 上验证过。
> 使用前建议先跑 `node dev/schema-check.mjs` 与 `node dev/smoke.mjs`，再按下面的配置项调整。

给 DSH 用的「真实浏览器」插件：在 Host 进程里直接启动（或附着到）一个 Chromium，
通过 **CDP（DevTools Protocol）** 驱动它，于是模型不必靠截图猜页面 —— 可以直接读
渲染后的正文、页面发出的网络请求与响应体、控制台日志、cookie/storage。

零第三方依赖：CDP 客户端用 Node 内置的 `WebSocket` 实现（Node ≥ 22）。

## 验证状态

已在本机验证：

- 启动 / 附着到已运行实例 / 持久化 profile / 换浏览器二进制时先关旧实例
- `open` / `goto` / `back` / `forward` / `reload` / 标签页管理
- `read` 的 `main`、`markdown`、`text`、`html`、`link`、`meta`、`interactive`、`ax` 八种模式
- `network` 列表与响应体读取（Hacker News 文档、bilibili 的 XHR JSON）
- `click` / `type` / `press` / `hover` / `scroll` / `wait` / `selectOption`
- `screenshot`（整页 / 元素 / jpeg）、`viewport`
- `console` / `cookies` / `storage` / 页面内 `fetch`
- 工具 schema 能通过模型 API（DeepSeek）校验；工具结果满足 lossless JSON 校验

未验证：

- macOS / Linux 的浏览器探测路径
- headless 模式长时间运行
- 视频、Canvas/WebGL、下载目录、弹窗/多窗口等边缘路径
- 其它 DSH 版本（本机为 0.2.1-rc.2）

## 安装形态

这是一个 bundle 包，安装后在 profile 里表现为插件行 `browser`：

```yaml
# cordis.patch.yml（包内）
- insert:
    - id: browser
      name: dsh-browser
      config:
        headless: false
        defaultTimeoutMs: 25000
```

注册两个工具：

| 工具 | 作用 |
| --- | --- |
| `browser` | 生命周期、导航、交互、截图、页面内 JS 求值 |
| `browser_read` | 读渲染结果、网络响应、控制台、cookie/storage、页面内 fetch |

## 常用动作

### 控制（`browser`）

| action | 说明 |
| --- | --- |
| `status` | 浏览器/可执行文件/标签页状态（不会启动浏览器） |
| `open` | 打开 URL（默认复用空白标签，新页面会新建标签） |
| `goto` / `back` / `forward` / `reload` | 当前标签导航与历史 |
| `tabs` / `activate` / `close` | 标签页管理 |
| `click` | `selector` 或 `text` 定位；真实鼠标事件；`force` 走 DOM click |
| `type` | 聚焦 + 选中 + `Input.insertText`；`submit` 回车提交 |
| `press` / `hover` / `scroll` / `selectOption` | 键盘、悬停、滚动、下拉 |
| `wait` | 元素 / 文本 / URL / 网络空闲 / 毫秒 |
| `eval` | 在页面执行 JS 并取回 JSON 化结果 |
| `screenshot` | 存盘返回路径（`fullPage` / `selector` / `jpeg`） |
| `viewport` | 设备尺寸/DPR/移动端模拟 |
| `close_browser` | 关闭整个浏览器 |

### 读取（`browser_read`）

| action | 说明 |
| --- | --- |
| `read` | `mode`：`main`（默认，正文转 Markdown）/ `markdown` / `text` / `html` / `link` / `meta` / `interactive`（可点击元素 + selector）/ `ax`（无障碍树） |
| `network` | 列出请求；带 `id` 直接返回响应体（XHR/fetch 的 JSON 一般已缓存） |
| `console` | 控制台/异常/日志 |
| `cookies` | get / set / clear |
| `storage` | localStorage / sessionStorage |
| `fetch` | 在页面上下文发请求，自动带登录态 |

典型流程：

```
browser        { action: "open", url: "https://example.com" }
browser_read   { action: "read", mode: "main" }
browser_read   { action: "read", mode: "interactive", limit: 60 }
browser        { action: "click", text: "登录" }
browser_read   { action: "network", filter: "/api/", limit: 20 }
browser_read   { action: "network", id: "<请求 id>" }
```

## 配置（包内 `cordis.patch.yml` 的 `config`）

插件不导出 Schemastery `Config`（链接安装时 `@deepseek-ai/schemastery` 不可解析），
所以配置在代码里归一化，键如下：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `browserPath` | `''` | 指定 Chromium 可执行文件；空=自动探测 |
| `userDataDir` | 空（`<profile>/.browser-profile`） | 持久化 profile，登录态存在这里 |
| `headless` | `false` | 是否无窗口 |
| `cdpEndpoint` | `''` | 附着到已开调试端口的浏览器，如 `http://127.0.0.1:9222` |
| `autoLaunch` | `true` | 首次调用时自动启动 |
| `reuseExisting` / `reuseBlank` | `true` | 复用上次的浏览器 / 复用空白标签 |
| `defaultTimeoutMs` | `25000` | 导航与等待的默认超时 |
| `maxBodyBytes` / `maxBodyTotalBytes` | 2 MiB / 48 MiB | 单个/整体响应体缓存上限 |
| `maxRequests` | `600` | 每个标签保留的请求条数 |
| `dialogBehavior` | `accept` | `alert/confirm` 的处理：accept / dismiss / manual |
| `windowSize` | `1440x900` | 窗口尺寸 |

浏览器探测顺序：`browserPath` → `DSH_BROWSER_PATH` → `CHROME_PATH` → 系统 Chrome →
系统 Edge → Playwright 的 Chromium → EdgeCore（厂商捆绑包，可能带推广首页，排在最后）。

同一 profile 目录只属于一个浏览器二进制：换二进制时会先关掉旧实例再启动新的
（`<profile>/dsh-browser.json` 记录上次使用的 exe）。

## 实现要点

- `lib/cdp.js`：最小 CDP 客户端（WebSocket + flat session 复用）。
- `lib/browser.js`：探测/启动/附着、标签页模型、Network/Console/Dialog 采集。
- `lib/page-lib.js`：注入页面的助手（Markdown 转换、正文启发式、可交互元素清单、文本定位）。
- `lib/actions.js`：工具动作实现（输入用 `Input.*` 真实事件，React 受控组件也能触发）。
- `index.js`：工具注册。**自己把 DSH 的 parameters 规格转成模型 API 认的 JSON Schema**
  （`{type:'object',properties,required:[...]}`，不输出 `enum`），并对结果做 `lossless` 清洗
  （去掉 `undefined`/非有限数，否则工具结果会被判为非法 JSON）。

采集时机：为了让页面**首个请求**就被记录，页面在 `Target.setAutoAttach`
（`waitForDebuggerOnStart: true`）下暂停，等 `Network.enable` 之后才
`Runtime.runIfWaitingForDebugger` 放行。

## 开发自测

```bash
node dev/schema-check.mjs   # 校验注册出去的工具 schema 形状
node dev/smoke.mjs          # 起本地 HTTP 服务，跑 28 项端到端断言
```

`dev/` 只在源码里，不参与插件运行。

## 已知限制

- 只采集 `Document` / `XHR` / `Fetch` 的文本响应体，且单条不超过 `maxBodyBytes`；
  被浏览器回收的响应体会返回「取不到响应体」，可用 `fetch` 动作重新请求。
- 视频/Canvas/WebGL 内容只能靠 `screenshot`。
- 目前没有 Harness Web UI 面板（只有工具）；需要「在 GUI 里看实时画面」可以后续加。
