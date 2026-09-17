/**
 * Behaviour tests for credential discovery and decryption.
 *
 * The fixtures build real AES-256-GCM envelopes with the same library the
 * implementation uses, so a passing test means the reader opens exactly the
 * layout the CLI writes rather than merely that it parses the fields it
 * happens to expect.
 */

import { createCipheriv, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  DevecoCredentialError,
  defaultDevecoPaths,
  decodeAccount,
  fingerprint,
  openEnvelope,
  resolveCredential,
  unwrapDataKey,
} from '../src/credentials.ts'
import type { DevecoEnvironment, SealedEnvelope } from '../src/credentials.ts'

/** One written layer: a sealed envelope plus the plaintext it hides. */
interface Sealed {
  envelope: SealedEnvelope
  plaintext: Buffer
}

/**
 * Seal plaintext into the envelope layout the CLI writes.
 * @param plaintext - bytes to encrypt.
 * @param key - 32-byte key.
 * @param extra - additional envelope fields such as `kekId`.
 * @returns the sealed layer.
 */
function seal(plaintext: Buffer, key: Buffer, extra: Record<string, unknown> = {}): Sealed {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return {
    plaintext,
    envelope: {
      version: 1,
      algorithm: 'aes-256-gcm',
      ciphertext: ciphertext.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      timeStamp: 1_700_000_000_000,
      ...extra,
    },
  }
}

/** An in-memory environment backed by a path-to-bytes map. */
function environment(files: Record<string, Buffer | string>, platform = 'darwin'): DevecoEnvironment {
  return {
    homeDir: '/home/tester',
    platform,
    readTextFile: async (path: string) => {
      const value = files[path]
      if (value === undefined) return undefined
      return Buffer.isBuffer(value) ? value.toString('utf8') : value
    },
    readBinaryFile: async (path: string) => {
      const value = files[path]
      if (value === undefined) return undefined
      return Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8')
    },
  }
}

/** Build a KEK, a DEK wrapped by it, and the credential document, as one set of files. */
function installation(options: { token: string; tokenTimestamp: number; authTimestamp?: number; withAuthJson?: boolean }) {
  const kek = randomBytes(32)
  const dek = randomBytes(32)
  const dekLayer = seal(dek, kek, { kekId: 'kek-v1' })
  const tokenLayer = seal(Buffer.from(options.token, 'utf8'), dek)
  const tokenEnc: SealedEnvelope = { ...tokenLayer.envelope, timeStamp: options.tokenTimestamp }

  const files: Record<string, Buffer | string> = {
    '/home/tester/.config/deveco/token.dek': JSON.stringify({
      version: 1,
      algorithm: 'aes-256-gcm',
      kekId: dekLayer.envelope.kekId,
      // The DEK layer names its ciphertext `encryptedDek`, not `ciphertext`.
      encryptedDek: dekLayer.envelope.ciphertext,
      iv: dekLayer.envelope.iv,
      authTag: dekLayer.envelope.authTag,
      timeStamp: 1_700_000_000_000,
    }),
    '/home/tester/.config/deveco/keys/kek-v1.bin': kek,
    '/home/tester/.config/deveco/token.enc': JSON.stringify(tokenEnc),
  }
  if (options.withAuthJson !== false) {
    const authLayer = seal(Buffer.from(options.token, 'utf8'), dek)
    files['/home/tester/.local/share/deveco/auth.json'] = JSON.stringify({
      deveco: {
        type: 'oauth',
        access: { ...authLayer.envelope, timeStamp: options.authTimestamp ?? options.tokenTimestamp },
        refresh: { version: 1, algorithm: 'aes-256-gcm', ciphertext: '', iv: authLayer.envelope.iv, authTag: authLayer.envelope.authTag },
        expires: Date.now() + 86_400_000,
      },
    })
  }
  return files
}

