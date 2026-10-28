/**
 * dsh-vpn — Client half: the VPN settings page in the DSH Web UI.
 *
 * The page registers one entry into the Settings shell's `settings.section`
 * list slot (declared by `@deepseek-ai/dsh-client-ui-settings-general`), so it
 * appears as its own navigation section ("VPN") inside the Settings dialog and
 * renders in the dialog's content column. Every value comes from the Host's
 * same-origin HTTP API under `/dsh-vpn/api/*`; the component holds no Host
 * Remote namespace and never touches the DOM outside its own tree.
 */
window.__ModuleLoader__.load({
  id: 'dsh-vpn',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Locale namespace owned by this plugin. */
    const NS = 'dsh-vpn';
    /** Same-origin HTTP API root the Host plugin registers. */
    const API_BASE = '/dsh-vpn/api/';
    /** Status polling cadence while the settings section is mounted. */
    const POLL_INTERVAL_MS = 5000;

    //#region dictionaries
    /** Simplified Chinese copy (the key-set source of truth). */
    const zh = {
      'nav': 'VPN',
      'title': 'VPN 代理',
      'description': '粘贴 Clash Verge 订阅地址，DSH 通过内置 mihomo 内核独立出网。这里可以开关代理、切换节点并运行测速。',
      'state.disabled': '已停用',
      'state.starting': '启动中',
      'state.running': '已连接',
      'state.degraded': '连接异常',
      'state.failed': '启动失败',
      'status.title': '连接状态',
      'status.hint': '代理内核的端口、当前节点与最近健康状态。',
      'status.currentNode': '当前节点',
      'status.mode': '路由模式',
      'status.port': '本地端口',
      'status.controllerPort': '控制端口',
      'status.health': '最近健康延迟',
      'status.startedAt': '启动时间',
      'status.lastError': '最近错误',
      'status.enable': '启用代理',
      'status.disable': '断开代理',
      'status.enabling': '启用中…',
      'status.disabling': '断开中…',
      'mode.rule': '规则模式',
      'mode.global': '全局模式',
      'mode.hint': '规则模式按分流规则出网；全局模式让全部流量经过代理。',
      'subscription.title': '订阅',
      'subscription.hint': '粘贴 Clash Verge 的订阅地址；保存后立即拉取节点。',
      'subscription.url': '订阅地址',
      'subscription.placeholder': 'https://example.com/sub?token=…',
      'subscription.save': '保存并拉取',
      'subscription.saving': '拉取中…',
      'subscription.update': '刷新订阅',
      'subscription.updating': '刷新中…',
      'subscription.nodes': '节点数',
      'subscription.traffic': '剩余流量',
      'subscription.expire': '到期时间',
      'subscription.interval': '自动更新',
      'subscription.intervalValue': '每 {hours} 小时',
      'subscription.empty': '尚未配置订阅地址。',
      'subscription.cached': '当前显示的是上次成功拉取的缓存订阅信息。',
      'subscription.error': '订阅拉取失败：{message}',
      'systemProxy.title': '系统代理（浏览器 / 其他应用）',
      'systemProxy.hint': '开启后，浏览器、Electron 应用等读取 Windows 系统代理的软件会走本插件；不改路由/TUN，也不改 Clash 配置。',
      'systemProxy.current': '当前系统代理',
      'systemProxy.original': '原系统代理',
      'systemProxy.originalNone': '原本未开启',
      'systemProxy.restoreHint': '关闭开关时会自动还原原系统代理设置。',
      'systemProxy.switching': '切换中…',
      'systemProxy.on': '已开启',
      'systemProxy.off': '已关闭',
      'systemProxy.unsupported': '仅 Windows 支持。',
      'systemProxy.needsVpn': '请先启用 VPN。',
      'systemProxy.notApplied': '未生效，可能 VPN 未运行。',
      'systemProxy.drift': '系统代理已被其他程序修改，未生效；重新打开开关可重新接管。',
      'systemProxy.error': '系统代理设置失败：{message}',
      'systemProxy.noticeOn': '系统代理已开启。',
      'systemProxy.noticeOff': '系统代理已关闭。',
      'nodes.title': '节点',
      'nodes.hint': '点击一行切换节点；测速结果以毫秒显示，超时单独标注。',
      'nodes.testAll': '测速全部',
      'nodes.testing': '测速中…',
      'nodes.selecting': '切换中…',
      'nodes.current': '当前',
      'nodes.timeout': '超时',
      'nodes.empty': '暂无节点，请先保存并拉取订阅。',
      'common.none': '—',
      'common.retry': '重试',
      'common.loading': '读取中…',
      'error.load': '读取失败：{message}',
      'error.urlRequired': '请先填写订阅地址。',
      'error.applyFailed': '切换没有生效，请重试或查看代理内核日志。',
      'notice.enabled': '代理已启用。',
      'notice.disabled': '代理已断开。',
      'notice.mode': '路由模式已切换。',
      'notice.subscription': '订阅已保存。',
      'notice.subscriptionCount': '订阅已保存，共 {count} 个节点。',
      'notice.update': '订阅已刷新。',
      'notice.updateCount': '订阅已刷新，共 {count} 个节点。',
      'notice.test': '测速完成。',
      'notice.selected': '已切换到节点 {node}。',
    };

    /** English copy, checked complete against the Chinese key set. */
    const en = {
      'nav': 'VPN',
      'title': 'VPN proxy',
      'description': 'Paste a Clash Verge subscription so DSH egresses through its bundled mihomo core. Toggle the proxy, switch nodes, and run latency tests here.',
      'state.disabled': 'Disabled',
      'state.starting': 'Starting',
      'state.running': 'Connected',
      'state.degraded': 'Degraded',
      'state.failed': 'Failed',
      'status.title': 'Connection',
      'status.hint': 'Ports, current node, and latest health of the proxy core.',
      'status.currentNode': 'Current node',
      'status.mode': 'Routing mode',
      'status.port': 'Local port',
      'status.controllerPort': 'Controller port',
      'status.health': 'Latest health latency',
      'status.startedAt': 'Started',
      'status.lastError': 'Last error',
      'status.enable': 'Enable proxy',
      'status.disable': 'Disable proxy',
      'status.enabling': 'Enabling…',
      'status.disabling': 'Disabling…',
      'mode.rule': 'Rule',
      'mode.global': 'Global',
      'mode.hint': 'Rule mode routes by the proxy rules; global mode sends every request through the proxy.',
      'subscription.title': 'Subscription',
      'subscription.hint': 'Paste the Clash Verge subscription URL; saving pulls its nodes immediately.',
      'subscription.url': 'Subscription URL',
      'subscription.placeholder': 'https://example.com/sub?token=…',
      'subscription.save': 'Save & pull',
      'subscription.saving': 'Pulling…',
      'subscription.update': 'Refresh subscription',
      'subscription.updating': 'Refreshing…',
      'subscription.nodes': 'Nodes',
      'subscription.traffic': 'Traffic left',
      'subscription.expire': 'Expires',
      'subscription.interval': 'Auto update',
      'subscription.intervalValue': 'Every {hours} h',
      'subscription.empty': 'No subscription URL is configured yet.',
      'subscription.cached': 'Showing the last successfully pulled subscription.',
      'subscription.error': 'Subscription fetch failed: {message}',
      'systemProxy.title': 'System proxy (browsers / other apps)',
      'systemProxy.hint': 'When on, browsers and Electron apps that read the Windows system proxy go through this plugin. It does not touch routes, TUN, or the Clash config.',
      'systemProxy.current': 'Current system proxy',
      'systemProxy.original': 'Previous system proxy',
      'systemProxy.originalNone': 'None was set',
      'systemProxy.restoreHint': 'Turning it off restores the previous system proxy settings.',
      'systemProxy.switching': 'Switching…',
      'systemProxy.on': 'On',
      'systemProxy.off': 'Off',
      'systemProxy.unsupported': 'Supported on Windows only.',
      'systemProxy.needsVpn': 'Enable the VPN first.',
      'systemProxy.notApplied': 'Not applied — the VPN may not be running.',
      'systemProxy.drift': 'Another program changed the system proxy; turn the switch on again to take it back.',
      'systemProxy.error': 'System proxy failed: {message}',
      'systemProxy.noticeOn': 'System proxy enabled.',
      'systemProxy.noticeOff': 'System proxy disabled.',
      'nodes.title': 'Nodes',
      'nodes.hint': 'Click a row to switch nodes; latency is shown in milliseconds and timeouts are marked.',
      'nodes.testAll': 'Test all',
      'nodes.testing': 'Testing…',
      'nodes.selecting': 'Switching…',
      'nodes.current': 'Current',
      'nodes.timeout': 'Timed out',
      'nodes.empty': 'No nodes yet. Save and pull a subscription first.',
      'common.none': '—',
      'common.retry': 'Retry',
      'common.loading': 'Loading…',
      'error.load': 'Failed to load: {message}',
      'error.urlRequired': 'Enter a subscription URL first.',
      'error.applyFailed': 'The switch did not take effect; retry or check the proxy core log.',
      'notice.enabled': 'Proxy enabled.',
      'notice.disabled': 'Proxy disabled.',
      'notice.mode': 'Routing mode updated.',
      'notice.subscription': 'Subscription saved.',
      'notice.subscriptionCount': 'Subscription saved with {count} nodes.',
      'notice.update': 'Subscription refreshed.',
      'notice.updateCount': 'Subscription refreshed with {count} nodes.',
      'notice.test': 'Latency test finished.',
      'notice.selected': 'Switched to node {node}.',
    };
    //#endregion

    //#region stylesheet
    /**
     * The whole page's stylesheet, scoped under the `dshvpn-` prefix. Only
     * `--dsw-alias-*` theme tokens (plus the theme's focus-ring and radius
     * variables) are consumed, so light/dark switching needs no extra code.
     */
    const CSS = `
.dshvpn-page{display:flex;flex-direction:column;gap:14px;width:100%;max-width:760px;color:var(--dsw-alias-label-primary)}
.dshvpn-head{display:flex;align-items:flex-start;gap:10px}
.dshvpn-mark{flex:none;width:22px;height:22px;margin-top:2px;color:var(--dsw-alias-brand-primary)}
.dshvpn-headText{display:flex;flex-direction:column;gap:4px;min-width:0;flex:1}
.dshvpn-title{margin:0;font-size:18px;font-weight:600;line-height:26px}
.dshvpn-intro{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.dshvpn-card{display:flex;flex-direction:column;gap:12px;padding:16px;border:.5px solid var(--dsw-alias-settings-card-stroke);border-radius:16px;background:var(--dsw-alias-settings-card-fill)}
.dshvpn-cardHead{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
.dshvpn-cardTitles{display:flex;flex-direction:column;gap:2px;min-width:0}
.dshvpn-cardTitle{margin:0;font-size:14px;font-weight:600;line-height:22px}
.dshvpn-hint{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.dshvpn-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshvpn-badge{display:inline-flex;align-items:center;gap:6px;flex:none;padding:2px 10px;border:.5px solid color-mix(in srgb, currentColor 30%, transparent);border-radius:999px;background:color-mix(in srgb, currentColor 10%, transparent);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:20px;white-space:nowrap}
.dshvpn-badge[data-tone="ok"]{color:var(--dsw-alias-state-success-primary)}
.dshvpn-badge[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary)}
.dshvpn-badge[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}
.dshvpn-badge[data-tone="pending"]{color:var(--dsw-alias-state-idle-primary)}
.dshvpn-dot{flex:none;width:6px;height:6px;border-radius:50%;background:currentColor}
.dshvpn-facts{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 16px;margin:0}
.dshvpn-fact{display:flex;flex-direction:column;gap:2px;min-width:0}
.dshvpn-fact dt{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dshvpn-fact dd{margin:0;font-size:13px;line-height:20px;overflow-wrap:anywhere}
.dshvpn-row{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.dshvpn-rowLabel{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
.dshvpn-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l3);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;white-space:nowrap;cursor:pointer}
.dshvpn-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dshvpn-btn:disabled{opacity:.5;cursor:default}
.dshvpn-btn:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dshvpn-btn[data-variant="primary"]{border-color:transparent;background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 14%, transparent);color:var(--dsw-alias-state-business-primary);font-weight:500}
.dshvpn-btn[data-variant="primary"]:hover:not(:disabled){background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 22%, transparent)}
.dshvpn-btn[data-variant="danger"]{border-color:transparent;background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent);color:var(--dsw-alias-state-error-primary)}
.dshvpn-btn[data-variant="danger"]:hover:not(:disabled){background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 20%, transparent)}
.dshvpn-seg{display:inline-flex;gap:2px;padding:2px;border:.5px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2)}
.dshvpn-segBtn{height:24px;padding:0 12px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:20px;cursor:pointer}
.dshvpn-segBtn[aria-checked="true"]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-weight:500;box-shadow:0 0 0 .5px var(--dsw-alias-border-l3)}
.dshvpn-segBtn:disabled{opacity:.5;cursor:default}
.dshvpn-segBtn:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.dshvpn-form{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshvpn-input{flex:1;min-width:220px;height:34px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;outline:none}
.dshvpn-input::placeholder{color:var(--dsw-alias-label-tertiary)}
.dshvpn-input:focus-visible{border-color:var(--dsw-alias-state-business-primary);box-shadow:0 0 0 2px color-mix(in srgb, var(--dsw-alias-state-business-primary) 18%, transparent)}
.dshvpn-input:disabled{opacity:.6}
.dshvpn-summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px 16px;margin:0}
.dshvpn-summaryItem{display:flex;flex-direction:column;gap:2px;min-width:0}
.dshvpn-summaryItem dt{font-size:12px;line-height:16px;color:var(--dsw-alias-label-tertiary)}
.dshvpn-summaryItem dd{margin:0;font-size:13px;line-height:20px;overflow-wrap:anywhere}
.dshvpn-nodeList{display:flex;flex-direction:column;margin:0;padding:0;max-height:380px;overflow-y:auto;border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;list-style:none}
.dshvpn-node{display:grid;grid-template-columns:minmax(0,1fr) auto auto;align-items:center;gap:12px;width:100%;padding:9px 12px;border:0;border-bottom:.5px solid var(--dsw-alias-border-l2);background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.dshvpn-nodeList>li:last-child .dshvpn-node{border-bottom:0}
.dshvpn-node:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.dshvpn-node:disabled{cursor:default}
.dshvpn-node[data-current="true"]{background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 8%, transparent)}
.dshvpn-node:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
.dshvpn-nodeText{display:flex;flex-direction:column;gap:1px;min-width:0}
.dshvpn-nodeName{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshvpn-nodeType{font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);text-transform:uppercase;letter-spacing:.02em}
.dshvpn-delay{font-size:12px;line-height:18px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.dshvpn-delay[data-tone="fast"]{color:var(--dsw-alias-state-success-primary)}
.dshvpn-delay[data-tone="mid"]{color:var(--dsw-alias-state-warn-primary)}
.dshvpn-delay[data-tone="slow"]{color:var(--dsw-alias-state-error-primary)}
.dshvpn-current{font-size:11px;line-height:18px;padding:0 8px;border-radius:999px;color:var(--dsw-alias-state-business-primary);background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);white-space:nowrap}
.dshvpn-switching{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.dshvpn-alert{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}
.dshvpn-warn{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-warn-primary)}
.dshvpn-notice{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-success-primary)}
.dshvpn-muted{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.dshvpn-switchSide{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshvpn-switchState{font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dshvpn-switch{position:relative;flex:none;width:36px;height:20px;padding:0;border:.5px solid var(--dsw-alias-border-l3);border-radius:999px;background:var(--dsw-alias-bg-layer-2);cursor:pointer;transition:background var(--ds-transition-duration-fast) ease,border-color var(--ds-transition-duration-fast) ease}
.dshvpn-switch[data-checked="true"]{border-color:transparent;background:var(--dsw-alias-state-business-primary)}
.dshvpn-switch:disabled{opacity:.5;cursor:default}
.dshvpn-switch:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:2px}
.dshvpn-switchThumb{position:absolute;top:50%;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-label-tertiary);transform:translateY(-50%);transition:left var(--ds-transition-duration-fast) ease,background var(--ds-transition-duration-fast) ease}
.dshvpn-switch[data-checked="true"] .dshvpn-switchThumb{left:18px;background:var(--dsw-alias-bg-base)}
@media (prefers-reduced-motion: reduce){.dshvpn-switch,.dshvpn-switchThumb{transition:none}}
`;

    /** Append the page stylesheet once per document; the disposer removes it. */
    function installStyles() {
      if (typeof document === 'undefined') return undefined;
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-vpn';
      tag.dataset.pluginCss = 'dsh-vpn/client.css';
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return () => {
        tag.remove();
      };
    }
    //#endregion

    //#region transport
    /**
     * One same-origin API call against the Host VPN plugin. Resolves with the
     * parsed body only for `{ ok: true, ... }`; every failure becomes an Error
     * whose message is safe to show inline.
     * @param {string} method - HTTP method.
     * @param {string} path - path after `/dsh-vpn/api/`.
     * @param {object} [payload] - JSON body; omitted for GET.
     * @returns {Promise<object>} the accepted response body.
     */
    async function request(method, path, payload) {
      const init = { method: method, credentials: 'same-origin' };
      if (payload !== undefined) {
        init.headers = { 'content-type': 'application/json' };
        init.body = JSON.stringify(payload);
      }
      let response;
      try {
        response = await fetch(API_BASE + path, init);
      } catch (error) {
        throw new Error(error && error.message ? error.message : String(error));
      }
      let body = null;
      try {
        body = await response.json();
      } catch (error) {
        body = null;
      }
      if (!response.ok || body === null || body.ok !== true) {
        const message = body !== null && typeof body.error === 'string' && body.error.length > 0
          ? body.error
          : 'HTTP ' + response.status;
        throw new Error(message);
      }
      return body;
    }

    /** Thin API surface; every call returns the Host's envelope. */
    const api = {
      status: () => request('GET', 'status'),
      nodes: () => request('GET', 'nodes'),
      enable: () => request('POST', 'enable', {}),
      disable: () => request('POST', 'disable', {}),
      update: () => request('POST', 'update', {}),
      test: () => request('POST', 'test', {}),
      setMode: (mode) => request('POST', 'mode', { mode: mode }),
      select: (node) => request('POST', 'select', { node: node }),
      saveSubscription: (url) => request('POST', 'subscription', { url: url }),
      setSystemProxy: (enabled) => request('POST', 'system-proxy', { enabled: enabled }),
    };

    /** Message of any thrown value. */
    function errorText(error) {
      if (error && typeof error.message === 'string' && error.message.length > 0) return error.message;
      return String(error);
    }
    //#endregion

    //#region formatting
    /** Zero-pad one clock component. */
    function pad2(value) {
      return value < 10 ? '0' + value : String(value);
    }

    /**
     * Format an epoch-millisecond, epoch-second, or date-string value as local
     * `YYYY-MM-DD HH:mm`. Returns null for values that do not parse.
     * @param {unknown} value - Host-provided timestamp.
     * @returns {string|null} the formatted local time.
     */
    function formatClock(value) {
      if (value === null || value === undefined || value === '') return null;
      let date;
      if (typeof value === 'number') {
        if (!isFinite(value)) return null;
        date = new Date(value < 1e12 ? value * 1000 : value);
      } else {
        date = new Date(value);
      }
      if (isNaN(date.getTime())) return null;
      return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate()) +
        ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes());
    }

    /**
     * Human byte size for a numeric value; non-numbers pass through as text.
     * @param {unknown} value - byte count.
     * @returns {string|null} display text.
     */
    function formatBytes(value) {
      if (typeof value !== 'number' || !isFinite(value) || value < 0) return null;
      const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
      let amount = value;
      let unit = 0;
      while (amount >= 1024 && unit < units.length - 1) {
        amount /= 1024;
        unit += 1;
      }
      const rounded = unit === 0 ? String(Math.round(amount)) : amount.toFixed(amount >= 100 ? 0 : 1);
      return rounded + ' ' + units[unit];
    }

    /**
     * Display text for a subscription field that may be a number, a
     * preformatted string, or absent.
     * @param {unknown} value - Host-provided field.
     * @returns {string|null} display text or null when absent.
     */
    function displayValue(value) {
      if (value === null || value === undefined || value === '') return null;
      if (typeof value === 'number') return formatBytes(value) || String(value);
      return String(value);
    }

    /** Tonal bucket of one latency value. */
    function delayTone(delay) {
      if (typeof delay !== 'number' || !isFinite(delay)) return 'none';
      if (delay < 200) return 'fast';
      if (delay < 500) return 'mid';
      return 'slow';
    }

    /** Badge tone for a VPN state string. */
    function stateTone(state) {
      if (state === 'running') return 'ok';
      if (state === 'degraded') return 'warn';
      if (state === 'failed') return 'error';
      if (state === 'starting') return 'pending';
      return 'idle';
    }
    //#endregion

    //#region icons
    /** Original shield mark shown beside the section title. */
    function ShieldMark() {
      return h('svg', {
        className: 'dshvpn-mark',
        viewBox: '0 0 24 24',
        'aria-hidden': 'true',
        focusable: 'false',
      },
        h('path', {
          d: 'M12 2.6 19.6 5.8v6.1c0 4.5-3.1 7.6-7.6 9.1-4.5-1.5-7.6-4.6-7.6-9.1V5.8L12 2.6Z',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: '1.6',
          strokeLinejoin: 'round',
        }),
        h('circle', { cx: '8.6', cy: '11', r: '1.2', fill: 'currentColor' }),
        h('circle', { cx: '15.4', cy: '11', r: '1.2', fill: 'currentColor' }),
        h('path', {
          d: 'M8.6 11h6.8M12 11v3.4M9.6 15.2 12 14.4l2.4.8',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: '1.4',
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
        }));
    }

    /** State pill: dot plus the localized state name. */
    function StateBadge({ t, state }) {
      const key = 'state.' + (typeof state === 'string' && state.length > 0 ? state : 'disabled');
      return h('span', { className: 'dshvpn-badge', 'data-tone': stateTone(state) },
        h('span', { className: 'dshvpn-dot', 'aria-hidden': 'true' }),
        t(key));
    }
    //#endregion

    //#region components
    /** Keeps one crashed section from blanking the whole Settings slot entry. */
    class VpnErrorBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error: error };
      }

      componentDidCatch(error) {
        console.error('dsh-vpn: settings section crashed', error);
      }

      render() {
        if (this.state.error !== null) {
          return h('p', { className: 'dshvpn-alert', role: 'alert' },
            'VPN UI error: ' + errorText(this.state.error));
        }
        return this.props.children;
      }
    }

    /** One labeled fact cell inside a `dl` grid. */
    function Fact({ label, value }) {
      return h('div', { className: 'dshvpn-fact' },
        h('dt', null, label),
        h('dd', null, value));
    }

    /** One labeled summary cell inside a `dl` grid. */
    function SummaryItem({ label, value }) {
      return h('div', { className: 'dshvpn-summaryItem' },
        h('dt', null, label),
        h('dd', null, value));
    }

    /**
     * The VPN settings section. Everything it shows comes from the HTTP API;
     * it polls status every five seconds and stops on unmount.
     * @param {{ t: (key: string, params?: object) => string }} props - slot props.
     */
    function VpnSection({ t }) {
      const [status, setStatus] = React.useState(null);
      const [statusError, setStatusError] = React.useState(null);
      const [statusLoading, setStatusLoading] = React.useState(true);
      const [nodes, setNodes] = React.useState(null);
      const [nodesError, setNodesError] = React.useState(null);
      const [nodesLoading, setNodesLoading] = React.useState(true);
      const [busy, setBusy] = React.useState('');
      const [actionError, setActionError] = React.useState(null);
      const [notice, setNotice] = React.useState(null);
      const [draftUrl, setDraftUrl] = React.useState(null);
      const [delays, setDelays] = React.useState(null);
      const mounted = React.useRef(true);

      React.useEffect(() => {
        mounted.current = true;
        return () => {
          mounted.current = false;
        };
      }, []);

      /** Read `/status`; the initial read owns the inline loading state. */
      const loadStatus = React.useCallback(async (initial) => {
        if (initial) setStatusLoading(true);
        try {
          const body = await api.status();
          if (!mounted.current) return;
          setStatus(body.status === undefined ? null : body.status);
          setStatusError(null);
        } catch (error) {
          if (!mounted.current) return;
          setStatusError(errorText(error));
        } finally {
          if (mounted.current && initial) setStatusLoading(false);
        }
      }, []);

      /** Read `/nodes`; reloaded after every action that can change the list. */
      const loadNodes = React.useCallback(async (initial) => {
        if (initial) setNodesLoading(true);
        try {
          const body = await api.nodes();
          if (!mounted.current) return;
          setNodes(Array.isArray(body.nodes) ? body.nodes : []);
          setNodesError(null);
        } catch (error) {
          if (!mounted.current) return;
          setNodesError(errorText(error));
        } finally {
          if (mounted.current && initial) setNodesLoading(false);
        }
      }, []);

      React.useEffect(() => {
        loadStatus(true);
        loadNodes(true);
        const timer = window.setInterval(() => {
          loadStatus(false);
        }, POLL_INTERVAL_MS);
        return () => {
          window.clearInterval(timer);
        };
      }, [loadStatus, loadNodes]);

      /** Run one user action behind the shared busy flag; failures stay inline. */
      const runAction = React.useCallback(async (key, work) => {
        setBusy(key);
        setActionError(null);
        setNotice(null);
        try {
          await work();
        } catch (error) {
          if (mounted.current) setActionError(errorText(error));
        } finally {
          if (mounted.current) setBusy('');
        }
      }, []);

      const state = status !== null && typeof status.state === 'string' ? status.state : null;
      const connected = state === 'running' || state === 'degraded' || state === 'starting';
      const canToggle = status !== null && busy === '' && state !== 'starting';
      // The Host reports the subscription summary as `status.subscription`; an
      // early contract revision called it `subscriptionSummary`. Field names are
      // read through aliases below so either shape renders.
      const subscription = status !== null && status.subscription && typeof status.subscription === 'object'
        ? status.subscription
        : (status !== null && status.subscriptionSummary && typeof status.subscriptionSummary === 'object'
          ? status.subscriptionSummary
          : null);
      /** Last subscription pull failure the Host reports on the summary. */
      const subscriptionError = subscription !== null && typeof subscription.error === 'string' && subscription.error.length > 0
        ? subscription.error
        : null;
      /** Whether the summary describes a cached instead of a freshly pulled subscription. */
      const subscriptionCached = subscription !== null && subscription.fromCache === true;
      const currentName = nodes !== null && typeof nodes.current === 'string' && nodes.current.length > 0
        ? nodes.current
        : (status !== null && typeof status.nodeName === 'string' && status.nodeName.length > 0 ? status.nodeName : null);
      const nodeList = Array.isArray(nodes) ? nodes : [];

      // Windows system proxy state owned by the Host (browsers and other apps
      // that read the system proxy). Absent until the Host ships the field, in
      // which case the card is not rendered at all.
      const systemProxy = status !== null && status.systemProxy && typeof status.systemProxy === 'object'
        ? status.systemProxy
        : null;
      const systemProxySupported = systemProxy !== null && systemProxy.supported === true;
      const systemProxyApplied = systemProxy !== null && systemProxy.applied === true;
      const systemProxyEnabled = systemProxy !== null && systemProxy.enabled === true;
      // The Host compares the live registry value with its own port: `drift`
      // means another program changed the system proxy back while the plugin
      // still intends to be on.
      const systemProxyDrift = systemProxy !== null && systemProxy.drift === true;
      const systemProxyBusy = busy === 'system-proxy';
      // Turning the switch off must stay possible while something is applied, so
      // `running` is only required when nothing is applied yet.
      const systemProxyReady = systemProxy !== null && systemProxySupported && (systemProxyApplied || state === 'running');
      const systemProxyDisabled = !systemProxyReady || systemProxyBusy;
      const originalProxy = systemProxy !== null && systemProxy.original && typeof systemProxy.original === 'object'
        ? systemProxy.original
        : null;
      const originalProxyServer = originalProxy !== null && typeof originalProxy.proxyServer === 'string' && originalProxy.proxyServer.length > 0
        ? originalProxy.proxyServer
        : null;
      const systemProxyTarget = systemProxy !== null && typeof systemProxy.target === 'string' && systemProxy.target.length > 0
        ? systemProxy.target
        : null;
      const systemProxyLastError = systemProxy !== null && typeof systemProxy.lastError === 'string' && systemProxy.lastError.length > 0
        ? systemProxy.lastError
        : null;
      /** One inline hint under the switch explaining why it is disabled or stale. */
      let systemProxyHint = null;
      let systemProxyHintWarn = false;
      if (systemProxy !== null) {
        if (!systemProxySupported) systemProxyHint = t('systemProxy.unsupported');
        else if (systemProxyEnabled && !systemProxyApplied) {
          systemProxyHint = systemProxyDrift ? t('systemProxy.drift') : t('systemProxy.notApplied');
          systemProxyHintWarn = true;
        } else if (!systemProxyApplied && state !== 'running') systemProxyHint = t('systemProxy.needsVpn');
      }

      const toggleSystemProxy = () => {
        if (systemProxy === null || systemProxyDisabled) return;
        const next = !systemProxyApplied;
        runAction('system-proxy', async () => {
          const body = await api.setSystemProxy(next);
          if (!mounted.current) return;
          if (body.status !== undefined) setStatus(body.status);
          setNotice(next ? t('systemProxy.noticeOn') : t('systemProxy.noticeOff'));
        });
      };

      const urlValue = draftUrl !== null
        ? draftUrl
        : (subscription !== null && typeof subscription.url === 'string' ? subscription.url : '');

      const toggleProxy = () => {
        if (!canToggle) return;
        const enabling = !connected;
        runAction(enabling ? 'enable' : 'disable', async () => {
          const body = enabling ? await api.enable() : await api.disable();
          if (!mounted.current) return;
          if (body.status !== undefined) setStatus(body.status);
          setNotice(enabling ? t('notice.enabled') : t('notice.disabled'));
          if (!enabling) setDelays(null);
          await loadNodes(false);
        });
      };

      const changeMode = (mode) => {
        if (status === null || busy !== '' || status.mode === mode) return;
        runAction('mode', async () => {
          const body = await api.setMode(mode);
          if (!mounted.current) return;
          // `/mode` reports whether the core accepted the reload; a false
          // `applied` is a failed switch even though the request said ok.
          if (body.applied === false) throw new Error(t('error.applyFailed'));
          setStatus((previous) => (previous === null ? previous : Object.assign({}, previous, { mode: mode })));
          setNotice(t('notice.mode'));
          await Promise.all([loadStatus(false), loadNodes(false)]);
        });
      };

      const saveSubscription = () => {
        if (busy !== '') return;
        const url = urlValue.trim();
        if (url.length === 0) {
          setActionError(t('error.urlRequired'));
          return;
        }
        runAction('subscription', async () => {
          const body = await api.saveSubscription(url);
          if (!mounted.current) return;
          setDraftUrl(null);
          setDelays(null);
          const count = body.summary && typeof body.summary.nodeCount === 'number' ? body.summary.nodeCount : null;
          setNotice(count === null ? t('notice.subscription') : t('notice.subscriptionCount', { count: count }));
          await Promise.all([loadStatus(false), loadNodes(false)]);
        });
      };

      const refreshSubscription = () => {
        if (busy !== '') return;
        runAction('update', async () => {
          const body = await api.update();
          if (!mounted.current) return;
          setDelays(null);
          const count = body.summary && typeof body.summary.nodeCount === 'number' ? body.summary.nodeCount : null;
          setNotice(count === null ? t('notice.update') : t('notice.updateCount', { count: count }));
          await Promise.all([loadStatus(false), loadNodes(false)]);
        });
      };

      const testAll = () => {
        if (busy !== '' || nodeList.length === 0) return;
        runAction('test', async () => {
          const body = await api.test();
          if (!mounted.current) return;
          setDelays(body.delays && typeof body.delays === 'object' ? body.delays : {});
          setNotice(t('notice.test'));
        });
      };

      const selectNode = (name) => {
        if (busy !== '' || status === null || name === currentName) return;
        runAction('select:' + name, async () => {
          const body = await api.select(name);
          if (!mounted.current) return;
          // `/select` reports whether the running group actually switched.
          if (body.applied === false) throw new Error(t('error.applyFailed'));
          setNotice(t('notice.selected', { node: name }));
          await Promise.all([loadStatus(false), loadNodes(false)]);
        });
      };

      /** Display state of one node row: tested delay first, then the list value. */
      const nodeDelay = (node) => {
        const name = typeof node.name === 'string' ? node.name : String(node.name);
        const tested = delays !== null && Object.prototype.hasOwnProperty.call(delays, name) ? delays[name] : undefined;
        if (tested === null) return { text: t('nodes.timeout'), tone: 'slow' };
        const value = tested !== undefined ? tested : node.delay;
        if (typeof value === 'number' && isFinite(value)) {
          return { text: value + ' ms', tone: delayTone(value) };
        }
        return { text: t('common.none'), tone: 'none' };
      };

      const factValue = (value) => {
        if (typeof value === 'number' && isFinite(value)) return String(value);
        if (typeof value === 'string' && value.length > 0) return value;
        return t('common.none');
      };

      /** A port fact: `0` and absent mean "not allocated yet". */
      const portValue = (value) => {
        if (typeof value === 'number' && isFinite(value) && value > 0) return String(value);
        if (typeof value === 'string' && value.length > 0 && value !== '0') return value;
        return t('common.none');
      };

      const healthText = status !== null && typeof status.lastHealthMs === 'number' && isFinite(status.lastHealthMs)
        ? status.lastHealthMs + ' ms'
        : t('common.none');
      const startedText = status !== null ? (formatClock(status.startedAt) || t('common.none')) : t('common.none');
      const modeText = status !== null && status.mode === 'global' ? t('mode.global') : (status !== null && status.mode === 'rule' ? t('mode.rule') : t('common.none'));

      const subscriptionNodes = subscription === null
        ? null
        : (typeof subscription.nodeCount === 'number'
          ? String(subscription.nodeCount)
          : (Array.isArray(subscription.nodes) ? String(subscription.nodes.length) : displayValue(subscription.nodeCount)));
      const subscriptionTraffic = subscription === null
        ? null
        : (displayValue(subscription.remainingTraffic) ||
          displayValue(subscription.traffic) ||
          formatBytes(subscription.totalBytes));
      const subscriptionExpire = subscription === null
        ? null
        : (displayValue(subscription.expireDate) ||
          displayValue(subscription.expire) ||
          formatClock(subscription.expireAtIso));
      const subscriptionInterval = subscription !== null && typeof subscription.updateIntervalHours === 'number' && isFinite(subscription.updateIntervalHours)
        ? t('subscription.intervalValue', { hours: subscription.updateIntervalHours })
        : null;

      let toggleLabel = t('status.enable');
      if (busy === 'enable' || state === 'starting') toggleLabel = t('status.enabling');
      else if (busy === 'disable') toggleLabel = t('status.disabling');
      else if (connected) toggleLabel = t('status.disable');

      return h('div', { className: 'dshvpn-page', 'data-plugin': 'dsh-vpn' },
        // ---- header --------------------------------------------------------
        h('header', { className: 'dshvpn-head' },
          h(ShieldMark),
          h('div', { className: 'dshvpn-headText' },
            h('h2', { className: 'dshvpn-title' }, t('title')),
            h('p', { className: 'dshvpn-intro' }, t('description')))),
        actionError === null ? null : h('p', { className: 'dshvpn-alert', role: 'alert' }, actionError),
        notice === null ? null : h('p', { className: 'dshvpn-notice', role: 'status' }, notice),

        // ---- connection ----------------------------------------------------
        h('section', { className: 'dshvpn-card', 'aria-label': t('status.title') },
          h('div', { className: 'dshvpn-cardHead' },
            h('div', { className: 'dshvpn-cardTitles' },
              h('h3', { className: 'dshvpn-cardTitle' }, t('status.title')),
              h('p', { className: 'dshvpn-hint' }, t('status.hint'))),
            h('div', { className: 'dshvpn-actions' },
              h('button', {
                type: 'button',
                className: 'dshvpn-btn',
                'data-variant': connected ? 'danger' : 'primary',
                'data-action': 'toggle',
                disabled: !canToggle,
                onClick: toggleProxy,
              }, toggleLabel),
              status === null ? null : h(StateBadge, { t: t, state: state }))),
          statusLoading && status === null
            ? h('p', { className: 'dshvpn-muted' }, t('common.loading'))
            : null,
          statusError === null ? null : h('div', { className: 'dshvpn-row' },
            h('p', { className: 'dshvpn-alert', role: 'alert' }, t('error.load', { message: statusError })),
            h('button', {
              type: 'button',
              className: 'dshvpn-btn',
              'data-action': 'retry-status',
              disabled: statusLoading,
              onClick: () => {
                loadStatus(true);
              },
            }, t('common.retry'))),
          status !== null ? h('dl', { className: 'dshvpn-facts' },
            h(Fact, { label: t('status.currentNode'), value: currentName === null ? t('common.none') : currentName }),
            h(Fact, { label: t('status.mode'), value: modeText }),
            h(Fact, { label: t('status.port'), value: portValue(status.port) }),
            h(Fact, { label: t('status.controllerPort'), value: portValue(status.controllerPort) }),
            h(Fact, { label: t('status.health'), value: healthText }),
            h(Fact, { label: t('status.startedAt'), value: startedText })) : null,
          status !== null && typeof status.lastError === 'string' && status.lastError.length > 0
            ? h('p', { className: 'dshvpn-alert', role: 'alert' }, t('status.lastError') + ': ' + status.lastError)
            : null,
          h('div', { className: 'dshvpn-row' },
            h('span', { className: 'dshvpn-rowLabel' }, t('status.mode')),
            h('div', { className: 'dshvpn-seg', role: 'radiogroup', 'aria-label': t('status.mode') },
              h('button', {
                type: 'button',
                className: 'dshvpn-segBtn',
                role: 'radio',
                'aria-checked': status !== null && status.mode === 'rule' ? 'true' : 'false',
                disabled: status === null || busy !== '',
                'data-mode': 'rule',
                onClick: () => changeMode('rule'),
              }, t('mode.rule')),
              h('button', {
                type: 'button',
                className: 'dshvpn-segBtn',
                role: 'radio',
                'aria-checked': status !== null && status.mode === 'global' ? 'true' : 'false',
                disabled: status === null || busy !== '',
                'data-mode': 'global',
                onClick: () => changeMode('global'),
              }, t('mode.global')))),
          h('p', { className: 'dshvpn-hint' }, t('mode.hint'))),

        // ---- system proxy (browsers / other apps) --------------------------
        systemProxy === null ? null : h('section', { className: 'dshvpn-card', 'aria-label': t('systemProxy.title') },
          h('div', { className: 'dshvpn-cardHead' },
            h('div', { className: 'dshvpn-cardTitles' },
              h('h3', { className: 'dshvpn-cardTitle' }, t('systemProxy.title')),
              h('p', { className: 'dshvpn-hint' }, t('systemProxy.hint'))),
            h('div', { className: 'dshvpn-switchSide' },
              h('span', { className: 'dshvpn-switchState' },
                systemProxyBusy ? t('systemProxy.switching') : (systemProxyApplied ? t('systemProxy.on') : t('systemProxy.off'))),
              h('button', {
                type: 'button',
                role: 'switch',
                'aria-checked': systemProxyApplied ? 'true' : 'false',
                'aria-label': t('systemProxy.title'),
                'aria-busy': systemProxyBusy ? 'true' : undefined,
                'data-action': 'system-proxy',
                className: 'dshvpn-switch',
                'data-checked': systemProxyApplied ? 'true' : 'false',
                disabled: systemProxyDisabled,
                onClick: toggleSystemProxy,
              }, h('span', { className: 'dshvpn-switchThumb', 'aria-hidden': 'true' })))),
          h('dl', { className: 'dshvpn-facts' },
            h(Fact, {
              label: t('systemProxy.current'),
              value: systemProxyApplied && systemProxyTarget !== null ? systemProxyTarget : t('common.none'),
            }),
            h(Fact, {
              label: t('systemProxy.original'),
              value: originalProxy === null
                ? t('common.none')
                : (originalProxyServer !== null ? originalProxyServer : t('systemProxy.originalNone')),
            })),
          originalProxy === null ? null : h('p', { className: 'dshvpn-hint' }, t('systemProxy.restoreHint')),
          systemProxyHint === null
            ? null
            : h('p', { className: systemProxyHintWarn ? 'dshvpn-warn' : 'dshvpn-hint' }, systemProxyHint),
          systemProxyLastError === null
            ? null
            : h('p', { className: 'dshvpn-alert', role: 'alert' }, t('systemProxy.error', { message: systemProxyLastError }))),

        // ---- subscription --------------------------------------------------
        h('section', { className: 'dshvpn-card', 'aria-label': t('subscription.title') },
          h('div', { className: 'dshvpn-cardHead' },
            h('div', { className: 'dshvpn-cardTitles' },
              h('h3', { className: 'dshvpn-cardTitle' }, t('subscription.title')),
              h('p', { className: 'dshvpn-hint' }, t('subscription.hint'))),
            h('div', { className: 'dshvpn-actions' },
              h('button', {
                type: 'button',
                className: 'dshvpn-btn',
                'data-action': 'update',
                disabled: busy !== '' || status === null,
                onClick: refreshSubscription,
              }, busy === 'update' ? t('subscription.updating') : t('subscription.update')))),
          h('div', { className: 'dshvpn-form' },
            h('input', {
              className: 'dshvpn-input',
              type: 'url',
              value: urlValue,
              placeholder: t('subscription.placeholder'),
              'aria-label': t('subscription.url'),
              spellCheck: false,
              autoComplete: 'off',
              disabled: busy === 'subscription',
              onChange: (event) => {
                setDraftUrl(event.currentTarget.value);
              },
              onKeyDown: (event) => {
                if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
                if (event.key === 'Enter') {
                  event.preventDefault();
                  saveSubscription();
                }
              },
            }),
            h('button', {
              type: 'button',
              className: 'dshvpn-btn',
              'data-variant': 'primary',
              'data-action': 'save-subscription',
              disabled: busy !== '',
              onClick: saveSubscription,
            }, busy === 'subscription' ? t('subscription.saving') : t('subscription.save'))),
          subscription === null || typeof subscription.url !== 'string' || subscription.url.length === 0
            ? h('p', { className: 'dshvpn-hint' }, t('subscription.empty'))
            : h('dl', { className: 'dshvpn-summary' },
              h(SummaryItem, { label: t('subscription.nodes'), value: subscriptionNodes === null ? t('common.none') : subscriptionNodes }),
              h(SummaryItem, { label: t('subscription.traffic'), value: subscriptionTraffic === null ? t('common.none') : subscriptionTraffic }),
              h(SummaryItem, { label: t('subscription.expire'), value: subscriptionExpire === null ? t('common.none') : subscriptionExpire }),
              h(SummaryItem, { label: t('subscription.interval'), value: subscriptionInterval === null ? t('common.none') : subscriptionInterval })),
          subscriptionError === null ? null : h('p', { className: 'dshvpn-alert', role: 'alert' }, t('subscription.error', { message: subscriptionError })),
          subscriptionError === null && subscriptionCached ? h('p', { className: 'dshvpn-hint' }, t('subscription.cached')) : null),

        // ---- nodes ---------------------------------------------------------
        h('section', { className: 'dshvpn-card', 'aria-label': t('nodes.title') },
          h('div', { className: 'dshvpn-cardHead' },
            h('div', { className: 'dshvpn-cardTitles' },
              h('h3', { className: 'dshvpn-cardTitle' }, t('nodes.title')),
              h('p', { className: 'dshvpn-hint' }, t('nodes.hint'))),
            h('div', { className: 'dshvpn-actions' },
              h('span', { className: 'dshvpn-hint' },
                t('status.currentNode') + ': ' + (currentName === null ? t('common.none') : currentName)),
              h('button', {
                type: 'button',
                className: 'dshvpn-btn',
                'data-action': 'test',
                disabled: busy !== '' || nodeList.length === 0,
                onClick: testAll,
              }, busy === 'test' ? t('nodes.testing') : t('nodes.testAll')))),
          nodesError === null ? null : h('div', { className: 'dshvpn-row' },
            h('p', { className: 'dshvpn-alert', role: 'alert' }, t('error.load', { message: nodesError })),
            h('button', {
              type: 'button',
              className: 'dshvpn-btn',
              'data-action': 'retry-nodes',
              disabled: nodesLoading,
              onClick: () => {
                loadNodes(true);
              },
            }, t('common.retry'))),
          nodesLoading && nodes === null ? h('p', { className: 'dshvpn-muted' }, t('common.loading')) : null,
          !nodesLoading && nodeList.length === 0 ? h('p', { className: 'dshvpn-muted' }, t('nodes.empty')) : null,
          nodeList.length === 0 ? null : h('ul', { className: 'dshvpn-nodeList', role: 'list' },
            nodeList.map((node, index) => {
              const name = typeof node.name === 'string' ? node.name : String(node.name);
              const isCurrent = name === currentName;
              const selecting = busy === 'select:' + name;
              const delay = nodeDelay(node);
              return h('li', { key: name + '#' + String(index) },
                h('button', {
                  type: 'button',
                  className: 'dshvpn-node',
                  'data-current': isCurrent ? 'true' : undefined,
                  'data-node': name,
                  disabled: busy !== '' || isCurrent,
                  onClick: () => selectNode(name),
                },
                  h('span', { className: 'dshvpn-nodeText' },
                    h('span', { className: 'dshvpn-nodeName' }, name),
                    typeof node.type === 'string' && node.type.length > 0
                      ? h('span', { className: 'dshvpn-nodeType' }, node.type)
                      : null),
                  h('span', { className: 'dshvpn-delay', 'data-tone': delay.tone }, delay.text),
                  selecting
                    ? h('span', { className: 'dshvpn-switching' }, t('nodes.selecting'))
                    : (isCurrent ? h('span', { className: 'dshvpn-current' }, t('nodes.current')) : null)));
            }))));
    }

    /** Slot entry wrapper carrying the crash boundary. */
    function VpnSectionEntry(props) {
      return h(VpnErrorBoundary, null, h(VpnSection, props));
    }
    //#endregion

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS);
        ctx.effect(() => ctx.locale.register(NS, { zh: zh, en: en }), 'dsh-vpn: dictionaries');
        ctx.effect(() => installStyles(), 'dsh-vpn: stylesheet');
        ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'vpn',
          order: 65,
          label: () => t('nav'),
          locale: NS,
        }, VpnSectionEntry)), 'dsh-vpn: settings section');
      },
    };
  },
});
