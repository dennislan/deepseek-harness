# dsh-connect-deveco

Connect the models served by a locally installed **DevEco Code** CLI (`deveco`) to
**DeepSeek Harness**, so a harness session can route requests to `GLM-5.3`,
`GLM-5.1`, and `Qwen3_VL_235B_A22B_Instruct` using the DevEco Code account that is
already signed in on this machine.

The plugin has three parts, all in this one package:

| Part | File | What it does |
| --- | --- | --- |
| Provider | `lib/host.js` | Registers the `deveco` route on `ctx.llm`: an `LlmAdapter` that lists models and streams completions. |
| Diagnostics CLI | `lib/cli.js` | `dsh-connect-deveco` reports whether the credential and catalog are usable. |
| Bundle patch | `cordis.patch.yml` | The row that mounts the provider into a harness composition. |

## Design

DevEco Code is a local agent CLI that talks to a Huawei-hosted gateway. It is not
an OpenAI-compatible endpoint, and it does not expose one, so the plugin is the
translation layer in both directions:

```
 agent loop ──▶ ctx.llm ──▶ DevecoAdapter ──▶ gateway ──▶ model
 (DSH)          registry     (this plugin)     cn.devecostudio.huawei.com
```

Two decisions shape everything else.

**The plugin reads the CLI's credential store directly instead of driving the
CLI.** `deveco serve` and `deveco run` both work, but shelling out per request
would add a process, a parse step, and a second copy of the conversation state
for every turn. The credential on disk is the same one `deveco` itself uses, so
reading it gives the plugin a first-class HTTP path with no CLI in the loop.

**The adapter is streaming-only.** The gateway refuses a non-streaming chat
request outright (`400 ... "argument stream is false"`), so there is no
non-streaming path to fall back to and none is implemented.

### Credential discovery

The CLI stores credentials in a two-layer AES-256-GCM envelope. Each layer is a
JSON document holding base64 `ciphertext`, `iv`, and `authTag`:

```
~/.config/deveco/keys/kek-v1.bin   raw 32-byte KEK (file bytes, not encoded)
        │  unwraps
        ▼
~/.config/deveco/token.dek         wraps the 32-byte DEK  (field: encryptedDek)
        │  unwraps
        ▼
~/.local/share/deveco/auth.json    wraps the access token   (deveco.access)
  or ~/.config/deveco/token.enc    wraps the access token
```

Two details matter and are easy to get wrong:

- The DEK layer names its ciphertext `encryptedDek`, not `ciphertext`. Both
  spellings are accepted.
- **The two token stores can disagree.** On the machine this plugin was developed
  against, `token.enc` held a token the gateway rejected as
  `4016 invalid accessToken` while `auth.json` held the working one. The reader
  therefore decrypts every candidate and picks the **newest by `timeStamp`**,
  rather than trusting whichever file it finds first.

Node's `createDecipheriv` is typed as the base `Decipher`, which has no
`setAuthTag`; GCM requires it, so the code narrows to `DecipherGCM` at that one
call rather than relaxing the type globally.

### Model catalog

`GET /codeGenie/modelConfig` returns groups of model configs. The catalog carries
more than an id — context window, output ceiling, modality list, tool-call mode,
and a reasoning-effort declaration:

- `reasoning_effort` arrives as a **JSON string**, not a nested object, and is
  decoded as such.
- `thinking_mode` is `on`, `off`, or `configurable`; `configurable` is treated as
  reasoning-capable.
- A malformed `reasoning_effort` drops the effort selector and keeps the model,
  because a bad optional field should not remove a usable model.

The cache is process-global with a TTL. A refresh failure **keeps serving the
last known models** and warns, so a transient network fault cannot empty the
model picker mid-session; a failure with a cold cache propagates, because there
is nothing to fall back to. Concurrent callers share one in-flight fetch.

### Streaming translation

The gateway speaks OpenAI-shaped SSE, which the adapter translates into the
harness's `StreamChunk` protocol. The mapping that needs care:

- **Reasoning and text are separate blocks.** `reasoning_content` opens a
  `reasoning` block that is closed before the text block opens, so the harness
  can render them independently. Prior reasoning is never replayed into a later
  request.
- **Some models put thinking inline in `content`.** GLM models here do not use
  `reasoning_content` at all: they stream their chain of thought as ordinary
  content, terminated by a bare `</think>` with no opening tag, and only then
  emit the answer. The adapter splits that stream at the terminator so the
  reasoning reaches the harness as a `reasoning` block instead of being shown to
  the user as the answer. The split is buffered across chunk boundaries, so a
  terminator divided between two frames is still recognized rather than partly
  shown, and text withheld at end of stream is released rather than dropped.
- **Tool calls are assembled, not forwarded.** Arguments arrive as string
  fragments across frames; the adapter accumulates them by index and emits the
  complete `tool-call` block at `block-end`. A call with no arguments becomes
  `{}` rather than an empty string.
- **A tool-call turn finishes as `tool-calls`, not `stop`**, which is what makes
  the agent loop execute the tools instead of treating the turn as a finished
  answer.
- **Failures arrive in-band.** The gateway reports errors inside an HTTP 200 —
  both as an `{"errorCode":...}` body and as an SSE `event: error` frame. Both are
  detected and raised; checking `response.ok` alone would silently report an
  empty catalog or an empty reply.

