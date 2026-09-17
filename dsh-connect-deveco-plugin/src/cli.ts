#!/usr/bin/env node
/**
 * `dsh-connect-deveco` diagnostics entry point.
 *
 * Reports whether the DevEco Code credential is reachable, which document it
 * came from, and which models the gateway advertises — without a browser and
 * without ever printing the token itself.
 *
 * @module dsh-connect-deveco/cli
 */

import { fetchModelCatalog, DEFAULT_BASE_URL } from './api.ts'
import { fingerprint, processEnvironment, resolveCredential, DevecoCredentialError } from './credentials.ts'

/** Parsed invocation. */
interface Invocation {
  /** Subcommand; defaults to `status`. */
  command: string
  /** Emit machine-readable JSON instead of text. */
  json: boolean
}

/**
 * Parse argv.
 * @param argv - process arguments after the script name.
 * @returns the invocation.
 */
function parseArgs(argv: readonly string[]): Invocation {
  const positional = argv.filter(argument => !argument.startsWith('-'))
  return {
    command: positional[0] ?? 'status',
    json: argv.includes('--json'),
  }
}

/**
 * Resolve the credential, returning a discriminated failure instead of throwing
 * so every command reports the same way.
 * @returns either the credential or a reported failure.
 */
async function loadCredential(): Promise<
  | { ok: true; accessToken: string; sourcePath: string; account?: unknown; timestampMs?: number }
  | { ok: false; code: string; message: string; searchedPaths: readonly string[] }
> {
  try {
    const credential = await resolveCredential(processEnvironment())
    return {
      ok: true,
      accessToken: credential.accessToken,
      sourcePath: credential.sourcePath,
      ...(credential.account !== undefined ? { account: credential.account } : {}),
      ...(credential.timestampMs !== undefined ? { timestampMs: credential.timestampMs } : {}),
    }
  } catch (error) {
    if (error instanceof DevecoCredentialError) {
      return { ok: false, code: error.code, message: error.message, searchedPaths: error.searchedPaths }
    }
    return {
      ok: false,
      code: 'UNKNOWN',
      message: error instanceof Error ? error.message : String(error),
      searchedPaths: [],
    }
  }
}

/**
 * Report credential status and, when reachable, the advertised model catalog.
 * @param json - whether to emit JSON.
 * @returns the process exit code.
 */
async function status(json: boolean): Promise<number> {
  const credential = await loadCredential()
  if (!credential.ok) {
    report(json, { ok: false, command: 'status', code: credential.code, message: credential.message, searchedPaths: credential.searchedPaths })
    return 1
  }

  let models: readonly { id: string; contextWindow: number }[] = []
  let catalogError: string | undefined
  try {
    models = await fetchModelCatalog({ accessToken: credential.accessToken, baseUrl: DEFAULT_BASE_URL })
  } catch (error) {
    catalogError = error instanceof Error ? error.message : String(error)
  }

  report(json, {
    ok: catalogError === undefined,
    command: 'status',
    credential: {
      source: credential.sourcePath,
      fingerprint: fingerprint(credential.accessToken),
      ...(credential.timestampMs !== undefined ? { writtenAt: new Date(credential.timestampMs).toISOString() } : {}),
      ...(credential.account !== undefined ? { account: credential.account } : {}),
    },
    ...(catalogError !== undefined
      ? { catalogError }
      : { models: models.map(model => ({ id: model.id, contextWindow: model.contextWindow })) }),
  })
  return catalogError === undefined ? 0 : 1
}

/**
 * Report where credentials are looked for and what was found at each path.
 * @param json - whether to emit JSON.
 * @returns the process exit code.
 */
async function doctor(json: boolean): Promise<number> {
  const env = processEnvironment()
  const credential = await loadCredential()
  report(json, {
    ok: credential.ok,
    command: 'doctor',
    platform: env.platform,
    homeDir: env.homeDir,
    credential: credential.ok
      ? { found: true, source: credential.sourcePath, fingerprint: fingerprint(credential.accessToken) }
      : { found: false, code: credential.code, message: credential.message, searchedPaths: credential.searchedPaths },
    gateway: DEFAULT_BASE_URL,
  })
  return credential.ok ? 0 : 1
}

/**
 * Print a result in the requested format.
 * @param json - whether to emit JSON.
 * @param payload - the result to print.
 */
function report(json: boolean, payload: Record<string, unknown>): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`)
    return
  }
  process.stdout.write(`${render(payload)}\n`)
}

/**
 * Render a result as human-readable text.
 * @param payload - the result to print.
 * @returns the text block.
 */
function render(payload: Record<string, unknown>): string {
  const lines: string[] = []
  if (payload.ok === false) {
    lines.push(`DevEco Code: NOT READY (${String(payload.code ?? '')})`)
    if (typeof payload.message === 'string') lines.push(`  ${payload.message}`)
    const searched = payload.searchedPaths
    if (Array.isArray(searched) && searched.length > 0) {
      lines.push('  searched:')
      for (const path of searched) lines.push(`    - ${String(path)}`)
    }
    lines.push('  Fix: run `deveco providers login` in a terminal, then retry.')
    return lines.join('\n')
  }

  if (payload.command === 'doctor') {
    lines.push('DevEco Code doctor')
    lines.push(`  platform: ${String(payload.platform)}`)
    lines.push(`  gateway:  ${String(payload.gateway)}`)
    const credential = payload.credential as Record<string, unknown> | undefined
    if (credential?.found === true) {
      lines.push(`  credential: ${String(credential.source)}`)
      lines.push(`  fingerprint: ${String(credential.fingerprint)}`)
    }
    return lines.join('\n')
  }

  const credential = payload.credential as Record<string, unknown>
  lines.push('DevEco Code status: READY')
  lines.push(`  credential:  ${String(credential.source)}`)
  lines.push(`  fingerprint: ${String(credential.fingerprint)}`)
  if (typeof credential.writtenAt === 'string') lines.push(`  written:     ${credential.writtenAt}`)
  const account = credential.account as Record<string, unknown> | undefined
  if (account !== undefined) {
    const name = account.userName ?? account.userId
    if (name !== undefined) lines.push(`  account:     ${String(name)}`)
  }
  if (typeof payload.catalogError === 'string') {
    lines.push(`  catalog:     UNAVAILABLE — ${payload.catalogError}`)
    return lines.join('\n')
  }
  const models = payload.models
  if (Array.isArray(models)) {
    lines.push(`  models:      ${models.length}`)
    for (const model of models as Record<string, unknown>[]) {
      lines.push(`    - ${String(model.id)} (context ${String(model.contextWindow)})`)
    }
  }
  return lines.join('\n')
}

const invocation = parseArgs(process.argv.slice(2))

switch (invocation.command) {
  case 'status':
    process.exitCode = await status(invocation.json)
    break
  case 'doctor':
    process.exitCode = await doctor(invocation.json)
    break
  case 'help':
  case '--help': {
    process.stdout.write(
      'dsh-connect-deveco — DevEco Code connectivity diagnostics\n\n'
      + 'Usage: dsh-connect-deveco <command> [--json]\n\n'
      + 'Commands:\n'
      + '  status   report credential and advertised models (default)\n'
      + '  doctor   report credential locations and resolved source\n'
      + '  help     show this message\n',
    )
    break
  }
  default:
    process.stderr.write(`Unknown command: ${invocation.command}\nRun \`dsh-connect-deveco help\` for usage.\n`)
    process.exitCode = 2
}
