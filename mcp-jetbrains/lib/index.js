/**
 * DSH Host plugin: one manager for several JetBrains IDE MCP servers.
 *
 * Every enabled connection mounts one `@deepseek-ai/dsh-mcp-client` child plugin
 * under this plugin's fiber, so IntelliJ IDEA, CLion and PyCharm appear side by
 * side as `mcp__<serverName>__*` tools. Tool names are unchanged from the earlier
 * single-connection bundle: the `idea` connection keeps `serverName: idea`, so the
 * IDE router tool stays `mcp__idea__execute_tool`.
 *
 * A child that cannot connect (IDE closed, wrong port) only logs: it never fails
 * this plugin's activation and never stops the other connections.
 *
 * ── Where the connections live ──────────────────────────────────────────────
 * In this plugin's OWN store, never in the profile's `cordis.patch.yml`:
 *
 *     $DSH_HOME/storages/dsh-mcp-jetbrains.connections.json
 *     { "version": 1, "connections": [ … ] }        (UTF-8, no BOM, LF)
 *
 * The profile patch row belongs to the Loader (and, on this machine, sits inside
 * the skin manager's auto-generated block), so a settings save that edited it
 * would be overwritten by the next skin write. The store is resolved from the
 * `dshHomePath` service when the running composition provides it, else from
 * `$DSH_HOME`, else `~/.dsh`. Read order: own store -> (one-time) the pre-rename
 * store `dsh-mcp-idea.connections.json` -> the legacy `connections` array a
 * profile patch may still carry -> `DEFAULT_CONNECTIONS`. Each legacy source is
 * copied into the store once on activation: the old store file is deliberately
 * LEFT IN PLACE (a rollback to the old bundle still finds its rows) and the copy
 * only runs while this build's own file is absent, so the old file can never
 * overwrite an existing store. A legacy patch array is migrated the same way, so
 * removing it from the patch loses nothing.
 *
 * ── The settings page routes (mounted from here) ────────────────────────────
 *
 *   GET  /dsh-mcp-jetbrains/config     current rows, which of them are mounted, health, store facts
 *   GET  /dsh-mcp-jetbrains/config?probe=surface
 *                                 the same view, after forcing ONE tool-surface check on every
 *                                 mounted row (a fresh MCP session + `tools/list`), so the page
 *                                 opens on a fact read now instead of the last timer tick
 *   POST /dsh-mcp-jetbrains/config     validate, write the store, remount every row
 *   POST /dsh-mcp-jetbrains/reconnect  rebuild one child in place (IDE restarted)
 *   POST /dsh-mcp-jetbrains/ide-io     flip the global "file IO goes through the IDE" switch
 *
 * `?probe=surface` is deliberately opt-in: one IDEA `tools/list` is ~138 KiB, so only
 * a page load or a manual refresh asks for it, while the page's 15-second status poll
 * keeps reading the cached health. Each response also carries `diagnostics`: the last
 * 50 automatic actions (see below), newest first.
 *
 * A save no longer restarts this plugin: `ctx.configEditor.edit` is gone, so the
 * route stays up and the response reports what is actually mounted now.
 *
 * ── Who may call those routes ───────────────────────────────────────────────
 * Every route starts with DSH's own browser-trust decision,
 * `ctx.connection.requestRejection(req)`: the Host/Origin fence plus the signed
 * `dsh-auth-*` browser cookie, judged by Connection in its own order. The
 * settings page is same-origin and carries that cookie, so it passes; a request
 * with no identity (curl, another page, a rebound host) gets 401/403 and a body
 * that names neither the rows nor the store path. A composition without the
 * `connection` service falls back to the same-origin invariant only (loopback
 * Host, no cross-site marker, Origin equal to the request authority) instead of
 * inventing a second credential.
 *
 * ── Automatic reload ────────────────────────────────────────────────────────
 * Every mounted row with `autoReload` (default true) gets one lightweight probe:
 * a TCP dial to the endpoint, then an MCP `ping` on a canary Streamable HTTP
 * session this plugin opens itself and keeps open with a GET SSE stream. That
 * stream is not decoration: measured on IDEA 2026.2.3, a session with no stream
 * is dropped after ~15 seconds idle, and a held stream survives (the server sends
 * `: heartbeat` comments). It is also the fastest restart detector — the IDE keeps
 * MCP sessions in memory, so a restart closes the stream — and it carries
 * `notifications/tools/list_changed`. A `404 Streamable HTTP session not found`
 * on the canary means the server restarted since the mount, which is exactly when
 * the child client's own session is dead. Every second healthy probe the canary
 * also re-reads `tools/list` and compares those names with the generation the
 * child registered, which is how a changed tool surface (the IDE's router-only
 * switch, for example) is noticed. Two consecutive abnormal probes remount that
 * ONE row through the same dispose-then-mount path the settings page uses: the
 * other rows, this plugin, and the store are untouched. The configured base
 * interval (default 30s) backs off up to 4x while healthy — never beyond 45s, so
 * a changed tool surface is seen within 2 x 45s = 90s even in the worst case —
 * and narrows to a quarter while abnormal; a stream event triggers an immediate
 * re-check.
 *
 * ── Diagnosing a failed MCP tool call (one retry at most) ───────────────────
 * The plugin also wraps `tools/execute` (the documented waterfall for
 * retry/metrics). When a call to one of ITS OWN `mcp__<serverName>__*` tools comes
 * back as a failure, it first re-reads that connection's tool list on a brand-new
 * MCP session and compares the invoked tool's original name with it:
 *
 *   - name absent  -> `tool-missing`: no retry (retrying a name the server does not
 *     list cannot work). The result is replaced with an explicit "tool does not
 *     exist" answer carrying the current tool count and any similar names, so the
 *     upper layer sees a name problem rather than a mysterious call failure.
 *   - name present -> only a transport/session error (session not found,
 *     ECONNREFUSED, ECONNRESET, fetch failed, socket hang up, timed out/timeout,
 *     EPIPE) may retry. Everything else — argument validation, business errors,
 *     4xx semantics — is returned untouched.
 *
 * The retry remounts that ONE row in place, waits (bounded by 10s) for the tool to
 * be registered again, and re-dispatches the same arguments exactly once. A second
 * failure keeps the failure semantics and appends the structured diagnosis plus
 * the original error text; the original error is never swallowed and no retry ever
 * happens without a completed diagnosis. Automatic remounts for this path share a
 * 60-second per-connection cooldown so a storm of failing calls cannot churn the
 * child. Every automatic action lands in the 50-entry ring buffer exposed as
 * `diagnostics`.
 *
 *
 * The plugin also tells the `settings` service that its page is self-provided
 * (`configure({ auto: false })` inside an optional `ctx.inject(['settings'])`),
 * so a future client-side schema-to-page implementation will not build a second,
 * competing page for this plugin. Settings missing (a composition without it)
 * changes nothing else.
 *
 * ── "File IO goes through the IDE" (`ideIo`) ────────────────────────────────
 * The store carries one extra document-level field next to `connections`:
 *
 *     { "version": 1, "ideIo": { "enabled": true }, "connections": [ … ] }
 *
 * The switch defaults to ON: a file without the field (an older store) reads as
 * `{ enabled: true }` and the default is written back on activation, while any
 * explicit boolean in the store is honoured as-is — a user's `false` is never
 * overridden. The switch is deliberately NOT part of `Config` (it is
 * presentation-independent state that must survive a profile patch rewrite), and
 * every write to it goes through `POST /dsh-mcp-jetbrains/ide-io`. While it is
 * on, this plugin's `tools/execute` wrapper intercepts `read`, `write` and `edit`
 * BEFORE calling `next()` and runs them on the selected IDE through its MCP
 * server:
 *
 *   read  -> read_file { offset, limit }                  (bounded range, native window)
 *   write -> read_file (existence + `before`) + create_new_file { overwrite: true }
 *   edit  -> search_text (locate the first distinctive line) + apply_patch
 *
 * `edit` never reads the file: exactly one search hit becomes a line-anchored
 * unified diff, multiple hits are refused with their candidate line numbers, and
 * an apply_patch rejection is returned with the IDE's own text plus a "longer
 * old_string" hint. The installed IDE (2026.2.3) takes `offset`/`limit` on
 * `read_file` (verified against the bundled jar and by measurement); its newer
 * 2026.2 documentation's `mode` flags are not honoured by this build.
 *
 * The connection is chosen by longest case-insensitive prefix of the target's
 * absolute path against each enabled row's `projectPath`; a tie is ambiguous, and
 * with no match exactly one enabled row is used as a fallback (logged and recorded
 * in `diagnostics`). EVERY unroutable case with at least one enabled row — a path
 * outside every project while several rows are enabled, an unmounted row, an IDE
 * error — returns an explicit `isError` result whose text names the three remedies
 * (turn the switch off / enable a matching connection / fix `projectPath`). It
 * never calls `next()` and never touches the disk on its own, because a silent
 * fallback would make the model believe the IDE's view was consulted when it was
 * not.
 *
 * The ONE exception is "switch on, zero enabled connections": then this plugin has
 * nothing that could ever accept the call, so it does NOT guess — it asks the user
 * through `ctx.get('userQuestions')` (optional dependency; `inject` unchanged):
 * paste an IDE config (create one connection and re-route THIS call), use the DSH
 * native path for this call only, or cancel. Only the native answer reaches
 * `next()`, and that pass-through is recorded as
 * `verdict: "ide-io-user-approved-passthrough"` / `action: "passthrough"` and
 * carries a visible note on the result. Paste parses, promotes and mounts a new
 * enabled row, then re-routes; a failed parse, a failed route after creation, a
 * cancelled answer, a thrown question and a missing service are all explicit
 * failures that name the three remedies (add a connection in Settings / paste the
 * config here / turn the switch off). Nothing in this branch silently touches the
 * disk, and nothing is persisted unless the user pasted a valid config.
 *
 * Result shapes stay those of the native tools: the wrapper returns the canonical
 * `value` (`{path, offset, lines, totalLines}` / `{path, operation, before, after}`
 * / `{path, before, after}`) and the pipeline's own render/presentationMeta turn it
 * into the same content envelope and `meta` the native tools produce. Known gaps:
 * IDE writes follow the IDE's line-ending setting (typically CRLF), `read_file`
 * normalizes line endings and answers a whole requested range rather than the
 * native byte-exact window (parsed and re-windowed here), `edit` returns the
 * replaced literal as `before`/`after` instead of the whole file (no read), and
 * an `edit` whose `old_string` is not a whole-line block, or whose surrounding
 * lines cannot disambiguate it, is refused rather than guessed.
 *
 * @module dsh-mcp-jetbrains
 */
import { createHash } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { connect as netConnect } from 'node:net';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import z from '@deepseek-ai/schemastery';
import * as McpClient from '@deepseek-ai/dsh-mcp-client';
/** Loader-visible plugin name, used by diagnostics. */
export const name = 'dsh-mcp-jetbrains';
/** Mounted children register their tools on `ctx.tools`, so wait for that service. */
export const inject = ['tools'];
/** Package name as written in the profile patch row. */
const PACKAGE_NAME = 'dsh-mcp-jetbrains';
/** Same bound `@deepseek-ai/dsh-mcp-client` applies to its own `serverName`. */
const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;
/** Route prefix shared with `client.js`. */
const ROUTE_BASE = '/dsh-mcp-jetbrains';
/**
 * URL scheme spellings, split into a bare scheme plus `://` where a message or a
 * template needs one. Keeping the literal `http://` out of the source is the same
 * trick `client.tsx` uses: the IDE's insecure-link inspection must not fire on
 * loopback addresses that are `http` by definition.
 */
const SCHEME_HTTP = 'http';
const SCHEME_HTTPS = 'https';
/** Largest settings write this plugin accepts. */
const MAX_BODY_BYTES = 256 * 1024;
/** This build's version, carried in the probe's MCP `initialize` clientInfo. */
const PLUGIN_VERSION = '0.10.0';
/** Default automatic-reload probe interval; `Config.probeIntervalMs` overrides it. */
const PROBE_INTERVAL_DEFAULT_MS = 30_000;
/** Probe interval bounds: quick enough to notice an IDE restart, slow enough to be a no-op. */
const PROBE_INTERVAL_MIN_MS = 5_000;
const PROBE_INTERVAL_MAX_MS = 300_000;
/** TCP dial timeout for one probe; the IDE listens on loopback, so this is generous. */
const PROBE_TCP_TIMEOUT_MS = 1_500;
/** HTTP timeout for one probe request. */
const PROBE_HTTP_TIMEOUT_MS = 4_000;
/** First probe after a mount: opens the canary session right away, so the restart window stays tiny. */
const PROBE_FIRST_DELAY_MS = 3_000;
/** A stream event (restart, tool-list change) asks for a re-check this soon. */
const PROBE_NUDGE_DELAY_MS = 800;
/** A freshly mounted child needs this long to register its tool generation. */
const MOUNT_GRACE_MS = 10_000;
/** Consecutive abnormal probes required before an automatic remount, so one blip never churns. */
const PROBE_FAILURE_THRESHOLD = 2;
/** Re-read the server's tool list every Nth healthy probe (one IDEA list is ~135 KiB). */
const PROBE_SURFACE_EVERY = 2;
/**
 * Healthy probes widen the interval up to this multiple of the configured base...
 */
const PROBE_OK_BACKOFF_FACTOR = 4;
/**
 * ...but never past this ceiling. With `surfaceEvery = 2` the worst-case delay
 * before a changed tool surface is noticed is 2 x 45s = 90s (it used to be
 * 2 x 120s = 4 minutes). The ceiling also bounds the jitter, so a healthy row is
 * never rescheduled later than 45s out.
 */
const PROBE_OK_BACKOFF_MAX_MS = 45_000;
/** Automatic remount backoff: doubles per consecutive restart, capped here. */
const PROBE_RESTART_DELAY_MIN_MS = 30_000;
const PROBE_RESTART_DELAY_MAX_MS = 300_000;
/** Consecutive healthy probes that reset the remount backoff. */
const PROBE_RESTART_RESET_AFTER = 3;
/** Budget for one forced `?probe=surface` check (three MCP round trips). */
const PROBE_FORCE_TIMEOUT_MS = 8_000;
/** Budget for the tool-list read that starts a failed-call diagnosis. */
const DIAGNOSE_TIMEOUT_MS = 6_000;
/** How long a retry waits for the remounted child to register the tool again. */
const RETRY_REMOUNT_WAIT_MS = 10_000;
/** One connection may be remounted for a failed call at most once per this window. */
const AUTO_REMOUNT_COOLDOWN_MS = 60_000;
/** Automatic actions kept in the in-memory ring buffer behind `diagnostics`. */
const DIAGNOSTICS_LIMIT = 50;
/**
 * Model-facing file tools this plugin owns while `ideIo` is on. These are the
 * names `@deepseek-ai/dsh-tool-fs` registers in this profile (`read`, `write`,
 * `edit`); activation logs which of them the registry actually carries, and
 * `GET /config` reports the same list, so a renamed tool is visible instead of
 * silently staying on the disk path.
 */
const FILE_TOOL_NAMES = ['read', 'write', 'edit'];
/**
 * Question asked when the switch is on but no enabled connection could accept the
 * call. The id is echoed by the answer; the labels are answer VALUES, so they are
 * compared literally and must stay in sync with the options below.
 */
const ASK_IDE_IO_QUESTION_ID = 'ide-io-no-connection';
const ASK_OPTION_PASTE = '粘贴 JetBrains 配置';
const ASK_OPTION_NATIVE = '本次改用 DSH 原生读写';
const ASK_OPTION_CANCEL = '取消本次操作';
/** Native read caps (the profile keeps the `dsh-tool-fs` defaults). */
const READ_LIMIT = 2000;
const READ_MAX_LINE_LENGTH = 2000;
const READ_MAX_BYTES = 50 * 1024;
/** One IDE file operation may take longer than a probe; keep the bound generous. */
const IDE_IO_TIMEOUT_MS = 30_000;
/** `edit`: context lines read on each side of a candidate (narrow window). */
const EDIT_CONTEXT_LINES = 3;
/** `edit`: more candidates than this fail immediately instead of being read one by one. */
const EDIT_CANDIDATE_LIMIT = 10;
/** `edit`: hard cap on lines read across one closed loop (candidates + retry). */
const EDIT_READ_LINE_BUDGET = 200;
/** `edit`: `apply_patch` attempts — the first one plus one self-corrected retry. */
const EDIT_PATCH_ATTEMPTS = 2;
/** Directory under the harness home that holds per-plugin durable files. */
const STORE_DIR = 'storages';
/** This plugin's own store file; the name carries the plugin and never collides
 * with a `@deepseek-ai/dsh-storage-json` unit (`^[a-z][a-z0-9_]*$` — no dots or dashes). */
const STORE_FILE = 'dsh-mcp-jetbrains.connections.json';
/**
 * The store file of the pre-rename bundle (`@local/dsh-mcp-idea`). It is read
 * ONCE, only when {@link STORE_FILE} does not exist yet, and is never deleted or
 * overwritten: keeping it lets a rollback to the old bundle find its rows again.
 */
const LEGACY_STORE_FILE = 'dsh-mcp-idea.connections.json';
/** Store document version written by this build. */
const STORE_VERSION = 1;
/** One IDE connection. */
const Connection = z.object({
    id: z.string().required()
        .description('Stable row id, for example "idea". Only used for logs and diagnostics.'),
    serverName: z.string().required().pattern(SERVER_NAME_PATTERN)
        .description('Tool-name namespace: this IDE is exposed as mcp__<serverName>__<tool>.'),
    url: z.string().default('')
        .description('Streamable HTTP endpoint of the IDE MCP server, for example http://127.0.0.1:64342/stream.'),
    projectPath: z.string().default('')
        .description('Absolute IDE project path sent as the IJ_MCP_SERVER_PROJECT_PATH header; empty sends no header.'),
    enabled: z.boolean().default(true)
        .description('Mount this connection.'),
    autoReload: z.boolean().default(true)
        .description('Probe this connection in the background and remount it automatically after an IDE restart, a dead MCP session, or a changed tool surface.'),
});
/** Defaults keep the connection the previous bundle had, plus two disabled rows. */
const DEFAULT_CONNECTIONS = [
    {
        id: 'idea',
        serverName: 'idea',
        url: 'http://127.0.0.1:64342/stream',
        projectPath: "D:/shing_of_kai/SourceCode/ShaoZhu'sDSHPlugins/dsh_jetbrains_interaction",
        enabled: true,
        autoReload: true,
    },
    {
        id: 'clion',
        serverName: 'clion',
        url: 'http://127.0.0.1:64362/stream',
        projectPath: '',
        enabled: false,
        autoReload: true,
    },
    {
        id: 'pycharm',
        serverName: 'pycharm',
        url: 'http://127.0.0.1:64462/stream',
        projectPath: '',
        enabled: false,
        autoReload: true,
    },
];
/**
 * Plugin config.
 *
 * `connections` is LEGACY: it is read at most once, only to migrate a profile
 * patch that still carries the old array into the plugin's own store. It has no
 * default on purpose — the schema default would be indistinguishable from a
 * user-supplied array, and every later save would then rewrite the store from a
 * default nobody asked for. New writes always go to the store.
 */
export const Config = z.object({
    connections: z.array(Connection)
        .description('[legacy, migrated once] Connection rows from a profile patch; the store above is authoritative.'),
    probeIntervalMs: z.number().step(1_000).min(PROBE_INTERVAL_MIN_MS).max(PROBE_INTERVAL_MAX_MS)
        .description('Automatic-reload base probe interval in milliseconds (default 30000). Healthy connections back off up to 4x, abnormal ones narrow to a quarter.'),
});
/** Trimmed string, or `''` for anything that is not a string. */
function text(value) {
    return typeof value === 'string' ? value.trim() : '';
}
/** Row id used for logs and the mount table; falls back to the row position. */
function rowId(connection, index) {
    return text(connection?.id) || `connection-${index + 1}`;
}
/**
 * Project one configured row onto exactly the five persisted fields.
 * @param connection - raw or resolved row.
 * @param index - row position, used for the fallback id.
 * @returns the row as the settings form and the store see it.
 */
