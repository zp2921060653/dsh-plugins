# dsh-mcp-jetbrains

[中文](README.md) | English · [Safety](SAFETY.en.md) · [Roadmap](文档/软件工程/0.项目管理/路线规划.md)

A DeepSeek Harness (DSH) plugin that turns the MCP Server built into JetBrains IDEs into DSH tools, so the agent can use the IDE directly: diagnostics, builds, file reads, databases, terminals, debugging.

The DSH side is only a connection manager and **installs nothing into your IDE**: since 2025.2, IntelliJ IDEA ships an `MCP Server` plugin that is enabled by default. The name says jetbrains rather than idea because it also connects CLion and PyCharm.

> **Read the [safety notes](SAFETY.en.md) first.** Wiring up the IDE's MCP hands the model everything the IDE can do — including running terminal commands and writing to databases.

## Why this exists

A single project holds two truths that never reconcile:

| | What it looks at |
|---|---|
| The IDE | The in-memory buffer plus its own inspection engine |
| DSH | Bytes on disk |

Hence "the IDE reports an error while DSH finds nothing", and "after the IDE restarts the tools are still listed, but every call fails with session not found".

The principle that follows:

> **Unable to read ≠ fine.** When the IDE's verdict cannot be obtained, say "unknown/unavailable" explicitly. Never degrade it into "check passed".

## What it provides

| Capability | Detail |
|---|---|
| Multi-IDE connection management | One MCP client child plugin per connection; settings live in the plugin's own store, never in the profile's `cordis.patch.yml`, so changes need no DSH restart |
| Health probing | Background probes distinguish "TCP refused (IDE not running)" from "session 404 / tool surface changed (stale)" |
| Automatic remount | Only the affected connection is remounted; other connections and the configuration stay untouched |
| Failure self-diagnosis | On failure, fetch the server's tool list to tell "wrong tool name" from "connection problem"; only transport-class failures trigger a remount and **one** retry |
| Read/write via IDE | A switch that forces `read` / `write` / `edit` through the IDE, failing loudly instead of falling back to disk |
| Diagnostics panel | The host keeps the last 50 automatic actions; the settings page shows the first 5, answering "why did it reconnect on its own" |

## Install

Requires IDE 2025.2+ (built-in MCP Server, enabled by default) with a reachable MCP Server endpoint.

```text
plugin_manager install_bundle  target = <this repository root>
```

**Reinstalling requires `remove_bundle` first**: linked plugins are not hot-reloaded; editing sources changes nothing until reinstalled.

Then open **Settings → JetBrains IDE 连接**.

Configuration lives at:

```text
$DSH_HOME/storages/dsh-mcp-jetbrains.connections.json
```

Shape: `{ version: 1, ideIo: { enabled }, connections: [...] }`. If an older install (`@local/dsh-mcp-idea`) left `dsh-mcp-idea.connections.json`, it is migrated automatically on first start and **the old file is kept for rollback**.

## Configuring a connection

| Field | Meaning |
|---|---|
| Connection ID | Used for logs and diagnostics, shown in the UI, must be unique within the config |
| `serverName` | Tool-name prefix matching `^[A-Za-z0-9_-]{1,32}$`; tools appear as `mcp__<serverName>__*`, so renaming it renames the tools |
| MCP address | Where the IDE's MCP Server listens; DSH connects with `streamable-http`, e.g. `http://127.0.0.1:64342/stream` |
| Project path | Optional. Sent as the `U_MCP_SERVER_PROJECT_PATH` header; leave empty to let the IDE choose |
| Enabled / Auto-reload | Whether to mount it, and whether background auto-reconnect is allowed |

Ports follow **no formula**: on our machine IDEA used 64342, CLion 64362, PyCharm 64462. Trust what the IDE shows.

### Router mode vs full mode (must read)

The IDE's MCP Server has a tool-exposure switch. In **router-only mode** `tools/list` returns a single `execute_tool`, and everything else hides behind it with string arguments of the form `--name value`, not structured JSON:

```text
mcp__idea__execute_tool  →  get_file_problems --filePath src/main.ts
```

On our machine that mode exposed 66 real tools. **This is a snapshot taken when the connection is established**: after switching modes you must reconnect to see the new tool surface.

## Read/write via IDE

A switch at the top of the settings page, stored as `ideIo.enabled` (**on by default**). When on, the plugin intercepts `read` / `write` / `edit` at the tool layer and routes them to the IDE's `read_file` / `create_new_file` / `apply_patch`.

Routing: longest-prefix match between the target file's absolute path and each enabled connection's `projectPath`; a tie fails; no match with exactly one enabled connection falls back to it (recorded as `fallback: true`).

