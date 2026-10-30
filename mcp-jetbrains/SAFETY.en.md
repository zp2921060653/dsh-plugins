# Safety

[中文](SAFETY.md) | English

## Experimental status

This plugin is experimental developer-preview software. It has not been security-audited and must not be treated as secure or production-ready.

It is only a connection manager — but **the tools it registers are the real IDE's tools**, and those tools can modify files, run commands, reach databases, and drive a debugger.

## What this plugin hands to the model

`dsh-mcp-jetbrains` implements no capabilities of its own. It registers the tools exposed by your IDE's built-in MCP Server with the DSH agent, as-is. On the IntelliJ IDEA 2026.2.3 build we measured, one connection exposes **66 tools**, including but not limited to:

| Tool | What it can do |
|---|---|
| `execute_terminal_command` | Run commands in the IDE terminal |
| `execute_sql_query` / `create_database_connection` | Run SQL against data sources configured in the IDE, alter connections |
| `apply_patch` / `create_new_file` / `read_file` | Read and modify files inside the project |
| `execute_run_configuration` | Run a Run Configuration (i.e. your launch scripts) |
| `xdebug_start_debugger_session` / `xdebug_set_variable` | Start debugging, read and write runtime values |
| `build_project` / `run_inspection_kts` | Build, and execute custom inspection scripts (Kotlin) |

In other words: **connecting the IDE's MCP hands the model everything the IDE can do**, and the IDE can execute arbitrary commands.

## Risks that follow

Wrong model output, prompt injection, defects, misconfiguration, or malicious input may cause:

- arbitrary command execution inside the project (including deletion and data exfiltration);
- reads and writes of open project files, including uncommitted changes;
- write operations against a **production database** configured in your IDE;
- indirect code execution through build scripts, Run Configurations, or inspection scripts;
- disclosure of code, credentials, and connection strings that the model can see.

## Limits this plugin does impose

| Limit | Detail |
|---|---|
| Route authentication | Every settings route runs behind DSH's own browser trust; without the cookie the answer is `401` and no configuration leaks |
| Path boundary | File operations routed through the IDE are confined to the project directory by the IDE itself; anything outside is rejected |
| Never silently fall back | With "read/write via IDE" on, an unroutable request must fail loudly with remedies — it never quietly writes to disk |
| It asks before acting when unconfigured | The switch may stay on with no usable connection: the first file operation asks you (paste the IDE config / do not run it for me / cancel). Choosing "do not run it" makes the plugin write **nothing** and hand the choice back to the model explicitly, so nobody believes the IDE served a plain disk read |
| `edit` budget | Multiple matches report candidate line numbers and fail; one `edit` reads at most 200 lines and attempts `apply_patch` at most twice |
| Audit trail | Automatic reconnects, diagnoses, and self-corrections go into `diagnostics` (last 50 entries), so "why did it do that" stays answerable |
| Reconnect cooldown | A connection is not auto-remounted twice within 60 seconds |

## What these limits do not cover

- **Terminal and SQL tools are not governed by "read/write via IDE"** — that switch only intercepts `read`, `write`, and `edit`.
- **Shell deletion is not governed either**: `Remove-Item` / `rm` bypasses the IDE entirely, and Local History cannot save you.
- **No OS-level isolation**: the MCP Server runs as the same OS user as your IDE; this is not a sandbox.
- **No intent validation or content filtering**: the plugin routes; it does not police.
- **Reads may return the IDE buffer**, including unsaved content.

## Data and network

- **No telemetry**: there is no reporting, analytics, or third-party call in the source.
- **The only outbound connection is the MCP address you configured** (a TCP dial for health probes plus session requests). Nothing goes to a third party.
- Configuration lives at `$DSH_HOME/storages/dsh-mcp-jetbrains.connections.json` on your machine.

## Responsible use

- Connect only IDEs and projects **you are authorized to access**.
- Prefer trying it in a disposable VM, container, or dedicated environment.
- Start from **least privilege**: leave "read/write via IDE" off until diagnostic tools prove sufficient.
- **Do not** point this plugin at a production database unless you accept that the model may write to it.
- Back up files it can reach, and keep important work under version control.
- Review the connection settings (address, `serverName`, `projectPath`) and the IDE's MCP tool-exposure settings before granting access.

## Legitimate and prohibited use

This project exists to connect **your own (or authorized) development environment** to a DSH agent, so it can read diagnostics, build results, and project files.

It explicitly does not support, and must not be used for: unauthorized access to other people's machines or data, circumventing software licensing or authorization, cracking or bypassing access controls, or any use that violates applicable law or the license terms of the IDE you use.

The author is not responsible for how you use it; you are responsible for keeping your use lawful.

## No warranty, no liability

Use this plugin with full understanding of the risks involved. It is provided under the [MIT License](LICENSE), without warranty of any kind. To the maximum extent permitted by applicable law, the authors and copyright holders are not liable for computer damage, data loss or disclosure, lost files, or other damages arising from its use.

Please report security issues through the repository's Issues; if the report contains exploitable details, say so and the author will prioritize it.