function rowOf(connection, index) {
    return {
        id: rowId(connection, index),
        serverName: text(connection?.serverName),
        url: text(connection?.url),
        projectPath: text(connection?.projectPath),
        enabled: connection?.enabled === undefined ? true : Boolean(connection.enabled),
        autoReload: connection?.autoReload === undefined ? true : Boolean(connection.autoReload),
    };
}
/** Why a row cannot be mounted, or `''` when it can. */
function blockerOf(row) {
    if (!row.enabled)
        return 'disabled';
    if (row.url === '')
        return 'no-url';
    if (!SERVER_NAME_PATTERN.test(row.serverName))
        return 'bad-server-name';
    return '';
}
/** Human-readable form of one blocker, for logs and the settings page. */
function blockerText(reason) {
    if (reason === 'disabled')
        return '该连接已禁用，没有挂载';
    if (reason === 'no-url')
        return 'MCP 地址为空，没有挂载';
    if (reason === 'bad-server-name')
        return 'serverName 不合法，没有挂载';
    return '';
}
/** Log wording for one probe state (the settings page carries its own copy). */
function healthText(state) {
    if (state === 'unreachable')
        return '探测不通，IDE 没有在监听';
    if (state === 'stale')
        return '探测判定会话/工具面失效';
    if (state === 'remounting')
        return '自动重挂中';
    return '正常';
}
/** Whether a string is an absolute http(s) URL the mcp-client accepts. */
function isHttpUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'http:' || url.protocol === 'https:';
    }
    catch {
        return false;
    }
}
/**
 * Parse what the IDE's "Copy configuration" action produces, on the Host.
 *
 * This is the Host's own implementation of the rules the settings page applies
 * to its paste box; it deliberately does NOT import from `client.js`, because the
 * browser bundle is loaded by a different loader and the Host must be able to
 * accept a paste with no page involved. Supported shapes:
 *
 *   1. `{ "mcpServers": { "<key>": { "url": … } } }` — the IDE's real output, 1..n
 *   2. one server object carrying a top-level `url`
 *   3. a bare URL (also accepted when JSON-encoded as a string)
 *
 * @param raw - the custom answer typed into the question.
 * @returns entries in input order, or a precise reason why nothing could be read.
 */
function parsePastedIdeConfig(raw) {
    const source = text(raw);
    if (source === '') {
        return { error: '自定义回答是空的：把 IDE「复制配置」得到的 JSON，或者只把 MCP 地址粘进来。' };
    }
    let body;
    try {
        body = JSON.parse(source.replace(/^\uFEFF/, ''));
    }
    catch (error) {
        // A bare address is not JSON, and it is the most common hand-typed paste.
        if (isHttpUrl(source))
            return { entries: [{ key: '', url: source }] };
        return {
            error: '这段内容既不是一个完整地址，也不是合法 JSON：'
                + `${messageOf(error)}。若只想导入一条连接，可以直接粘贴 ${SCHEME_HTTP}://… 地址。`,
        };
    }
    if (typeof body === 'string') {
        const value = text(body);
        if (isHttpUrl(value))
            return { entries: [{ key: '', url: value }] };
        return { error: `粘贴的是一个 JSON 字符串，但它不是 ${SCHEME_HTTP}:// 或 ${SCHEME_HTTPS}:// 地址：${value.slice(0, 120)}` };
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return {
            error: 'JSON 顶层是' + (Array.isArray(body) ? '数组' : typeof body)
                + '，需要一个对象 { "mcpServers": { … } } 或一个含 url 的 server 对象。',
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
        entries = keys.map((key) => ({ key, label: key, spec: servers[key] }));
    }
    else if (typeof body.url === 'string') {
        const named = typeof body.name === 'string' ? body.name : (typeof body.serverName === 'string' ? body.serverName : '');
        entries = [{ key: named, label: '（单个 server）', spec: body }];
    }
    else {
        return {
            error: '这个 JSON 里既没有 mcpServers，也没有顶层 url 字段。IDE「复制配置」通常长这样：'
                + '{"mcpServers":{"idea":{"type":"streamable-http","url":"' + SCHEME_HTTP + '://127.0.0.1:64342/stream"}}}',
        };
    }
    const items = [];
    const problems = [];
    for (const entry of entries) {
        const spec = entry.spec;
        if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
            problems.push(`「${entry.label}」的值不是对象`);
            continue;
        }
        const url = text(spec.url);
        if (url === '') {
            const stdio = typeof spec.command === 'string' && spec.command.trim() !== '';
            problems.push('「' + entry.label + '」没有 url 字段'
                + (stdio ? '（这是 command/args 的 stdio 配置，本插件只连 Streamable HTTP）' : '（IDE 的复制配置里一定有 url）'));
            continue;
        }
        if (!isHttpUrl(url)) {
            problems.push(`「${entry.label}」的 url 不是完整的 ${SCHEME_HTTP}:// 或 ${SCHEME_HTTPS}:// 地址：${url.slice(0, 120)}`);
            continue;
        }
        items.push({ key: entry.key, url });
    }
    if (problems.length > 0)
        return { error: `这次没有导入任何一条：${problems.join('；')}` };
    return { entries: items };
}
/**
 * Fold a pasted server key into the `^[A-Za-z0-9_-]{1,32}$` space. Uniqueness is
 * a separate step: the same cleaning rule can map two keys to the same name.
 * @param raw - the key from `mcpServers`, or a name field.
 */
function sanitizeServerName(raw) {
    return text(raw)
        .replace(/[^A-Za-z0-9_-]+/g, '-')
        .replace(/-{2,}/g, '-')
        .replace(/^-+/, '')
        .slice(0, 32);
}
/** Port of a parsed URL, for naming a connection pasted as a bare address. */
function portOfUrl(url) {
    try {
        return new URL(url).port;
    }
    catch {
        return '';
    }
}
/**
 * Base `serverName` for a pasted entry: its cleaned key, or `idea` / `idea-<port>`
 * when the paste carried no name (a bare URL).
 * @param key - the key from the pasted JSON, possibly `''`.
 * @param url - the validated MCP address.
 */
function pastedNameBase(key, url) {
    const cleaned = sanitizeServerName(key);
    if (cleaned !== '')
        return cleaned;
    const port = portOfUrl(url);
    return port === '' ? 'idea' : `idea-${port}`;
}
/**
 * Pick a name that is not in `taken`: `base`, `base-2`, `base-3`… (all ≤32 chars).
 * Mirrors the settings page so a paste in the question and a paste in the page
 * produce the same names.
 * @param base - the desired base name.
 * @param taken - names already in use.
 */
function uniqueName(base, taken) {
    const root = base === '' ? 'jetbrains' : base.slice(0, 32);
    if (!taken.has(root))
        return root;
    for (let index = 2; index < 100; index += 1) {
        const suffix = `-${index}`;
        const head = root.length + suffix.length > 32 ? root.slice(0, 32 - suffix.length) : root;
        const candidate = head + suffix;
        if (!taken.has(candidate))
            return candidate;
    }
    return `${root.slice(0, 27)}-100`;
}
/* ── "File IO goes through the IDE": path, text and MCP plumbing ─────────────
 *
 * Everything below is pure (or filesystem-read-only for canonical paths) so the
 * interception logic stays one readable layer above the MCP transport. The IDE
 * is the ONLY content source while the switch is on: no function here reads file
 * bytes from disk. `realpath` is used for the same canonical spelling the native
 * `read`/`write` result carries, never to obtain content.
 */
/** Expand a leading `~` the way the local fs provider does. */
function expandHomePath(value) {
    if (value === '~')
        return homedir();
    if (value.startsWith('~/') || value.startsWith('~\\'))
        return join(homedir(), value.slice(2));
    return value;
}
/** Resolve a model-supplied path against the session directory. */
function absolutePathOf(filePath, cwd) {
    return resolve(cwd, expandHomePath(filePath));
}
/**
 * Canonical absolute path used in the native result shape. For an existing target
 * this is the realpath (exactly what `ctx.fs.processPath` returns); for a target
 * that does not exist yet it is the realpath of the nearest existing directory
 * plus the missing suffix.
 * @param absolute - already resolved absolute path.
 * @returns the canonical spelling, with the platform separator.
 */
async function canonicalPathOf(absolute) {
    try {
        return await realpath(absolute);
    }
    catch {
        try {
            return join(await realpath(dirname(absolute)), basename(absolute));
        }
        catch {
            return absolute;
        }
    }
}
/**
 * Normalize a path for prefix comparison: absolute, forward slashes, no trailing
 * separator (a bare drive root keeps its slash), lowercased on Windows.
 * @param value - absolute path.
 * @returns the comparison key.
 */
function comparablePath(value) {
    let normalized = resolve(value).replace(/\\/g, '/').replace(/\/+$/, '');
    if (/^[A-Za-z]:$/.test(normalized))
        normalized += '/';
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
/**
 * Whether a normalized file path lies inside a normalized project path.
 * The separator boundary matters: `D:/a/bc` is not inside `D:/a/b`.
 */
function isWithinProject(file, project) {
    if (project === '')
        return false;
    if (file === project)
        return true;
    const root = project.endsWith('/') ? project : `${project}/`;
    return file.startsWith(root);
}
/**
 * Project-relative path for the IDE create/patch tools, or `undefined` when the
 * target is outside the project (or the row has no `projectPath` to be relative
 * to). The caller turns `undefined` into an explicit refusal.
 */
function relativeInProject(projectPath, absolute) {
    if (projectPath === '')
        return undefined;
    const rel = relative(resolve(projectPath), absolute).replace(/\\/g, '/');
    if (rel === '' || rel === '.')
        return undefined;
    if (rel.startsWith('../') || rel === '..' || isAbsolute(rel))
        return undefined;
    return rel;
}
/** LF-normalize a literal, matching the local fs provider's edit semantics. */
function normalizeLineEndings(value) {
    return value.replace(/\r\n/g, '\n');
}
/** Split content into lines without manufacturing a line for the final newline. */
function linesOfContent(content) {
    if (content === '')
        return [];
    const body = content.endsWith('\n') ? content.slice(0, -1) : content;
    return body.split('\n');
}
/**
 * Parse a numbered `read_file` answer.
 *
 * The installed IDE (2026.2.3) takes `offset`/`limit` (1-based line, line count)
 * rather than the newer `mode` flags in the 2026.2 help copy, and when the
 * requested range is longer than the output budget it keeps the first and last
 * half and writes `…N lines truncated…` in the middle. Head lines are contiguous
 * from the requested offset, which is exactly what a bounded read needs; the tail
 * supplies the file's true last line number.
 * @param text - the text block returned by `read_file`.
 */
function parseNumberedRead(text) {
    const parsed = { head: [], tail: [], truncated: false, truncatedCount: 0 };
    if (text === '')
        return parsed;
    for (const rawLine of text.split('\n')) {
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        if (line === '')
            continue;
        const marker = /^(?:…|\.{3})\s*(\d+)\s+lines truncated(?:…|\.{3})$/u.exec(line);
        if (marker !== null) {
            parsed.truncated = true;
            parsed.truncatedCount = Number(marker[1]);
            continue;
        }
        const match = /^L(\d+): ?([\s\S]*)$/.exec(line);
        if (match === null)
            throw new Error(`IDE read_file 输出行没有 L<n>: 前缀：${line.slice(0, 80)}`);
        const entry = { number: Number(match[1]), text: match[2] };
        if (parsed.truncated)
            parsed.tail.push(entry);
        else
            parsed.head.push(entry);
    }
    return parsed;
}
/** The file's last known line number, minus the IDE's trailing-newline phantom. */
function lastLineFacts(parsed) {
    const all = parsed.truncated ? parsed.tail : parsed.head;
    const last = all[all.length - 1];
    if (last === undefined)
        return { totalLines: 0, trailingNewline: false };
    const emptyFile = all.length === 1 && last.number === 1 && last.text === '';
    if (emptyFile)
        return { totalLines: 0, trailingNewline: false };
    const trailingNewline = last.number > 1 && last.text === '';
    return { totalLines: trailingNewline ? last.number - 1 : last.number, trailingNewline };
}
/**
 * Reconstruct content from a numbered read for `write`'s `before` value. A
 * truncated (very large) file keeps a visible omission marker instead of
 * pretending the head and tail are contiguous.
 */
function contentOfNumberedRead(parsed) {
    const all = parsed.truncated ? [...parsed.head, ...parsed.tail] : parsed.head;
    if (all.length === 0)
        return '';
    const { trailingNewline } = lastLineFacts(parsed);
    const lines = all
        .filter((entry) => !(trailingNewline && entry === all[all.length - 1] && entry.text === ''))
        .map((entry) => entry.text);
    if (parsed.truncated) {
        const insertAt = parsed.head.length;
        lines.splice(insertAt, 0, `…${parsed.truncatedCount} lines truncated…`);
    }
    return `${lines.join('\n')}${trailingNewline ? '\n' : ''}`;
}
/**
 * Apply the native read window (line, line-length and byte caps) to the head the
 * IDE returned. Mirrors `buildWindow` in `@deepseek-ai/dsh-tool-fs`.
 * @param head - contiguous numbered lines starting at the requested offset.
 * @param totalLines - exact native line count (trailing phantom already removed).
 * @param offset - 1-based first line.
 * @param limit - maximum number of lines.
 * @param displayPath - canonical path used in the out-of-range message.
 * @returns the numbered window.
 */
function ideReadWindow(head, totalLines, offset, limit, displayPath) {
    if (offset > totalLines && !(totalLines === 0 && offset === 1)) {
        throw new Error(`offset ${offset} is out of range for "${displayPath}" (${totalLines} lines)`);
    }
    const selected = [];
    let outputBytes = 0;
    for (const entry of head) {
        if (entry.number < offset || entry.number > totalLines || selected.length >= limit)
            continue;
        const text = entry.text.length > READ_MAX_LINE_LENGTH
            ? `${entry.text.substring(0, READ_MAX_LINE_LENGTH)}... (line truncated to ${READ_MAX_LINE_LENGTH} chars)`
            : entry.text;
        const bytes = Buffer.byteLength(text, 'utf8') + (selected.length > 0 ? 1 : 0);
        if (outputBytes + bytes > READ_MAX_BYTES)
            break;
        outputBytes += bytes;
        selected.push({ number: entry.number, text });
    }
    return selected;
}
/**
 * A unified diff anchored at the search hit, used by the first `apply_patch`
 * attempt (no file read): the removed lines are `old_string`'s lines, the added
 * lines are `new_string`'s lines.
 */
function buildAnchoredDiff(projectRelative, startLine, oldLines, newLines) {
    return [
        `--- a/${projectRelative}`,
        `+++ b/${projectRelative}`,
        `@@ -${startLine},${oldLines.length} +${startLine},${newLines.length} @@`,
        ...oldLines.map((line) => `-${line}`),
        ...newLines.map((line) => `+${line}`),
    ].join('\n');
}
/**
 * A unified diff whose hunk carries one line of context on each side, built from
 * a narrow `read_file` window. Context lines make the hunk unambiguous even when
 * the removed block itself appears elsewhere. `body` must already be an
 * interleaved context/removal/addition sequence.
 * @param projectRelative - path relative to the IDE project root.
 * @param hunkStart - 1-based first line of the hunk (including leading context).
 * @param body - hunk lines, each already including its ` `, `-` or `+` marker.
 * @param oldCount - number of context + removed lines in the hunk.
 * @param newCount - number of context + added lines in the hunk.
 */
function buildContextDiff(projectRelative, hunkStart, body, oldCount, newCount) {
    return [
        `--- a/${projectRelative}`,
        `+++ b/${projectRelative}`,
        `@@ -${hunkStart},${oldCount} +${hunkStart},${newCount} @@`,
        ...body,
    ].join('\n');
}
/** Quote one router command value; the IDE parser treats backslashes literally. */
function quoteRouterValue(value) {
    return `"${value.replace(/"/g, '\\"')}"`;
}
/**
 * Render one `execute_tool` command for a server that hides its tools behind the
 * router. `projectPath` is appended last because the IDE reads it as a call-level
 * selector, not as a tool argument.
 * @param tool - raw IDE tool name (`read_file`, `create_new_file`, `apply_patch`).
 * @param args - structured tool arguments.
 * @param projectPath - the row's project path (omitted when empty).
 * @returns the command string.
 */
function buildRouterCommand(tool, args, projectPath) {
    const parts = [tool];
    for (const key of Object.keys(args)) {
        const value = args[key];
        if (key === 'projectPath' || value === undefined)
            continue;
        if (typeof value === 'boolean')
            parts.push(`--${key} ${value ? 'true' : 'false'}`);
        else if (value !== null && typeof value === 'object')
            parts.push(`--${key} ${quoteRouterValue(JSON.stringify(value))}`);
        else
            parts.push(`--${key} ${quoteRouterValue(String(value))}`);
    }
    if (projectPath !== '')
        parts.push(`--projectPath ${quoteRouterValue(projectPath)}`);
    return parts.join(' ');
}
/** Concatenate the text blocks of one MCP tool result. */
function textBlocksOf(result) {
    const blocks = Array.isArray(result?.content) ? result.content : [];
    return blocks
        .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n');
}
/* ── Automatic-reload probe ──────────────────────────────────────────────────
 *
 * The child client's live MCP session is private to `@deepseek-ai/dsh-mcp-client`,
 * so the probe cannot ask it anything. What it can do is keep a session of its
 * own on the same endpoint and use that as the canary: MCP servers keep sessions
 * in memory, so "my canary session is gone" means "this server restarted since I
 * opened it", which is precisely when the child's session is dead too. A TCP dial
 * separates that from the plain "no IDE is listening" case.
 */
/** Mirror of `@deepseek-ai/dsh-mcp-client`'s public tool-name rule, for surface comparison. */
function publicToolName(serverName, rawName) {
    const joined = `mcp__${serverName}__${rawName}`;
    const normalized = joined.replace(/[^A-Za-z0-9_-]/g, '_');
    if (normalized === joined && normalized.length <= 64)
        return normalized;
    const hash = createHash('sha256').update(`${serverName}\0${rawName}`).digest('hex').slice(0, 12);
    return `${normalized.slice(0, 64 - 12 - 1)}_${hash}`;
}
/** One-line diagnostic text from an unknown thrown value. */
function messageOf(error) {
    const raw = error instanceof Error ? error.message : String(error);
    return raw.replace(/\s+/g, ' ').trim().slice(0, 300);
}
/** Socket error code, when the platform supplies one. */
function errorCodeOf(error) {
    return error.code;
}
/**
 * Let a timer stop holding the process open. Node's timer handles have
 * `unref`; a browser-style numeric handle does not, hence the optional call.
 * @param timer - handle returned by `setTimeout`.
 */
function unrefTimer(timer) {
    timer.unref?.();
}
/** Trim a response body for `lastError`; never echo more than one short line. */
function shortBody(value) {
    const raw = String(value ?? '').replace(/\s+/g, ' ').trim();
    return raw.length > 160 ? `${raw.slice(0, 157)}...` : raw;
}
/** Transport headers for one MCP request against a connection row. */
function mcpHeadersOf(row) {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (row.projectPath !== '')
        headers.IJ_MCP_SERVER_PROJECT_PATH = row.projectPath;
    return headers;
}
/**
 * Every piece of text a failed tool result carries: the structured message plus
 * its rendered blocks — without repeating a block that only re-renders the
 * message (`Error: <message>`). The transport whitelist below is matched against
 * this, never against the error class name, because an MCP error reaches the
 * registry as a plain `Error` whose message holds the server's own text.
 * @param result - one settled `ToolExecutionResult`.
 * @returns the joined text, or `''`.
 */
function failureTextOf(result) {
    const message = typeof result?.error?.message === 'string' ? result.error.message.trim() : '';
    const extra = [];
    for (const block of Array.isArray(result?.content) ? result.content : []) {
        if (block === null || typeof block !== 'object' || block.type !== 'text' || typeof block.text !== 'string')
            continue;
        const text = block.text.trim();
        if (text === '' || text === message || text === `Error: ${message}`)
            continue;
        extra.push(text);
    }
    return [message, ...extra].filter((part) => part !== '').join('\n').trim();
}
/**
 * The transport/session failures a retry may repair, matched case-insensitively.
 * Anything else — argument validation, a business error, a 4xx semantic error —
 * is not retried: re-sending it would only repeat itself (or repeat a write).
 */
const TRANSPORT_ERROR_PATTERNS = [
    'session not found',
    'ECONNREFUSED',
    'ECONNRESET',
    'fetch failed',
    'socket hang up',
    'timed out',
    'timeout',
    'EPIPE',
];
/** The whitelist entry `text` matches, or `undefined` when this failure is not transport-class. */
function transportPatternOf(text) {
    const lowered = String(text ?? '').toLowerCase();
    if (lowered === '')
        return undefined;
    return TRANSPORT_ERROR_PATTERNS.find(pattern => lowered.includes(pattern.toLowerCase()));
}
/**
 * The inner tool name carried by a router call's `command` argument.
 * Router mode exposes one `execute_tool` and puts the real tool name plus its
 * `--flag value` arguments into a single string, so a typo lives inside the
 * arguments rather than in the dispatched tool name.
 * @param args - the call arguments.
 * @returns the leading command token, or undefined when it is not a router call.
 */
function routerCommandName(args) {
    if (args === null || typeof args !== 'object')
        return undefined;
    const command = args.command;
    if (typeof command !== 'string')
        return undefined;
    const token = command.trim().split(/\s+/)[0];
    return token === '' ? undefined : token;
}
/**
 * The inner tool names the server itself listed in a "not found" failure.
 * Router-only mode lists just `execute_tool`, so the router session's own
 * `tools/list` cannot answer whether an inner command exists; the server's
 * error text is the only place that names them.
 * @param text - the failure text.
 * @returns the advertised inner names, or undefined when the text lists none.
 */
function availableToolsFromError(text) {
    const match = /Available tools:\s*([^\n]+)/i.exec(String(text ?? ''));
    if (match === null)
        return undefined;
    const names = match[1].split(',').map((name) => name.trim()).filter((name) => name !== '');
    return names.length === 0 ? undefined : names;
}
/**
 * Up to five tool names that look like `target`, for a `tool-missing` report.
 * @param target - the raw name the caller used.
 * @param available - every raw name the server currently lists.
 * @returns similar raw names, best first.
 */
function similarRawNames(target, available) {
    const wanted = String(target ?? '').toLowerCase();
    if (wanted === '')
        return [];
    const wantedTokens = wanted.split(/[^a-z0-9]+/).filter(token => token.length > 2);
    const scored = [];
    for (const raw of available) {
        const name = String(raw).toLowerCase();
        if (name === wanted)
            continue;
        let score = 0;
        if (name.includes(wanted) || wanted.includes(name))
            score = 100;
        else if (wanted.replace(/_/g, '') === name.replace(/_/g, ''))
            score = 90;
        else if (wanted.slice(0, 6) === name.slice(0, 6))
            score = 60;
        else if (wantedTokens.some(token => name.split(/[^a-z0-9]+/).includes(token)))
            score = 50;
        else if (editDistanceAtMost(wanted, name, 3) !== undefined)
            score = 30;
        if (score > 0)
            scored.push([score, raw]);
    }
    scored.sort((left, right) => right[0] - left[0] || String(left[1]).localeCompare(String(right[1])));
    return scored.slice(0, 5).map(entry => entry[1]);
}
/**
 * Bounded Levenshtein distance: `undefined` as soon as the distance must exceed
 * `limit`, so a long tool list stays cheap.
 * @param a - first string.
 * @param b - second string.
 * @param limit - largest distance still worth reporting.
 * @returns the distance when it is at most `limit`.
 */
function editDistanceAtMost(a, b, limit) {
    if (Math.abs(a.length - b.length) > limit)
        return undefined;
    let previous = Array.from({ length: b.length + 1 }, (_unused, index) => index);
    for (let row = 1; row <= a.length; row += 1) {
        const current = [row];
        let best = row;
        for (let column = 1; column <= b.length; column += 1) {
            const cost = a[row - 1] === b[column - 1] ? 0 : 1;
            current[column] = Math.min(previous[column] + 1, current[column - 1] + 1, previous[column - 1] + cost);
            if (current[column] < best)
                best = current[column];
        }
        if (best > limit)
            return undefined;
        previous = current;
    }
    return previous[b.length] <= limit ? previous[b.length] : undefined;
}
/**
 * Parse one MCP response body, JSON or SSE framed.
 * @param body - response text.
 * @returns the JSON-RPC messages it carries, in order.
 */
function parseMcpMessages(body) {
    const trimmed = body.trim();
    if (trimmed === '')
        return [];
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
        try {
            const parsed = JSON.parse(trimmed);
            return Array.isArray(parsed) ? parsed : [parsed];
        }
        catch {
            return [];
        }
    }
    const messages = [];
    for (const line of trimmed.split(/\r?\n/)) {
        if (!line.startsWith('data:'))
            continue;
        try {
            messages.push(JSON.parse(line.slice(5).trim()));
        }
        catch {
            /* a partial frame is not a reply; the caller reports a missing reply */
        }
    }
    return messages;
}
/** The reply carrying `id`, or the first message that looks like one. */
function pickReply(messages, id) {
    const matching = messages.filter(message => message !== null
        && typeof message === 'object' && message.id === id);
    if (matching.length > 0)
        return matching[matching.length - 1];
    return messages.find(message => message !== null
        && typeof message === 'object' && (message.result !== undefined || message.error !== undefined));
}
/**
 * Dial one resolved address.
 * @param address - IPv4/IPv6 literal.
 * @param port - TCP port.
 * @param signal - probe cancellation.
 * @returns `{ ok: true }`, or `{ ok: false, error }` with the socket error code.
 */
