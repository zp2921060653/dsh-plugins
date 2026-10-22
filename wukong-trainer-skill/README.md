# dsh-wukong-trainer-skill

给 DeepSeek Harness 用的 agent skill：**黑神话·悟空（以及同架构 UE5 + USharp/C# 游戏）修改器制作方法论**。

## 状态

> **WIP / 未完成**。已实测：属性上限、攻击/防御、掉落加成、坐标传送。
> 待补：灵蕴钱包、无敌、100% 掉宝、速度/跳跃。详见 SKILL.md 第 3、6 节。

## 装上会得到什么

一个 skill：`wukong-trainer-re`。当任务涉及给该游戏做修改器、理解其属性系统、
或排查"改了没反应"时，agent 会自动加载它。

## 内容

| 章节 | 内容 |
|---|---|
| 0 | 三层架构（引擎 / C# 托管 / protobuf 存档）与选层原则 |
| 1 | 属性数组公式 `addr = base + 0x20 + id*4` + 完整属性 ID 表 |
| 2 | 五类功能 × 五种手法（直接写 / 冻结 / 代码补丁 / 钩访问器 / 引擎参数） |
| 3 | 44 项功能的完成度对照（WIP 标记） |
| 4 | 从零复现的 7 步流程（CE 实操） |
| 5 | 七个实战坑（派生值、钱包不可扫描、连号表、地址漂移、进程树、AA 段头、AOB 自毁） |
| 6 | TODO 清单 |

## 安装

```bash
# 在 dsh profile 里
npm install --save file:<path-to>/dsh-wukong-trainer-skill
# 或发布后
npm install --save dsh-wukong-trainer-skill
```

然后把 `dsh-wukong-trainer-skill` 加进 profile `package.json` 的 `dsh.profile.bundles`，重启 DSH。

## 目录

```
index.js                    插件入口，把 skill 注册进 ctx.skills
lib/skill.js                读取并解析 SKILL.md 的 frontmatter
skills/wukong-trainer-re/SKILL.md   技能正文
```

## License

MIT