describe('defaultDevecoPaths', () => {
  it('derives both store directories from the home directory', () => {
    expect(defaultDevecoPaths('/home/tester')).toEqual({
      configDir: '/home/tester/.config/deveco',
      dataDir: '/home/tester/.local/share/deveco',
    })
  })
})

describe('openEnvelope', () => {
  it('round-trips plaintext through a sealed layer', () => {
    const key = randomBytes(32)
    const sealed = seal(Buffer.from('opaque-token-bytes'), key)
    expect(openEnvelope(sealed.envelope, key, 'test').toString('utf8')).toBe('opaque-token-bytes')
  })

  it('rejects a wrong key instead of returning garbage', () => {
    const sealed = seal(Buffer.from('opaque-token-bytes'), randomBytes(32))
    expect(() => openEnvelope(sealed.envelope, randomBytes(32), 'test')).toThrow(DevecoCredentialError)
  })

  it('rejects a tampered authentication tag', () => {
    const key = randomBytes(32)
    const sealed = seal(Buffer.from('token'), key)
    const tag = Buffer.from(sealed.envelope.authTag, 'base64')
    tag[0] = (tag[0] ?? 0) ^ 0xff
    expect(() => openEnvelope({ ...sealed.envelope, authTag: tag.toString('base64') }, key, 'test')).toThrow(/could not decrypt/)
  })

  it('rejects an unsupported algorithm rather than deciphering with the wrong mode', () => {
    const key = randomBytes(32)
    const sealed = seal(Buffer.from('token'), key)
    expect(() => openEnvelope({ ...sealed.envelope, algorithm: 'aes-128-cbc' }, key, 'test')).toThrow(/unsupported envelope algorithm/)
  })

  it('rejects a key of the wrong length with a named error', () => {
    const sealed = seal(Buffer.from('token'), randomBytes(32))
    expect(() => openEnvelope(sealed.envelope, randomBytes(16), 'test')).toThrow(/expected a 32-byte key/)
  })
})

describe('unwrapDataKey', () => {
  it('selects the key file the document names', async () => {
    const kek = randomBytes(32)
    const dek = seal(randomBytes(32), kek, { kekId: 'kek-v7' })
    const files = {
      '/cfg/token.dek': JSON.stringify({
        version: 1,
        algorithm: 'aes-256-gcm',
        kekId: 'kek-v7',
        encryptedDek: dek.envelope.ciphertext,
        iv: dek.envelope.iv,
        authTag: dek.envelope.authTag,
      }),
      '/cfg/keys/kek-v7.bin': kek,
    }
    const key = await unwrapDataKey('/cfg', environment(files))
    expect(key.length).toBe(32)
  })

  it('reports a missing wrapping key as not logged in', async () => {
    const kek = randomBytes(32)
    const dek = seal(randomBytes(32), kek, { kekId: 'kek-v3' })
    const files = {
      '/cfg/token.dek': JSON.stringify({
        version: 1, kekId: 'kek-v3', encryptedDek: dek.envelope.ciphertext, iv: dek.envelope.iv, authTag: dek.envelope.authTag,
      }),
      // kek-v3.bin is absent.
    }
    await expect(unwrapDataKey('/cfg', environment(files))).rejects.toThrow(/wrapping key is missing/)
  })
})

