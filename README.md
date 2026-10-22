# dsh-plugins

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH 桌面版）开发的插件。

## 包含的插件

| 插件 | 作用 | 目录 |
| --- | --- | --- |
| dsh-agent-bridge | 让 DSH 调用本机其他 AI 编码 agent：Claude Code / Codex / 腾讯 Marvis（后台任务流式输出） | [agent-bridge/](agent-bridge/) |
| dsh-ghidra | 让 DSH 操作 Ghidra 反编译：导入二进制、反编译函数、字符串、交叉引用（常驻 PyGhidra 服务器） | [ghidra-bridge/](ghidra-bridge/) |
| dsh-reminder | 任务需要用户决定/辅助时，检测前台窗口（看剧/游戏），用声音/弹窗/黑白屏幕闪烁提醒用户回到工作；内置「桌面通知」设置页可调位置与闪烁参数 | [reminder-bridge/](reminder-bridge/) |
| dsh-wukong-trainer-skill | 黑神话·悟空（UE5 + C# 托管层）修改器制作方法论：属性数组公式、属性 ID 表、五类功能手法、AOB+代码洞穴注入流程、7 个实战坑（**WIP：属性/传送/掉落已验证，灵蕴/无敌/速度待补**） | [wukong-trainer-skill/](wukong-trainer-skill/) |

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

然后重启 DSH，插件在启动时加载。

## 各插件说明

- [agent-bridge/README.md](agent-bridge/README.md) — 工具：`call_agent` / `agent_status`；支持流式后台任务
- [ghidra-bridge/README.md](ghidra-bridge/README.md) — 工具：`ghidra_status` / `ghidra_open` / `ghidra_info` / `ghidra_decompile` / `ghidra_functions` / `ghidra_strings` / `ghidra_xrefs` / `ghidra_close`
- [reminder-bridge/README.md](reminder-bridge/README.md) — 提醒配置面板（设置 → 桌面通知）；滑轨调位置/方式/闪烁参数

## 许可

MIT
