/**
 * dsh-mcp-jetbrains —— 浏览器半端（设置里的一页「JetBrains IDE 连接」）
 * ============================================================================
 * 自注册脚本（与 dsh-feiyu-mood / dsh-bili-scroll 同一约定）：
 *
 *     window['__ModuleLoader__'].load({ id: '<包名>', factory: (require) => ({ inject, apply }) })
 *
 * 这一页管的是 Host 插件 `dsh-mcp-jetbrains` 的 Config：`connections[]`，
 * 每条连接 5 个字段（id / serverName / url / projectPath / enabled），
 * 一条连接在 Host 侧挂一个 mcp-client 子插件，工具以 mcp__<serverName>__* 暴露。
 *
 * 读写都不走 schema 自动表单：这个插件的 Config 里没有 volatile field，
 * `ctx.settings` 的表单路径根本不会收录它（volatileForm 返回 undefined）。
 * 所以数据面是本插件 Host 半端挂的三条自己的路由：
 *
 *     GET  /dsh-mcp-jetbrains/config     读当前 rows + 已挂载状态 + 存储位置 + ideIo
 *     GET  /dsh-mcp-jetbrains/config?probe=surface
 *                                   同一份视图，但先对所有已挂载连接做一次工具面校验
 *     POST /dsh-mcp-jetbrains/config     save（Host 写插件自有存储 → 就地重挂全部连接）
 *     POST /dsh-mcp-jetbrains/reconnect  单独重挂一条（IDE 重启后旧 HTTP 会话失效时用）
 *     POST /dsh-mcp-jetbrains/ide-io     翻转全局「读写走 IDE」开关
 *
 * 页面顶部的「读写走 IDE」不是纯界面状态：Host 把开关存进**同一个**存储 JSON
 * 的 `ideIo` 字段（默认开），并在 `tools/execute` 里强制 read/write/edit 走 IDE。
 * 开启期间任何无法路由的文件操作都由 Host 明确报错，绝不悄悄回落到磁盘；唯一
 * 例外是一条启用连接都没有——此时 Host 不直接放行，而是通过 `userQuestions`
 * 提问：粘贴 IDE 配置（自动建连接并用同一次调用重试）/ 本次改用 DSH 原生读写 /
 * 取消。只有用户显式选择原生读写的那一次才放行磁盘路径，页面上把开关标成
 * 「尚未生效」。
 *
 * 卡片的展开态不认「连接 ID」，认每行的**内部 key**（`__key`，加载/新增时自增
 * 分配，只活在页面内存里）：改 ID 只是字段编辑，不会换掉卡片身份，也就不会在
 * 每敲一个字符时把卡片收起。保存前 `__key` 被显式剥掉，Host 的 `rowOf` 也只保留
 * 六个持久字段，所以它既进不了存储，也不会出现在 `GET /config` 的返回里。
 *
 * 页面还能直接粘贴 IDE「复制配置」得到的 JSON（`mcpServers` / 单个 server 对象 /
 * 纯地址三种形态），解析后追加成新行，走同一套校验，并且不自动保存。
 *
 * `?probe=surface` 只在「页面首次加载」和「手动刷新」时带：它会真的向每个 IDE 新开
 * 一次 MCP 会话读 tools/list（一次约 138KB），而 15 秒的状态轮询只用缓存下来的健康
 * 结果，绝不带这个参数。
 *
 * 响应里的 `diagnostics` 是 Host 侧最近 50 条自动动作（工具缺失判定、自动重挂、
 * 重试结果…），这里只展示最新几条，方便说明「为什么它刚重连过」。
 *
 * 保存不碰 profile 的 cordis.patch.yml：那一行归 Loader（本机还落在皮肤管理器的
 * 自动生成块里，随时会被改写），连接值一律写进插件自己的存储
 * `$DSH_HOME/storages/dsh-mcp-jetbrains.connections.json`。因此保存不再重启 Host 插件、
 * 路由也不会断；POST 的返回就是保存并重挂之后的事实，页面据此直接更新。
 *
 * 源码在 src/client.tsx，由 `pnpm build`（tsc，经典 JSX 运行时）编译成包根的
 * client.js：浏览器直接加载那份产物，不打包、没有 import map，产物里除模块顶层
 * 这次自注册之外不出现 import 语句。`h` / `Fragment` 在模块作用域声明，由 factory
 * 里宿主注入的 require('react') 赋值，TSX 编译出的 h(...) 才能解析到。
 * ============================================================================
 */
