/**
 * Credential discovery and decryption for the locally signed-in DevEco Code
 * (`deveco`) CLI.
 *
 * DevEco Code is an OpenCode-derived agent CLI. It stores no plaintext token on
 * disk. Two encrypted stores hold the OAuth access token, and both use the same
 * two-layer AES-256-GCM envelope:
 *
 * 1. A 32-byte key-encryption key (KEK) sits raw in `<configDir>/keys/kek-v*.bin`.
 * 2. `<configDir>/token.dek` (`{version, algorithm, kekId, encryptedDek, iv, authTag}`)
 *    wraps a 32-byte data-encryption key (DEK) with that KEK. `kekId` names which
 *    `kek-v*.bin` to use, so the file to read is chosen by the document, not by us.
 * 3. The credential document (`token.enc`, or the `deveco.access` node of
 *    `auth.json`) wraps the token itself with that DEK.
 *
 * Every layer is `iv` + `authTag` carried beside the ciphertext, which is the
 * layout Node's `createDecipheriv('aes-256-gcm', ...)` takes: the tag is passed
 * separately rather than appended. Decryption is authenticated, so a wrong KEK
 * or a truncated file fails loudly instead of yielding a plausible-looking
 * token.
 *
 * The two stores are not equivalent. Observed on a real installation: `auth.json`
 * held the token the CLI was actively using (written the same morning as
 * successful streaming runs), while `token.enc` held a weeks-old token that the
 * gateway rejected with `4016 invalid accessToken`. Freshness therefore decides
 * which document wins, and the envelope's own `timeStamp` is the only ordering
 * fact available without decrypting.
 *
 * @module dsh-connect-deveco/credentials
 */

import { createDecipheriv, createHash } from 'node:crypto'
import type { DecipherGCM } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** One AES-256-GCM envelope exactly as the CLI writes it. */
export interface SealedEnvelope {
  /** Envelope format version; layer 1 is the only format observed. */
  readonly version?: number
  /** Cipher name; must resolve to an AES-256-GCM decipher. */
  readonly algorithm?: string
  /** Wrapping-key selector at the DEK layer; a key file name stem such as `kek-v1`. */
  readonly kekId?: string
  /** Base64 ciphertext. */
  readonly ciphertext: string
  /** Base64 12-byte initialization vector. */
  readonly iv: string
  /** Base64 16-byte GCM authentication tag. */
  readonly authTag: string
  /** Wall-clock milliseconds the envelope was written; used only for freshness ordering. */
  readonly timeStamp?: number
}

/** A decrypted DevEco credential plus the provenance needed to explain it. */
export interface DevecoCredential {
  /** Bearer token sent as `Authorization: Bearer <access>`. */
  readonly accessToken: string
  /** Absolute path of the credential document this token came from. */
  readonly sourcePath: string
  /** Envelope `timeStamp` in milliseconds, when the document carried one. */
  readonly timestampMs?: number
  /** Account facts parsed from the token when it is a readable JWT. */
  readonly account?: DevecoAccount
}

/** Non-secret account facts decoded from a JWT-shaped access token. */
export interface DevecoAccount {
  /** DevEco user name, when present. */
  readonly userName?: string
  /** DevEco user id, when present. */
  readonly userId?: string
  /** Declared site code; DevEco Code only supports `CN`. */
  readonly nationalCode?: string
  /** Token expiry in epoch milliseconds, when present. */
  readonly expiresAtMs?: number
}

/** Credential file locations resolved for one platform. */
export interface DevecoPaths {
  /** Directory holding `token.enc`, `token.dek`, and `keys/`. */
  readonly configDir: string
  /** Directory holding `auth.json`. */
  readonly dataDir: string
}

/** Injectable filesystem and platform facts, so discovery is testable without a real install. */
export interface DevecoEnvironment {
  /** Home directory the default locations derive from. */
  readonly homeDir: string
  /** Platform string (`process.platform`); selects the default directories. */
  readonly platform: string
  /** Reads a file as UTF-8, or resolves `undefined` when it does not exist. */
  readonly readTextFile: (path: string) => Promise<string | undefined>
  /** Reads a file as raw bytes, or resolves `undefined` when it does not exist. */
  readonly readBinaryFile: (path: string) => Promise<Buffer | undefined>
}

