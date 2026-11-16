/**
 * dsh-reminder 浏览器端 bundle（单文件，经 __ModuleLoader__ 加载）。
 *
 * 提供「提醒配置」面板（滑轨）：
 *  - 小窗位置：顶部居中 / 上右 / 上左 / 下右 / 下左 / 屏幕中央
 *  - 提醒方式：智能判断 / 手动（声音 / 弹窗 / 屏幕闪烁 多选）
 *  - 闪烁滑轨：强度 / 轮数 / 闪速 / 间隔
 *
 * 数据通道：ctx.get('remote.reminderConfig')（Typert RPC）→ getConfig / setConfig。
 */

window.__ModuleLoader__.load({
  id: 'dsh-reminder',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    // ── 常量 ────────────────────────────────────────────────────────────────

    const POSITIONS = [
      { id: 'top', label: '顶部居中' },
      { id: 'top-right', label: '上右' },
      { id: 'top-left', label: '上左' },
      { id: 'bottom-right', label: '下右' },
      { id: 'bottom-left', label: '下左' },
      { id: 'center', label: '屏幕中央' },
    ]
    const MODES = [
      { id: 'sound', label: '声音' },
      { id: 'popup', label: '弹窗' },
      { id: 'flash', label: '屏幕闪烁' },
    ]

    const DEFAULT_CFG = {
      position: 'top',
      mode: 'auto',
      manualModes: ['sound', 'popup'],
      flashOpacity: 0.35,
      flashRounds: 2,
      flashPulseMs: 300,
      flashGapMs: 400,
      enabled: true,
    }

    // ── 线路校验器（与 host 面 zod 清单对应，宽松校验必要字段）──────────────
    // client 面注册 remote 调用时，descriptor.result / parameters[].codec 必须
    // 是严格 codec { mode:'strict', typeSymbol, create }，其中 create() 返回
    // 带 parse() 的对象；否则 typert-registry 的 validateInvocation 会抛
    // "strict codec has no create() factory"，导致插件 boot 失败。

    function fail(path, expect) {
      throw new Error('dsh-reminder: 服务端数据非法 (' + path + ': ' + expect + ')')
    }
    function parseConfig(v, path) {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) fail(path, 'object')
      return {
        position: typeof v.position === 'string' ? v.position : 'top',
        mode: typeof v.mode === 'string' ? v.mode : 'auto',
        manualModes: Array.isArray(v.manualModes) ? v.manualModes.filter((x) => typeof x === 'string') : [],
        flashOpacity: typeof v.flashOpacity === 'number' && Number.isFinite(v.flashOpacity) ? v.flashOpacity : 0.35,
        flashRounds: typeof v.flashRounds === 'number' && Number.isFinite(v.flashRounds) ? v.flashRounds : 2,
        flashPulseMs: typeof v.flashPulseMs === 'number' && Number.isFinite(v.flashPulseMs) ? v.flashPulseMs : 300,
        flashGapMs: typeof v.flashGapMs === 'number' && Number.isFinite(v.flashGapMs) ? v.flashGapMs : 400,
        enabled: typeof v.enabled === 'boolean' ? v.enabled : true,
      }
    }
    function parsePatch(v, path) {
      if (v === null || typeof v !== 'object' || Array.isArray(v)) fail(path, 'object')
      return v
    }
    function codecOf(typeSymbol, parse) {
      return {
        mode: 'strict',
        typeSymbol,
        create: () => ({ parse }),
        decode: (value) => parse(value),
      }
    }

    // ── 样式（主题变量） ─────────────────────────────────────────────────────

    const css = [
      '.rm-cfg{font-size:12px;color:var(--dsw-alias-label-secondary);padding:2px 0}',
      '.rm-cfg-title{font-weight:600;color:var(--dsw-alias-label-primary);margin-bottom:4px}',
      '.rm-cfg-desc{color:var(--dsw-alias-label-tertiary);margin-bottom:10px;line-height:1.6}',
      '.rm-cfg-current{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border);border-radius:8px;padding:6px 10px;margin-bottom:10px;color:var(--dsw-alias-label-primary);font-weight:500}',
      '.rm-cfg-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:3px 0}',
      '.rm-cfg-label{flex:none;min-width:64px;color:var(--dsw-alias-label-secondary)}',
      '.rm-cfg-options{display:flex;gap:4px;flex-wrap:wrap}',
      '.rm-cfg-btn{padding:3px 10px;border-radius:6px;border:1px solid var(--dsw-alias-border);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:12px}',
      '.rm-cfg-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.rm-cfg-btn.on{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-on-brand-primary);border-color:var(--dsw-alias-brand-primary);font-weight:600;box-shadow:0 0 0 1px var(--dsw-alias-brand-primary)}',
      '.rm-cfg-slider-row{display:flex;align-items:center;gap:8px;margin:2px 0}',
      '.rm-cfg-slider-label{flex:none;min-width:96px;color:var(--dsw-alias-label-secondary)}',
      '.rm-cfg-slider-row input[type=range]{flex:1;max-width:220px;accent-color:var(--dsw-alias-brand-primary)}',
      '.rm-cfg-check{display:inline-flex;align-items:center;gap:3px;cursor:pointer;margin-right:8px}',
      '.rm-cfg-hint{color:var(--dsw-alias-label-tertiary);margin-top:3px}',
    ].join('\n')

    // ── 面板组件 ────────────────────────────────────────────────────────────

    function ConfigPanel({ api }) {
      const [cfg, setCfg] = React.useState(null)
      // 服务端响应延迟/乱序会弹回滑块：本地乐观值为权威，RPC 仅用于持久化
      const [pending, setPending] = React.useState(false)

      React.useEffect(() => {
        let alive = true
        api.getConfig().then((next) => { if (alive) setCfg(next) }).catch(() => {})
        return () => { alive = false }
      }, [api])

      const update = (patch) => {
        const next = { ...(cfg || DEFAULT_CFG), ...patch }
        setCfg(next)
        // 状态式更新：防止快速连点时旧响应覆盖新值——用最终状态发送
        setPending(true)
        api.setConfig(patch).then(() => setPending(false)).catch(() => setPending(false))
      }

      if (cfg === null) return React.createElement('div', { className: 'rm-cfg' }, '加载配置中…')

      const row = (label, children, key) => React.createElement('div', { key, className: 'rm-cfg-row' },
        React.createElement('span', { className: 'rm-cfg-label' }, label),
        children)

      const slider = (label, key, min, max, step, fmt) => React.createElement('div', { key, className: 'rm-cfg-slider-row' },
        React.createElement('span', { className: 'rm-cfg-slider-label' }, label + '：' + fmt(cfg[key] ?? min)),
        React.createElement('input', {
          type: 'range',
          min,
          max,
          step,
          value: cfg[key] ?? min,
          onChange: (e) => update({ [key]: Number(e.target.value) }),
        }))

      const posButtons = React.createElement('div', { className: 'rm-cfg-options' },
        POSITIONS.map((p) => React.createElement('button', {
          key: p.id,
          className: 'rm-cfg-btn' + (cfg.position === p.id ? ' on' : ''),
          onClick: () => update({ position: p.id }),
        }, (cfg.position === p.id ? '✓ ' : '') + p.label)))

      const modeButtons = React.createElement('div', { className: 'rm-cfg-options' },
        React.createElement('button', {
          key: 'auto',
          className: 'rm-cfg-btn' + (cfg.mode === 'auto' ? ' on' : ''),
          onClick: () => update({ mode: 'auto' }),
        }, (cfg.mode === 'auto' ? '✓ ' : '') + '智能判断'),
        React.createElement('button', {
          key: 'manual',
          className: 'rm-cfg-btn' + (cfg.mode === 'manual' ? ' on' : ''),
          onClick: () => update({ mode: 'manual' }),
        }, (cfg.mode === 'manual' ? '✓ ' : '') + '手动'))

      const manualChecks = cfg.mode !== 'manual' ? null : React.createElement('div', { className: 'rm-cfg-options' },
        MODES.map((m) => {
          const on = (cfg.manualModes || []).includes(m.id)
          return React.createElement('label', { key: m.id, className: 'rm-cfg-check' },
            React.createElement('input', {
              type: 'checkbox',
              checked: on,
              onChange: (e) => {
                const cur = cfg.manualModes || []
                update({ manualModes: e.target.checked ? [...cur, m.id] : cur.filter((x) => x !== m.id) })
              },
            }),
            m.label)
        }))

      const flashSliders = React.createElement('div', { className: 'rm-cfg-flash' },
        slider('闪烁强度', 'flashOpacity', 0.05, 0.9, 0.05, (v) => Math.round(v * 100) + '%'),
        slider('闪烁轮数', 'flashRounds', 1, 6, 1, (v) => v + ' 轮'),
        slider('闪速（ms）', 'flashPulseMs', 50, 800, 50, (v) => v + 'ms'),
        slider('间隔（ms）', 'flashGapMs', 100, 1500, 100, (v) => v + 'ms'))

      const posLabel = POSITIONS.find((p) => p.id === cfg.position)?.label || cfg.position
      const modeLabel = cfg.mode === 'auto' ? '智能判断' : '手动'
      const manualLabel = cfg.mode === 'manual'
        ? (cfg.manualModes || []).map((m) => MODES.find((x) => x.id === m)?.label || m).join('、') || '（未选择）'
        : '无'
      const hint = cfg.mode === 'auto'
        ? '智能：激烈网游→黑白屏闪；看剧/休闲→弹窗+声音；其他→声音+弹窗'
        : '手动：勾选需要的方式（至少一种）'

      return React.createElement('div', { className: 'rm-cfg' },
        React.createElement('div', { className: 'rm-cfg-desc' },
          '任务需要你决定/辅助时，若检测到你在看剧/玩游戏，会按下面的方式提醒你回到工作。'),
        React.createElement('div', { className: 'rm-cfg-current' },
          '当前：小窗 ' + posLabel + ' ｜ 方式 ' + modeLabel +
          (cfg.mode === 'manual' ? '（' + manualLabel + '）' : '') +
          ' ｜ 闪烁 ' + Math.round((cfg.flashOpacity ?? 0.35) * 100) + '% × ' + (cfg.flashRounds ?? 2) + ' 轮' +
          (pending ? '（保存中…）' : '')),
        row('小窗位置', posButtons, 'pos'),
        row('提醒方式', modeButtons, 'mode'),
        manualChecks === null ? null : row('具体方式', manualChecks, 'manual'),
        flashSliders,
        React.createElement('div', { className: 'rm-cfg-hint' }, hint))
    }

    // ── 远程服务注册 ────────────────────────────────────────────────────────

    const CONTRIBUTION = {
      package: 'dsh-reminder',
      descriptors: [
        {
          id: 'dsh-reminder#reminderConfig/getConfig',
          service: 'reminderConfig',
          namespace: 'reminderConfig',
          method: 'getConfig',
          invocation: { kind: 'direct' },
          parameters: [],
          result: codecOf('dsh-reminder#ReminderConfig', parseConfig),
        },
        {
          id: 'dsh-reminder#reminderConfig/setConfig',
          service: 'reminderConfig',
          namespace: 'reminderConfig',
          method: 'setConfig',
          invocation: { kind: 'direct' },
          parameters: [
            {
              name: 'patch',
              wire: 'patch',
              source: 'json',
              codec: codecOf('dsh-reminder#ReminderConfigPatch', parsePatch),
            },
          ],
          result: codecOf('dsh-reminder#ReminderConfig', parseConfig),
        },
      ],
    }

    const inject = ['remote']

    async function apply(ctx) {
      const remote = ctx.remote
      if (remote === undefined || typeof remote.$mount !== 'function') return
      const unmount = await remote.$mount(CONTRIBUTION)
      ctx.effect(() => () => { unmount() }, 'dsh-reminder: remote contribution')

      const reminderConfig = ctx.get('remote.reminderConfig')
      if (reminderConfig === undefined) return

      // 样式注入
      const style = document.createElement('style')
      style.textContent = css
      document.head.appendChild(style)
      ctx.effect(() => () => { document.head.removeChild(style) }, 'dsh-reminder: styles')

      const api = {
        getConfig: () => reminderConfig.getConfig(),
        setConfig: (patch) => reminderConfig.setConfig(patch),
      }

      // 缓存：设置页重挂载时先显示上次的值，避免 RPC 慢导致 UI 闪回旧值
      let cachedCfg = null
      const getCached = () => {
        if (cachedCfg !== null) return Promise.resolve(cachedCfg)
        return api.getConfig().then((next) => { cachedCfg = next; return next })
      }
      const setCached = (patch) => {
        if (cachedCfg === null) cachedCfg = { ...DEFAULT_CFG, ...patch }
        else cachedCfg = { ...cachedCfg, ...patch }
        return api.setConfig(patch).then((saved) => { cachedCfg = saved; return saved })
      }
      const viewApi = {
        getConfig: getCached,
        setConfig: setCached,
      }

      const slots = ctx.get('slots')
      if (slots === undefined) return
      // 注册为设置页「桌面通知」：设置导航栏出现入口，点开即滑轨配置面板
      slots.inject('settings.section', () => {
        const dispose = slots.register(
          {
            name: 'settings.section',
            id: 'reminder',
            label: '桌面通知',
            order: 60,
            inject: () => ({ api: viewApi }),
          },
          (props) => React.createElement(ConfigPanel, { api: props.api || viewApi }),
        )
        return dispose
      })
    }

    module.exports.inject = inject
    module.exports.apply = apply
    return module.exports
  },
})