function dialAddress(address, port, signal) {
    return new Promise((resolve) => {
        let timer;
        let settled = false;
        const socket = netConnect({ host: address, port });
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            socket.destroy();
            resolve(result);
        };
        const onAbort = () => finish({ ok: false, error: '探测已取消' });
        timer = setTimeout(() => finish({ ok: false, error: `TCP ${address}:${port} 连接超时` }), PROBE_TCP_TIMEOUT_MS);
        unrefTimer(timer);
        signal?.addEventListener('abort', onAbort, { once: true });
        socket.once('connect', () => finish({ ok: true }));
        socket.once('error', (error) => {
            finish({ ok: false, error: `TCP ${address}:${port} 连不上（${errorCodeOf(error) ?? messageOf(error)}）` });
        });
    });
}
/**
 * One TCP reachability check: the "no IDE is listening" half of the probe.
 * Every resolved address is tried, so `localhost` reaching a v4-only IDE is not
 * mistaken for a closed port.
 * @param host - hostname, IPv6 brackets already stripped.
 * @param port - TCP port.
 * @param signal - probe cancellation.
 * @returns `{ ok: true }` when any address accepts, else `{ ok: false, error }`.
 */
async function dialTcp(host, port, signal) {
    let addresses;
    try {
        addresses = await lookup(host, { all: true });
    }
    catch (error) {
        return { ok: false, error: `无法解析 ${host}（${messageOf(error)}）` };
    }
    let failure = `TCP ${host}:${port} 连不上`;
    for (const { address } of addresses) {
        const attempt = await dialAddress(address, port, signal);
        if (attempt.ok)
            return attempt;
        failure = attempt.error;
        if (signal?.aborted)
            break;
    }
    return { ok: false, error: failure };
}
/**
 * One MCP request over Streamable HTTP, classified by what it proves.
 * @param href - endpoint URL.
 * @param headers - transport headers (content type, accept, project path).
 * @param sessionId - canary session, or `undefined` for a fresh handshake.
 * @param payload - JSON-RPC message.
 * @param signal - probe cancellation.
 * @param timeoutMs - per-request HTTP budget.
 * @returns `{ kind: 'ok', result?, methodError?, session? }`,
 *   `{ kind: 'stale', error }` (the listener answered but not this session),
 *   or `{ kind: 'unreachable', error }` (the request never got an answer).
 */
async function mcpRequest(href, headers, sessionId, payload, signal, timeoutMs = PROBE_HTTP_TIMEOUT_MS) {
    const timeout = AbortSignal.timeout(timeoutMs);
    let response;
    try {
        response = await fetch(href, {
            method: 'POST',
            headers: {
                ...headers,
                ...(sessionId === undefined ? {} : { 'mcp-session-id': sessionId }),
            },
            body: JSON.stringify(payload),
            signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
        });
    }
    catch (error) {
        return { kind: 'unreachable', error: `请求失败：${messageOf(error.cause ?? error)}` };
    }
    const session = response.headers.get('mcp-session-id') ?? undefined;
    let body = '';
    try {
        body = await response.text();
    }
    catch {
        /* the status still decides; a lost body only loses the detail text */
    }
    if (!response.ok) {
        return { kind: 'stale', error: `HTTP ${response.status} ${shortBody(body)}`.trim(), session };
    }
    if (payload.id === undefined)
        return { kind: 'ok', session };
    const reply = pickReply(parseMcpMessages(body), payload.id);
    if (reply === undefined)
        return { kind: 'stale', error: `响应里没有 MCP 回包：${shortBody(body)}`, session };
    if (reply.error !== undefined) {
        const detail = shortBody(reply.error?.message ?? reply.error);
        // A JSON-RPC error still proves the server understood this session; only a
        // session-scoped complaint means the canary itself is gone.
        if (/session/i.test(detail))
            return { kind: 'stale', error: detail, session };
        return { kind: 'ok', methodError: detail, session };
    }
    return { kind: 'ok', result: reply.result, session };
}
/** Names from one `tools/list` result. */
function toolNamesOf(result) {
    const tools = Array.isArray(result?.tools) ? result.tools : [];
    return tools.map(tool => (typeof tool?.name === 'string' ? tool.name : '')).filter(name => name !== '');
}
/**
 * Open the canary session: `initialize`, `notifications/initialized`, `tools/list`.
 * The caller keeps a GET SSE stream open on the returned session, because an IDE
 * drops a session after ~15s without one — the stream is also the fastest restart
 * signal (a restart closes it) and the carrier of `tools/list_changed`.
 * @param row - connection row.
 * @param headers - transport headers.
 * @param signal - probe cancellation.
 * @param timeoutMs - per-request HTTP budget.
 * @returns `{ kind: 'ok', sessionId, toolNames }` or a failure classified like {@link mcpRequest}.
 */
async function openProbeSession(row, headers, signal, timeoutMs = PROBE_HTTP_TIMEOUT_MS) {
    const initialized = await mcpRequest(row.url, headers, undefined, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'dsh-mcp-jetbrains-probe', version: PLUGIN_VERSION },
        },
    }, signal, timeoutMs);
    if (initialized.kind !== 'ok')
        return initialized;
    const sessionId = initialized.session;
    if (sessionId !== undefined) {
        const notified = await mcpRequest(row.url, headers, sessionId, {
            jsonrpc: '2.0',
            method: 'notifications/initialized',
        }, signal, timeoutMs);
        if (notified.kind !== 'ok')
            return notified;
    }
    const listed = await mcpRequest(row.url, headers, sessionId, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
    }, signal, timeoutMs);
    if (listed.kind !== 'ok')
        return listed;
    return { kind: 'ok', sessionId, toolNames: toolNamesOf(listed.result) };
}
/** Re-read the server's tool list on the existing canary session. */
async function listServerTools(row, headers, sessionId, signal, timeoutMs = PROBE_HTTP_TIMEOUT_MS) {
    const listed = await mcpRequest(row.url, headers, sessionId, {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
    }, signal, timeoutMs);
    return listed.kind === 'ok' ? { kind: 'ok', toolNames: toolNamesOf(listed.result) } : listed;
}
/** Obvious keepalive comments a Streamable HTTP server may write; never JSON. */
function isMcpNotificationFrame(data) {
    try {
        const parsed = JSON.parse(data);
        return typeof parsed?.method === 'string';
    }
    catch {
        return false;
    }
}
/**
 * Hold the canary session open with the GET SSE stream every Streamable HTTP MCP
 * client uses. Without it the IDE expires the session after ~15 seconds idle,
 * which would make every probe look stale; with it, a server restart closes the
 * stream (immediate signal) and `tools/list_changed` announces a changed surface.
 * @param row - connection row.
 * @param probe - probe state; owns the stream's abort controller.
 * @param signalProbe - asks the owner to run another probe soon.
 */
function openProbeStream(row, probe, signalProbe) {
    if (probe.streamUnsupported)
        return;
    probe.stream?.abort?.();
    const controller = new AbortController();
    probe.stream = controller;
    const headers = { accept: 'text/event-stream' };
    if (row.projectPath !== '')
        headers.IJ_MCP_SERVER_PROJECT_PATH = row.projectPath;
    if (probe.sessionId !== undefined)
        headers['mcp-session-id'] = probe.sessionId;
    void (async () => {
        let response;
        try {
            response = await fetch(row.url, { method: 'GET', headers, signal: controller.signal });
        }
        catch {
            // A transport-level failure says nothing about stream support; the next
            // scheduled probe retries it.
            if (probe.stream === controller)
                probe.stream = undefined;
            return;
        }
        if (!response.ok || response.body === null) {
            // The server refuses server->client streams (typically 405). Sessions then
            // cannot be held open at all, so the canary degrades to a throwaway session
            // per probe and only TCP plus the tool surface are judged.
            probe.streamUnsupported = true;
            if (probe.stream === controller)
                probe.stream = undefined;
            probe.sessionId = undefined;
            if (!probe.warnedUnsupported) {
                probe.warnedUnsupported = true;
                signalProbe(`该服务器不支持 SSE 流（HTTP ${response.status}），探测退化为 TCP + 工具面`);
            }
            return;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        try {
            for (;;) {
                const { value, done } = await reader.read();
                if (done)
                    break;
                buffer += decoder.decode(value, { stream: true });
                let cut = buffer.indexOf('\n\n');
                while (cut >= 0) {
                    const frame = buffer.slice(0, cut);
                    buffer = buffer.slice(cut + 2);
                    cut = buffer.indexOf('\n\n');
                    const data = frame.split(/\r?\n/)
                        .filter(line => line.startsWith('data:'))
                        .map(line => line.slice(5).trim())
                        .join('');
                    if (data === '' || !isMcpNotificationFrame(data))
                        continue;
                    const notification = JSON.parse(data);
                    if (String(notification.method).endsWith('tools/list_changed')) {
                        probe.surfaceDirty = true;
                        signalProbe('IDE 通知工具列表变化');
                    }
                }
            }
        }
        catch {
            /* aborted by us, or the server went away: handled below */
        }
        if (probe.stream === controller)
            probe.stream = undefined;
        if (!controller.signal.aborted)
            signalProbe('canary stream 已断开（服务器可能已重启）');
    })();
}
/**
 * Probe one mounted row and decide its health.
 * @param row - the effective row.
 * @param probe - this row's probe state (canary session, stream, cached tool names, mount time).
 * @param signal - probe cancellation.
 * @param registeredOf - reads the public tool names the mounted child registered.
 * @param signalProbe - asks the owner to run another probe soon (stream loss / list changed).
 * @returns `{ state: 'ok'|'unreachable'|'stale'|'remounting', error?, toolCount? }`.
 */
async function probeConnection(row, probe, signal, registeredOf, signalProbe) {
    let url;
    try {
        url = new URL(row.url);
    }
    catch {
        return { state: 'unreachable', error: 'MCP 地址无法解析' };
    }
    const port = url.port === ''
        ? (url.protocol === 'https:' ? 443 : 80)
        : Number(url.port);
    const dial = await dialTcp(url.hostname.replace(/^\[|]$/g, ''), port, signal);
    if (!dial.ok)
        return { state: 'unreachable', error: dial.error };
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (row.projectPath !== '')
        headers.IJ_MCP_SERVER_PROJECT_PATH = row.projectPath;
    if (probe.sessionId === undefined) {
        const opened = await openProbeSession(row, headers, signal);
        if (opened.kind === 'unreachable')
            return { state: 'unreachable', error: opened.error };
        if (opened.kind !== 'ok') {
            // The listener is up but will not complete an MCP handshake: not a session
            // we may trust, and not something a later signal can repair from here.
            return { state: 'stale', error: `MCP 握手失败：${opened.error}` };
        }
        probe.toolNames = opened.toolNames;
        probe.pings = 0;
        probe.surfaceDirty = false;
        if (probe.streamUnsupported) {
            // No server->client stream means no session can be kept alive, so this probe
            // used a throwaway session and the next one opens a fresh one.
            probe.sessionId = undefined;
        }
        else {
            probe.sessionId = opened.sessionId;
            if (probe.sessionId !== undefined)
                openProbeStream(row, probe, signalProbe);
        }
    }
    else {
        const pinged = await mcpRequest(row.url, headers, probe.sessionId, {
            jsonrpc: '2.0',
            id: 99,
            method: 'ping',
        }, signal);
        if (pinged.kind === 'unreachable')
            return { state: 'unreachable', error: pinged.error };
        if (pinged.kind === 'stale') {
            // Keep pinging the dead canary: a gone session never comes back, while the
            // server restart that killed it also killed the child's session.
            return { state: 'stale', error: `会话失效：${pinged.error}` };
        }
        if (probe.stream === undefined)
            openProbeStream(row, probe, signalProbe);
        probe.pings += 1;
        if (probe.surfaceDirty || probe.pings >= PROBE_SURFACE_EVERY) {
            probe.pings = 0;
            probe.surfaceDirty = false;
            const listed = await listServerTools(row, headers, probe.sessionId, signal);
            if (listed.kind === 'unreachable')
                return { state: 'unreachable', error: listed.error };
            if (listed.kind === 'stale')
                return { state: 'stale', error: `读取工具列表失败：${listed.error}` };
            probe.toolNames = listed.toolNames;
        }
    }
    if (Date.now() - probe.mountedAt < MOUNT_GRACE_MS) {
        return { state: 'remounting', toolCount: probe.toolNames?.length };
    }
    if (probe.toolNames === undefined)
        return { state: 'ok' };
    const registered = registeredOf(row.serverName);
    if (registered !== undefined) {
        const expected = probe.toolNames.map(rawName => publicToolName(row.serverName, rawName)).sort();
        const actual = [...registered].sort();
        const same = expected.length === actual.length
            && expected.every((name, index) => name === actual[index]);
        if (!same) {
            return {
                state: 'stale',
                error: `工具面已变：IDE 列出 ${expected.length} 个工具，已挂载的是 ${actual.length} 个`,
                toolCount: probe.toolNames.length,
            };
        }
    }
    return { state: 'ok', toolCount: probe.toolNames.length };
}
/**
 * Validate one submitted connection array.
 * @param input - whatever the settings page posted.
 * @returns normalized rows plus every problem that blocks a save.
 */
function validateConnections(input) {
    if (!Array.isArray(input))
        return { rows: [], problems: ['connections 必须是数组'] };
    const problems = [];
    const rows = [];
    const ids = new Set();
    const serverNames = new Set();
    for (const [index, raw] of input.entries()) {
        const row = rowOf(raw, index);
        const where = `第 ${index + 1} 行`;
        if (row.id === '')
            problems.push(`${where}：连接 ID 不能为空`);
        else if (ids.has(row.id))
            problems.push(`${where}：连接 ID「${row.id}」重复`);
        ids.add(row.id);
        if (!SERVER_NAME_PATTERN.test(row.serverName)) {
            problems.push(`${where}：serverName 只能由字母、数字、下划线、连字符组成，长度 1–32（当前「${row.serverName}」）`);
        }
        else if (serverNames.has(row.serverName)) {
            problems.push(`${where}：serverName「${row.serverName}」重复，工具名会撞车`);
        }
        serverNames.add(row.serverName);
        if (row.url === '')
            problems.push(`${where}：MCP 地址不能为空`);
        else if (!isHttpUrl(row.url))
            problems.push(`${where}：MCP 地址必须是 ${SCHEME_HTTP}:// 或 ${SCHEME_HTTPS}:// 开头的完整地址（当前「${row.url}」）`);
        rows.push(row);
    }
    try {
        Config({ connections: rows });
    }
    catch (error) {
        problems.push(`配置校验未通过：${error instanceof Error ? error.message : String(error)}`);
    }
    return { rows, problems };
}
/** One JSON response. */
function sendJson(res, status, payload) {
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
    });
    res.end(JSON.stringify(payload));
}
/** Loopback test mirroring the Connection package's Host fence. */
function isLoopbackHostname(hostname) {
    if (hostname === 'localhost' || hostname === '[::1]')
        return true;
    const parts = hostname.split('.');
    return parts.length === 4
        && parts[0] === '127'
        && parts.every(part => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}
/**
 * Fallback fence for a composition without the `connection` service: keep the
 * same-origin invariant this page relies on, and nothing weaker. It mirrors what
 * DSH applies to its own routes (loopback Host, no cross-site marker, an Origin
 * equal to the request authority) instead of inventing a second credential, and it
 * never runs when DSH's own trust service is present.
 * @param headers - raw Node request headers.
 * @returns whether a same-origin request from this listener may proceed.
 */
function sameOriginOnly(headers) {
    const host = typeof headers?.host === 'string' ? headers.host : '';
    if (host === '')
        return false;
    let hostUrl;
    try {
        hostUrl = new URL(`${SCHEME_HTTP}://${host}`);
    }
    catch {
        return false;
    }
    if (!isLoopbackHostname(hostUrl.hostname))
        return false;
    if (String(headers['sec-fetch-site'] ?? '') === 'cross-site')
        return false;
    const origin = headers.origin;
    if (origin === undefined)
        return true;
    try {
        const originUrl = new URL(String(origin));
        const scheme = originUrl.protocol === 'http:' || originUrl.protocol === 'https:';
        return scheme && originUrl.host === hostUrl.host;
    }
    catch {
        return false;
    }
}
/** Read a JSON request body, or throw once it outgrows the bound. */
async function readJsonBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES)
            throw new Error(`请求体超过 ${MAX_BODY_BYTES} 字节`);
        chunks.push(chunk);
    }
    if (size === 0)
        return {};
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
/**
 * Describe what the running composition actually provides, so the settings page
 * (and the report) can state the storage decision from evidence instead of hope.
 * @param ctx - plugin context.
 * @returns one string per probed service key: `absent` or `<typeof>[:<constructor>]`.
 */