/** Raised when no usable DevEco credential can be resolved. */
export class DevecoCredentialError extends Error {
  /** Stable machine-readable reason, so the CLI and the adapter can branch on it. */
  readonly code: DevecoCredentialCode
  /** Absolute paths examined while looking for the credential, for diagnostics. */
  readonly searchedPaths: readonly string[]

  /**
   * @param code - stable failure reason.
   * @param message - operator-facing explanation.
   * @param searchedPaths - every path examined before failing.
   */
  constructor(code: DevecoCredentialCode, message: string, searchedPaths: readonly string[] = []) {
    super(message)
    this.name = 'DevecoCredentialError'
    this.code = code
    this.searchedPaths = searchedPaths
  }
}

/** Why credential resolution failed. */
export type DevecoCredentialCode =
  | 'NOT_INSTALLED'
  | 'NOT_LOGGED_IN'
  | 'UNREADABLE'
  | 'DECRYPT_FAILED'
  | 'EMPTY_TOKEN'

/**
 * MACOS and Linux keep both stores under the home directory; the CLI has no
 * Linux build, but naming the layout keeps diagnostics honest on that platform.
 * @param homeDir - home directory to derive from.
 * @returns the default DevEco Code credential locations.
 */
export function defaultDevecoPaths(homeDir: string): DevecoPaths {
  return {
    configDir: join(homeDir, '.config', 'deveco'),
    dataDir: join(homeDir, '.local', 'share', 'deveco'),
  }
}

/** Reads a UTF-8 file, mapping "absent" to `undefined` while letting real I/O faults propagate. */
async function readTextOrUndefined(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (isMissingFile(error)) return undefined
    throw error
  }
}

/** Reads raw bytes, mapping "absent" to `undefined` while letting real I/O faults propagate. */
async function readBytesOrUndefined(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path)
  } catch (error) {
    if (isMissingFile(error)) return undefined
    throw error
  }
}

/**
 * Recognize the error shape that means "this path has no file".
 * @param error - the caught value.
 * @returns true when the path is absent rather than unreadable for another reason.
 */
function isMissingFile(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code = (error as { code?: unknown }).code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** The real filesystem and platform facts used outside tests. */
export function processEnvironment(): DevecoEnvironment {
  return {
    homeDir: homedir(),
    platform: process.platform,
    readTextFile: readTextOrUndefined,
    readBinaryFile: readBytesOrUndefined,
  }
}

/**
 * Parse a JSON document, naming the file in any failure.
 * @param text - raw file contents.
 * @param path - path the text came from, for the error message.
 * @returns the parsed document.
 */
function parseJson(text: string, path: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new DevecoCredentialError('UNREADABLE', `DevEco credential file is not valid JSON: ${path}`, [path])
  }
}

/**
 * Narrow an unknown value to an envelope, requiring only the three fields every
 * layer must carry.
 *
 * The ciphertext field is named per layer: the token layers use `ciphertext`,
 * while the DEK layer in `token.dek` uses `encryptedDek`. Both are accepted so
 * one reader serves every layer.
 *
 * @param value - candidate document node.
 * @returns the node as an envelope when it has the required base64 fields.
 */
function asEnvelope(value: unknown): SealedEnvelope | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as Record<string, unknown>
  const ciphertext = candidate.ciphertext ?? candidate.encryptedDek
  const { iv, authTag } = candidate
  if (typeof ciphertext !== 'string' || typeof iv !== 'string' || typeof authTag !== 'string') return undefined
  return {
    ciphertext,
    iv,
    authTag,
    ...(typeof candidate.version === 'number' ? { version: candidate.version } : {}),
    ...(typeof candidate.algorithm === 'string' ? { algorithm: candidate.algorithm } : {}),
    ...(typeof candidate.kekId === 'string' ? { kekId: candidate.kekId } : {}),
    ...(typeof candidate.timeStamp === 'number' ? { timeStamp: candidate.timeStamp } : {}),
  }
}