## Integration with DeepSeek Harness

The source is a small set of modules, one per concern:

| Module | Responsibility |
| --- | --- |
| `src/credentials.ts` | Locates and decrypts the on-disk credential envelope. |
| `src/api.ts` | Talks to the gateway: model catalog and SSE chat streaming. |
| `src/catalog.ts` | Caches the catalog, coalescing concurrent refreshes. |
| `src/reasoning.ts` | Splits inline `</think>`-terminated thinking out of the content stream. |
| `src/adapter.ts` | Translates between the harness's `StreamChunk` protocol and the gateway's. |
| `src/host.ts` | The Cordis plugin: config schema, registrations, disposal. |
| `src/cli.ts` | The `dsh-connect-deveco` diagnostic command. |

`apply(ctx, config)` in `src/host.ts` contributes three registrations to the
`llm` service, each owned by the plugin's effect scope:

| Registration | Purpose |
| --- | --- |
| `ctx.llm.registerConfigurableProviders` | Exposes `deveco` in provider selectors, with settings namespace `dsh-connect-deveco`. |
| `ctx.llm.registerAdapter([PROVIDER], adapter)` | Binds the adapter to the `deveco` route. |
| `ctx.llm.registerModelDiscovery` | Lets the settings surface refresh the model list on demand. |

The catalog is fetched **lazily**, on the first `listModels` or `resolveModel`
call. A harness that never routes to this provider pays nothing at boot, and the
plugin still loads when the gateway is unreachable. Disposal releases both
registrations and the process-global catalog cache through `ctx.effect`.

## Integration with the DevEco CLI

The only hard coupling is the on-disk credential layout and the gateway the CLI
points at. The plugin never invokes the `deveco` binary: no process is spawned,
and `deveco` need not be on `PATH` at request time — only its credential files
must exist, which means having run `deveco providers login` at least once.

Requests carry `authorization: Bearer <access>`, `content-type: application/json`,
`lang: en`, and a per-request `Chat-Id`. The `accept` header is set per call —
`application/json` for the catalog and `text/event-stream` for chat — because
sending the wrong one on either route is rejected (`406` on the catalog route).

## Configuration

All options live on the plugin row in `cordis.yml`. Every field is optional and
validated at load; an invalid value fails the plugin rather than silently
defaulting.

```yaml
- id: dsh-connect-deveco
  name: 'dsh-connect-deveco'
  config:
    displayName: DevEco Code      # label shown by provider selectors
    baseUrl: https://cn.devecostudio.huawei.com
    authFile: null                # pin one credential file instead of newest-wins
    dataDir: null                 # override the directory holding auth.json
    configDir: null               # override the directory holding token.enc and keys/
    catalogTtlSeconds: 900        # how long a fetched catalog stays fresh
    requestTimeoutSeconds: 300    # per-attempt timeout for catalog and chat
    models: []                    # advertise this list instead of discovering one
```

`models` exists for environments where the catalog route is unreachable but the
model ids are known; it is empty by default, which means discover. Declared ids
are advertisement-only — the gateway remains the authority on what it serves, so
declaring one does not make a request to it succeed, and their capacity metadata
falls back to a conservative floor.

A negative `catalogTtlSeconds` or a `requestTimeoutSeconds` below 1 is rejected at
load by the schema.

## Diagnostics

```sh
dsh-connect-deveco            # status: credential, fingerprint, model count
dsh-connect-deveco doctor     # platform, gateway, credential path
dsh-connect-deveco --json     # machine-readable status
```

Status is `READY`, `NOT_LOGGED_IN`, `NO_CREDENTIAL`, or
`AUTH_REJECTED`. The CLI never prints the token — only a 12-hex-digit SHA-256
fingerprint, which is enough to tell two credentials apart in a bug report.

## Requirements and known limitations

- **A DevEco Code account is required, and it must be a China-site account.**
  The gateway rejects others with "only China site accounts are currently
  supported". The CLI supports the China site only.
- **macOS paths are verified.** Linux and Windows paths are derived from platform
  convention and have not been exercised on real hardware; the CLI has no Linux
  build.
- **The credential layout is undocumented** and was established by inspecting the
  CLI's own files. A future CLI version could change it, in which case
  `dsh-connect-deveco doctor` reports `NO_CREDENTIAL` while `deveco` itself still
  works — that combination is the signal to re-derive the layout.
- **Model ids and quotas belong to the DevEco Code account**, not to this plugin.
  The catalog is advisory; an unlisted model id is still routed, and the gateway
  remains the authority on what it serves.
- Not every catalog model supports tools (`Qwen3_VL_235B_A22B_Instruct` declares
  `tool_call_mode: none`), so tool-using sessions should select a model that does.

## Development

```sh
npm install
npm run build       # tsc declarations + tsdown bundles
npm run typecheck
npm test            # 82 tests
```

The tests cover the credential envelope round-trip (including tampering, wrong
keys, and stale-vs-live store selection), gateway response parsing, SSE frame
reassembly across read boundaries, the HTTP-200 error paths, catalog caching and
failure fallback, and the adapter's chunk emission in both directions.

## License

MIT. See [LICENSE](LICENSE).
