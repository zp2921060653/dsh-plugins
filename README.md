# dsh-plugins

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH 桌面版）开发的插件与技能。

## 包含的插件

| 插件 | 版本 | 作用 | 目录 | 状态 |
| --- | --- | --- | --- | --- |
| dsh-agent-bridge | 0.1.0 | 让 DSH 调用本机其他 AI 编码 agent：Claude Code / Codex / 腾讯 Marvis（后台任务流式输出） | [agent-bridge/](agent-bridge/) | 已验证 |
| dsh-ghidra | 0.1.0 | 让 DSH 操作 Ghidra 反编译：导入二进制、反编译函数、字符串、交叉引用（常驻 PyGhidra 服务器） | [ghidra-bridge/](ghidra-bridge/) | 已验证 |
| dsh-reminder | 0.1.0 | 任务需要用户决定/辅助时，检测前台窗口（看剧/游戏），用声音/弹窗/黑白屏幕闪烁提醒用户回到工作；内置「桌面通知」设置页 | [reminder-bridge/](reminder-bridge/) | 已验证 |
| dsh-forensics | 0.1.3 | 取证工具箱：radare2/RetDec 反编译、tshark/mitmproxy 抓包、trafilatura/crawl4ai 抓网页、single-file/monolith 网页克隆 | [forensics-bridge/](forensics-bridge/) | 已验证 |
| dsh-wxapkg | 0.1.2 | 微信小程序包（wxapkg）反编译与分析：内置 wedecode 还原工程，再解析路由/分包/接口 | [wxapkg-bridge/](wxapkg-bridge/) | 已验证 |
| dsh-micropather | 0.1.2 | MicroPather（C++ A*）网格寻路：给出一张网格与起终点，返回路径点与代价 | [micropather-bridge/](micropather-bridge/) | 已验证 |
| dsh-dumper7 | 0.1.0 | 把 Dumper-7 注入 UE 游戏进程并检视生成的 SDK | [dumper7-bridge/](dumper7-bridge/) | 已验证 |
| dsh-browser | 0.1.0 | 用 CDP 驱动真实 Chromium：导航/点击/读渲染后的正文/直接读网络响应体（XHR JSON） | [browser-bridge/](browser-bridge/) | ⚠️ **未验证** |
| dsh-vpn | 0.2.0 | DSH 自带 VPN/代理能力：粘贴 Clash 订阅地址，插件内置 mihomo 内核独立出网（不再依赖本机 Clash/系统代理）；设置页可手动开/关 **Windows 系统代理**，让浏览器等本机软件也走插件，关闭/停用/退出自动精确还原 | [dsh-vpn/](dsh-vpn/) | 已验证 |
| dsh-wukong-trainer-skill | — | 黑神话·悟空（UE5 + C# 托管层）修改器制作方法论：属性数组公式、属性 ID 表、五类功能手法、AOB+代码洞穴注入流程、7 个实战坑（**WIP：属性/传送/掉落已验证，灵蕴/无敌/速度待补**） | [wukong-trainer-skill/](wukong-trainer-skill/) | WIP |

## 状态说明

- **已验证**：在作者本机的 DSH desktop profile 上实际安装并跑过主要路径。
- **未验证**：代码完成、本机跑通过主要路径，但没有跨平台/跨版本/长时间验证；接口与行为可能变化。
  使用前请先读该插件的 README 与自测脚本。

`dsh-browser` 的验证范围：

- 已跑通：启动与附着、标签页管理、8 种 `read` 模式、`network` 列表与响应体、click/type/press/scroll/wait、
  截图（整页/元素）、console/cookie/storage/页面内 fetch、工具 schema 通过模型 API 校验。
- 未覆盖：macOS 与 Linux 的浏览器探测、headless 长跑、视频与 WebGL、下载与弹窗、其它 DSH 版本。

## 安装