/**
 * Open one AES-256-GCM envelope.
 *
 * Node takes the authentication tag as a separate argument rather than
 * appended to the ciphertext, so the tag is set before finalization; a wrong
 * key fails at `final()` with an authentication error rather than returning
 * garbage.
 *
 * @param envelope - the sealed layer to open.
 * @param key - the 32-byte key for this layer.
 * @param context - human-readable description of the layer, used in failures.
 * @returns the plaintext bytes.
 */
export function openEnvelope(envelope: SealedEnvelope, key: Buffer, context: string): Buffer {
  const algorithm = normaliseAlgorithm(envelope.algorithm, context)
  const iv = Buffer.from(envelope.iv, 'base64')
  const authTag = Buffer.from(envelope.authTag, 'base64')
  const ciphertext = Buffer.from(envelope.ciphertext, 'base64')
  if (key.length !== 32) {
    throw new DevecoCredentialError('DECRYPT_FAILED', `${context}: expected a 32-byte key, received ${key.length} bytes`)
  }
  if (iv.length !== 12) {
    throw new DevecoCredentialError('DECRYPT_FAILED', `${context}: expected a 12-byte IV, received ${iv.length} bytes`)
  }
  if (authTag.length !== 16) {
    throw new DevecoCredentialError('DECRYPT_FAILED', `${context}: expected a 16-byte auth tag, received ${authTag.length} bytes`)
  }
  try {
    // `createDecipheriv` is typed as the base `Decipher`, which has no
    // `setAuthTag`; GCM authenticates with one, and the algorithm is fixed by
    // this function, so the narrow cast is exact rather than an escape hatch.
    const decipher = createDecipheriv(algorithm, key, iv) as DecipherGCM
    decipher.setAuthTag(authTag)
    return Buffer.concat([decipher.update(ciphertext), decipher.final()])
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new DevecoCredentialError(
      'DECRYPT_FAILED',
      `${context}: could not decrypt (${reason}). The DevEco Code key files may have rotated; re-run \`deveco providers login\`.`,
    )
  }
}

/**
 * Resolve the envelope's declared cipher to a Node algorithm name.
 *
 * Every observed envelope declares `aes-256-gcm`, which Node already accepts;
 * the mapping exists so a future `aes-256-gcm` alias cannot silently fall
 * through to the wrong mode.
 *
 * @param algorithm - declared algorithm, when the envelope carries one.
 * @param context - human-readable description of the layer, used in failures.
 * @returns a Node cipher name.
 */
function normaliseAlgorithm(algorithm: string | undefined, context: string): string {
  if (algorithm === undefined) return 'aes-256-gcm'
  const normalised = algorithm.toLowerCase().replace(/_/g, '-')
  if (normalised !== 'aes-256-gcm') {
    throw new DevecoCredentialError('DECRYPT_FAILED', `${context}: unsupported envelope algorithm "${algorithm}"`)
  }
  return normalised
}

/**
 * Unwrap the data-encryption key from `<configDir>/token.dek` using the KEK the
 * document names.
 *
 * The KEK is used as stored, with no key-derivation step: verified against a
 * real installation, the raw 32 bytes of `keys/kek-vN.bin` open `token.dek`
 * directly.
 *
 * @param configDir - directory holding `token.dek` and `keys/`.
 * @param env - filesystem facts.
 * @returns the 32-byte DEK.
 */
export async function unwrapDataKey(configDir: string, env: DevecoEnvironment): Promise<Buffer> {
  const dekPath = join(configDir, 'token.dek')
  const raw = await env.readTextFile(dekPath)
  if (raw === undefined) {
    throw new DevecoCredentialError('NOT_LOGGED_IN', `DevEco Code key file is missing: ${dekPath}`, [dekPath])
  }
  const envelope = asEnvelope(parseJson(raw, dekPath))
  if (envelope === undefined) {
    throw new DevecoCredentialError('UNREADABLE', `DevEco Code key file has no readable envelope: ${dekPath}`, [dekPath])
  }
  // The selector is the kekId the document declares; when it is absent, the
  // documented default generation is the only defensible choice.
  const kekId = envelope.kekId ?? 'kek-v1'
  const kekPath = join(configDir, 'keys', `${kekId}.bin`)
  const kek = await env.readBinaryFile(kekPath)
  if (kek === undefined) {
    throw new DevecoCredentialError('NOT_LOGGED_IN', `DevEco Code wrapping key is missing: ${kekPath}`, [kekPath])
  }
  return openEnvelope(envelope, kek, `token.dek (${kekId})`)
}