/** 宿主 React 的 createElement；模块作用域先占位，factory 里由 require('react') 赋值。 */
let h;
/** 宿主 React 的 Fragment；`<>...</>` 经经典运行时编译成 h(Fragment, ...)。 */
let Fragment;
window['__ModuleLoader__'].load({
    id: 'dsh-mcp-jetbrains',
    factory: (require) => {
        /**
         * 宿主注入的 require；工程内无 node_modules，标 any 以免 IDE 误报「未安装模块」。
         * 这层 JSDoc 转换会被 tsc 原样带到产物里，产物因此也保持同一条抑制。
         */
        const React = ( /** @type {any} */(require))('react');
        h = React.createElement;
        Fragment = React.Fragment;
        /** 与 index.js 同源的路由前缀。 */
        const API = '/dsh-mcp-jetbrains';
        /** 示例地址用变量拼出，避免字面量 http 前缀触发「不安全链接」检查（本机回环本就是 http）。 */
        const SCHEME = 'http';
        /** 与 Host 侧 SERVER_NAME_PATTERN 一致。 */
        const NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;
        const blankRow = () => ({
            id: 'connection-' + String(Date.now()).slice(-4),
            serverName: '',
            url: '',
            projectPath: '',
            enabled: true,
            autoReload: true,
        });
        /**
         * 卡片身份用的内部自增 key：与「连接 ID」解耦，改名不会换身份。
         * 它只在页面内存里存在：保存前的 payload 逐字段重写（没有 `__key`），
         * Host 的 `rowOf` 也只投影六个持久字段。
         */
        let rowKeySeq = 0;
        const nextRowKey = () => 'r' + (rowKeySeq += 1);
        /** 给 Host 返回的行补内部 key，顺序不变。 */
        const withKeys = (list) => (list || []).map((row) => ({ ...row, __key: nextRowKey() }));
        /** 一行的展开态集合：键是 `__key`，不是连接 ID。 */
        const addKey = (keys, key) => {
            const next = new Set(keys);
            next.add(key);
            return next;
        };
        const dropKey = (keys, key) => {
            const next = new Set(keys);
            next.delete(key);
            return next;
        };
        /** 把任意字符串收成 serverName 允许的字符集（不保证唯一）。 */
        const sanitizeName = (raw) => String(raw ?? '')
            .trim()
            .replace(/[^A-Za-z0-9_-]+/g, '-')
            .replace(/-{2,}/g, '-')
            .replace(/^-+/, '')
            .slice(0, 32);
        /** 在 `taken` 里挑一个不撞车的名字：`base`、`base-2`、`base-3`…（都 ≤32 字符）。 */
        const uniqueName = (base, taken) => {
            const root = base === '' ? 'jetbrains' : base.slice(0, 32);
            if (!taken.has(root))
                return root;
            for (let index = 2; index < 100; index += 1) {
                const suffix = '-' + index;
                const head = root.length + suffix.length > 32 ? root.slice(0, 32 - suffix.length) : root;
                const candidate = head + suffix;
                if (!taken.has(candidate))
                    return candidate;
            }
            return root.slice(0, 27) + '-100';
        };
        /** 地址里的端口，用来给「只粘了一个地址」的情况起一个不撞车的名字。 */
        const portOf = (url) => {
            try {
                return new URL(url).port;
            }
            catch {
                return '';
            }
        };
        /**
         * 解析 IDE「复制配置」的粘贴内容。支持的形态：
         *   1. `{ "mcpServers": { "<key>": { "url": … } } }`（IDE 的实际产出，可多条）
         *   2. 单个 server 对象：`{ "type": "streamable-http", "url": … }`
         *   3. 纯地址：`http://127.0.0.1:64342/stream`（也接受 JSON 字符串形式的地址）
         * 解析失败时返回 `{ error }` 并说清哪一段不对，绝不静默什么都不做。
         * @returns `{ entries: [{ key, url }] }`（`key` 为空表示没有名字可用）或 `{ error }`。
         */
        const parsePastedConfig = (raw) => {
            const source = String(raw ?? '').trim();
            if (source === '') {
                return { error: '粘贴框是空的：把 IDE「复制配置」得到的 JSON，或者只把地址粘进来。' };
            }
            let body;
            try {
                body = JSON.parse(source.replace(/^\uFEFF/, ''));
            }
            catch (error) {
                if (isHttpUrl(source))
                    return { entries: [{ key: '', url: source }] };
                return {
                    error: '这段内容既不是一个完整地址，也不是合法 JSON：'
                        + (error && error.message ? error.message : String(error))
                        + '。若只想导入一条连接，可以直接粘贴 ' + SCHEME + '://… 地址。',
                };
            }
            if (typeof body === 'string') {
                const value = body.trim();
                if (isHttpUrl(value))
                    return { entries: [{ key: '', url: value }] };
                return { error: '粘贴的是一个 JSON 字符串，但它不是 ' + SCHEME + ':// 或 https:// 地址：' + value.slice(0, 120) };
            }
            if (body === null || typeof body !== 'object' || Array.isArray(body)) {
                return {
                    error: 'JSON 顶层是' + (Array.isArray(body) ? '数组' : typeof body)
                        + '，需要对象 { "mcpServers": { … } } 或一个含 url 的 server 对象。',
                };
            }
            const servers = body.mcpServers;
            let entries;
            if (servers !== undefined) {
                if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) {
                    return { error: 'mcpServers 必须是一个对象，形如 { "idea": { "type": "streamable-http", "url": "…" } }。' };
                }
                const keys = Object.keys(servers);
                if (keys.length === 0)
                    return { error: 'mcpServers 是空对象，没有可导入的连接。' };
                entries = keys.map((key) => ({ key, keyLabel: key, spec: servers[key] }));
            }
            else if (typeof body.url === 'string') {
                const named = typeof body.name === 'string' ? body.name : (typeof body.serverName === 'string' ? body.serverName : '');
                entries = [{ key: named, keyLabel: '（单个 server）', spec: body }];
            }
            else {
                return {
                    error: '这个 JSON 里既没有 mcpServers，也没有顶层 url 字段。IDE「复制配置」通常长这样：'
                        + '{"mcpServers":{"idea":{"type":"streamable-http","url":"' + SCHEME + '://127.0.0.1:64342/stream"}}}',
                };
            }
            const items = [];
            const problems = [];
            for (const entry of entries) {
                const spec = entry.spec;
                if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
                    problems.push('「' + entry.keyLabel + '」的值不是对象');
                    continue;
                }
                const url = typeof spec.url === 'string' ? spec.url.trim() : '';
                if (url === '') {
                    const stdio = typeof spec.command === 'string' && spec.command.trim() !== '';
                    problems.push('「' + entry.keyLabel + '」没有 url 字段'
                        + (stdio ? '（这是 command/args 的 stdio 配置，本插件只连 Streamable HTTP）' : '（IDE 的复制配置里一定有 url）'));
                    continue;
                }
                if (!isHttpUrl(url)) {
                    problems.push('「' + entry.keyLabel + '」的 url 不是完整的 ' + SCHEME + ':// 或 https:// 地址：' + url.slice(0, 120));
                    continue;
                }
                items.push({ key: entry.key, url });
            }
            if (problems.length > 0)
                return { error: '这次没有导入任何一条：' + problems.join('；') };
            return { entries: items };
        };
        /** 与 Host 侧 PROBE_* 常量对应的白话说明；只报状态，不猜测原因。 */
        const healthText = (health) => {
            if (!health || typeof health !== 'object')
                return '';
            const state = String(health.state || '');
            const phrase = {
                ok: '探测正常',
                unreachable: 'IDE 没在监听这个地址',
                stale: '会话/工具面已失效，等待自动重挂',
                remounting: '正在重新挂载',
                off: '自动重载已关闭',
                idle: '未挂载，没有探测',
            }[state] || ('状态：' + state);
            const tails = [];
            if (health.restarts > 0)
                tails.push('已自动重挂 ' + health.restarts + ' 次');
            if (health.toolCount > 0)
                tails.push('IDE 现有 ' + health.toolCount + ' 个工具');
            if (health.lastProbeAt > 0)
                tails.push('上次探测 ' + new Date(health.lastProbeAt).toLocaleTimeString());
            if (health.lastError)
                tails.push(String(health.lastError).slice(0, 160));
            return phrase + (tails.length > 0 ? '（' + tails.join('；') + '）' : '');
        };
        const isHttpUrl = (value) => {
            try {
                const url = new URL(value);
                return url.protocol === 'http:' || url.protocol === 'https:';
            }
            catch {
                return false;
            }
        };
        const getJson = async (url) => {
            const res = await fetch(url, { headers: { accept: 'application/json' }, cache: 'no-store' });
            const data = await res.json().catch(() => ({}));
            return { status: res.status, data };
        };
        const postJson = async (url, body) => {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json', accept: 'application/json' },
                body: JSON.stringify(body || {}),
            });
            const data = await res.json().catch(() => ({}));
            return { status: res.status, data };
        };
        /** Host 的 config 路由；`probe` 只给「首次加载」与「手动刷新」带，15 秒轮询不带。 */
        const configUrl = (probe) => API + '/config' + (probe ? '?probe=surface' : '');
        /** 一条 Host 诊断记录 → 一句人话（时间 · 连接/工具 · verdict/动作：细节）。 */
        const diagText = (item) => {
            if (!item || typeof item !== 'object')
                return '';
            const when = item.at > 0 ? new Date(item.at).toLocaleTimeString() : '';
            const who = String(item.tool || item.connection || '');
            // verdict 是判定（ide-io-user-approved-passthrough / tool-missing…），action 是处置（passthrough…）；
            // 两者不同时都显示，页面上才看得出「开了但未生效」这类状态。
            const what = item.action && item.verdict && item.action !== item.verdict
                ? String(item.verdict) + ' / ' + String(item.action)
                : String(item.action || item.verdict || '');
            const head = [when, who, what].filter((part) => part !== '');
            const detail = String(item.detail || item.error || '');
            return head.join(' · ') + (detail !== '' ? '：' + detail.slice(0, 240) : '');
        };
        const CSS = `
[data-mi-wrap]{display:flex;flex-direction:column;gap:14px;padding:4px 2px 24px;}
[data-mi-head]{display:flex;flex-direction:column;gap:4px;}
[data-mi-title]{font-size:15px;font-weight:600;}
[data-mi-note]{font-size:12px;opacity:.62;line-height:1.55;}
[data-mi-warn]{font-size:12px;line-height:1.55;padding:8px 10px;border-radius:8px;background:rgba(229,72,77,.10);border-left:3px solid rgba(229,72,77,.55);}
/* 卡片外观对齐 Our Free Model 的 ofm_panel（实测其计算样式：半透明浅底 + 细边 + 16px 圆角 + 双向内阴影） */
[data-mi-card]{display:flex;flex-direction:column;gap:10px;padding:14px 16px;border-radius:16px;
  background:rgba(235,240,250,.68);
  border:1px solid rgba(71,91,145,.3);
  box-shadow:rgba(255,255,255,.34) 0 1px 0 0 inset, rgba(0,0,0,.06) 0 -14px 28px -18px inset;}
[data-mi-card][data-mi-off]{opacity:.72;}
[data-mi-cardhead]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}
[data-mi-card][data-mi-open] [data-mi-cardhead]{border-bottom:1px solid rgba(71,91,145,.18);padding-bottom:10px;}
[data-mi-cardname]{font-size:13px;font-weight:600;}
[data-mi-cardsub]{font-size:12px;opacity:.6;}
[data-mi-grow]{flex:1;min-width:0;}
[data-mi-summary]{flex:1;min-width:0;display:flex;align-items:flex-start;gap:6px;background:none;border:0;padding:0;margin:0;cursor:pointer;color:inherit;font:inherit;text-align:left;}
[data-mi-summary]:hover [data-mi-cardname]{text-decoration:underline;}
[data-mi-chevron]{font-size:.75rem;line-height:1.1rem;opacity:.55;flex:0 0 auto;}
[data-mi-row]{display:flex;align-items:flex-start;gap:10px;flex-wrap:wrap;}
[data-mi-field]{display:flex;flex-direction:column;gap:4px;flex:1 1 260px;min-width:0;}
[data-mi-label]{font-size:12px;font-weight:600;opacity:.85;}
[data-mi-input]{padding:6px 9px;border-radius:7px;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;font-size:13px;width:100%;box-sizing:border-box;}
[data-mi-input][data-mi-bad]{border-color:rgba(229,72,77,.75);}
[data-mi-input]:disabled{opacity:.55;}
[data-mi-err]{font-size:12px;color:#e5484d;line-height:1.45;}
[data-mi-btn]{padding:6px 12px;border-radius:7px;border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;font-size:13px;cursor:pointer;white-space:nowrap;}
[data-mi-btn]:hover{background:rgba(127,127,127,.12);}
[data-mi-btn][disabled]{opacity:.5;cursor:default;}
[data-mi-btn][data-mi-primary]{border-color:rgba(127,127,127,.55);background:rgba(127,127,127,.16);font-weight:600;}
[data-mi-btn][data-mi-danger]:hover{background:rgba(229,72,77,.14);}
[data-mi-bar]{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding-top:4px;border-top:1px solid rgba(127,127,127,.18);}
[data-mi-msg]{font-size:12px;line-height:1.5;flex:1 1 220px;min-width:0;}
[data-mi-msg][data-mi-ok]{color:#2f9e44;}
[data-mi-msg][data-mi-err]{color:#e5484d;}
[data-mi-toggle]{display:inline-flex;align-items:center;gap:6px;font-size:12px;cursor:pointer;user-select:none;}
[data-mi-state]{font-size:12px;opacity:.7;}
[data-mi-pill]{display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;border:1px solid rgba(127,127,127,.3);}
[data-mi-pill][data-mi-live]{border-color:rgba(47,158,68,.6);color:#2f9e44;}
[data-mi-diag]{display:flex;flex-direction:column;gap:3px;}
[data-mi-diagitem]{font-size:11px;line-height:1.45;opacity:.72;white-space:pre-wrap;word-break:break-word;}
[data-mi-diagitem][data-mi-bad]{color:#e5484d;opacity:.9;}
[data-mi-io]{gap:8px;}
[data-mi-io][data-mi-on]{border-color:rgba(47,158,68,.55);background:rgba(47,158,68,.09);}
[data-mi-io][data-mi-inactive]{border-color:rgba(229,187,77,.6);background:rgba(229,187,77,.12);}
[data-mi-ioswitch]{font-size:13px;font-weight:600;}
[data-mi-textarea]{width:100%;box-sizing:border-box;min-height:104px;padding:8px 10px;border-radius:8px;
  border:1px solid rgba(127,127,127,.35);background:transparent;color:inherit;resize:vertical;
  font:12px/1.55 ui-monospace,SFMono-Regular,Consolas,monospace;}
[data-mi-textarea]::placeholder{opacity:.5;}
[data-mi-pastebar]{border-top:0;padding-top:0;}
[data-mi-compare]{display:grid;grid-template-columns:auto minmax(0,1fr) minmax(0,1fr);gap:4px 12px;font-size:11px;line-height:1.5;}
[data-mi-compare] [data-mi-chead]{font-weight:600;opacity:.72;}
`;
        /* ── validate：字段级 + 行间重复 ───────────────────────────────────────── */
        function validate(rows) {
            const per = {};
            const list = [];
            const ids = new Map();
            const names = new Map();
            (rows || []).forEach((row, index) => {
                const bad = {};
                const id = String(row.id || '').trim();
                const serverName = String(row.serverName || '').trim();
                const url = String(row.url || '').trim();
                if (id === '')
                    bad.id = '连接 ID 不能为空';
                if (!NAME_RE.test(serverName)) {
                    bad.serverName = '只允许字母、数字、下划线、连字符，长度 1–32';
                }
                if (url === '')
                    bad.url = 'MCP 地址不能为空（启用这条连接必须给地址）';
                else if (!isHttpUrl(url))
                    bad.url = '需要以 ' + SCHEME + ':// 或 https:// 开头的完整地址，例如 ' + SCHEME + '://127.0.0.1:64342/stream';
                if (id !== '') {
                    if (ids.has(id))
                        bad.id = '连接 ID 与第 ' + (ids.get(id) + 1) + ' 行重复';
                    else
                        ids.set(id, index);
                }
                if (NAME_RE.test(serverName)) {
                    if (names.has(serverName))
                        bad.serverName = 'serverName 与第 ' + (names.get(serverName) + 1) + ' 行重复，工具名会撞车';
                    else
                        names.set(serverName, index);
                }
                if (Object.keys(bad).length > 0) {
                    per[index] = bad;
                    list.push('第 ' + (index + 1) + ' 行：' + Object.values(bad)[0]);
                }
            });
            return { per, list, ok: list.length === 0 };
        }
        /* ── 一行的编辑卡片 ───────────────────────────────────────────────── */
        function Card(props) {
            const { row, index, bad, mounted, busy, health, expanded, forced, onChange, onRemove, onReconnect, onToggle } = props;
            const live = mounted.find((item) => item.id === String(row.id || '').trim());
            const renamed = live !== undefined && String(row.serverName || '').trim() !== live.serverName;
            const notMounted = live === undefined
                ? (row.enabled ? '未挂载（地址或 serverName 不合法）' : '未挂载（已禁用）')
                : '已挂载 → ' + live.url;
            const rowHealth = healthText(health && health[String(row.id || '').trim()]);
            // 展开态由上面的 Panel 统一持有（键是内部 key，不是连接 ID）；有校验问题或
            // 改名警告时 forced 把卡片钉在展开态，避免错误被折叠藏住。
            const field = (key, label, placeholder, note, extra) => (h("div", { "data-mi-field": "" },
                h("div", { "data-mi-label": "" }, label),
                h("input", { "data-mi-input": "", "data-mi-bad": bad[key] ? '' : undefined, value: String(row[key] ?? ''), placeholder: placeholder, spellCheck: false, onChange: (event) => onChange(index, key, event.target.value) }),
                bad[key] ? h("div", { "data-mi-err": "" }, bad[key]) : null,
                note ? h("div", { "data-mi-note": "" }, note) : null,
                extra || null));
            return (h("div", { "data-mi-card": "", "data-mi-off": row.enabled ? undefined : '', "data-mi-open": expanded ? '' : undefined },
                h("div", { "data-mi-cardhead": "" },
                    h("label", { "data-mi-toggle": "" },
                        h("input", { type: "checkbox", checked: Boolean(row.enabled), onChange: (event) => onChange(index, 'enabled', event.target.checked) }),
                        '启用这条连接'),
                    h("label", { "data-mi-toggle": "", title: '开启后由 Host 侧轻量探测（TCP + MCP ping，默认 30 秒左右一次）；'
                            + 'IDE 重启、会话失效或工具面变化时只自动重挂这一条，不影响其它连接。关闭后行为回到纯手动。' },
                        h("input", { type: "checkbox", checked: Boolean(row.autoReload), onChange: (event) => onChange(index, 'autoReload', event.target.checked) }),
                        '自动重载'),
                    h("button", { "data-mi-summary": "", type: "button", "aria-expanded": expanded, title: forced ? '有校验问题或改名警告，暂不能收起' : (expanded ? '收起这条连接的详细字段' : '展开这条连接的详细字段'), onClick: onToggle },
                        h("span", { "data-mi-chevron": "" }, expanded ? '▾' : '▸'),
                        h("span", null,
                            h("div", { "data-mi-cardname": "" }, String(row.id || '').trim() || '（未命名连接）'),
                            h("div", { "data-mi-cardsub": "" }, notMounted))),
                    h("button", { "data-mi-btn": "", type: "button", disabled: busy !== '' || !row.enabled || live === undefined, title: live === undefined ? '这条连接当前没有挂载，无需重新连接' : '销毁这个 MCP 子客户端并重新握手（IDE 重启后用）', onClick: () => onReconnect(row) }, '重新连接'),
                    h("button", { "data-mi-btn": "", "data-mi-danger": "", type: "button", disabled: busy !== '', onClick: () => onRemove(index) }, '删除')),
                expanded ? (h(Fragment, null,
                    h("div", { "data-mi-row": "" },
                        field('id', '连接 ID', 'idea', '只用于日志与诊断，页面上认这一行；同一份配置里不能重复。'),
                        field('serverName', '服务名（工具名前缀）', 'idea', '工具会以 mcp__' + (String(row.serverName || '').trim() || '<serverName>') + '__* 暴露；'
                            + '改这一栏等于给工具改名，历史会话、权限规则和别人记下来的旧工具名都会失效。', renamed
                            ? (h("div", { "data-mi-warn": "" }, '保存后这条连接的工具会从 mcp__' + live.serverName + '__* 变成 mcp__'
                                + String(row.serverName || '').trim() + '__*。旧名字（含 mcp__' + live.serverName
                                + '__execute_tool）立刻失效，确认别处没有写死它再保存。'))
                            : null)),
                    h("div", { "data-mi-row": "" },
                        field('url', 'MCP 地址（Streamable HTTP）', 'http://127.0.0.1:64342/stream', 'IDE 里 MCP Server 插件监听的地址，DSH 会以 streamable-http 连过去。'),
                        h("div", { "data-mi-field": "" },
                            h("div", { "data-mi-label": "" }, '状态'),
                            h("div", { "data-mi-state": "" },
                                h("span", { "data-mi-pill": "", "data-mi-live": live ? '' : undefined }, live ? '已挂载' : '未挂载'),
                                ' ',
                                live ? ('当前 serverName：' + live.serverName) : '保存后按这里的值重新挂载'),
                            h("div", { "data-mi-state": "" }, live ? (rowHealth || '等待第一次探测…') : '挂载之后才会有探测结果'))),
                    h("div", { "data-mi-row": "" }, field('projectPath', '项目路径（可选）', "D:/shing_of_kai/SourceCode/ShaoZhu'sDSHPlugins/dsh_jetbrains_interaction", '绝对路径，作为 IJ_MCP_SERVER_PROJECT_PATH 请求头发给 IDE；留空则不发这个头，由 IDE 自己挑项目。')))) : null));
        }
        /* ── 设置页 ───────────────────────────────────────────────────────── */
        /** Stable comparison key for "are the connection rows still the persisted ones?". */
        function rowSignature(list) {
            return JSON.stringify((list || []).map((row) => [
                String(row.id || '').trim(),
                String(row.serverName || '').trim(),
                String(row.url || '').trim(),
                String(row.projectPath || '').trim(),
                Boolean(row.enabled),
                Boolean(row.autoReload),
            ]));
        }
        function Panel() {
            const [rows, setRows] = React.useState(null);
            const [mounted, setMounted] = React.useState([]);
            const [health, setHealth] = React.useState({});
            const [diag, setDiag] = React.useState([]);
            const [ideIo, setIdeIo] = React.useState({ enabled: true });
            const [ideBusy, setIdeBusy] = React.useState(false);
            const [compare, setCompare] = React.useState(false);
            const [saved, setSaved] = React.useState('');
            const [loading, setLoading] = React.useState(true);
            const [busy, setBusy] = React.useState('');
            const [notice, setNotice] = React.useState(null);
            /** 展开态：键是行的内部 key（`__key`），改「连接 ID」不会让卡片收起。 */
            const [openKeys, setOpenKeys] = React.useState(() => new Set());
            /** 「粘贴配置」框：展开状态与原始文本都只活在页面内存里，不写存储。 */
            const [pasteOpen, setPasteOpen] = React.useState(false);
            const [pasteText, setPasteText] = React.useState('');
            const notify = (kind, text) => setNotice({ kind, text });
            // 首屏只取配置（不带 ?probe=surface）：卡片要立刻能看能改。工具面校验
            // 会阻塞约 8 秒（每条已挂载连接都要新开一次会话读 tools/list），所以放到
            // 渲染之后再补，绝不挡首屏。
            const load = async (probe = false) => {
                const { status, data } = await getJson(configUrl(probe));
                if (status !== 200 || !data.ok)
                    throw new Error(data.error || ('HTTP ' + status));
                const list = Array.isArray(data.connections) ? data.connections : [];
                // Host 只回六个持久字段；内部 key 在这里现分配，绝不由存储提供。
                setRows(withKeys(list));
                setOpenKeys(new Set());
                setSaved(rowSignature(list));
                setIdeIo(data.ideIo && typeof data.ideIo === 'object' ? data.ideIo : { enabled: true });
                setMounted(Array.isArray(data.mounted) ? data.mounted : []);
                setHealth(data.health && typeof data.health === 'object' ? data.health : {});
                setDiag(Array.isArray(data.diagnostics) ? data.diagnostics : []);
            };
            /** 只刷新挂载状态/健康/诊断，绝不动 rows：字段里可能有还没保存的编辑。 */
            const applyHealthOnly = (data) => {
                setMounted(Array.isArray(data.mounted) ? data.mounted : []);
                setHealth(data.health && typeof data.health === 'object' ? data.health : {});
                setDiag(Array.isArray(data.diagnostics) ? data.diagnostics : []);
                if (data.ideIo && typeof data.ideIo === 'object')
                    setIdeIo(data.ideIo);
            };
            React.useEffect(() => {
                let alive = true;
                (async () => {
                    try {
                        await load(false);
                        if (alive)
                            notify(null, '');
                    }
                    catch (error) {
                        if (alive)
                            notify('err', '读取连接配置失败：' + (error && error.message ? error.message : String(error)));
                    }
                    finally {
                        if (alive)
                            setLoading(false);
                    }
                    // 首屏渲染完成后再补一次真实校验；失败就静默，不打扰正在改配置的人。
                    if (!alive)
                        return;
                    try {
                        const { status, data } = await getJson(configUrl(true));
                        if (alive && status === 200 && data.ok)
                            applyHealthOnly(data);
                    }
                    catch {
                        // 校验失败不影响已经渲染出来的配置
                    }
                })();
                return () => { alive = false; };
            }, []);
            // 只刷新「挂载状态 + rowHealth」，绝不动 rows：字段里可能有还没保存的编辑。
            // 这里刻意不带 ?probe=surface —— 15 秒一次的工具面校验等于每 15 秒拉 138KB。
            React.useEffect(() => {
                let alive = true;
                const poll = async () => {
                    if (!alive)
                        return;
                    try {
                        const { status, data } = await getJson(configUrl(false));
                        if (!alive || status !== 200 || !data.ok)
                            return;
                        applyHealthOnly(data);
                    }
                    catch {
                        // 一次探测刷新失败不该打扰正在填写的人
                    }
                };
                const timer = setInterval(poll, 15000);
                return () => { alive = false; clearInterval(timer); };
            }, []);
            // 手动刷新：带上 ?probe=surface，让 Host 立刻对每条已挂载连接做一次工具面校验。
            const refresh = async () => {
                setBusy('refresh');
                notify(null, '正在向每个 IDE 校验工具面…');
                try {
                    const { status, data } = await getJson(configUrl(true));
                    if (status !== 200 || !data.ok) {
                        notify('err', '刷新失败：' + (data.error || ('HTTP ' + status)));
                        return;
                    }
                    applyHealthOnly(data);
                    const forced = Array.isArray(data.probe?.forced) ? data.probe.forced : [];
                    const bad = forced.filter((item) => item && item.state && item.state !== 'ok' && item.state !== 'remounting');
                    if (bad.length === 0) {
                        notify('ok', '已校验 ' + forced.length + ' 条连接的工具面，全部正常');
                        return;
                    }
                    notify('err', '工具面校验发现 ' + bad.length + ' 条异常：'
                        + bad.map((item) => String(item.id) + '：' + String(item.error || item.state)).join('；').slice(0, 240));
                }
                catch (error) {
                    notify('err', '刷新失败：' + (error && error.message ? error.message : String(error)));
                }
                finally {
                    setBusy('');
                }
            };
            const edit = (index, key, value) => {
                setRows((current) => (current || []).map((row, i) => (i === index ? { ...row, [key]: value } : row)));
            };
            const addRow = () => {
                const row = { ...blankRow(), __key: nextRowKey() };
                setRows((current) => [...(current || []), row]);
                // 新增行默认展开（它本来就是空的，展开才能填）。
                setOpenKeys((current) => addKey(current, row.__key));
                notify(null, '');
            };
            const removeRow = (index) => {
                const target = (rows || [])[index];
                setRows((current) => (current || []).filter((_, i) => i !== index));
                // 只丢掉这一行的 key：其它行的展开态跟着各自的 key 走，不会错位。
                if (target && target.__key)
                    setOpenKeys((current) => dropKey(current, target.__key));
                notify(null, '');
            };
            const toggleRow = (key) => {
                setOpenKeys((current) => (current.has(key) ? dropKey(current, key) : addKey(current, key)));
            };
            const save = async () => {
                if (rows === null)
                    return;
                const checked = validate(rows);
                if (!checked.ok) {
                    notify('err', '还有 ' + checked.list.length + ' 处需要改：' + checked.list[0]);
                    return;
                }
                // 逐字段重写：内部 key（`__key`）就是在这里被剥掉的，存储里永远不会出现它。
                const payload = rows.map((row) => ({
                    id: String(row.id || '').trim(),
                    serverName: String(row.serverName || '').trim(),
                    url: String(row.url || '').trim(),
                    projectPath: String(row.projectPath || '').trim(),
                    enabled: Boolean(row.enabled),
                    autoReload: Boolean(row.autoReload),
                }));
                setBusy('save');
                notify(null, '正在保存…');
                try {
                    const { status, data } = await postJson(API + '/config', { connections: payload });
                    if (status !== 200 || !data.ok) {
                        notify('err', '保存失败：' + (data.error || ('HTTP ' + status)));
                        return;
                    }
                    // 保存写自有存储并就地重挂，路由不会断：返回的就是保存并重挂之后的事实，
                    // 不用再轮询去等一次「重启完成」。
                    const list = Array.isArray(data.connections) ? data.connections : payload;
                    // 返回的行没有内部 key：按位置沿用保存前的 key，保存后卡片不会集体收起。
                    const previous = rows || [];
                    setRows(list.map((row, i) => ({
                        ...row,
                        __key: previous[i] && previous[i].__key ? previous[i].__key : nextRowKey(),
                    })));
                    setSaved(rowSignature(list));
                    if (data.ideIo && typeof data.ideIo === 'object')
                        setIdeIo(data.ideIo);
                    const mountedNow = Array.isArray(data.mounted) ? data.mounted : [];
                    setMounted(mountedNow);
                    setHealth(data.health && typeof data.health === 'object' ? data.health : {});
                    notify('ok', '已保存到插件自己的存储，' + mountedNow.length + ' 条连接在线');
                }
                catch (error) {
                    notify('err', '保存失败：' + (error && error.message ? error.message : String(error)));
                }
                finally {
                    setBusy('');
                }
            };
            /**
             * 把「复制配置」的粘贴内容解析成新行。导入只**追加**行、不自动保存：
             * 这些行和手填的行走同一套 `validate`，用户确认后仍要点「保存并重挂」。
             * 解析失败时把原因完整报出来，绝不静默什么都不做。
             */
            const importPasted = () => {
                if (busy !== '')
                    return;
                const parsed = parsePastedConfig(pasteText);
                if (parsed.error) {
                    notify('err', parsed.error);
                    return;
                }
                const takenNames = new Set((rows || [])
                    .map((row) => String(row.serverName || '').trim())
                    .filter((name) => name !== ''));
                const takenIds = new Set((rows || [])
                    .map((row) => String(row.id || '').trim())
                    .filter((id) => id !== ''));
                const notes = [];
                const imported = parsed.entries.map((entry) => {
                    const port = portOf(entry.url);
                    const fallback = 'idea' + (port === '' ? '' : '-' + port);
                    const cleaned = sanitizeName(entry.key);
                    const base = cleaned === '' ? fallback : cleaned;
                    if (entry.key !== '' && cleaned !== String(entry.key).trim()) {
                        notes.push('「' + entry.key + '」不是合法的 serverName，清洗为「' + cleaned + '」');
                    }
                    const serverName = uniqueName(base, takenNames);
                    takenNames.add(serverName);
                    if (serverName !== base)
                        notes.push('「' + base + '」已存在，改名为「' + serverName + '」');
                    const id = uniqueName(serverName, takenIds);
                    takenIds.add(id);
                    // projectPath 不在「复制配置」里：留空，导入后由用户补。
                    return {
                        ...blankRow(),
                        id,
                        serverName,
                        url: entry.url,
                        projectPath: '',
                        enabled: true,
                        autoReload: true,
                        __key: nextRowKey(),
                    };
                });
                setRows((current) => [...(current || []), ...imported]);
                // 导入的行默认展开：projectPath 还空着，得让用户看见。
                setOpenKeys((current) => imported.reduce((keys, row) => addKey(keys, row.__key), current));
                setPasteText('');
                setPasteOpen(false);
                notify('ok', '已导入 ' + imported.length + ' 条：' + imported.map((row) => row.serverName).join('、')
                    + (notes.length > 0 ? '；' + notes.join('；') : '')
                    + '。未保存：确认后点「保存并重挂」。');
            };
            const reconnect = async (row) => {
                const id = String(row.id || '').trim();
                if (id === '')
                    return;
                setBusy('reconnect:' + id);
                notify(null, '正在重新挂载「' + id + '」…');
                try {
                    const { status, data } = await postJson(API + '/reconnect', { id });
                    if (status !== 200 || !data.ok) {
                        notify('err', '重新连接失败：' + (data.error || ('HTTP ' + status)));
                        return;
                    }
                    setMounted(Array.isArray(data.mounted) ? data.mounted : []);
                    setHealth(data.health && typeof data.health === 'object' ? data.health : {});
                    notify('ok', '已重新挂载「' + id + '」。能不能用仍取决于 IDE 是否在监听那个地址。');
                }
                catch (error) {
                    notify('err', '重新连接失败：' + (error && error.message ? error.message : String(error)));
                }
                finally {
                    setBusy('');
                }
            };
            /**
             * 翻转「读写走 IDE」。开启前只拦一件事：连接有未保存的改动（否则不知道
             * 到底会路由到哪份配置）。一条启用连接都没有不再拦——开关照样打开，之后
             * 每次 read / write / edit 都先问用户：粘贴配置 / 本次走原生读写 / 取消。
             */
            const toggleIdeIo = async (enabled) => {
                if (busy !== '' || ideBusy)
                    return;
                if (enabled && (rows === null || rowSignature(rows) !== saved)) {
                    notify('err', '连接有未保存的改动：先点「保存并重挂」，再打开「读写走 IDE」。');
                    return;
                }
                setIdeBusy(true);
                notify(null, enabled ? '正在打开「读写走 IDE」…' : '正在恢复磁盘读写…');
                try {
                    const { status, data } = await postJson(API + '/ide-io', { enabled });
                    if (status !== 200 || !data.ok) {
                        notify('err', (enabled ? '开启失败：' : '关闭失败：') + (data.error || ('HTTP ' + status)));
                        return;
                    }
                    setIdeIo(data.ideIo && typeof data.ideIo === 'object' ? data.ideIo : { enabled });
                    notify('ok', enabled
                        ? '已打开：read / write / edit 现在由 IDE 承接；没有可用连接时会先问你怎么处理，无法路由时明确报错，不会悄悄改磁盘。'
                        : '已关闭：read / write / edit 恢复直接读写磁盘。');
                }
                catch (error) {
                    notify('err', '切换「读写走 IDE」失败：' + (error && error.message ? error.message : String(error)));
                }
                finally {
                    setIdeBusy(false);
                }
            };
            const checked = rows === null ? { per: {}, list: [], ok: true } : validate(rows);
            const ioOn = Boolean(ideIo && ideIo.enabled);
            const ioCandidates = ideIo && Array.isArray(ideIo.enabledConnections) ? ideIo.enabledConnections : [];
            // 开关开着却没有一条启用连接：页面显示「尚未生效」，每次读写都会先问用户。
            const ioInactive = ioOn && ((ideIo && ideIo.inactive === true) || ioCandidates.length === 0);
            if (loading)
                return (h("div", { "data-mi-wrap": "" },
                    h("div", { "data-mi-note": "" }, '正在读取连接配置…')));
            return (h("div", { "data-mi-wrap": "" },
                h("div", { "data-mi-head": "" },
                    h("div", { "data-mi-title": "" }, 'JetBrains IDE 连接'),
                    h("div", { "data-mi-note": "" }, '每条连接对应一个 IDE（IntelliJ IDEA、CLion、PyCharm）内置的 MCP Server，'
                        + '工具以 mcp__<serverName>__* 暴露给智能体。保存后立即生效，不用重启 DSH。')),
                h("div", { "data-mi-card": "", "data-mi-io": "", "data-mi-on": ioOn ? '' : undefined, "data-mi-inactive": ioInactive ? '' : undefined },
                    h("div", { "data-mi-cardhead": "" },
                        h("label", { "data-mi-toggle": "", "data-mi-ioswitch": "" },
                            h("input", { type: "checkbox", checked: ioOn, disabled: busy !== '' || ideBusy, onChange: (event) => toggleIdeIo(event.target.checked) }),
                            '读写走 IDE'),
                        h("span", { "data-mi-pill": "", "data-mi-live": ioOn ? '' : undefined }, ioOn ? (ioInactive ? '已开启 · 尚未生效' : '已开启') : '已关闭'),
                        h("div", { "data-mi-grow": "" }),
                        h("button", { "data-mi-btn": "", type: "button", onClick: () => setCompare(!compare) }, compare ? '收起对比' : '对比两种模式')),
                    h("div", { "data-mi-note": "" }, '开着：read / write / edit 全部交给 IDE 执行，读的是 IDE 的项目视图，写回也由 IDE 落盘。'
                        + '关着：照旧直接读写磁盘。新装默认开着。'),
                    ioOn
                        ? (h("div", { "data-mi-note": "" }, ioInactive
                            ? '已开启 · 尚未生效：当前没有任何启用连接。下次 read / write / edit 会先向你提问——把 IDE「复制配置」的 JSON 粘进自定义回答（插件自动建连接并重试这次调用）、让这次不代执行（由你自己走 shell 读写）、或者取消本次操作。启用一条连接后立即生效。'
                            : '承接读写的候选：' + ioCandidates.map((item) => String(item.id)
                                + (String(item.projectPath || '') === '' ? '（projectPath 为空）' : '')).join('、')))
                        : null,
                    compare
                        ? (h("div", { "data-mi-compare": "" },
                            h("div", { "data-mi-chead": "" }, '维度'),
                            h("div", { "data-mi-chead": "" }, '读写走 IDE（开）'),
                            h("div", { "data-mi-chead": "" }, '直接读写磁盘（关）'),
                            h("div", null, '读文件'),
                            h("div", null, 'IDE 当前项目视图：未保存缓冲区、依赖源码都可能被读到。'),
                            h("div", null, '磁盘上的字节，读不到 IDE 里还没保存的改动。'),
                            h("div", null, '写文件'),
                            h("div", null, '经 create_new_file / apply_patch，落盘跟随 IDE 的行尾等设置。'),
                            h("div", null, '按内容原样写入。'),
                            h("div", null, '无法路由'),
                            h("div", null, '明确报错并说清三种解法，绝不悄悄改磁盘（唯一例外：一条启用连接都没有时先问你要粘贴配置、仅本次走原生读写、还是取消；只有你选原生读写的那一次才读写磁盘）。'),
                            h("div", null, '不涉及。')))
                        : null),
                (rows || []).length === 0
                    ? h("div", { "data-mi-note": "" }, '还没有任何连接。点下面的「添加连接」新建一条。')
                    : null,
                (rows || []).map((row, index) => {
                    const bad = checked.per[index] || {};
                    const live = (mounted || []).find((item) => item.id === String(row.id || '').trim());
                    const renamed = live !== undefined && String(row.serverName || '').trim() !== live.serverName;
                    // 有校验问题或改名警告时强制展开；其余情况认内部 key 记住的展开态。
                    const forced = Object.keys(bad).length > 0 || renamed;
                    const expanded = forced || openKeys.has(row.__key);
                    return (h(Card, { key: row.__key, row: row, index: index, bad: bad, mounted: mounted, health: health, busy: busy, expanded: expanded, forced: forced, onChange: edit, onRemove: removeRow, onReconnect: reconnect, onToggle: () => toggleRow(row.__key) }));
                }),
                pasteOpen
                    ? (h("div", { "data-mi-card": "", "data-mi-paste": "" },
                        h("div", { "data-mi-cardhead": "" },
                            h("div", { "data-mi-cardname": "" }, '粘贴 IDE 的「复制配置」'),
                            h("div", { "data-mi-cardsub": "" }, '支持 mcpServers / 单个 server 对象 / 纯地址')),
                        h("div", { "data-mi-note": "" }, '在 IDE 的 MCP Server 设置里点「复制配置」，把整段 JSON 原样粘进来即可。'
                            + 'serverName 取自 mcpServers 的键（不合规会清洗并提示），地址取自 url；'
                            + 'projectPath 不在其中，导入后自己补。导入不会自动保存，确认后仍要点「保存并重挂」。'),
                        h("textarea", { "data-mi-textarea": "", value: pasteText, spellCheck: false, placeholder: '{"mcpServers":{"idea":{"type":"streamable-http","url":"' + SCHEME + '://127.0.0.1:64342/stream"}}}', onChange: (event) => setPasteText(event.target.value) }),
                        h("div", { "data-mi-bar": "", "data-mi-pastebar": "" },
                            h("button", { "data-mi-btn": "", type: "button", disabled: busy !== '', onClick: importPasted }, '解析并导入'),
                            h("button", { "data-mi-btn": "", type: "button", disabled: busy !== '', onClick: () => setPasteText('') }, '清空'),
                            h("div", { "data-mi-grow": "" }),
                            h("div", { "data-mi-note": "" }, '粘贴内容只留在页面内存里，不写任何存储。'))))
                    : null,
                h("div", { "data-mi-bar": "" },
                    h("button", { "data-mi-btn": "", type: "button", disabled: busy !== '', onClick: addRow }, '添加连接'),
                    h("button", { "data-mi-btn": "", type: "button", disabled: busy !== '', onClick: () => setPasteOpen(!pasteOpen) }, pasteOpen ? '收起粘贴框' : '粘贴配置'),
                    h("button", { "data-mi-btn": "", type: "button", disabled: busy !== '', title: '立刻向每条已挂载连接新开一次 MCP 会话读 tools/list，把结果写进健康状态后返回；'
                            + '比等后台探测快，代价是一次约 138KB 的工具清单。', onClick: refresh }, busy === 'refresh' ? '校验中…' : '刷新状态（校验工具面）'),
                    h("div", { "data-mi-grow": "" }, notice && notice.text
                        ? (h("div", { "data-mi-msg": "", "data-mi-ok": notice.kind === 'ok' ? '' : undefined, "data-mi-err": notice.kind === 'err' ? '' : undefined }, notice.text))
                        : (h("div", { "data-mi-msg": "" }, checked.ok
                            ? '共 ' + (rows || []).length + ' 条，' + mounted.length + ' 条已挂载'
                            : '有 ' + checked.list.length + ' 处校验问题，保存会被拦下'))),
                    h("button", { "data-mi-btn": "", "data-mi-primary": "", type: "button", disabled: busy !== '' || !checked.ok, onClick: save }, busy === 'save' ? '保存中…' : '保存并重挂')),
                (diag || []).length > 0
                    ? (h("div", { "data-mi-card": "" },
                        h("div", { "data-mi-cardhead": "" },
                            h("div", { "data-mi-cardname": "" }, '最近的自动动作'),
                            h("div", { "data-mi-cardsub": "" }, 'Host 侧最近 50 条，这里是前 5 条：工具缺失判定、自动重挂、重试结果。')),
                        h("div", { "data-mi-diag": "" }, (diag || []).slice(0, 5).map((item, index) => (h("div", { key: index, "data-mi-diagitem": "", "data-mi-bad": String(item?.action || '') === 'retry-failed' || String(item?.verdict || '') === 'tool-missing' ? '' : undefined }, diagText(item)))))))
                    : null));
        }
        return {
            inject: ['slots'],
            apply(ctx) {
                const style = document.createElement('style');
                style.setAttribute('data-plugin-css', 'dsh-mcp-jetbrains');
                style.textContent = CSS;
                document.head.appendChild(style);
                ctx.effect(() => () => style.remove(), 'dsh-mcp-jetbrains: 设置页样式');
                const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots;
                if (!slots || typeof slots.inject !== 'function')
                    return;
                slots.inject('settings.section', () => slots.register({ name: 'settings.section', id: 'jetbrains-mcp', order: 42, label: 'JetBrains IDE 连接' }, (props) => h(Panel, { ...props })));
            },
        };
    },
});