describe('resolveCredential', () => {
  it('reads the live token from auth.json', async () => {
    const files = installation({ token: 'live-token-value', tokenTimestamp: 1_700_000_100_000 })
    const credential = await resolveCredential(environment(files))
    expect(credential.accessToken).toBe('live-token-value')
    expect(credential.sourcePath).toBe('/home/tester/.local/share/deveco/auth.json')
  })

  it('prefers the newest store, so a stale file cannot shadow the live one', async () => {
    // Both stores decrypt; only freshness decides. This is the real failure
    // this ordering exists to prevent: an old token.enc was observed to hold a
    // token the gateway rejected while auth.json held the working one.
    const kek = randomBytes(32)
    const dek = randomBytes(32)
    const dekLayer = seal(dek, kek, { kekId: 'kek-v1' })
    const stale = seal(Buffer.from('stale-token'), dek)
    const live = seal(Buffer.from('live-token'), dek)
    const files: Record<string, Buffer | string> = {
      '/home/tester/.config/deveco/token.dek': JSON.stringify({
        version: 1, kekId: 'kek-v1', encryptedDek: dekLayer.envelope.ciphertext, iv: dekLayer.envelope.iv, authTag: dekLayer.envelope.authTag,
      }),
      '/home/tester/.config/deveco/keys/kek-v1.bin': kek,
      '/home/tester/.config/deveco/token.enc': JSON.stringify({ ...stale.envelope, timeStamp: 1_700_000_000_000 }),
      '/home/tester/.local/share/deveco/auth.json': JSON.stringify({
        deveco: { type: 'oauth', access: { ...live.envelope, timeStamp: 1_800_000_000_000 } },
      }),
    }
    const credential = await resolveCredential(environment(files))
    expect(credential.accessToken).toBe('live-token')
  })

  it('falls back to token.enc when auth.json is absent', async () => {
    const files = installation({ token: 'token-enc-only', tokenTimestamp: 1_700_000_000_000, withAuthJson: false })
    const credential = await resolveCredential(environment(files))
    expect(credential.accessToken).toBe('token-enc-only')
    expect(credential.sourcePath).toBe('/home/tester/.config/deveco/token.enc')
  })

  it('reports NOT_LOGGED_IN with the searched paths when nothing exists', async () => {
    await expect(resolveCredential(environment({}))).rejects.toMatchObject({
      code: 'NOT_LOGGED_IN',
      searchedPaths: ['/home/tester/.local/share/deveco/auth.json', '/home/tester/.config/deveco/token.enc'],
    })
  })

  it('honors an explicit authFile override', async () => {
    const files = installation({ token: 'explicit-token', tokenTimestamp: 1_700_000_000_000 })
    const credential = await resolveCredential(environment(files), {
      authFile: '/home/tester/.local/share/deveco/auth.json',
    })
    expect(credential.accessToken).toBe('explicit-token')
  })

  it('fails loudly when an explicit authFile does not exist', async () => {
    await expect(resolveCredential(environment({}), { authFile: '/nope/auth.json' })).rejects.toMatchObject({
      code: 'NOT_LOGGED_IN',
    })
  })

  it('reports the timestamp so callers can describe credential age', async () => {
    const files = installation({ token: 't', tokenTimestamp: 1_700_000_123_000 })
    const credential = await resolveCredential(environment(files))
    expect(credential.timestampMs).toBe(1_700_000_123_000)
  })
})

describe('decodeAccount', () => {
  it('reads account facts from a JWT-shaped token', () => {
    const payload = Buffer.from(JSON.stringify({
      access_token: 'x', userName: 'Tester', userId: '42', nationalCode: 'CN', exp: 1_700_000_000,
    })).toString('base64url')
    const account = decodeAccount(`header.${payload}.signature`)
    expect(account).toMatchObject({ userName: 'Tester', userId: '42', nationalCode: 'CN' })
    expect(account?.expiresAtMs).toBe(1_700_000_000_000)
  })

  it('returns nothing for an opaque token, which is the common case', () => {
    expect(decodeAccount('DgEAAGOupRgvX1+ZbpsENidd0dcHl6WhkEOGUcUTR2AdKf3fYJo2rU2dPPVQ')).toBeUndefined()
  })

  it('returns nothing rather than throwing for a JWT-shaped string that does not decode', () => {
    expect(decodeAccount('a.!!!!.c')).toBeUndefined()
  })
})

describe('fingerprint', () => {
  it('is stable, short, and does not contain the token', () => {
    const token = 'super-secret-token'
    const value = fingerprint(token)
    expect(value).toHaveLength(12)
    expect(value).toBe(fingerprint(token))
    expect(value).not.toContain(token)
    expect(fingerprint('another-token')).not.toBe(value)
  })
})