/**
 * Decode the account facts carried by a JWT-shaped access token.
 *
 * The two stores hold differently shaped tokens: `auth.json` carries an opaque
 * 136-byte binary-prefixed token, while `token.enc` carries a three-part JWT
 * whose payload holds the account facts. A token that is not a JWT is normal
 * and yields no account rather than an error.
 *
 * @param token - the decrypted access token.
 * @returns the decoded account facts, or `undefined` when the token is not a JWT.
 */
export function decodeAccount(token: string): DevecoAccount | undefined {
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  try {
    const payload = parts[1] ?? ''
    const json = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')
    const claims = JSON.parse(json) as Record<string, unknown>
    const account: DevecoAccount = {
      ...(typeof claims.userName === 'string' ? { userName: claims.userName } : {}),
      ...(typeof claims.userId === 'string' ? { userId: claims.userId } : {}),
      ...(typeof claims.nationalCode === 'string' ? { nationalCode: claims.nationalCode } : {}),
      ...(typeof claims.exp === 'number' ? { expiresAtMs: claims.exp * 1000 } : {}),
    }
    return Object.keys(account).length > 0 ? account : undefined
  } catch {
    // A JWT-shaped string that does not decode is still a usable opaque token;
    // account facts are decoration, not a precondition for authenticating.
    return undefined
  }
}

/** One candidate credential document, before it is opened. */
interface CredentialCandidate {
  /** Absolute path of the document. */
  readonly path: string
  /** The sealed token envelope found inside it. */
  readonly envelope: SealedEnvelope
  /** Document `timeStamp` in milliseconds, when present. */
  readonly timestampMs?: number
}

/**
 * Collect the sealed token envelopes from both stores.
 *
 * `auth.json` nests the envelope under `deveco.access`; `token.enc` is the
 * envelope itself. A document that is absent or malformed is skipped rather
 * than fatal, because a stale second store must not mask a usable first one —
 * but a store that exists and cannot be read at all is reported, so a genuine
 * permissions problem does not look like "not logged in".
 *
 * @param paths - credential file locations.
 * @param env - filesystem facts.
 * @returns every readable candidate, newest first.
 */
async function collectCandidates(paths: DevecoPaths, env: DevecoEnvironment): Promise<CredentialCandidate[]> {
  const candidates: CredentialCandidate[] = []

  const authPath = join(paths.dataDir, 'auth.json')
  const authRaw = await env.readTextFile(authPath)
  if (authRaw !== undefined) {
    const document = parseJson(authRaw, authPath)
    const deveco = readNested(document, ['deveco'])
    const access = readNested(deveco, ['access'])
    const envelope = asEnvelope(access)
    if (envelope !== undefined) {
      candidates.push({ path: authPath, envelope, ...(envelope.timeStamp !== undefined ? { timestampMs: envelope.timeStamp } : {}) })
    }
  }

  const tokenPath = join(paths.configDir, 'token.enc')
  const tokenRaw = await env.readTextFile(tokenPath)
  if (tokenRaw !== undefined) {
    const envelope = asEnvelope(parseJson(tokenRaw, tokenPath))
    if (envelope !== undefined) {
      candidates.push({ path: tokenPath, envelope, ...(envelope.timeStamp !== undefined ? { timestampMs: envelope.timeStamp } : {}) })
    }
  }

  // Newest first. Undated candidates sort last: an undated document cannot be
  // shown to be current, and the dated one empirically tracks the live session.
  return candidates.sort((left, right) => (right.timestampMs ?? 0) - (left.timestampMs ?? 0))
}

/**
 * Read one nested object property without asserting a document layout.
 * @param value - current node.
 * @param path - remaining property names.
 * @returns the node at that path, or `undefined` when any step is absent.
 */