function probeServices(ctx) {
    const probe = (key) => {
        try {
            const value = typeof ctx.get === 'function' ? ctx.get(key) : undefined;
            if (value === undefined || value === null)
                return 'absent';
            const kind = typeof value;
            const ctor = kind === 'object' || kind === 'function' ? text(value.constructor?.name) : '';
            return ctor === '' || ctor === 'Object' ? kind : `${kind}:${ctor}`;
        }
        catch {
            return 'absent';
        }
    };
    return {
        dshHomePath: probe('dshHomePath'),
        storage: probe('storage'),
        storageDomain: probe('storageDomain'),
        fs: probe('fs'),
        profileContext: probe('profileContext'),
        configEditor: probe('configEditor'),
        settings: probe('settings'),
        webServer: probe('webServer'),
    };
}
/**
 * Resolve the harness home the same way the harness does, preferring its own
 * service over the environment so a configured home wins.
 * @param ctx - plugin context.
 * @returns the absolute home plus how it was obtained, for the report.
 */
function locateHome(ctx) {
    const service = typeof ctx.get === 'function' ? ctx.get('dshHomePath') : undefined;
    if (typeof service === 'function') {
        try {
            const home = text(service());
            if (home !== '')
                return { home, via: 'service dshHomePath()' };
        }
        catch {
            /* fall through to the environment */
        }
    }
    const fromEnv = text(process.env.DSH_HOME);
    if (fromEnv !== '')
        return { home: fromEnv, via: 'process.env.DSH_HOME' };
    return { home: join(homedir(), '.dsh'), via: 'os.homedir()/.dsh' };
}
/**
 * Read one `ideIo` value. The switch defaults to ON, so a store written before
 * the field existed (or one whose `enabled` is not a boolean) yields `true` with
 * `explicit: false`, and the caller writes that default back. An explicit boolean
 * is always honoured as-is: a user's `false` is never overridden.
 * @param value - raw document field.
 */
function ideIoOf(value) {
    const raw = value !== null && typeof value === 'object' ? value : undefined;
    if (raw !== undefined && typeof raw.enabled === 'boolean') {
        return { settings: { enabled: raw.enabled }, explicit: true };
    }
    return { settings: { enabled: true }, explicit: false };
}
/**
 * Read this plugin's own store.
 * @param path - absolute store path.
 * @returns the stored rows plus the `ideIo` switch, or `undefined` when the file does not exist yet.
 * @throws when the file exists but is not a store this build understands.
 */
async function readStore(path) {
    let raw;
    try {
        raw = await readFile(path, 'utf8');
    }
    catch (error) {
        if (error?.code === 'ENOENT')
            return undefined;
        throw error;
    }
    const body = JSON.parse(raw.replace(/^\uFEFF/, ''));
    if (body === null || typeof body !== 'object')
        throw new Error('存储文件不是 JSON 对象');
    if (!Array.isArray(body.connections))
        throw new Error('存储文件缺少 connections 数组');
    const version = Number(body.version);
    if (!Number.isInteger(version) || version < 1)
        throw new Error(`存储文件 version 非法：${JSON.stringify(body.version)}`);
    if (version > STORE_VERSION)
        throw new Error(`存储文件 version ${version} 高于本插件支持的 ${STORE_VERSION}`);
    const switchValue = ideIoOf(body.ideIo);
    return {
        connections: body.connections.map(rowOf),
        ideIo: switchValue.settings,
        ideIoStored: switchValue.explicit,
    };
}
/**
 * Replace this plugin's store atomically: a temp file in the same directory is
 * written UTF-8 (no BOM, LF, two-space indent) and renamed over the target, so a
 * crash leaves either the old document or the new one.
 * @param path - absolute store path.
 * @param connections - rows to persist.
 * @param ideIo - the global switch to persist beside them.
 */
async function writeStore(path, connections, ideIo) {
    await mkdir(dirname(path), { recursive: true });
    const body = `${JSON.stringify({ version: STORE_VERSION, ideIo: { enabled: ideIo.enabled === true }, connections }, null, 2)}\n`;
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, body, 'utf8');
    try {
        await rename(temp, path);
    }
    catch (error) {
        // A failed rename must not leave a half-finished temp file behind for the
        // next activation to trip over; the target is untouched either way.
        await rm(temp, { force: true }).catch(() => { });
        throw error;
    }
}
/**
 * Copy the pre-rename bundle's store into this build's store, exactly once, and
 * never delete the old file: it stays as the rollback copy. A failure here must
 * not block activation, so every outcome is reported and the caller falls back
 * to whatever rows the composition offers.
 * @param storePath - absolute path of this build's store.
 * @param legacyPath - absolute path of the pre-rename store.
 * @param log - activation logger.
 * @returns the copied document (when the old file had one) and the store
 * `status` to report; `status` is `undefined` when there was nothing to copy.
 */
async function migrateLegacyStore(storePath, legacyPath, log) {
    let legacy;
    try {
        legacy = await readStore(legacyPath);
    }
    catch (error) {
        // Unreadable old store: report it, copy nothing, and leave BOTH files alone.
        log('error', 'dsh-mcp-jetbrains: legacy store %s is unreadable (%s); nothing was migrated and %s stays untouched', legacyPath, error, storePath);
        return { status: 'legacy-store-unreadable' };
    }
    if (legacy === undefined)
        return {};
    try {
        await writeStore(storePath, legacy.connections, legacy.ideIo);
    }
    catch (error) {
        // The new file does not exist on this path, so the old file is the only copy:
        // keep running on its rows in memory and never touch it.
        log('error', 'dsh-mcp-jetbrains: could not copy the legacy store %s into %s (%s); running on its %d row(s) in memory', legacyPath, storePath, error, legacy.connections.length);
        return { document: legacy, status: 'legacy-store-migrate-failed' };
    }
    log('info', 'dsh-mcp-jetbrains: migrated %d connection row(s) from the legacy store %s into %s; the old file is kept for rollback', legacy.connections.length, legacyPath, storePath);
    // The copy above wrote the effective switch (default ON when the old file had
    // none), so the migrated document no longer needs a write-back.
    legacy.ideIoStored = true;
    return { document: legacy, status: 'legacy-store-migrated' };
}
/**
 * Mount one mcp-client child plugin per usable connection, and serve the settings
 * page routes that edit the same rows.
 * @param ctx - plugin context; children live under this fiber and are disposed with it.
 * @param config - validated plugin config; `connections` is legacy-only.
 */