**Core semantics: when it cannot route, it fails loudly and never silently writes to disk.** The error lists three remedies: turn the switch off, enable a connection covering that file, or fix its `projectPath`.

### When there is no connection yet

The switch may stay on; the plugin neither refuses to work nor decides for you. The first `read` / `write` / `edit` **asks you**:

| Option | Outcome |
|---|---|
| Paste JetBrains config | Put the IDE's "copy config" JSON in the custom answer; the plugin creates a connection and **retries the same call** |
| Do not run it for me | The plugin writes nothing and tells the model plainly: use the shell yourself, or enable a connection and retry |
| Cancel | Nothing happens |

The second option is deliberate: extra text on a *successful* result is dropped by the host pipeline, so if the plugin wrote to disk on your behalf the model would believe the bytes came from the IDE — exactly the confusion this project exists to remove. One extra round beats one silent misconception.

`edit` never reads the whole file: it locates with `search_text` first, then applies with `apply_patch`, under hard budgets (3 context lines, 10 candidates, 200 lines read per call, at most 2 patch attempts).

## Known limitations

This section is the honest part; read it before installing. Full risk notes live in [Safety](SAFETY.en.md).

| Limitation | Detail |
|---|---|
| Shell deletion is not covered | The switch only intercepts `read`/`write`/`edit`. A model running `Remove-Item` / `rm` bypasses the IDE, and Local History cannot save you |
| Terminal and SQL are not covered | The IDE's `execute_terminal_command` and `execute_sql_query` stay available regardless of routing policy |
| EOL is decided by the IDE | Writes through the IDE produced **CRLF** on our machine, while DSH writes LF |
| Reads may return the IDE buffer | If the file is open with unsaved edits, you read the buffer (measured 640 lines vs 763 on disk) |
| `apply_patch` ignores ambiguity | With repeated text it **silently patches the first match** and reports success (verified). Hence `edit` must locate first |
| Docs disagree with this build | The official docs describe `mode`/`start_line`; IDE 2026.2.3 actually takes `(file_path, offset, limit)` |
| `apply_patch` batches are not atomic | Valid operations apply, invalid ones report per-path errors, **no rollback**: `1 out of 2 operations applied` |
| `write` still reads once | To produce the native `before` it reads offset 1 / limit 5000; files over 5000 lines get a truncation marker |

## Build

Sources are TypeScript / TSX, compiled 1:1 by `tsc`, **no bundling**:

```text
pnpm build      # tsc -p tsconfig.host.json && tsc -p tsconfig.client.json
```

| Source | Output | Notes |
|---|---|---|
| `src/index.ts` | `lib/index.js` | Host half, Node ESM, bare `import` allowed |
| `src/client.tsx` | `client.js` | Client half (settings page), **must contain no `import` at all** |

Host and client are compiled by two configs (`tsconfig.host.json` / `tsconfig.client.json`) that share the options in `tsconfig.json`: the host lands in `lib/`, the client stays at the root — the conventional layout for DSH plugins. Static assets live in `assets/` (`icon.svg`); `locale/*.json` must stay at the root, because DSH reads it by directory convention and also expects it in `exports`.

JSX uses the classic runtime (`jsx: "react"` + `jsxFactory: "h"`): the browser loads a bare ESM factory script that cannot resolve `react/jsx-runtime`.

`@deepseek-ai/*` are peer dependencies and are not resolvable inside this project; types come from module shims in `src/env.d.ts`.

`pnpm-lock.yaml` is **not committed**: `pnpm install` here hits a 404 on an unpublished upstream package, so the lock cannot be validated. `pnpm-workspace.yaml` therefore disables `verifyDepsBeforeRun`.

## Compatibility

| Item | Value |
|---|---|
| IDE | 2025.2+ built-in MCP Server (enabled by default) |
| Measured on | **2026.2.3 (IU-262.10968.63)**, `since-build = 262` |
| DSH transports | `stdio`, `streamable-http` (**no SSE**) |
| Older versions | Untested; community feedback welcome |

## Roadmap

Technical judgement, measurements, and plans live in the [roadmap](文档/软件工程/0.项目管理/路线规划.md). The next round wires deletion, moves, and symbol renames into the IDE (`apply_patch` Delete / move-to and `rename_refactoring`).

## Support

If this plugin helps you, you can scan the code below to buy me a coffee.

<img src="assets/wechat-reward.png" alt="WeChat reward code" width="220">

Sponsorship is entirely voluntary and does **not** affect any right granted by the [MIT License](LICENSE): you may use, modify, and distribute it whether or not you donate.

## License

[MIT](LICENSE) © 2026 极下少主 (darkwithlight)
