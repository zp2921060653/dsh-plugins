# dsh-vpn 第三方组件与许可声明（LICENSE-NOTICE）

本包（`dsh-vpn`）自身代码以 MIT 许可发布（见 `package.json` 的 `license` 字段）。
包内附带的以下第三方二进制/数据文件**不是** MIT 作品，各自遵循其上游许可：

---

## 1. `bin/mihomo.exe`

- 项目：**mihomo**（Clash Meta 内核）
- 上游：MetaCubeX / mihomo — <https://github.com/MetaCubeX/mihomo>
- 版本：**v1.19.33**（输出：`Mihomo Meta v1.19.33 windows amd64 with go1.26.10`，tags: `with_gvisor`）
- 许可：**GPL-3.0** — <https://github.com/MetaCubeX/mihomo/blob/Alpha/LICENSE>
- 分发方式：原样附带本构建产物（未修改），作为独立可执行程序由插件 `spawn` 启动，插件通过其
  RESTful external-controller API 与本地端口交互。
- GPL-3.0 义务提示：本包以独立程序方式聚合分发 mihomo，mihomo 的完整对应源码可从上述上游仓库
  对应 tag/release 获取；若你需要本分发所含二进制的完整对应源码，可按 GPL-3.0 第 3 节向分发者索取，
  或从上游 release 页面 <https://github.com/MetaCubeX/mihomo/releases> 获取。
- 许可证全文已随包附带：`third_party/mihomo-LICENSE.txt`（GPL-3.0）。
- 版权归 MetaCubeX/mihomo 及其贡献者所有。

## 2. `data/Country.mmdb`

- 来源：**MetaCubeX / meta-rules-dat** — <https://github.com/MetaCubeX/meta-rules-dat>
- 用途：mihomo 的 GeoIP 数据库；插件启动时把它复制到数据目录，并配合运行配置里的
  `geo-auto-update: false` / `geodata-mode: false`，避免 mihomo 启动时联网下载 geo 数据（离线可用）。
- 分发方式：原样附带，未修改。
- 许可：**GPL-3.0**（上游仓库 `LICENSE`）；许可证全文已随包附带：`third_party/meta-rules-dat-LICENSE.txt`。
- 版权归上游项目及其数据提供方所有。

## 3. 与 DSH 自带包的关系

- `@deepseek-ai/dsh-http-proxy`、`@deepseek-ai/dsh-tools`、`schemastery` 等由 **DSH 安装本身**提供，
  本包不附带、不在 `package.json` 中声明依赖；插件在 DSH 宿主进程内才解析它们。
- 这些包遵循 DSH 自身的许可。

---

## 4. 订阅内容

插件只负责按用户提供的订阅地址拉取、缓存并交给本机 mihomo 使用；订阅内容（节点、规则、流量信息）的
版权与使用条款由用户与订阅服务商之间约定，本插件不分发任何订阅内容。