export async function apply(ctx, config) {
    const logger = ctx.logger;
    /** Log through the captured logger; a disposed fiber's logger must not throw. */
    const log = (level, ...args) => {
        try {
            logger?.[level]?.(...args);
        }
        catch {
            /* the fiber is gone; the Loader owns the diagnostics from here on */
        }
    };
    /** Which services this composition really has, reported by `GET /config`. */
    const probed = probeServices(ctx);
    /** Harness home plus this plugin's store location. */
    const located = locateHome(ctx);
    const storePath = join(located.home, STORE_DIR, STORE_FILE);
    /** Store facts reported by `GET /config`; `status` says where the rows came from. */
    const store = {
        path: storePath,
        home: located.home,
        resolvedBy: located.via,
        version: STORE_VERSION,
        status: '',
        probed,
    };
    /**
     * Effective rows of this activation. Read order: own store -> the pre-rename
     * store (copied in once) -> the legacy profile-patch array (migrated once) ->
     * built-in defaults.
     */
    let rows = [];
    /** The global switch; the stored value, or the new default (on) for a 0.7 store / defaults. */
    let ideIo = { enabled: true };
    let stored;
    try {
        stored = await readStore(storePath);
    }
    catch (error) {
        // A damaged store must not block the plugin: keep it on disk for inspection,
        // run on whatever fallback the composition offers, and let the next save heal it.
        log('error', 'dsh-mcp-jetbrains: store %s is unreadable, keeping it untouched for this activation', storePath, error);
        store.status = 'store-unreadable';
    }
    if (stored === undefined && store.status !== 'store-unreadable') {
        // One-time migration from the pre-rename bundle. It only runs while THIS
        // build's file is absent, so an existing store always wins and the old file
        // can never overwrite it.
        const migrated = await migrateLegacyStore(storePath, join(located.home, STORE_DIR, LEGACY_STORE_FILE), log);
        if (migrated.status !== undefined)
            store.status = migrated.status;
        if (migrated.document !== undefined)
            stored = migrated.document;
    }
    if (stored !== undefined) {
        rows = stored.connections;
        ideIo = stored.ideIo;
        // Keep a migration status (`legacy-store-migrated` / `-failed`) for the page.
        if (store.status === '')
            store.status = 'store';
        log('info', 'dsh-mcp-jetbrains: %d connection row(s) loaded from %s (ideIo %s)', rows.length, storePath, ideIo.enabled ? 'on' : 'off');
        if (!stored.ideIoStored) {
            // The store predates the switch, so the effective value is this build's
            // default. Persist it now: otherwise the page, the tool hook and the file
            // would answer differently about the same store until the next save.
            try {
                await writeStore(storePath, rows, ideIo);
                stored.ideIoStored = true;
                log('info', 'dsh-mcp-jetbrains: store %s carried no ideIo field; wrote the default (on) back to it', storePath);
            }
            catch (error) {
                log('error', 'dsh-mcp-jetbrains: could not write the default ideIo (on) back to %s; it stays on for this activation', storePath, error);
            }
        }
    }
    const legacy = (Array.isArray(config?.connections) ? config.connections : []).map(rowOf);
    if (stored === undefined) {
        // Never write over a file we could not read: report the rows we are using in
        // memory instead of healing silently.
        const storeReadBlocked = store.status === 'store-unreadable' || store.status === 'legacy-store-unreadable';
        if (legacy.length > 0) {
            rows = legacy;
            if (storeReadBlocked) {
                if (store.status !== 'legacy-store-unreadable')
                    store.status = 'legacy-in-memory';
                log('warn', 'dsh-mcp-jetbrains: using %d legacy row(s) in memory; %s stays untouched', rows.length, storePath);
            }
            else {
                try {
                    await writeStore(storePath, rows, ideIo);
                    store.status = 'migrated';
                    log('info', 'dsh-mcp-jetbrains: migrated %d connection row(s) from the profile patch into %s', rows.length, storePath);
                }
                catch (error) {
                    store.status = 'migrate-failed';
                    log('error', 'dsh-mcp-jetbrains: could not migrate the legacy connection rows into %s', storePath, error);
                }
            }
        }
        else {
            rows = DEFAULT_CONNECTIONS.map(rowOf);
            if (!storeReadBlocked)
                store.status = 'defaults';
            log('info', 'dsh-mcp-jetbrains: no store at %s; using the %d built-in default row(s)', storePath, rows.length);
        }
    }
    /** Row id -> live child fiber, for in-place rebuilds. */
    const mounted = new Map();
    /** Row id -> probe scheduling plus the canary session; one entry per mounted child. */
    const probes = new Map();
    /** Row id -> health counters; survives a remount so `restarts` keeps counting. */
    const healthByRow = new Map();
    /** Fresh health counters for one row. */
    function freshHealth() {
        return {
            state: 'remounting',
            lastProbeAt: 0,
            lastError: '',
            restarts: 0,
            toolCount: 0,
            consecutiveOk: 0,
            consecutiveFailures: 0,
            restartDelay: 0,
            lastRestartAt: 0,
        };
    }
    /** Health counters for one row, created on first use. */
    function healthEntry(id) {
        let entry = healthByRow.get(id);
        if (entry === undefined) {
            entry = freshHealth();
            healthByRow.set(id, entry);
        }
        return entry;
    }
    /**
     * Health as the settings page reads it. `idle` is a row nothing is mounted for,
     * `off` a mounted row whose owner turned automatic reload off. A row with
     * automatic reload off still reports a state once a forced `?probe=surface`
     * check has read one, because that result is a fact and hiding it would make
     * the page lie.
     * @param id - row id.
     */
    function healthFor(id) {
        const row = rows.find((candidate) => candidate.id === id);
        const idle = { state: 'idle', lastProbeAt: 0, lastError: '', restarts: 0, toolCount: 0 };
        if (row === undefined || blockerOf(row) !== '')
            return idle;
        const entry = healthByRow.get(id);
        const live = {
            state: entry.state,
            lastProbeAt: entry.lastProbeAt,
            lastError: entry.lastError,
            restarts: entry.restarts,
            toolCount: entry.toolCount,
        };
        if (!row.autoReload) {
            if (!healthByRow.has(id) || entry.lastProbeAt === 0)
                return { ...idle, state: 'off' };
            return live;
        }
        if (!healthByRow.has(id))
            return idle;
        return live;
    }
    /** Health of every configured row, keyed by row id. */
    function healthMap() {
        const map = {};
        for (const row of rows)
            map[row.id] = healthFor(row.id);
        return map;
    }
    /**
     * Ring buffer of automatic actions, newest first. It answers "why did this
     * connection reconnect at 03:12" without a log tail, and it is what the
     * settings page shows beside a failed call's diagnosis.
     */
    const diagnostics = [];
    /**
     * Record one automatic action. Newest first, capped at {@link DIAGNOSTICS_LIMIT};
     * a full buffer drops the oldest entry.
     * @param entry - fields to record; `at` and the buffer bound are added here.
     */
    function recordDiagnostic(entry) {
        diagnostics.unshift({ at: Date.now(), ...entry });
        if (diagnostics.length > DIAGNOSTICS_LIMIT)
            diagnostics.length = DIAGNOSTICS_LIMIT;
    }
    /** Row id -> when this plugin last remounted it for a failed call (cooldown). */
    const lastAutoRemountAt = new Map();
    /** Tool names whose retry is in flight; their failures never start a second diagnosis. */
    const retryingTools = new Set();
    /** What the settings page shows beside each row. */
    const mountedRows = () => [...mounted.values()].map(({ id, serverName, url }) => ({
        id,
        serverName,
        url,
        health: healthFor(id),
    }));
    /** Configured probe interval, clamped to the schema bounds. */
    function probeIntervalMs() {
        const configured = Number(config?.probeIntervalMs);
        if (!Number.isFinite(configured))
            return PROBE_INTERVAL_DEFAULT_MS;
        return Math.min(PROBE_INTERVAL_MAX_MS, Math.max(PROBE_INTERVAL_MIN_MS, Math.round(configured)));
    }
    /** Spread a delay by ±10% so several IDEs do not probe in lockstep. */
    function jitter(ms) {
        return Math.round(ms * (0.9 + Math.random() * 0.2));
    }
    /**
     * Delay before the next probe: a freshly mounted child waits for its tool
     * generation, a healthy row backs off, an abnormal one looks again sooner.
     * The healthy branch is clamped twice: the widened interval and its jitter both
     * stay at or below {@link PROBE_OK_BACKOFF_MAX_MS}, which is what keeps the
     * worst-case surface change delay at 2 x 45s.
     * @param entry - health counters of the row.
     * @param probe - probe state holding `mountedAt`.
     */
    function nextDelay(entry, probe) {
        if (entry.state === 'remounting') {
            return Math.max(1_000, probe.mountedAt + MOUNT_GRACE_MS - Date.now());
        }
        if (entry.state === 'ok') {
            const factor = Math.min(PROBE_OK_BACKOFF_FACTOR, 1 + Math.floor(entry.consecutiveOk / 2));
            const widened = Math.min(PROBE_OK_BACKOFF_MAX_MS, probeIntervalMs() * factor);
            return Math.min(PROBE_OK_BACKOFF_MAX_MS, jitter(widened));
        }
        // Abnormal: sooner than the base interval, but never a tight loop.
        return Math.max(PROBE_INTERVAL_MIN_MS, Math.round(probeIntervalMs() / 4));
    }
    /**
     * Public tool names the mounted child registers for one server namespace. This
     * is the only view of the child's generation the parent has: mcp-client keeps
     * its live session private, and the registry is what the model sees.
     * @param serverName - the row's serverName.
     * @returns the names, or `undefined` when the registry cannot answer.
     */
    function registeredToolsOf(serverName) {
        try {
            const registry = typeof ctx.get === 'function' ? ctx.get('tools') : undefined;
            if (typeof registry?.definitions !== 'function')
                return undefined;
            const prefix = `mcp__${serverName}__`;
            return registry.definitions()
                .map((definition) => text(definition?.name))
                .filter((name) => name.startsWith(prefix));
        }
        catch {
            return undefined;
        }
    }
    /* ── "File IO goes through the IDE" ────────────────────────────────────────
     *
     * This section is the enforcement point the settings switch only *asks* for.
     * The Host re-reads the live rows on every call, so a stale page (or a hand
     * crafted POST) cannot route to a connection that no longer exists; and every
     * refusal below is an `isError` result returned WITHOUT calling `next()`, so
     * the disk path is never taken by accident.
     */
    /**
     * File tools this build intercepts. The plugin's scoped `tools.definitions()`
     * only lists its own children, so it cannot be used to discover the global
     * file tools; the live Agent catalog was read instead (`read`, `write`, `edit`,
     * all from `@deepseek-ai/dsh-tool-fs`) and {@link FILE_TOOL_NAMES} is the
     * compiled-in result. `GET /config` reports the same list, and activation logs
     * it, so a profile that renames them is visible rather than silently ignored.
     */
    function interceptedFileTools() {
        return FILE_TOOL_NAMES.slice();
    }
    /** Rows that are enabled, regardless of whether they can currently mount. */
    function enabledRows() {
        return rows.filter((row) => row.enabled);
    }
    /** The switch plus the rows that could currently accept a routed call. */
    function ideIoView() {
        const enabled = enabledRows();
        return {
            enabled: ideIo.enabled,
            // On but with nothing to serve: file tools then ask the user how to proceed
            // (paste a config / native path once / cancel). Reported so the page can say
            // "enabled but not in force" instead of implying that routing works.
            inactive: ideIo.enabled && enabled.length === 0,
            enabledConnections: enabled.map((row) => ({
                id: row.id,
                serverName: row.serverName,
                projectPath: row.projectPath,
                mounted: mounted.has(row.id),
            })),
            fileTools: interceptedFileTools(),
        };
    }
    /** One-line description of the enabled rows, for a refusal. */
    function enabledSummary() {
        const enabled = enabledRows();
        if (enabled.length === 0)
            return '没有任何已启用连接';
        return enabled
            .map((row) => `${row.id}${row.projectPath === '' ? '（projectPath 为空）' : ` → ${row.projectPath}`}`)
            .join('；');
    }
    /**
     * Choose the connection for one absolute path: longest case-insensitive prefix
     * of `projectPath`, a unique single enabled row as the explicit fallback, and a
     * hard error for a tie or an ambiguous multi-row miss.
     * @param display - canonical absolute path of the target.
     * @returns the chosen row (with `via`) or the reason it cannot be chosen.
     */
    function pickIdeRow(display) {
        const enabled = enabledRows();
        if (enabled.length === 0)
            return { matches: [], error: '当前没有任何已启用（enabled: true）的连接' };
        const target = comparablePath(display);
        const matched = enabled.filter((row) => row.projectPath !== '' && isWithinProject(target, comparablePath(row.projectPath)));
        if (matched.length > 0) {
            let best = 0;
            for (const row of matched)
                best = Math.max(best, comparablePath(row.projectPath).length);
            const top = matched.filter((row) => comparablePath(row.projectPath).length === best);
            if (top.length > 1) {
                return { matches: top, error: `有 ${top.length} 条已启用连接的 projectPath 与目标同样匹配，无法唯一确定：${top.map((row) => row.id).join('、')}` };
            }
            return { row: top[0], via: 'prefix', matches: [top[0]] };
        }
        if (enabled.length === 1)
            return { row: enabled[0], via: 'single', matches: enabled };
        return { matches: enabled, error: `目标不在任何已启用连接的 projectPath 内，且有 ${enabled.length} 条已启用连接，无法唯一确定用哪一条` };
    }
    /**
     * The one refusal shape used by every unroutable case. It always names the same
     * three remedies, because a vague failure while the switch is on would invite
     * the reader to assume the disk was written.
     * @param tool - intercepted tool name.
     * @param reason - what could not be routed.
     * @param detail - optional extra facts (path, IDE error, candidate rows).
     */
    function ideIoError(tool, reason, detail = '') {
        const lines = [
            `Error: dsh-mcp-jetbrains 的「读写走 IDE」已开启：${tool} 被强制交给 IDE，本次没有回落到磁盘。`,
            `原因：${reason}`,
        ];
        if (detail !== '')
            lines.push(`细节：${detail}`);
        lines.push('解法（任选其一）：', '1. 关闭「读写走 IDE」：设置 → JetBrains IDE 连接 → 顶部开关；', '2. 启用一条 projectPath 覆盖该文件的连接（若只有一条启用连接，它会被兜底使用）；', '3. 修正已启用连接的 projectPath，使其包含该文件所在的上级目录。');
        return {
            isError: true,
            content: [{ type: 'text', text: lines.join('\n') }],
            error: {
                message: `ide-io: ${tool} refused (${reason})`,
                info: {
                    name: 'IdeIoRouteError',
                    code: 'IDE_IO_REFUSED',
                    ...detail === '' ? {} : { reason: detail.slice(0, 1000) },
                },
            },
            meta: { 'dsh-mcp-jetbrains': { verdict: 'ide-io-refused', tool, reason } },
        };
    }
    /* ── "Switch on, nothing to serve": ask the human, never guess ─────────────
     *
     * With zero enabled connections there is nothing that could accept the call.
     * The previous behavior (pass the call to the disk path and record
     * `ide-io-inactive`) let the model believe the IDE's view was consulted, so the
     * only honest options are to ask or to fail. The question offers exactly three
     * outcomes, and every one of them is explicit: paste a config (create one
     * connection and re-route this same call), use the native path once, or cancel.
     * No branch below returns a silent pass-through.
     */
    /**
     * The `userQuestions` service of this composition, when present. It is an
     * OPTIONAL dependency (`inject` stays `['tools']`): a composition without it
     * still activates, and the file tools then fail explicitly instead of using the
     * disk. `ctx.get` can throw on a disposed fiber, hence the catch.
     */
    function userQuestionsService() {
        try {
            const service = typeof ctx.get === 'function' ? ctx.get('userQuestions') : undefined;
            return typeof service?.ask === 'function' ? service : undefined;
        }
        catch {
            return undefined;
        }
    }
    /**
     * The one question asked when the switch is on but no connection can serve a
     * file call. Option labels are answer values, so {@link askForConnectionThenRetry}
     * compares them literally.
     * @param tool - intercepted tool name.
     */
    function noConnectionQuestion(tool) {
        return {
            id: ASK_IDE_IO_QUESTION_ID,
            header: '读写走 IDE',
            question: `「读写走 IDE」已开启，但当前没有任何可用的 JetBrains IDE 连接。本次 ${tool} 要怎么办？`,
            detail: '选「粘贴 JetBrains 配置」时，请把 IDE「复制配置」得到的 JSON 填进自定义回答；插件会自动建立一条连接，并用同一次调用重新路由。任何失败都会明确报出来，不会悄悄读写磁盘。',
            options: [
                {
                    label: ASK_OPTION_PASTE,
                    description: '把 IDE「复制配置」得到的 JSON 粘到自定义回答里；我会自动建立连接并重试这次调用。',
                },
                {
                    label: ASK_OPTION_NATIVE,
                    description: '让插件这次不代你执行：改由你自己走 shell（pwsh / bash）读写，或先启用连接再重试。不改变「读写走 IDE」设置。',
                },
                {
                    label: ASK_OPTION_CANCEL,
                    description: '这次调用不执行，什么都不改。',
                },
            ],
        };
    }
    /**
     * The answer item for this plugin's question. A UI is expected to echo the id;
     * a single-item answer without one is still accepted rather than thrown away.
     * @param answer - the service's answer batch.
     */
    function answerItemOf(answer) {
        const items = Array.isArray(answer?.answers) ? answer.answers : [];
        return items.find((item) => text(item?.id) === ASK_IDE_IO_QUESTION_ID)
            ?? (items.length === 1 ? items[0] : undefined);
    }
    /**
     * Refusal used by every branch that could not obtain a usable user decision.
     * It names the three remedies whenever the user did not simply cancel, because
     * the model must never conclude that the file was read or written.
     * @param tool - intercepted tool name.
     * @param reason - what went wrong, in one line.
     * @param detail - optional extra facts (what was not done).
     * @param remedies - append the three-solution list (default `true`).
     */
    function ideIoAskError(tool, reason, detail = '', remedies = true) {
        const lines = [
            `Error: dsh-mcp-jetbrains 的「读写走 IDE」已开启，但当前没有可用的 JetBrains 连接：${tool} 没有执行，也没有回落到磁盘。`,
            `原因：${reason}`,
        ];
        if (detail !== '')
            lines.push(`细节：${detail}`);
        if (remedies) {
            lines.push('可选解法（任选其一）：', '1. 去设置页加连接：设置 → JetBrains IDE 连接 → 「添加连接」，填 IDE 的 MCP 地址（「复制配置」里的 JSON 可用页面上的「粘贴配置」导入），建议同时填 projectPath；', '2. 在会话里粘配置：重试这次调用，在弹出的问题里选「' + ASK_OPTION_PASTE + '」，把 IDE「复制配置」得到的 JSON（或只把 ' + SCHEME_HTTP + '://… 地址）填进自定义回答；', '3. 关闭「读写走 IDE」：设置 → JetBrains IDE 连接 → 顶部开关，恢复 DSH 原生读写。');
        }
        return {
            isError: true,
            content: [{ type: 'text', text: lines.join('\n') }],
            error: {
                message: `ide-io: ${tool} not executed (${reason})`,
                info: {
                    name: 'IdeIoNoConnectionError',
                    code: 'IDE_IO_NO_CONNECTION',
                    ...detail === '' ? {} : { reason: detail.slice(0, 1000) },
                },
            },
            meta: { 'dsh-mcp-jetbrains': { verdict: 'ide-io-needs-connection', tool, reason } },
        };
    }
    /**
     * Append one visible note to a native result, keeping its `isError`, `value` and
     * `error` untouched. `undefined` (the waterfall had no executor) is returned
     * as-is: there is no result to annotate.
     *
     * **Only failures actually show it.** On success the pipeline re-renders
     * `content` from `value` through the owning tool's `output.render`
     * (`normalizeDispatchResult` → `createSuccessResult`), so a block appended by
     * an around-dispatch wrapper is dropped. Keep appending — it stays correct if
     * that ever changes — but treat `diagnostics` as the durable record, and only
     * rely on this note where the outcome is an error.
     * @param result - the native result.
     * @param note - the human/model-visible sentence.
     */
    function withVisibleNote(result, note) {
        if (result === undefined || result === null)
            return result;
        const content = Array.isArray(result.content) ? result.content : [];
        return { ...result, content: [...content, { type: 'text', text: note }] };
    }
    /**
     * Create exactly one connection from one parsed pasted entry. The server name
     * and the id are deduplicated against the existing rows, `projectPath` stays
     * empty (the pasted content never carries one), and the row is persisted BEFORE
     * it is mounted so a mount failure cannot lose it. It is mounted in place — not
     * through `save()` — because disposing every other child would drop the tool
     * generations the current call is already inside.
     * @param entry - one parsed `{ key, url }`.
     * @returns the created row, or why it could not be created.
     */
    async function createPastedConnection(entry) {
        if (!isHttpUrl(entry.url)) {
            return { error: `粘贴的地址不是完整的 ${SCHEME_HTTP}:// 或 ${SCHEME_HTTPS}:// 地址：${entry.url}` };
        }
        if (store.status === 'store-unreadable' || store.status === 'legacy-store-unreadable') {
            // Activation deliberately kept the unreadable file untouched. A paste must
            // not become the write that silently replaces it with in-memory rows.
            return { error: `插件自有存储 ${storePath} 当前不可读；为避免覆盖原文件，这次没有写入任何内容。请到设置页保存一次（或先修复该文件）后重试。` };
        }
        const takenNames = new Set(rows.map((row) => row.serverName).filter((name) => name !== ''));
        const takenIds = new Set(rows.map((row) => row.id).filter((id) => id !== ''));
        const serverName = uniqueName(pastedNameBase(entry.key, entry.url), takenNames);
        const id = uniqueName(serverName, takenIds);
        if (!SERVER_NAME_PATTERN.test(serverName)) {
            return { error: `粘贴内容里的名字无法清洗成合法的 serverName（只允许字母、数字、下划线、连字符，长度 1–32）：${serverName}` };
        }
        const row = {
            id,
            serverName,
            url: entry.url,
            projectPath: '',
            enabled: true,
            autoReload: true,
        };
        const next = [...rows, row];
        try {
            await writeStore(storePath, next, ideIo);
        }
        catch (error) {
            return { error: `写入插件自有存储失败：${messageOf(error)}` };
        }
        rows = next;
        store.status = 'store';
        healthByRow.set(row.id, freshHealth());
        const mountedNow = mountChild(row);
        log('info', 'dsh-mcp-jetbrains: created connection %s (serverName %s) from a pasted IDE config; mounted=%s, %d row(s) now', row.id, row.serverName, mountedNow, rows.length);
        if (!mountedNow) {
            // Not fatal: a routed call opens its own short MCP session, so the row can
            // still serve this call. It stays in the store for the page to repair.
            log('warn', 'dsh-mcp-jetbrains: connection %s was saved but could not be mounted; a routed call opens its own MCP session, and the settings page shows the row', row.id);
        }
        return { row };
    }
    /**
     * Adopt a pasted IDE config as one connection and re-route THIS call through it.
     * Parsing or creation failures create nothing and execute nothing; a routing
     * failure after creation is reported with the created row's id and the fact
     * that its `projectPath` is empty.
     * @param exec - the intercepted file call.
     * @param raw - the custom answer text.
     */
    async function adoptPastedIdeConfig(exec, raw) {
        const tool = exec.name;
        const parsed = parsePastedIdeConfig(raw);
        if (parsed.entries === undefined) {
            const reason = parsed.error ?? '粘贴内容无法解析';
            recordDiagnostic({
                source: 'tool-call', tool, connection: '', verdict: 'ide-io-paste-invalid', action: 'none',
                detail: reason, ideIo: 'on',
            });
            log('warn', 'dsh-mcp-jetbrains: 用户粘贴的 IDE 配置无法解析，%s 未执行：%s', tool, reason);
            return ideIoAskError(tool, `你粘贴的配置无法解析：${reason}`, '没有建立连接、没有执行这次读写，也没有写入存储。');
        }
        const entries = parsed.entries;
        const entry = entries[0];
        const created = await createPastedConnection(entry);
        if (created.row === undefined) {
            const reason = created.error ?? '建立连接失败';
            recordDiagnostic({
                source: 'tool-call', tool, connection: '', verdict: 'ide-io-paste-failed', action: 'none',
                detail: reason, ideIo: 'on',
            });
            log('error', 'dsh-mcp-jetbrains: 无法按粘贴内容建立连接，%s 未执行：%s', tool, reason);
            return ideIoAskError(tool, reason, '这次读写没有执行；连接可能未建立或未写入，请检查设置页与 Host 日志。');
        }
        const row = created.row;
        const others = entries.length > 1
            ? `粘贴内容里有 ${entries.length} 条 server，本次只用了第一条「${entry.key === '' ? '(未命名)' : entry.key}」；其余请到设置页按需添加。`
            : '';
        // Re-route through the SAME call: `pickIdeRow` now sees the new row.
        const retried = await routeFileTool(exec);
        if (retried.isError !== true) {
            recordDiagnostic({
                source: 'tool-call', tool, connection: row.id, verdict: 'ide-io-paste-connected', action: 'created-and-routed',
                detail: `按粘贴内容新建连接「${row.id}」（serverName ${row.serverName}，projectPath 为空），并用同一次调用路由成功。`,
                ideIo: 'on',
            });
            const note = [
                `【dsh-mcp-jetbrains】已按你粘贴的配置新建连接「${row.id}」（serverName ${row.serverName}），本次 ${tool} 已经走 IDE。`,
                '该连接的 projectPath 为空（粘贴内容里没有项目路径），建议到 设置 → JetBrains IDE 连接 补成项目根目录。',
                ...others === '' ? [] : [others],
            ];
            return withVisibleNote(retried, note.join('\n')) ?? retried;
        }
        const reason = failureTextOf(retried);
        const detail = `连接「${row.id}」已保存并启用，但它的 projectPath 为空（粘贴内容里没有项目路径）。若上面的原因与「找不到文件 / 项目不匹配 / IDE 不接受该路径」有关，请到设置页把 projectPath 补成项目根目录后重试。`;
        recordDiagnostic({
            source: 'tool-call', tool, connection: row.id, verdict: 'ide-io-paste-unrouted', action: 'none',
            detail: `${reason}${reason === '' ? '' : '；'}${detail}`, ideIo: 'on',
        });
        log('warn', 'dsh-mcp-jetbrains: 按粘贴内容新建连接 %s 后重新路由 %s 仍失败：%s', row.id, tool, reason);
        return {
            isError: true,
            content: [{
                    type: 'text',
                    text: [
                        `Error: 已按你粘贴的配置建立连接「${row.id}」（serverName ${row.serverName}），但用同一次调用重新路由 ${tool} 仍然失败；这次读写没有执行，也没有回落到磁盘。`,
                        `原因：${reason}`,
                        ...others === '' ? [] : [others],
                        `后续：请到 设置 → JetBrains IDE 连接，把「${row.id}」的 projectPath 补成项目根目录（例如 D:\\path\\to\\project），确认 IDE 正在监听 ${row.url} 后重试。`,
                    ].join('\n'),
                }],
            error: {
                message: `ide-io: ${tool} not executed (pasted connection ${row.id} could not route this call)`,
                info: { name: 'IdeIoPasteRouteError', code: 'IDE_IO_PASTE_UNROUTED', reason: reason.slice(0, 1000) },
            },
            meta: { 'dsh-mcp-jetbrains': { verdict: 'ide-io-paste-unrouted', tool, connection: row.id, reason } },
        };
    }
    /**
     * The `tools/execute` branch for "switch on, zero enabled connections": ask the
     * user, then act on exactly one of the three answers. Every path returns an
     * explicit result except the native passthrough, which calls `next()` only
     * because the user approved it — and even then appends a visible note.
     * @param exec - the intercepted file call.
     */
    async function askForConnectionThenRetry(exec) {
        const tool = exec.name;
        const service = userQuestionsService();
        if (service === undefined) {
            const reason = '取不到 userQuestions 服务（这个运行时里没有可提问的通道）';
            recordDiagnostic({
                source: 'tool-call', tool, connection: '', verdict: 'ide-io-needs-connection', action: 'ask-unavailable',
                detail: reason, ideIo: 'on',
            });
            log('error', 'dsh-mcp-jetbrains: ideIo is ON with no enabled connection and no userQuestions service; %s was refused', tool);
            return ideIoAskError(tool, reason, '没有弹出提问，因此也没有执行任何读写。');
        }
        let answer;
        try {
            answer = await service.ask({
                questions: [noConnectionQuestion(tool)],
                agent: exec.agent,
                signal: exec.signal,
            });
        }
        catch (error) {
            const reason = `向用户提问失败：${messageOf(error)}`;
            recordDiagnostic({
                source: 'tool-call', tool, connection: '', verdict: 'ide-io-needs-connection', action: 'ask-failed',
                detail: reason, ideIo: 'on',
            });
            log('warn', 'dsh-mcp-jetbrains: ideIo is ON with no enabled connection and the question failed; %s was refused: %s', tool, reason);
            return ideIoAskError(tool, reason, '提问没有完成（子代理会话无法向用户提问，运行时根也可能已经变化），因此这次读写没有执行。若当前是子代理，请把这个问题带回上级会话。');
        }
        const item = answerItemOf(answer);
        const custom = text(item?.custom);
        // A typed answer wins over the option list: it is the only way to paste a
        // config, and the user typed it instead of (or beside) picking an option.
        if (custom !== '')
            return await adoptPastedIdeConfig(exec, custom);
        const selected = Array.isArray(item?.selected)
            ? item.selected.map((label) => text(label)).filter((label) => label !== '')
            : [];
        if (selected.includes(ASK_OPTION_NATIVE)) {
            recordDiagnostic({
                source: 'tool-call', tool, connection: '', verdict: 'ide-io-user-approved-native', action: 'refuse-and-instruct',
                detail: '「读写走 IDE」已开启但没有启用连接；用户显式放行本次改用 DSH 原生读写。插件没有代执行，改为要求模型自己走 shell 或关闭开关后重试。',
                ideIo: 'on',
            });
            log('warn', 'dsh-mcp-jetbrains: user approved the native path for %s; refusing to run it here so the model must choose the path explicitly', tool);
            // Deliberately NOT calling next() here. A successful passthrough result
            // cannot carry a visible note (the pipeline re-renders content from
            // `value`), so the model would read disk while believing the IDE served
            // it — exactly the two-truths confusion this plugin exists to remove. One
            // extra round is cheaper than silently doing the wrong thing.
            return ideIoAskError(tool, '用户已放行本次改用 DSH 原生读写，但插件不会代替你执行', '若要读写磁盘，请你自己用 shell（pwsh / bash）完成这次操作；若希望继续走 IDE，请先在设置页启用一条连接（或在会话里粘贴 IDE 配置），然后重试。');
        }
        if (selected.includes(ASK_OPTION_PASTE)) {
            const reason = `你选择了「${ASK_OPTION_PASTE}」，但自定义回答是空的`;
            recordDiagnostic({
                source: 'tool-call', tool, connection: '', verdict: 'ide-io-needs-connection', action: 'ask-empty',
                detail: reason, ideIo: 'on',
            });
            return ideIoAskError(tool, reason, '没有建立连接、没有执行这次读写；请重试并在自定义回答里粘贴 IDE「复制配置」的 JSON 或 MCP 地址。');
        }
        if (selected.includes(ASK_OPTION_CANCEL)) {
            const reason = `你选择了「${ASK_OPTION_CANCEL}」`;
            recordDiagnostic({
                source: 'tool-call', tool, connection: '', verdict: 'ide-io-needs-connection', action: 'cancelled',
                detail: reason, ideIo: 'on',
            });
            log('info', 'dsh-mcp-jetbrains: user cancelled %s (no enabled connection and ideIo on)', tool);
            return ideIoAskError(tool, reason, '这次调用没有执行，也没有改写存储；需要时重新发起即可。', false);
        }
        const reason = selected.length > 0
            ? `回答里的选项无法识别：${selected.join('、')}`
            : '回答里既没有选中项，也没有自定义内容';
        recordDiagnostic({
            source: 'tool-call', tool, connection: '', verdict: 'ide-io-needs-connection', action: 'ask-empty',
            detail: reason, ideIo: 'on',
        });
        return ideIoAskError(tool, reason, '没有执行任何读写。请重试，并从三个选项里选一个，或把 IDE「复制配置」的 JSON 粘进自定义回答。');
    }
    /** Terminate one short-lived IO session; the IDE may not support it, so never throw. */
    async function closeIdeSession(row, headers, sessionId) {
        if (sessionId === undefined)
            return;
        try {
            await fetch(row.url, {
                method: 'DELETE',
                headers: { ...headers, 'mcp-session-id': sessionId },
                signal: AbortSignal.timeout(2_000),
            });
        }
        catch {
            /* best effort: the session also expires on its own */
        }
    }
    /**
     * Call one IDE file tool on a NEW MCP session (never through the mounted child,
     * whose session is private and whose router shape may differ). The server may
     * expose the tool directly or hide it behind `execute_tool`; both are handled,
     * and a failed call is returned as text, never as a disk fallback.
     * @param row - the chosen connection.
     * @param tool - raw IDE tool name.
     * @param args - structured arguments for that tool.
     * @param signal - the model call's cancellation.
     */
    async function callIdeTool(row, tool, args, signal) {
        const headers = mcpHeadersOf(row);
        const timeout = AbortSignal.timeout(IDE_IO_TIMEOUT_MS);
        const bound = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
        let opened;
        try {
            opened = await openProbeSession(row, headers, bound, IDE_IO_TIMEOUT_MS);
        }
        catch (error) {
            return { ok: false, error: `无法连接「${row.id}」（${row.url}）：${messageOf(error)}` };
        }
        if (opened.kind !== 'ok')
            return { ok: false, error: `连接「${row.id}」的 MCP 会话失败：${opened.error ?? opened.kind}` };
        try {
            const toolNames = opened.toolNames ?? [];
            let callName;
            let callArgs;
            if (toolNames.includes(tool)) {
                callName = tool;
                callArgs = { ...args };
            }
            else if (toolNames.includes('execute_tool')) {
                callName = 'execute_tool';
                callArgs = { command: buildRouterCommand(tool, args, row.projectPath) };
            }
            else {
                return { ok: false, error: `IDE 既没有暴露 ${tool}，也没有暴露 execute_tool（共列出 ${toolNames.length} 个工具）` };
            }
            if (row.projectPath !== '')
                callArgs.projectPath = row.projectPath;
            const reply = await mcpRequest(row.url, headers, opened.sessionId, {
                jsonrpc: '2.0',
                id: 3,
                method: 'tools/call',
                params: { name: callName, arguments: callArgs },
            }, bound, IDE_IO_TIMEOUT_MS);
            if (reply.kind !== 'ok')
                return { ok: false, error: reply.error ?? 'MCP 调用没有返回结果' };
            if (reply.methodError !== undefined)
                return { ok: false, error: reply.methodError };
            const result = reply.result;
            const text = textBlocksOf(result);
            if (result?.isError === true)
                return { ok: false, error: text === '' ? 'IDE 工具返回失败' : text };
            return { ok: true, text };
        }
        catch (error) {
            return { ok: false, error: messageOf(error) };
        }
        finally {
            await closeIdeSession(row, headers, opened.sessionId);
        }
    }
    /** The Session directory a relative `file_path` resolves against. */
    async function executionCwd(exec) {
        const directories = typeof ctx.get === 'function' ? ctx.get('workingDirectory') : undefined;
        if (exec.agent !== undefined && typeof directories?.ensure === 'function') {
            try {
                const cwd = text(await directories.ensure(exec.agent, exec.signal));
                if (cwd !== '')
                    return cwd;
            }
            catch {
                /* fall through to the process directory */
            }
        }
        return process.cwd();
    }
    /** Whether an IDE read failure means "the file does not exist". */
    function isMissingFileText(value) {
        return /does(?:n't| not) exist|can(?:no|')t be opened|not found|no such file/i.test(String(value ?? ''));
    }
    /** Record one routed call in the settings page's diagnostic ring. */
    function recordIdeIo(tool, row, display, fallback) {
        recordDiagnostic({
            source: 'tool-call',
            tool,
            connection: row.id,
            verdict: 'ide-io',
            action: tool,
            detail: `${fallback ? '唯一启用连接兜底；' : ''}${display}`,
            ideIo: 'on',
            fallback,
        });
    }
    /**
     * `read` on the IDE with a bounded range. The installed IDE's `read_file` takes
     * `offset`/`limit` (1-based first line, line count), so the DSH window maps
     * directly. The requested IDE limit is `2 * limit + 1`: when the IDE has to
     * truncate a long answer it keeps the first and last half, so the head alone
     * still covers the whole native window without ever requesting the whole file.
     */
    async function readViaIde(exec, row, display) {
        const args = (exec.arguments !== null && typeof exec.arguments === 'object' ? exec.arguments : {});
        const offset = args.offset === undefined ? 1 : args.offset;
        const limit = args.limit === undefined ? READ_LIMIT : args.limit;
        if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 1)
            return ideIoError('read', 'offset must be a positive integer');
        if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1)
            return ideIoError('read', 'limit must be a positive integer');
        if (limit > READ_LIMIT)
            return ideIoError('read', `limit must be less than or equal to ${READ_LIMIT}`);
        const ideLimit = Math.min(5000, 2 * limit + 1);
        const reply = await callIdeTool(row, 'read_file', { file_path: display, offset, limit: ideLimit }, exec.signal);
        if (!reply.ok)
            return ideIoError('read', `IDE 连接「${row.id}」的 read_file 失败`, reply.error);
        const parsed = parseNumberedRead(reply.text ?? '');
        const { totalLines } = lastLineFacts(parsed);
        const lines = ideReadWindow(parsed.head, totalLines, offset, limit, display);
        return {
            isError: false,
            value: { path: display, offset, lines, totalLines },
        };
    }
    /**
     * `write` on the IDE: `read_file` (for the create/update decision and the
     * native `before` value) then `create_new_file` with `overwrite: true`.
     */
    async function writeViaIde(exec, row, display) {
        const args = (exec.arguments !== null && typeof exec.arguments === 'object' ? exec.arguments : {});
        const content = args.content;
        if (typeof content !== 'string')
            return ideIoError('write', 'content 必须是字符串');
        const projectRelative = relativeInProject(row.projectPath, display);
        if (projectRelative === undefined) {
            const reason = row.projectPath === ''
                ? `连接「${row.id}」没有 projectPath，无法算出 IDE 项目内的相对路径`
                : `文件不在连接「${row.id}」的 projectPath（${row.projectPath}）内`;
            return ideIoError('write', reason, display);
        }
        let before = null;
        const prior = await callIdeTool(row, 'read_file', { file_path: display, offset: 1, limit: 5000 }, exec.signal);
        if (prior.ok) {
            before = contentOfNumberedRead(parseNumberedRead(prior.text ?? ''));
        }
        else if (!isMissingFileText(prior.error)) {
            return ideIoError('write', `无法通过 IDE 判断目标文件是否已存在（连接「${row.id}」）`, prior.error);
        }
        const written = await callIdeTool(row, 'create_new_file', {
            pathInProject: projectRelative,
            text: content,
            overwrite: true,
        }, exec.signal);
        if (!written.ok)
            return ideIoError('write', `IDE 连接「${row.id}」的 create_new_file 失败`, written.error);
        return {
            isError: false,
            value: {
                path: display,
                operation: before === null ? 'create' : 'update',
                before,
                after: content,
            },
        };
    }
    /**
     * Read a narrow window around one `edit` candidate: `startLine - N` through
     * `startLine + oldLines + N - 1`, never the whole file.
     *
     * The installed `read_file` truncates a long requested range to its first and
     * last halves, so the request asks for `2 * window` lines; the head half is the
     * contiguous window the patch needs and the tail half is ignored. Only the head
     * counts toward the read budget.
     * @returns the numbered lines plus how many head lines were used.
     */
    async function readEditWindow(row, display, startLine, lineCount, signal) {
        const from = Math.max(1, startLine - EDIT_CONTEXT_LINES);
        const windowLines = lineCount + EDIT_CONTEXT_LINES * 2;
        const limit = windowLines * 2;
        if (limit > 5000)
            throw new Error(`old_string 跨 ${lineCount} 行，超过 IDE 单次范围读取上限`);
        const reply = await callIdeTool(row, 'read_file', { file_path: display, offset: from, limit }, signal);
        if (!reply.ok)
            throw new Error(reply.error ?? '窄窗口读取失败');
        const parsed = parseNumberedRead(reply.text ?? '');
        const lines = new Map(parsed.head.map((entry) => [entry.number, entry.text]));
        return { lines, count: parsed.head.length };
    }
    /**
     * `edit` on the IDE, with NO whole-file read.
     *
     * The loop is: locate candidates with the IDE's own `search_text`, try a
     * line-anchored diff, and only when that fails read ONE narrow window
     * (`candidate ± EDIT_CONTEXT_LINES`, plus the old_string span) to build a
     * context-unique hunk and retry once. A wrong occurrence is never guessed:
     * multiple candidates that really contain `old_string` are a hard failure.
     *
     * NOTE on the order: the first `apply_patch` is preceded by `search_text`
     * because the installed IDE applies a context-free hunk to the FIRST identical
     * occurrence without an error (measured). A blind first patch would therefore
     * risk changing the wrong place, so the search is the safety gate. The patch
     * budget (2) and the narrow-read budget are enforced below.
     */
    async function editViaIde(exec, row, display) {
        /** @type {Record<string, any>} */
        const args = (exec.arguments !== null && typeof exec.arguments === 'object' ? exec.arguments : {});
        const oldString = args.old_string;
        const newString = args.new_string;
        const replaceAll = args.replace_all === true;
        if (typeof oldString !== 'string' || oldString.length === 0)
            return ideIoError('edit', 'old_string must be a non-empty string');
        if (typeof newString !== 'string')
            return ideIoError('edit', 'new_string must be a string');
        if (oldString === newString)
            return ideIoError('edit', 'old_string and new_string must differ');
        const projectRelative = relativeInProject(row.projectPath, display);
        if (projectRelative === undefined) {
            const reason = row.projectPath === ''
                ? `连接「${row.id}」没有 projectPath，无法算出 IDE 项目内的相对路径`
                : `文件不在连接「${row.id}」的 projectPath（${row.projectPath}）内`;
            return ideIoError('edit', reason, display);
        }
        const oldNorm = normalizeLineEndings(oldString);
        const newNorm = normalizeLineEndings(newString);
        const oldLines = linesOfContent(oldNorm);
        const newLines = linesOfContent(newNorm);
        if (oldLines.length === 0)
            return ideIoError('edit', 'old_string 去掉行尾后没有可定位的行');
        const query = oldLines.map((line) => line.trim()).find((line) => line !== '') ?? oldNorm.trim();
        if (query === '')
            return ideIoError('edit', 'old_string 去掉空白后为空，无法定位');
        let attempts = 0;
        let linesRead = 0;
        let candidates = [];
        let chosen;
        const readRanges = [];
        /** Record one closed-loop step with the counters that matter for later diagnosis. */
        const step = (action, detail, extra = {}) => {
            recordDiagnostic({
                source: 'tool-call',
                tool: 'edit',
                connection: row.id,
                verdict: 'ide-io-edit',
                action,
                detail,
                ideIo: 'on',
                attempt: attempts,
                candidates,
                linesRead,
                readRanges: readRanges.slice(),
                ...chosen === undefined ? {} : { chosen },
                ...extra,
            });
        };
        /** Run one `apply_patch` attempt, never beyond the budget. */
        const patchAttempt = async (patch, phase) => {
            if (attempts >= EDIT_PATCH_ATTEMPTS)
                return { ok: false, error: `apply_patch 预算 ${EDIT_PATCH_ATTEMPTS} 次已用完` };
            attempts += 1;
            step('apply_patch', `第 ${attempts} 次 apply_patch（${phase}）`, { phase });
            const reply = await callIdeTool(row, 'apply_patch', { input: patch }, exec.signal);
            const applied = /(\d+)\s+out of\s+(\d+)\s+operations applied/i.exec(reply.text ?? '');
            const partial = applied !== null && Number(applied[1]) < Number(applied[2]);
            step(reply.ok && !partial ? 'apply_patch-ok' : 'apply_patch-failed', reply.ok ? (partial ? `只应用 ${applied?.[1]}/${applied?.[2]} 个 hunk` : '成功') : String(reply.error ?? '失败'), { phase, patch: patch.slice(0, 1000) });
            return reply.ok && !partial ? reply : { ok: false, error: partial ? `IDE 只应用了 ${applied?.[1]}/${applied?.[2]} 个 hunk` : reply.error };
        };
        // Safety gate: locate candidates before any blind patch (see the note above).
        const searched = await callIdeTool(row, 'search_text', { q: query, paths: [projectRelative], limit: 1000 }, exec.signal);
        if (!searched.ok) {
            step('search_text-failed', String(searched.error ?? ''));
            return ideIoError('edit', `IDE 连接「${row.id}」的 search_text 失败，无法确认 old_string 是否唯一`, searched.error);
        }
        let items;
        try {
            const body = JSON.parse(searched.text ?? '{}');
            items = Array.isArray(body?.items) ? body.items : [];
        }
        catch {
            step('search_text-failed', shortBody(searched.text));
            return ideIoError('edit', 'IDE search_text 没有返回可解析的 JSON，无法确认 old_string 是否唯一', shortBody(searched.text));
        }
        const target = projectRelative.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
        candidates = items
            .map((item) => ({
            startLine: Number(item?.startLine),
            filePath: String(item?.filePath ?? '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase(),
        }))
            .filter((item) => Number.isInteger(item.startLine) && item.startLine >= 1)
            .filter((item) => item.filePath === target || item.filePath.endsWith(`/${target}`))
            .map((item) => item.startLine)
            .sort((left, right) => left - right);
        step('search_text', `查询「${query}」命中 ${candidates.length} 处${candidates.length > 0 ? `（行 ${candidates.join('、')}）` : ''}`, { candidates: candidates.slice() });
        if (candidates.length === 0) {
            return ideIoError('edit', `old_string was not found in "${display}"`, `查询「${query}」在目标文件里没有命中`);
        }
        if (candidates.length > EDIT_CANDIDATE_LIMIT) {
            return ideIoError('edit', `old_string 的定位查询「${query}」命中 ${candidates.length} 处，超过候选上限 ${EDIT_CANDIDATE_LIMIT}；请给更长的 old_string 以便唯一定位`, `前 5 个候选行：${candidates.slice(0, 5).join('、')}；本次没有读取任何候选`);
        }
        /** Build a context-unique patch from one narrow window, or explain why not. */
        const contextPatchOf = async (startLine) => {
            const worstCase = oldLines.length + EDIT_CONTEXT_LINES * 2;
            if (linesRead + worstCase > EDIT_READ_LINE_BUDGET) {
                return { patch: '', ok: false, reason: `累计读取将达到 ${linesRead + worstCase} 行，超过预算 ${EDIT_READ_LINE_BUDGET} 行` };
            }
            const window = await readEditWindow(row, display, startLine, oldLines.length, exec.signal);
            linesRead += window.count;
            readRanges.push(`${Math.max(1, startLine - EDIT_CONTEXT_LINES)}..${startLine + oldLines.length + EDIT_CONTEXT_LINES - 1}`);
            step('read_file', `读取候选行 ${startLine} 的窄窗口（${window.count} 行，±${EDIT_CONTEXT_LINES}）`, { linesRead });
            const block = [];
            for (let line = startLine; line < startLine + oldLines.length; line += 1) {
                const text = window.lines.get(line);
                if (text === undefined)
                    return { patch: '', ok: false, reason: `候选行 ${startLine} 的窗口缺少第 ${line} 行` };
                block.push(text);
            }
            const beforeText = block.join('\n');
            if (!beforeText.includes(oldNorm)) {
                return { patch: '', ok: false, reason: `候选行 ${startLine} 的行块里没有完整的 old_string` };
            }
            if (beforeText.split(oldNorm).length - 1 > 1) {
                return { patch: '', ok: false, reason: `候选行 ${startLine} 的行块里 old_string 出现多次` };
            }
            const afterText = beforeText.split(oldNorm).join(newNorm);
            const beforeCtx = window.lines.get(startLine - 1);
            const afterCtx = window.lines.get(startLine + oldLines.length);
            const body = [];
            let oldCount = 0;
            let newCount = 0;
            if (beforeCtx !== undefined) {
                body.push(` ${beforeCtx}`);
                oldCount += 1;
                newCount += 1;
            }
            for (const line of block) {
                body.push(`-${line}`);
                oldCount += 1;
            }
            for (const line of afterText.split('\n')) {
                body.push(`+${line}`);
                newCount += 1;
            }
            if (afterCtx !== undefined) {
                body.push(` ${afterCtx}`);
                oldCount += 1;
                newCount += 1;
            }
            const hunkStart = beforeCtx === undefined ? startLine : startLine - 1;
            return { patch: buildContextDiff(projectRelative, hunkStart, body, oldCount, newCount), ok: true };
        };
        if (candidates.length === 1) {
            chosen = candidates[0];
            const first = await patchAttempt(buildAnchoredDiff(projectRelative, chosen, oldLines, newLines), 'anchored-no-context');
            if (first.ok) {
                step('success', `锚定 hunk 一次成功（行 ${chosen}）`);
                log('info', 'dsh-mcp-jetbrains: ideIo edit %s 成功（search_text 1 处，apply_patch 1 次，未读文件）', display);
                return { isError: false, value: { path: display, before: oldNorm, after: newNorm } };
            }
            /** @type {any} */
            const built = await contextPatchOf(chosen).catch((error) => ({ patch: '', ok: false, reason: messageOf(error) }));
            if (!built.ok) {
                return ideIoError('edit', `首次 apply_patch 失败，窄窗口也无法构造唯一 hunk：${built.reason}`, `候选行：${candidates.join('、')}；请给更长的 old_string`);
            }
            const second = await patchAttempt(built.patch, 'narrow-context');
            if (!second.ok) {
                return ideIoError('edit', `自纠后的第 2 次 apply_patch 仍失败：${second.error}`, `候选行：${candidates.join('、')}；请给更长的 old_string`);
            }
            step('success', `自纠后第 2 次 apply_patch 成功（行 ${chosen}，累计读 ${linesRead} 行）`);
            log('info', 'dsh-mcp-jetbrains: ideIo edit %s 自纠成功（读 %d 行，apply_patch 2 次）', display, linesRead);
            return { isError: false, value: { path: display, before: oldNorm, after: newNorm } };
        }
        // Multiple candidates: read each narrow window (within budget) and keep only
        // those whose block actually contains old_string.
        const matches = [];
        const failures = [];
        for (const candidate of candidates) {
            /** @type {any} */
            const built = await contextPatchOf(candidate).catch((error) => ({ patch: '', ok: false, reason: messageOf(error) }));
            if (built.ok)
                matches.push({ startLine: candidate, patch: built.patch });
            else {
                failures.push(`行 ${candidate}：${built.reason ?? '窄窗口不可用'}`);
                step('candidate-skipped', `候选行 ${candidate} 未采用：${built.reason ?? '窄窗口不可用'}`);
            }
        }
        if (matches.length === 0) {
            return ideIoError('edit', `搜索命中 ${candidates.length} 处，但窄窗口里没有任何一处完整包含 old_string`, `候选行：${candidates.join('、')}；累计读 ${linesRead} 行；${failures.slice(0, 5).join('；')}；请给更长的 old_string`);
        }
        if (matches.length > 1) {
            return ideIoError('edit', `old_string 在 ${matches.length} 处都完整匹配（候选行：${matches.map((match) => match.startLine).join('、')}），无法唯一确定；请给更长的 old_string，本次没有写入`, `累计读 ${linesRead} 行；replace_all=${replaceAll ? 'true' : 'false'}`);
        }
        chosen = matches[0].startLine;
        const patched = await patchAttempt(matches[0].patch, 'multi-narrow-context');
        if (!patched.ok) {
            return ideIoError('edit', `带唯一上下文的 apply_patch 失败：${patched.error}`, `候选行：${candidates.join('、')}；请给更长的 old_string`);
        }
        step('success', `多候选中按上下文选中行 ${chosen}（读 ${linesRead} 行，apply_patch 1 次）`);
        log('info', 'dsh-mcp-jetbrains: ideIo edit %s 多候选自纠成功（行 %d，读 %d 行）', display, chosen, linesRead);
        return { isError: false, value: { path: display, before: oldNorm, after: newNorm } };
    }
    /**
     * The interception entry point. Resolves the absolute path, chooses a
     * connection, and dispatches to the right IDE tool; every thrown error becomes
     * an explicit refusal, so the caller never reaches the disk path.
     * @param exec - the file tool call.
     */
    async function routeFileTool(exec) {
        const tool = exec.name;
        const args = (exec.arguments !== null && typeof exec.arguments === 'object' ? exec.arguments : {});
        try {
            if (exec.signal?.aborted)
                return ideIoError(tool, '这次调用已被取消');
            const filePath = typeof args.file_path === 'string' ? args.file_path : '';
            if (filePath.trim() === '')
                return ideIoError(tool, 'file_path must be a non-empty string');
            const cwd = await executionCwd(exec);
            const absolute = absolutePathOf(filePath, cwd);
            const display = await canonicalPathOf(absolute);
            const route = pickIdeRow(display);
            if (route.row === undefined) {
                recordDiagnostic({
                    source: 'tool-call',
                    tool,
                    connection: '',
                    verdict: 'ide-io-refused',
                    action: 'none',
                    detail: route.error,
                    ideIo: 'on',
                    matches: route.matches.map((row) => row.id),
                });
                return ideIoError(tool, route.error ?? '无法确定使用哪一条连接', `文件：${display}；已启用连接：${enabledSummary()}`);
            }
            const row = route.row;
            const blocked = blockerOf(row);
            if (blocked !== '') {
                recordDiagnostic({
                    source: 'tool-call',
                    tool,
                    connection: row.id,
                    verdict: 'ide-io-refused',
                    action: 'none',
                    detail: blockerText(blocked),
                    ideIo: 'on',
                });
                return ideIoError(tool, `连接「${row.id}」已启用，但当前没有挂载：${blockerText(blocked)}`, `文件：${display}`);
            }
            recordIdeIo(tool, row, display, route.via === 'single');
            log('info', 'dsh-mcp-jetbrains: ideIo %s -> %s%s（%s）', tool, row.id, route.via === 'single' ? '（唯一启用连接兜底）' : '', display);
            if (tool === 'read')
                return await readViaIde(exec, row, display);
            if (tool === 'write')
                return await writeViaIde(exec, row, display);
            return await editViaIde(exec, row, display);
        }
        catch (error) {
            recordDiagnostic({
                source: 'tool-call',
                tool,
                connection: '',
                verdict: 'ide-io-error',
                action: 'none',
                detail: messageOf(error),
                ideIo: 'on',
            });
            log('error', 'dsh-mcp-jetbrains: ideIo %s 抛错，已拒绝并且没有回落磁盘', tool, error);
            return ideIoError(tool, `处理时抛错：${messageOf(error)}`);
        }
    }
    /**
     * Read one connection's tool list on a NEW MCP session — never on the canary
     * and never through the child, whose live session is private. This is the one
     * operation both the forced `?probe=surface` check and the failed-call
     * diagnosis use, and it is deliberately session-terminated afterwards.
     * @param row - the effective row.
     * @param signal - bounded cancellation.
     * @returns `{ kind: 'ok', toolNames }` or a failure classified like {@link mcpRequest}.
     */
    async function inspectSurface(row, signal) {
        const headers = mcpHeadersOf(row);
        const opened = await openProbeSession(row, headers, signal);
        if (opened.kind !== 'ok')
            return opened;
        try {
            await fetch(row.url, {
                method: 'DELETE',
                headers: { ...headers, 'mcp-session-id': opened.sessionId },
                signal: AbortSignal.timeout(PROBE_HTTP_TIMEOUT_MS),
            });
        }
        catch {
            // Best effort: the IDE may not implement session termination at all, and
            // this session expires on its own after ~15 seconds without a stream.
        }
        return { kind: 'ok', toolNames: opened.toolNames };
    }
    /**
     * Compare one mounted row's registered tool generation with the server's live
     * `tools/list`, now, and write the outcome into its health entry. Used by
     * `GET /config?probe=surface`; it never reschedules the periodic probe and
     * never remounts — the timer path owns recovery, this only reports a fact.
     * @param id - row id.
     * @returns what the forced check found, for the route response.
     */
    async function forceSurfaceCheck(id) {
        const row = rows.find((candidate) => candidate.id === id);
        if (row === undefined)
            return { id, state: 'idle', skipped: 'no-row' };
        const blocked = blockerOf(row);
        if (blocked !== '')
            return { id, state: 'idle', skipped: blocked };
        if (mounted.get(id) === undefined)
            return { id, state: 'idle', skipped: 'unmounted' };
        const entry = healthEntry(id);
        const probe = probes.get(id);
        let inspect;
        try {
            inspect = await inspectSurface(row, AbortSignal.timeout(PROBE_FORCE_TIMEOUT_MS));
        }
        catch (error) {
            inspect = { kind: 'unreachable', error: `工具面校验失败：${messageOf(error)}` };
        }
        entry.lastProbeAt = Date.now();
        if (inspect.kind !== 'ok') {
            entry.state = inspect.kind;
            entry.lastError = inspect.error;
            recordDiagnostic({
                source: 'settings',
                connection: id,
                verdict: inspect.kind,
                action: 'none',
                detail: `强制工具面校验：${inspect.error}`,
            });
            return { id, state: entry.state, error: entry.lastError, toolCount: entry.toolCount };
        }
        entry.toolCount = inspect.toolNames.length;
        if (probe !== undefined && Date.now() - probe.mountedAt < MOUNT_GRACE_MS) {
            // A child mounted seconds ago has not registered its generation yet;
            // judging it here would report a false mismatch.
            entry.state = 'remounting';
            return { id, state: 'remounting', toolCount: entry.toolCount };
        }
        const registered = registeredToolsOf(row.serverName);
        const expected = inspect.toolNames.map((rawName) => publicToolName(row.serverName, rawName)).sort();
        if (registered === undefined) {
            entry.state = 'ok';
            entry.lastError = '';
            return { id, state: 'ok', toolCount: entry.toolCount, error: '' };
        }
        const actual = [...registered].sort();
        const same = expected.length === actual.length
            && expected.every((name, index) => name === actual[index]);
        if (same) {
            entry.state = 'ok';
            entry.lastError = '';
            return { id, state: 'ok', toolCount: entry.toolCount, error: '' };
        }
        entry.state = 'stale';
        entry.lastError = `工具面已变：IDE 列出 ${expected.length} 个工具，已挂载的是 ${actual.length} 个`;
        recordDiagnostic({
            source: 'settings',
            connection: id,
            verdict: 'surface-changed',
            action: 'none',
            detail: entry.lastError,
        });
        return { id, state: 'stale', error: entry.lastError, toolCount: entry.toolCount };
    }
    /** One row's probe state, created when the child mounts. */
    function probeState(id) {
        let probe = probes.get(id);
        if (probe === undefined) {
            probe = {
                sessionId: undefined,
                toolNames: undefined,
                pings: 0,
                mountedAt: Date.now(),
                timer: undefined,
                controller: undefined,
                stream: undefined,
                streamUnsupported: false,
                warnedUnsupported: false,
                surfaceDirty: false,
                running: false,
                remounting: false,
            };
            probes.set(id, probe);
        }
        return probe;
    }
    /** Forget the canary session and its stream: a remount opens a new pair. */
    function resetProbeSession(probe) {
        probe.stream?.abort?.();
        probe.stream = undefined;
        probe.sessionId = undefined;
        probe.toolNames = undefined;
        probe.pings = 0;
        probe.surfaceDirty = false;
    }
    /** Arm the next probe, replacing any timer this row already has. */
    function scheduleProbe(id, delayMs) {
        const probe = probes.get(id);
        if (probe === undefined)
            return;
        if (probe.timer !== undefined)
            clearTimeout(probe.timer);
        const delay = Math.max(1_000, Math.round(delayMs));
        probe.timer = setTimeout(() => {
            probe.timer = undefined;
            void runProbe(id);
        }, delay);
        unrefTimer(probe.timer);
    }
    /** Stop probing one row: cancels the timer, the request and the canary stream. */
    function stopProbe(id) {
        const probe = probes.get(id);
        if (probe === undefined)
            return;
        if (probe.timer !== undefined)
            clearTimeout(probe.timer);
        probe.timer = undefined;
        probe.controller?.abort();
        probe.controller = undefined;
        resetProbeSession(probe);
        probes.delete(id);
    }
    /**
     * Probe one mounted row, record what it proved, and either reschedule or
     * remount. Every probe is one TCP dial plus one MCP `ping`; the canary session's
     * SSE stream carries the restart and `tools/list_changed` signals between probes.
     * Nothing here calls the child or one of its tools.
     * @param id - row id.
     */
    async function runProbe(id) {
        const probe = probes.get(id);
        const live = mounted.get(id);
        if (probe === undefined || live === undefined || probe.running || probe.remounting)
            return;
        const row = rows.find((candidate) => candidate.id === id);
        if (row === undefined || blockerOf(row) !== '' || !row.autoReload)
            return;
        probe.running = true;
        probe.controller = new AbortController();
        const entry = healthEntry(id);
        /** The stream and the tool-list notification ask for a quick re-check. */
        const signalProbe = (reason) => {
            log('debug', 'dsh-mcp-jetbrains: %s 探测提前重试（%s）', id, reason);
            scheduleProbe(id, PROBE_NUDGE_DELAY_MS);
        };
        let outcome;
        try {
            outcome = await probeConnection(row, probe, probe.controller.signal, registeredToolsOf, signalProbe);
        }
        catch (error) {
            outcome = { state: 'stale', error: `探测失败：${messageOf(error)}` };
        }
        finally {
            probe.running = false;
            probe.controller = undefined;
        }
        if (probes.get(id) !== probe || mounted.get(id) !== live)
            return;
        entry.lastProbeAt = Date.now();
        if (outcome.toolCount !== undefined)
            entry.toolCount = outcome.toolCount;
        if (outcome.state === 'ok') {
            entry.lastError = '';
            entry.consecutiveFailures = 0;
            entry.consecutiveOk += 1;
            // `remounting` -> `ok` is the normal settle of a fresh mount; only an outage
            // that cleared itself is worth a log line.
            if (entry.state === 'unreachable' || entry.state === 'stale') {
                log('info', 'dsh-mcp-jetbrains: %s 探测恢复正常', id);
            }
            entry.state = 'ok';
            if (entry.consecutiveOk >= PROBE_RESTART_RESET_AFTER)
                entry.restartDelay = 0;
        }
        else if (outcome.state === 'remounting') {
            entry.state = 'remounting';
        }
        else {
            entry.lastError = outcome.error ?? '';
            entry.consecutiveOk = 0;
            entry.consecutiveFailures += 1;
            if (entry.state !== outcome.state) {
                log('warn', 'dsh-mcp-jetbrains: %s %s（%s）', id, healthText(outcome.state), entry.lastError);
            }
            entry.state = outcome.state;
        }
        let remounting = false;
        if (entry.state === 'stale' && entry.consecutiveFailures >= PROBE_FAILURE_THRESHOLD) {
            const waitLeft = entry.lastRestartAt === 0
                ? 0
                : entry.restartDelay - (Date.now() - entry.lastRestartAt);
            if (waitLeft <= 0)
                remounting = true;
            else
                log('debug', 'dsh-mcp-jetbrains: %s 仍然失效，但自动重挂冷却还剩 %dms', id, waitLeft);
        }
        if (remounting)
            await remountRow(id);
        else
            scheduleProbe(id, nextDelay(entry, probe));
    }
    /**
     * Dispose and re-mount one stale row. Only this row moves: the other children,
     * this plugin's fiber, and the store file are untouched.
     * @param id - row id.
     */
    async function remountRow(id) {
        const probe = probes.get(id);
        const entry = healthEntry(id);
        if (probe !== undefined)
            probe.remounting = true;
        const reason = entry.lastError;
        entry.state = 'remounting';
        entry.restarts += 1;
        entry.lastRestartAt = Date.now();
        entry.restartDelay = entry.restartDelay === 0
            ? PROBE_RESTART_DELAY_MIN_MS
            : Math.min(PROBE_RESTART_DELAY_MAX_MS, entry.restartDelay * 2);
        entry.consecutiveFailures = 0;
        log('warn', 'dsh-mcp-jetbrains: %s 自动重挂（第 %d 次，原因：%s）', id, entry.restarts, reason);
        recordDiagnostic({
            source: 'probe',
            connection: id,
            verdict: reason === '' ? 'probe' : 'stale',
            action: 'auto-remount',
            detail: reason,
        });
        const result = await reconnect(id, { automatic: true });
        const fresh = probes.get(id);
        if (fresh === undefined)
            return;
        fresh.remounting = false;
        if (result.ok) {
            entry.state = 'remounting';
            entry.lastError = '';
            scheduleProbe(id, PROBE_FIRST_DELAY_MS);
            return;
        }
        entry.state = 'stale';
        entry.lastError = result.error ?? '自动重挂失败';
        log('error', 'dsh-mcp-jetbrains: %s 自动重挂失败：%s', id, entry.lastError);
        scheduleProbe(id, nextDelay(entry, fresh));
    }
    /**
     * Dispose one child fiber. Children are owned by `ctx` and would go away with it
     * anyway; forgetting the entry here is what makes a rebuild start from scratch.
     * Disposal is awaited so a rebuild never runs while the old child still holds its
     * `serverName` in the tool registry.
     * @param id - row id.
     * @returns whether a child was mounted.
     */
    async function disposeChild(id) {
        const live = mounted.get(id);
        if (live === undefined)
            return false;
        mounted.delete(id);
        stopProbe(id);
        try {
            await live.fiber?.dispose?.();
        }
        catch (error) {
            log('error', 'dsh-mcp-jetbrains: %s could not be disposed', id, error);
        }
        return true;
    }
    /**
     * Mount one child. The fiber stays addressable in `mounted` so `reconnect` can
     * replace just this row; the single lifetime effect below disposes whatever is
     * left when this plugin unloads.
     * @param row - one effective connection row.
     * @returns whether a child was mounted.
     */
    function mountChild(row) {
        const reason = blockerOf(row);
        if (reason !== '') {
            if (reason === 'disabled')
                log('debug', 'dsh-mcp-jetbrains: %s is disabled, nothing mounted', row.id);
            else
                log('warn', 'dsh-mcp-jetbrains: %s %s', row.id, blockerText(reason));
            return false;
        }
        const headers = row.projectPath === '' ? {} : { IJ_MCP_SERVER_PROJECT_PATH: row.projectPath };
        try {
            const fiber = ctx.plugin(McpClient, {
                serverName: row.serverName,
                transport: 'streamable-http',
                url: row.url,
                headers,
                failOnStartupError: false,
            });
            mounted.set(row.id, { id: row.id, fiber, serverName: row.serverName, url: row.url });
            resetProbeSession(probeState(row.id));
            // The row counts as "remounting" until its first probe clears the grace window.
            healthEntry(row.id);
            if (row.autoReload)
                scheduleProbe(row.id, PROBE_FIRST_DELAY_MS);
            log('info', 'dsh-mcp-jetbrains: mounted %s -> %s (tools are mcp__%s__*)', row.id, row.url, row.serverName);
            return true;
        }
        catch (error) {
            log('error', 'dsh-mcp-jetbrains: %s could not be mounted', row.id, error);
            return false;
        }
    }
    /**
     * Dispose and re-mount one child against the current row. This is the recovery
     * action for "the IDE restarted, so the streamable HTTP session is dead but the
     * tools still look callable"; the automatic path calls it with `automatic`.
     * @param id - row id.
     * @param options - `automatic` keeps the health counters of the auto-reload loop.
     * @returns the outcome the settings page reports.
     */
    async function reconnect(id, { automatic = false } = {}) {
        const row = rows.find((candidate) => candidate.id === id);
        if (row === undefined)
            return { ok: false, error: `没有 id 为「${id}」的连接` };
        const reason = blockerOf(row);
        if (reason !== '')
            return { ok: false, error: blockerText(reason) };
        const replaced = await disposeChild(id);
        if (!mountChild(row))
            return { ok: false, error: '重新挂载失败，详见 Host 日志' };
        if (!automatic) {
            // A user-owned rebuild starts from a clean slate: it is not an auto-restart.
            const entry = healthEntry(id);
            Object.assign(entry, { ...freshHealth(), state: 'remounting', lastError: '' });
        }
        return { ok: true, replaced };
    }
    /**
     * Persist the submitted rows into this plugin's own store and remount every
     * child. Nothing here touches the profile patch: the Loader (and the skin
     * manager that owns a block of that file) keeps it, and this plugin must not
     * fight them over it.
     * @param next - validated rows.
     */
    async function save(next) {
        await writeStore(storePath, next, ideIo);
        rows = next;
        store.status = 'store';
        // Every row is mounted afresh, so health counters and the remount backoff of
        // the previous layout would describe connections that no longer exist.
        for (const id of [...healthByRow.keys()]) {
            if (!next.some((row) => row.id === id))
                healthByRow.delete(id);
        }
        for (const row of next)
            healthByRow.set(row.id, freshHealth());
        // Same serverName may move between rows; dispose everything before mounting
        // anything so the tool registry never sees a duplicate name mid-swap.
        await Promise.all([...mounted.keys()].map((id) => disposeChild(id)));
        for (const row of rows)
            mountChild(row);
        log('info', 'dsh-mcp-jetbrains: saved %d connection row(s) to %s; remounted %d', rows.length, storePath, mounted.size);
    }
    /**
     * Persist only the global switch. The connection layout and its mounted
     * children stay untouched: flipping a file-routing preference must not
     * reconnect every IDE.
     * @param enabled - desired state, already validated by the route.
     */
    async function persistIdeIo(enabled) {
        await writeStore(storePath, rows, { enabled });
        ideIo = { enabled };
        store.status = 'store';
        log('info', 'dsh-mcp-jetbrains: ideIo switched %s (store %s)', enabled ? 'on' : 'off', storePath);
    }
    /* ── Failed-call diagnosis and the single allowed retry ────────────────────
     *
     * `tools/execute` is the documented waterfall around dispatch (see
     * `@deepseek-ai/dsh-tools`' `events.ts`): reaching it means the call already
     * ran, and `next()` resolved to a normalized `ToolExecutionResult`. Everything
     * below only ever runs for a failure of one of THIS plugin's own
     * `mcp__<serverName>__*` tools, and only after a completed diagnosis.
     */
    /**
     * The mounted row whose `serverName` namespace owns `toolName`.
     * @param toolName - the model-facing tool name.
     * @returns the row, or `undefined` for a tool this plugin did not mount.
     */
    function mountedRowOf(toolName) {
        for (const row of rows) {
            if (!mounted.has(row.id))
                continue;
            const prefix = `mcp__${row.serverName}__`;
            if (toolName.startsWith(prefix) && toolName.length > prefix.length)
                return row;
        }
        return undefined;
    }
    /**
     * Dispose and re-mount one row in place for a failed call. Unlike `reconnect`
     * with `automatic: false` this KEEPS the health counters: the outage that made
     * the call fail is still the truth about this connection.
     * @param id - row id.
     * @returns `{ ok: true, replaced }` or `{ ok: false, error }`.
     */
    async function remountForRetry(id) {
        const row = rows.find((candidate) => candidate.id === id);
        if (row === undefined)
            return { ok: false, error: `没有 id 为「${id}」的连接` };
        const blocked = blockerOf(row);
        if (blocked !== '')
            return { ok: false, error: blockerText(blocked) };
        const probe = probes.get(id);
        if (probe !== undefined)
            probe.remounting = true;
        const entry = healthEntry(id);
        const replaced = await disposeChild(id);
        if (!mountChild(row))
            return { ok: false, error: '重新挂载失败，详见 Host 日志' };
        const fresh = probes.get(id);
        if (fresh !== undefined)
            fresh.remounting = false;
        entry.state = 'remounting';
        entry.lastError = '';
        entry.restarts += 1;
        entry.lastRestartAt = Date.now();
        entry.restartDelay = entry.restartDelay === 0
            ? PROBE_RESTART_DELAY_MIN_MS
            : Math.min(PROBE_RESTART_DELAY_MAX_MS, entry.restartDelay * 2);
        return { ok: true, replaced };
    }
    /**
     * Wait, bounded, until the remounted child has registered `toolName` again.
     * Re-dispatching before that would fail with an unrelated `unknown tool`.
     * @param toolName - public tool name.
     * @param serverName - the row's namespace.
     * @param timeoutMs - bounded wait.
     * @returns whether the tool is registered now.
     */
    async function waitForRegistered(toolName, serverName, timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const names = registeredToolsOf(serverName);
            if (names !== undefined && names.includes(toolName))
                return true;
            if (Date.now() >= deadline)
                return false;
            await new Promise((resolve) => {
                const timer = setTimeout(resolve, 100);
                unrefTimer(timer);
            });
        }
    }
    /**
     * Re-dispatch the same call, same parsed arguments, exactly once.
     *
     * This deliberately goes through `ctx.tools.execute` instead of re-entering
     * the captured `next()`: the failed call carried its step's `toolSet`, and a
     * remount replaces the tool's registration object, which makes that admitted
     * snapshot resolve the name to nothing (`unknown tool`). A fresh batch has no
     * step admission, so the just-registered definition is the one that runs.
     * `retryingTools` keeps this second dispatch from starting a second diagnosis.
     * @param exec - the failed execution.
     * @returns the second result, or `undefined` when the executor returned none.
     */
    async function dispatchSameCall(exec) {
        const service = typeof ctx.get === 'function' ? ctx.get('tools') : undefined;
        if (typeof service?.execute !== 'function')
            throw new Error('tools 服务不可用，无法重试');
        const raw = typeof exec.arguments === 'string' ? exec.arguments : JSON.stringify(exec.arguments ?? {});
        const argumentsText = typeof raw === 'string' ? raw : '{}';
        retryingTools.add(exec.name);
        try {
            const batch = await service.execute({
                calls: [{ type: 'tool-call', id: `${String(exec.callId)}#dsh-mcp-jetbrains-retry`, name: exec.name, arguments: argumentsText }],
                signal: exec.signal,
                ...exec.agent === undefined ? {} : { agent: exec.agent },
            });
            return batch?.results?.[0]?.result;
        }
        finally {
            retryingTools.delete(exec.name);
        }
    }
    /**
     * The `tool-missing` answer: a name problem, not a call failure. No retry.
     * @param exec - the failed execution.
     * @param first - the original failed result (its text is preserved).
     * @param row - the owning row.
     * @param toolCount - how many tools the server currently lists.
     * @param similar - similar raw names, may be empty.
     * @returns an `isError` result that leads with the missing name.
     */
    function toolMissingResult(exec, first, row, toolCount, similar) {
        const original = failureTextOf(first);
        const lines = [
            `Error: tool-missing — ${exec.name} 不在连接「${row.id}」（serverName ${row.serverName}）当前的工具清单里。`,
            `诊断：已向该 IDE 新开一次 MCP 会话读取 tools/list，共 ${toolCount} 个工具，其中没有这个原始名。`,
        ];
        if (similar.length > 0)
            lines.push(`相近的名字：${similar.join(', ')}。`);
        if (original !== '')
            lines.push(`原始错误原文：${original}`);
        lines.push('本插件没有重试：重试一个服务器没有列出的工具名不会成功。');
        return {
            isError: true,
            content: [{ type: 'text', text: lines.join('\n') }],
            error: {
                message: `tool-missing: ${exec.name} is not in ${row.serverName}'s current tool list (${toolCount} tools)`,
                info: {
                    name: 'ToolMissingError',
                    code: 'TOOL_MISSING',
                    ...original === '' ? {} : { reason: original.slice(0, 1000) },
                },
            },
            meta: {
                'dsh-mcp-jetbrains': {
                    verdict: 'tool-missing',
                    connection: row.id,
                    serverName: row.serverName,
                    tool: exec.name,
                    toolCount,
                    similar,
                },
            },
        };
    }
    /**
     * Append one model-facing note to a failed result without touching its error.
     * @param result - the result to annotate.
     * @param note - the text block to append.
     * @returns a new `isError` result.
     */
    function withNote(result, note) {
        const content = Array.isArray(result?.content) ? result.content : [];
        return { ...result, content: [...content, { type: 'text', text: note }] };
    }
    /**
     * Diagnose one failed MCP tool call and, only when the diagnosis allows it,
     * remount that one connection and retry exactly once.
     * @param exec - the failed execution (`name`, `arguments`, `signal`, `agent`).
     * @param row - the owning mounted row.
     * @param first - the original failed result.
     * @returns the result the caller returns to the model.
     */
    async function diagnoseAndRetry(exec, row, first) {
        const tool = exec.name;
        const record = (fields) => recordDiagnostic({ source: 'tool-call', tool, connection: row.id, ...fields });
        let inspect;
        try {
            inspect = await inspectSurface(row, AbortSignal.timeout(DIAGNOSE_TIMEOUT_MS));
        }
        catch (error) {
            inspect = { kind: 'unreachable', error: `读取工具清单失败：${messageOf(error)}` };
        }
        if (inspect.kind !== 'ok') {
            // No diagnosis, no retry — and the original failure stays exactly as it was.
            record({ verdict: 'undiagnosable', action: 'none', detail: inspect.error });
            log('warn', 'dsh-mcp-jetbrains: 无法诊断 %s（%s），按原样返回失败', tool, inspect.error);
            return withNote(first, `【dsh-mcp-jetbrains 诊断】未能读取连接「${row.id}」的工具清单（${inspect.error}），因此没有重试。原始错误见上。`);
        }
        const present = inspect.toolNames.some((rawName) => publicToolName(row.serverName, rawName) === tool);
        if (!present) {
            const prefix = `mcp__${row.serverName}__`;
            const hint = tool.startsWith(prefix) ? tool.slice(prefix.length) : tool;
            const similar = similarRawNames(hint, inspect.toolNames);
            record({ verdict: 'tool-missing', action: 'none', toolCount: inspect.toolNames.length, similar });
            log('warn', 'dsh-mcp-jetbrains: %s 判定 tool-missing（IDE 现有 %d 个工具），不重试', tool, inspect.toolNames.length);
            return toolMissingResult(exec, first, row, inspect.toolNames.length, similar);
        }
        const text = failureTextOf(first);
        // Router mode wraps the real tool name inside the `command` argument, so a
        // typo never shows up in `exec.name`. Router sessions list only
        // `execute_tool`, so the inner names can only come from the server's own
        // failure text; when it advertises none we say nothing rather than guess.
        const prefixOfConnection = `mcp__${row.serverName}__`;
        const rawName = tool.startsWith(prefixOfConnection) ? tool.slice(prefixOfConnection.length) : tool;
        if (rawName === 'execute_tool') {
            const inner = routerCommandName(exec.arguments);
            const advertised = availableToolsFromError(text);
            if (inner !== undefined && advertised !== undefined && !advertised.includes(inner)) {
                const similar = similarRawNames(inner, advertised);
                record({ verdict: 'tool-missing', action: 'none', router: true, innerTool: inner, toolCount: advertised.length, similar });
                log('warn', 'dsh-mcp-jetbrains: %s 的子命令 %s 不在工具清单里（IDE 现有 %d 个工具），不重试', tool, inner, advertised.length);
                return withNote(first, `【dsh-mcp-jetbrains 诊断】路由器工具 ${tool} 的子命令「${inner}」不在 IDE 的工具清单中`
                    + `（现有 ${advertised.length} 个${similar.length > 0 ? '；相近名字：' + similar.join('、') : ''}）。`
                    + '这是工具名问题，不是连接问题，因此没有重试。');
            }
        }
        const pattern = transportPatternOf(text);
        if (pattern === undefined) {
            // Tool exists, but this is not a transport/session failure: argument
            // validation, a business error, or a 4xx semantic error. Return it as is.
            record({ verdict: 'not-transport', action: 'none', error: text.slice(0, 400) });
            return first;
        }
        const sinceLast = Date.now() - (lastAutoRemountAt.get(row.id) ?? 0);
        if (sinceLast < AUTO_REMOUNT_COOLDOWN_MS) {
            const left = Math.ceil((AUTO_REMOUNT_COOLDOWN_MS - sinceLast) / 1000);
            record({ verdict: 'not-retried', action: 'skipped-cooldown', pattern, retryAfterSeconds: left, error: text.slice(0, 400) });
            return withNote(first, `【dsh-mcp-jetbrains 诊断】工具存在，错误属传输/会话类（命中「${pattern}」），但连接「${row.id}」在 60 秒冷却内刚自动重挂过（还剩 ${left} 秒），本次不重挂也不重试。`);
        }
        lastAutoRemountAt.set(row.id, Date.now());
        const remounted = await remountForRetry(row.id);
        if (!remounted.ok) {
            record({ verdict: 'not-retried', action: 'remount-failed', pattern, detail: remounted.error });
            return withNote(first, `【dsh-mcp-jetbrains 诊断】工具存在、错误属传输/会话类（命中「${pattern}」），已尝试就地重挂连接「${row.id}」但失败（${remounted.error}），因此没有重试。`);
        }
        record({ verdict: 'diagnosed', action: 'remounted', pattern });
        const ready = await waitForRegistered(tool, row.serverName, RETRY_REMOUNT_WAIT_MS);
        if (!ready) {
            record({ verdict: 'not-retried', action: 'remount-tool-absent', pattern, detail: `等待 ${RETRY_REMOUNT_WAIT_MS}ms 后工具仍未重新注册` });
            return withNote(first, `【dsh-mcp-jetbrains 诊断】工具存在、已就地重挂连接「${row.id}」，但 ${Math.round(RETRY_REMOUNT_WAIT_MS / 1000)} 秒内 ${tool} 没有重新注册，因此没有重试。`);
        }
        if (exec.signal?.aborted) {
            record({ verdict: 'not-retried', action: 'aborted', pattern });
            return withNote(first, `【dsh-mcp-jetbrains 诊断】工具存在、已就地重挂连接「${row.id}」，但这次调用已被取消，因此没有重试。`);
        }
        let second;
        try {
            second = await dispatchSameCall(exec);
        }
        catch (error) {
            record({ verdict: 'retried', action: 'retry-threw', pattern, detail: messageOf(error) });
            return withNote(first, `【dsh-mcp-jetbrains 诊断】已诊断：工具存在、已重挂并重试一次，但重试本身抛错（${messageOf(error)}）。原始错误见上。`);
        }
        if (second === undefined) {
            record({ verdict: 'retried', action: 'retry-no-result', pattern });
            return withNote(first, '【dsh-mcp-jetbrains 诊断】已诊断：工具存在、已重挂并重试一次，但执行器没有返回结果。原始错误见上。');
        }
        if (!second.isError) {
            record({ verdict: 'retried', action: 'retry-ok', pattern, error: text.slice(0, 400) });
            log('info', 'dsh-mcp-jetbrains: %s 重挂并重试成功（命中「%s」）', tool, pattern);
            return second;
        }
        const secondText = failureTextOf(second);
        record({ verdict: 'retried', action: 'retry-failed', pattern, error: secondText.slice(0, 400), firstError: text.slice(0, 400) });
        log('warn', 'dsh-mcp-jetbrains: %s 重挂并重试后仍失败', tool);
        const note = [
            '【dsh-mcp-jetbrains 诊断】已诊断：工具存在、已重挂并重试一次、仍失败。',
            `- 连接：${row.id}（serverName ${row.serverName}），命中的传输类特征：${pattern}`,
            `- 第一次错误：${text}`,
            `- 重试错误：${secondText}`,
        ].join('\n');
        return {
            ...second,
            content: [...(Array.isArray(second.content) ? second.content : []), { type: 'text', text: note }],
            meta: {
                'dsh-mcp-jetbrains': {
                    verdict: 'retried',
                    action: 'retry-failed',
                    connection: row.id,
                    serverName: row.serverName,
                    tool,
                    pattern,
                    firstError: text,
                    retryError: secondText,
                    toolCount: inspect.toolNames.length,
                },
            },
        };
    }
    /**
     * The `tools/execute` waterfall.
     *
     * While `ideIo` is on, `read` / `write` / `edit` are answered by the IDE path
     * and `next()` is NEVER called — that is the whole enforcement: no code below
     * can fall back to disk. The single exception is a switch with zero enabled
     * connections: nothing can accept the call, so the user is ASKED how to proceed
     * ({@link askForConnectionThenRetry}). Only the answer "let this one run natively"
     * reaches `next()`, and that pass-through is recorded as
     * `ide-io-user-approved-passthrough` with a visible note on the result; paste,
     * cancel, a failed question and a missing `userQuestions` service all return an
     * explicit failure. Otherwise the call runs normally, and a failure of one of
     * this plugin's own `mcp__<serverName>__*` tools goes through
     * {@link diagnoseAndRetry}. A diagnosis that throws is contained: the original
     * failure is returned unchanged.
     */
    ctx.on('tools/execute', async (exec, next) => {
        const toolName = typeof exec?.name === 'string' ? exec.name : '';
        if (ideIo.enabled && FILE_TOOL_NAMES.includes(toolName)) {
            if (enabledRows().length === 0) {
                // The switch is on but nothing could ever accept the call. Asking is the
                // ONLY honest move: silently using the disk would make the model believe
                // the IDE's view was consulted. The ask returns an explicit result on
                // every branch except the user-approved native pass-through.
                return await askForConnectionThenRetry(exec);
            }
            return routeFileTool(exec);
        }
        const result = await next();
        if (result === undefined || result.isError !== true)
            return result;
        if (toolName === '' || retryingTools.has(toolName))
            return result;
        const row = mountedRowOf(toolName);
        if (row === undefined)
            return result;
        if (exec.signal?.aborted)
            return result;
        try {
            return await diagnoseAndRetry(exec, row, result);
        }
        catch (error) {
            recordDiagnostic({ source: 'tool-call', tool: toolName, connection: row.id, verdict: 'diagnosis-error', action: 'none', detail: messageOf(error) });
            log('error', 'dsh-mcp-jetbrains: 诊断 %s 时抛错，按原样返回失败', toolName, error);
            return result;
        }
    });
    /** The profile patch row that owns this plugin, read-only, for diagnostics. */
    function findEntry() {
        try {
            const editor = typeof ctx.get === 'function' ? ctx.get('configEditor') : undefined;
            if (typeof editor?.entries !== 'function')
                return undefined;
            const entries = editor.entries();
            return entries.find((candidate) => candidate?.options?.name === PACKAGE_NAME)
                ?? entries.find((candidate) => String(candidate?.options?.id ?? '').endsWith('jetbrains-mcp'));
        }
        catch {
            return undefined;
        }
    }
    for (const row of rows)
        mountChild(row);
    // Tool-name evidence for the report and for a renamed registry: log exactly
    // which file tools this profile registers, and warn when the switch is on but
    // there is no connection that could ever accept a routed call.
    const fileTools = interceptedFileTools();
    log('info', 'dsh-mcp-jetbrains: ideIo intercepts [%s]; registry file tools [%s]', FILE_TOOL_NAMES.join(', '), fileTools.join(', '));
    if (ideIo.enabled && enabledRows().length === 0) {
        log('warn', 'dsh-mcp-jetbrains: ideIo is ON but no connection is enabled; the next read/write/edit asks the user whether to paste an IDE config, use the native path once, or cancel');
    }
    ctx.effect(() => () => Promise.all([...mounted.keys()].map((id) => disposeChild(id))).then(() => undefined), 'dsh-mcp-jetbrains.children');
    // The page below is self-provided, so tell Settings not to generate one from
    // the schema later. Optional: a composition without Settings runs unchanged.
    ctx.inject(['settings'], (child) => {
        child.effect(() => {
            try {
                return child.settings.configure({ auto: false }, ctx.fiber);
            }
            catch (error) {
                // Already configured for this instance (a second apply on one fiber):
                // keep the existing policy and its disposer rather than failing activation.
                log('warn', 'dsh-mcp-jetbrains: settings presentation policy was already configured', error);
                return () => { };
            }
        }, 'dsh-mcp-jetbrains.settings-presentation');
    });
    const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : undefined;
    if (typeof webServer?.register !== 'function') {
        log('warn', 'dsh-mcp-jetbrains: no webServer service; the settings page cannot reach the host');
        return;
    }
    /**
     * Refuse a request that carries no valid identity, before it can read or change
     * anything. DSH's own browser trust decides, so this route is exactly as
     * reachable as the settings page that calls it: same-origin plus the signed
     * `dsh-auth-*` cookie. The body never repeats a row value or the store path.
     * @param req - incoming route request.
     * @param res - response owned when the request is refused.
     * @returns whether the request was refused (and answered) here.
     */
    function refused(req, res) {
        let trust;
        try {
            const service = typeof ctx.get === 'function' ? ctx.get('connection') : undefined;
            trust = typeof service?.requestRejection === 'function' ? service : undefined;
        }
        catch {
            trust = undefined;
        }
        let status;
        if (trust !== undefined) {
            try {
                status = trust.requestRejection(req);
            }
            catch (error) {
                // A trust decision that cannot run must not become an allow.
                log('error', 'dsh-mcp-jetbrains: 连接信任校验抛错，按拒绝处理', error);
                status = 403;
            }
        }
        else {
            // No Connection service in this composition: keep the same-origin invariant
            // the page itself relies on, and refuse everything else.
            status = sameOriginOnly(req.headers) ? undefined : 403;
        }
        if (status === undefined)
            return false;
        sendJson(res, status === 401 ? 401 : 403, {
            ok: false,
            error: status === 401 ? 'unauthorized' : 'forbidden',
        });
        return true;
    }
    ctx.effect(() => webServer.register({
        kind: 'exact',
        path: `${ROUTE_BASE}/config`,
        handler: async (req, res) => {
            if (refused(req, res))
                return;
            if (req.method === 'GET' || req.method === 'HEAD') {
                // `?probe=surface` reads every mounted connection's `tools/list` NOW on a
                // fresh session, then answers with the health this very check wrote. The
                // page sends it once per load/manual refresh; its 15-second poll does not,
                // because one IDE list is ~138 KiB. An unknown `probe` value is ignored.
                const requested = new URL(req.url ?? '/', 'http://localhost').searchParams.get('probe');
                const forced = requested === 'surface'
                    ? await Promise.all([...mounted.keys()].map((id) => forceSurfaceCheck(id)))
                    : [];
                const entry = findEntry();
                sendJson(res, 200, {
                    ok: true,
                    entry: PACKAGE_NAME,
                    entryId: entry?.options?.id === undefined ? '' : String(entry.options.id),
                    connections: rows,
                    mounted: mountedRows(),
                    health: healthMap(),
                    ideIo: ideIoView(),
                    probe: {
                        intervalMs: probeIntervalMs(),
                        failureThreshold: PROBE_FAILURE_THRESHOLD,
                        surfaceEvery: PROBE_SURFACE_EVERY,
                        okBackoffMaxMs: PROBE_OK_BACKOFF_MAX_MS,
                        surfaceMaxDelayMs: PROBE_SURFACE_EVERY * PROBE_OK_BACKOFF_MAX_MS,
                        forced: requested === 'surface' ? forced : [],
                    },
                    diagnostics: diagnostics.slice(),
                    diagnosticsLimit: DIAGNOSTICS_LIMIT,
                    store,
                });
                return;
            }
            if (req.method !== 'POST') {
                sendJson(res, 405, { ok: false, error: '只接受 GET 与 POST' });
                return;
            }
            let body;
            try {
                body = await readJsonBody(req);
            }
            catch (error) {
                sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
                return;
            }
            const { rows: next, problems } = validateConnections(body?.connections);
            if (problems.length > 0) {
                sendJson(res, 400, { ok: false, error: problems[0], problems });
                return;
            }
            if (ideIo.enabled && next.every((row) => !row.enabled)) {
                // Legitimate state since the switch defaults to ON: it simply has nothing
                // to serve, so file tools keep using the disk path and say so in
                // `diagnostics`. Report it here instead of refusing the save; refusing
                // would leave the page and the store disagreeing about what was asked.
                log('warn', 'dsh-mcp-jetbrains: saved %d connection row(s) with ideIo on and none enabled; file tools stay on the plain disk path until one is enabled', next.length);
            }
            try {
                await save(next);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                log('error', 'dsh-mcp-jetbrains: could not write %s', storePath, error);
                sendJson(res, 500, { ok: false, error: `写入插件自有存储失败：${message}`, store });
                return;
            }
            sendJson(res, 200, {
                ok: true,
                saved: true,
                connections: rows,
                mounted: mountedRows(),
                health: healthMap(),
                ideIo: ideIoView(),
                diagnostics: diagnostics.slice(),
                store,
            });
        },
    }), 'dsh-mcp-jetbrains.route.config');
    /**
     * Flip the global switch. This is the only writer of `ideIo`. Turning it on
     * without an enabled connection is allowed: the switch is then "not in force",
     * and each file call asks the user how to proceed (paste a config / native path
     * once / cancel) instead of guessing. The switch is never silently overridden.
     */
    ctx.effect(() => webServer.register({
        kind: 'exact',
        path: `${ROUTE_BASE}/ide-io`,
        handler: async (req, res) => {
            if (refused(req, res))
                return;
            if (req.method !== 'POST') {
                sendJson(res, 405, { ok: false, error: '只接受 POST' });
                return;
            }
            let body;
            try {
                body = await readJsonBody(req);
            }
            catch (error) {
                sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
                return;
            }
            if (typeof body?.enabled !== 'boolean') {
                sendJson(res, 400, { ok: false, error: 'enabled 必须是布尔值' });
                return;
            }
            if (body.enabled && enabledRows().length === 0) {
                log('warn', 'dsh-mcp-jetbrains: ideIo turned on with no enabled connection; it is inactive until one is enabled');
            }
            try {
                await persistIdeIo(body.enabled);
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                log('error', 'dsh-mcp-jetbrains: could not write the ideIo switch to %s', storePath, error);
                sendJson(res, 500, { ok: false, error: `写入插件自有存储失败：${message}`, store });
                return;
            }
            sendJson(res, 200, { ok: true, ideIo: ideIoView(), store });
        },
    }), 'dsh-mcp-jetbrains.route.ide-io');
    ctx.effect(() => webServer.register({
        kind: 'exact',
        path: `${ROUTE_BASE}/reconnect`,
        handler: async (req, res) => {
            if (refused(req, res))
                return;
            if (req.method !== 'POST') {
                sendJson(res, 405, { ok: false, error: '只接受 POST' });
                return;
            }
            let body;
            try {
                body = await readJsonBody(req);
            }
            catch (error) {
                sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
                return;
            }
            const id = text(body?.id);
            if (id === '') {
                sendJson(res, 400, { ok: false, error: '缺少连接 id' });
                return;
            }
            const result = await reconnect(id);
            sendJson(res, result.ok ? 200 : 400, { ...result, mounted: mountedRows(), health: healthMap() });
        },
    }), 'dsh-mcp-jetbrains.route.reconnect');
}