function readNested(value: unknown, path: readonly string[]): unknown {
  let node = value
  for (const key of path) {
    if (typeof node !== 'object' || node === null) return undefined
    node = (node as Record<string, unknown>)[key]
  }
  return node
}

/** Optional overrides supplied by plugin configuration. */
export interface ResolveCredentialOptions {
  /** Explicit credential document to read, replacing discovery of both default stores. */
  readonly authFile?: string
  /** Credential file locations; defaults derive from the environment. */
  readonly paths?: DevecoPaths
}

/**
 * Resolve the DevEco Code access token from local credential stores.
 *
 * Candidates are tried newest first and the first that decrypts to a non-empty
 * token wins, so a stale store cannot shadow the live one. When every candidate
 * fails, the error reports every path examined.
 *
 * @param env - filesystem and platform facts.
 * @param options - optional explicit credential path or directory overrides.
 * @returns the usable credential and where it came from.
 */
export async function resolveCredential(
  env: DevecoEnvironment = processEnvironment(),
  options: ResolveCredentialOptions = {},
): Promise<DevecoCredential> {
  const paths = options.paths ?? defaultDevecoPaths(env.homeDir)
  const searched: string[] = []
  let dek: Buffer | undefined

  const open = async (path: string, envelope: SealedEnvelope, timestampMs?: number): Promise<DevecoCredential> => {
    dek ??= await unwrapDataKey(paths.configDir, env)
    const plaintext = openEnvelope(envelope, dek, `access token (${path})`)
    const token = plaintext.toString('utf8').trim()
    if (token.length === 0) {
      throw new DevecoCredentialError('EMPTY_TOKEN', `DevEco Code credential at ${path} decrypted to an empty token`, [path])
    }
    const account = decodeAccount(token)
    return {
      accessToken: token,
      sourcePath: path,
      ...(timestampMs !== undefined ? { timestampMs } : {}),
      ...(account !== undefined ? { account } : {}),
    }
  }

  if (options.authFile !== undefined) {
    searched.push(options.authFile)
    const raw = await env.readTextFile(options.authFile)
    if (raw === undefined) {
      throw new DevecoCredentialError('NOT_LOGGED_IN', `DevEco Code credential file not found: ${options.authFile}`, searched)
    }
    const document = parseJson(raw, options.authFile)
    const envelope = asEnvelope(readNested(document, ['deveco', 'access'])) ?? asEnvelope(document)
    if (envelope === undefined) {
      throw new DevecoCredentialError('UNREADABLE', `DevEco Code credential file holds no token envelope: ${options.authFile}`, searched)
    }
    return open(options.authFile, envelope, envelope.timeStamp)
  }

  const candidates = await collectCandidates(paths, env)
  searched.push(...candidates.map(candidate => candidate.path))
  if (candidates.length === 0) {
    throw new DevecoCredentialError(
      'NOT_LOGGED_IN',
      'No DevEco Code credential found. Install the CLI (npm i -g @deveco/deveco-code) and sign in with `deveco providers login`.',
      [join(paths.dataDir, 'auth.json'), join(paths.configDir, 'token.enc')],
    )
  }

  const failures: string[] = []
  for (const candidate of candidates) {
    try {
      return await open(candidate.path, candidate.envelope, candidate.timestampMs)
    } catch (error) {
      // A stale or rotated store failing is expected while another candidate
      // may still succeed, so each failure is retained for the final report
      // instead of aborting the search.
      failures.push(error instanceof Error ? error.message : String(error))
    }
  }
  throw new DevecoCredentialError(
    'DECRYPT_FAILED',
    `No DevEco Code credential could be decrypted. ${failures.join(' | ')}`,
    searched,
  )
}

/**
 * Derive a stable, non-reversible fingerprint of a token for diagnostics.
 *
 * Diagnostics run in a terminal and may be pasted into issues, so the token
 * itself never appears; the fingerprint is enough to tell two credentials
 * apart and to notice that a login changed the stored token.
 *
 * @param token - the access token.
 * @returns the first 12 hex characters of the token's SHA-256 digest.
 */
export function fingerprint(token: string): string {
  return createHash('sha256').update(token).digest('hex').slice(0, 12)
}