插件均以 DSH 的 **bundle**（组合包）形式交付，装进桌面版 profile：

    # 把本仓库克隆到本地后，分别安装各子目录
    git clone https://github.com/GalaxyBatMan111/dsh-plugins.git

    # 安装 agent 桥接插件
    & "$env:APPDATA\DSH Desktop\host-commands\desktop\bin\dsh.cmd" plugin --profile desktop add .\dsh-plugins\agent-bridge

    # 安装 Ghidra 插件（需先满足 ghidra-bridge/README.md 的环境要求）
    & "$env:APPDATA\DSH Desktop\host-commands\desktop\bin\dsh.cmd" plugin --profile desktop add .\dsh-plugins\ghidra-bridge

    # 安装提醒插件（web/profile 模式通用，也可用 web）
    & "$env:APPDATA\DSH Desktop\host-commands\web\bin\dsh.cmd" plugin --profile web add .\dsh-plugins\reminder-bridge

    # 安装 VPN 插件（内置 mihomo 内核 + 系统代理开关）
    & "$env:APPDATA\DSH Desktop\host-commands\desktop\bin\dsh.cmd" plugin --profile desktop add .\dsh-plugins\dsh-vpn

其余插件同理，把 `add` 后面的目录换成对应的 `*-bridge` 目录即可。然后重启 DSH，插件在启动时加载。

> **DSH 0.2.1-rc.3 的本地插件解析注意**：以目录方式安装的插件，从 `index.js` 里 `import` DSH 自带包
> （如 `@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-http-proxy`）时，必须在
> 该插件 `package.json` 的 `peerDependencies` 中声明这些包名，否则运行时会报
> `ERR_MODULE_NOT_FOUND`（见 `dsh-vpn/package.json` 的写法）。

> `dsh-ghidra` 的包名与 npm 上第三方同名包相同，安装时请以本仓库目录为准。

## 各插件说明

- [agent-bridge/README.md](agent-bridge/README.md) — 工具：`call_agent` / `agent_status`；支持流式后台任务
- [ghidra-bridge/README.md](ghidra-bridge/README.md) — 工具：`ghidra_status` / `ghidra_open` / `ghidra_info` / `ghidra_decompile` / `ghidra_functions` / `ghidra_strings` / `ghidra_xrefs` / `ghidra_close`
- [reminder-bridge/README.md](reminder-bridge/README.md) — 提醒配置面板（设置 → 桌面通知）；滑轨调位置/方式/闪烁参数
- [forensics-bridge/README.md](forensics-bridge/README.md) — 工具：`r2_info` / `r2_functions` / `r2_disasm` / `retdec_decompile` / `tshark_interfaces` / `tshark_capture` / `tshark_read` / `mitm_start` / `page_extract` / `crawl_page` / `clone_page`
- [wxapkg-bridge/README.md](wxapkg-bridge/README.md) — 工具：`wxapkg_status` / `wxapkg_scan` / `wxapkg_decompile` / `wxapkg_analyze`
- [micropather-bridge/README.md](micropather-bridge/README.md) — 工具：`micropather_solve` / `micropather_info`
- [dumper7-bridge/README.md](dumper7-bridge/README.md) — 工具：`dumper7_status` / `dumper7_dump` / `dumper7_sdk` / `dumper7_class`
- [browser-bridge/README.md](browser-bridge/README.md) — 工具：`browser` / `browser_read`（⚠️ 未验证）
- [dsh-vpn/README.md](dsh-vpn/README.md) — 工具：`vpn`（status / enable / disable / subscription / update / nodes / select / test / mode / system-proxy）；设置页「VPN」：订阅、节点、测速、rule/global、系统代理开关；内置 `mihomo.exe`（GPL-3.0，见目录内 LICENSE-NOTICE）
- [wukong-trainer-skill/README.md](wukong-trainer-skill/README.md) — 技能（skill），不是 bundle：放进 DSH 的 skills 目录即可被模型按需加载

## 许可

MIT（各插件目录内另有 LICENSE 声明的，以目录内声明为准，例如 wxapkg-bridge 为 GPL-3.0-or-later）。
