# dsh-mcp-plugin

English | [中文](README.zh.md)

Manage MCP servers for DeepSeek Harness and keep them **live-callable**. The plugin adds
`mcp_list` / `mcp_add` / `mcp_modify` / `mcp_remove` tools that register, reconnect, and remove
MCP servers in the running harness. Each server is backed by a real
`@deepseek-ai/dsh-mcp-client` fiber, so an added server's tools appear on `ctx.tools`
immediately as `mcp__<serverName>__<tool>` — and removing the server unmounts them at once.

## How it works

- **Store** — server definitions persist to `~/.dsh/mcp-servers.json` (or a per-profile
  `storePath`). The definition is exactly the mcp-client `Config`, so it is wire-ready for a
  live mount with no schema drift. A file written by hand in the Claude-Code `mcpServers`
  style (e.g. `{ "mcpServers": { "postgres": { "command": …, "args": […] } } }`) is detected
  and migrated in place on load: the transport is inferred from the entry's fields and each
  server is named after its key; the next save normalizes the file to the native
  `{ version, servers }` envelope.
- **Live mounting** — on `add`/`modify`/load the plugin mounts a child mcp-client fiber under
  its own context (`ctx.plugin`). The fiber is disposed on `remove`/`modify` and unwinds with
  the plugin on teardown. On plugin load every stored server is re-mounted, so the set
  survives a restart.
- **Transports** — `stdio` (spawned child process: `command`/`args`/`env`/`cwd`) and
  `streamable-http` (remote endpoint: `url`/`headers`), matching mcp-client.
- **Per-session server choice** — the client half also registers a compact picker on
  `conversation.composer.dock` (the ambient row below the chat input). For the active
  session the user prefers one managed server (or「自动」for no preference). The choice is
  kept in memory on the host, keyed by session id, and reaches the model as a dynamic
  `mcp-server-preference` context entry on every prompt assembly for that session, so sent
  requests steer toward the selected server's `mcp__<serverName>__*` tools when they are
  needed. The picker and the management panel talk to the host over the same-origin
  `/api/mcp/*` routes (the standalone-plugin bridge).

A server that is down on `add` does not fail the call (the mcp-client default
`failOnStartupError: false` is used); its reconnect loop keeps trying and its tools appear
when a connection succeeds. `mcp_list` reports each server as `connected` or `connecting`.

## Enable

The bundle ships disabled. In your profile's `cordis.patch.yml`:

```yaml
- id: dsh-mcp-plugin-host
  disabled: false
  config:
    storePath: '~/.dsh/mcp-servers.json'   # optional; defaults to $DSH_HOME/mcp-servers.json
```

## The tools

| Tool | Purpose |
| --- | --- |
| `mcp_list` | List registered servers with transport, connection status, and tool count. |
| `mcp_add` | Register and live-mount a new server (`serverName`, `transport`, and the matching fields). |
| `mcp_modify` | Change a stored server and reconnect it; `serverName` is immutable. |
| `mcp_remove` | Disconnect and delete a server (its tools become unavailable). |

## Choosing a server per session

A compact picker sits on `conversation.composer.dock` — the ambient row directly below the
chat input. It lists every managed server (with a live status dot and tool count) plus a「自动」
chip. Clicking a server chip prefers that server for the **current session**; clicking it
again (or「自动」) clears the preference. The choice is stored on the host per session id and,
on every prompt assembly for that session, contributes a `mcp-server-preference` context entry
so the model prefers that server's `mcp__<serverName>__*` tools when they are needed.

- The picker is a no-op (renders nothing) when no server is managed.
- The preference is in-memory and per session: it does not persist across a restart and does
  not affect other sessions.
- Clearing a server via `mcp_remove` drops any session preference that pointed at it.

Under the hood the picker reads/writes the per-session preference over the same-origin
`/api/mcp/pref` route (`GET ?sessionId=` to read, `POST {sessionId, serverName}` to set or
clear with `null`), part of the standalone-plugin webserver bridge alongside `/api/mcp/*`.

## Develop / test

```sh
# From the plugin directory, against the repo's built packages and node_modules:
npm run typecheck     # host + client typecheck
npm run build         # emit lib/ (host tsc + client tsdown bundle)
npm test              # live-mount + per-session-preference integration tests
```

## Known Limitations and Deferred Work

- Status is derived from registered `mcp__<name>__*` tools, not the mcp-client's internal
  connection state, so a server between reconnects reports `connecting` rather than the exact
  error.
- A downed server keeps its reconnect loop alive; `mcp_remove` clears the fiber so no
  background work remains.
- The per-session server preference is in-memory only: it is not persisted to the store and
  is re-asked on every restart. Selecting a server that is still `connecting` biases the
  prompt, but that server's tools only become callable once its reconnect succeeds.
