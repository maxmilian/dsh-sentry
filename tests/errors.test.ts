import { describe, expect, it } from 'vitest'

import { createHttpError, SentryApiError, sanitizeUpstreamDetail } from '../src/errors.js'

const TOKEN = 'sntryu_supersecret'

describe('sanitizeUpstreamDetail', () => {
  it('returns the detail field verbatim', () => {
    const body = { detail: 'Invalid query. "foo" is not a supported search key' }
    expect(sanitizeUpstreamDetail(body, TOKEN)).toBe(
      'Invalid query. "foo" is not a supported search key',
    )
  })

  it('falls back to the error field and prefers detail when both exist', () => {
    expect(sanitizeUpstreamDetail({ error: 'bad request' }, TOKEN)).toBe('bad request')
    expect(sanitizeUpstreamDetail({ detail: 'first', error: 'second' }, TOKEN)).toBe('first')
  })

  it('rejects non-string and missing fields', () => {
    expect(sanitizeUpstreamDetail({ detail: { nested: true } }, TOKEN)).toBeUndefined()
    expect(sanitizeUpstreamDetail({ detail: ['a'] }, TOKEN)).toBeUndefined()
    expect(sanitizeUpstreamDetail({ detail: 42 }, TOKEN)).toBeUndefined()
    expect(sanitizeUpstreamDetail({ detail: null }, TOKEN)).toBeUndefined()
    expect(sanitizeUpstreamDetail({}, TOKEN)).toBeUndefined()
    expect(sanitizeUpstreamDetail('plain string', TOKEN)).toBeUndefined()
    expect(sanitizeUpstreamDetail(null, TOKEN)).toBeUndefined()
  })

  it('drops any detail containing the configured token', () => {
    expect(sanitizeUpstreamDetail({ detail: `bad token ${TOKEN}` }, TOKEN)).toBeUndefined()
  })

  it.each([
    'Bearer abc123 rejected',
    'missing Authorization header',
    'token sntryu_abc is invalid',
    'token sntrys_abc is invalid',
    'api_key not accepted',
    'api-key not accepted',
    'the secret is wrong',
    'password mismatch',
    'credential=abc123',
    'passwd=abc123',
    'passphrase=abc123',
    'pwd=abc123',
    'private_key=abc123',
    'access_key_id=abc123',
    'ssh_key=abc123',
    'signing_key=abc123',
    'jwt=abc123',
    'dsn=abc123',
    'x-amz-signature=abc123',
    'token=abc123',
    'token: abc123',
  ])('drops detail matching a secret pattern: %s', (detail) => {
    expect(sanitizeUpstreamDetail({ detail }, TOKEN)).toBeUndefined()
  })

  it.each([
    'accessToken sk_live_ABC',
    'apiToken sk_live_ABC',
    'api key AKIA-BAIT rejected',
    'api.key BAIT',
    'apiKey BAIT',
    'private key BAIT',
    'private.key BAIT',
    'privateKey BAIT',
    'access key AKIA-BAIT',
    'access.key BAIT',
    'accessKey BAIT',
    'ssh key BAIT',
    'ssh.key BAIT',
    'sshKey BAIT',
    'signing key BAIT',
    'signing.key BAIT',
    'signingKey BAIT',
    'encryption key BAIT',
    'connection string postgres://u:p@h/db',
    'database url postgres://u:p@h/db',
    'bearer BAIT',
    'apikey BAIT',
    'APIKEY BAIT',
    'accesskey BAIT',
    'privatekey BAIT',
    'sshkey BAIT',
    'sessiontoken BAIT',
    'refreshtoken BAIT',
  ])('drops detail naming a credential with any separator: %s', (detail) => {
    expect(sanitizeUpstreamDetail({ detail }, TOKEN)).toBeUndefined()
  })

  it.each([
    'monkey business is not a supported search key',
    'turnkey is not a supported search key',
    'hotkey is not a supported search key',
    'primary_key is not a supported search key',
    'idempotency_key is not a supported search key',
    'cache_key is not a supported search key',
    'tokenizer failed on the query',
  ])('keeps a detail that only looks like a credential name: %s', (detail) => {
    expect(sanitizeUpstreamDetail({ detail }, TOKEN)).toBe(detail)
  })

  it('still lets ordinary search errors through', () => {
    expect(sanitizeUpstreamDetail({ detail: '"foo" is not a supported search key' }, TOKEN)).toBe(
      '"foo" is not a supported search key',
    )
    expect(sanitizeUpstreamDetail({ detail: 'invalid sort option' }, TOKEN)).toBe(
      'invalid sort option',
    )
  })

  it('collapses control characters and repeated whitespace', () => {
    expect(sanitizeUpstreamDetail({ detail: '  a\r\nb\t\tc   d  ' }, TOKEN)).toBe('a b c d')
  })

  it('truncates to 200 characters after cleaning', () => {
    const result = sanitizeUpstreamDetail({ detail: 'x'.repeat(250) }, TOKEN)
    expect(result).toHaveLength(201)
    expect(result?.endsWith('…')).toBe(true)
  })
})

describe('createHttpError', () => {
  it('maps 400 with recommended sort to UNSUPPORTED_BY_INSTANCE', () => {
    const error = createHttpError(400, { isSearch: true, usedRecommendedSort: true })
    expect(error.code).toBe('UNSUPPORTED_BY_INSTANCE')
    expect(error.message).toBe('This Sentry instance does not support the requested sort order.')
  })

  it('maps a search 400 to INVALID_QUERY and appends the detail', () => {
    const error = createHttpError(400, { isSearch: true, detail: 'bad key' })
    expect(error.code).toBe('INVALID_QUERY')
    expect(error.message).toBe(
      'Sentry rejected the search query. Check the Sentry search syntax. Sentry said: bad key',
    )
    expect(error.detail).toBe('bad key')
  })

  it('omits the Sentry said clause when there is no detail', () => {
    const error = createHttpError(400, { isSearch: true })
    expect(error.message).toBe('Sentry rejected the search query. Check the Sentry search syntax.')
    expect(error.detail).toBeUndefined()
  })

  it.each([
    ['accessToken sk_live_ABC', 'sk_live_ABC'],
    ['api key AKIA-BAIT rejected', 'AKIA-BAIT'],
    ['access.key BAIT', 'BAIT'],
  ])(
    'never surfaces a credential-bearing detail through the 400 error surface: %s',
    (raw, bait) => {
      const detail = sanitizeUpstreamDetail({ detail: raw }, TOKEN)
      const error = createHttpError(400, { isSearch: true, detail })

      expect(detail).toBeUndefined()
      expect(error.detail).toBeUndefined()
      expect(error.message).not.toContain(bait)
      expect(JSON.stringify(error.toJSON())).not.toContain(bait)
    },
  )

  it('maps a non-search 400 to SENTRY_HTTP_ERROR', () => {
    expect(createHttpError(400, {}).code).toBe('SENTRY_HTTP_ERROR')
  })

  it.each([
    [401, 'AUTHENTICATION_FAILED'],
    [403, 'PERMISSION_DENIED'],
    [404, 'NOT_FOUND'],
    [429, 'RATE_LIMITED'],
    [500, 'SERVER_ERROR'],
    [503, 'SERVER_ERROR'],
    [418, 'SENTRY_HTTP_ERROR'],
  ])('maps HTTP %i to %s', (status, code) => {
    expect(createHttpError(status, {}).code).toBe(code)
  })

  it('mentions the region in 401 and 404 messages', () => {
    expect(createHttpError(401, {}).message).toContain('https://de.sentry.io/')
    expect(createHttpError(404, {}).message).toContain('region')
  })

  it('preserves Retry-After on 429', () => {
    expect(createHttpError(429, { retryAfter: '30' }).retryAfter).toBe('30')
  })
})

describe('SentryApiError', () => {
  it('serializes exactly five keys and nothing else', () => {
    const error = new SentryApiError('boom', {
      code: 'RATE_LIMITED',
      status: 429,
      retryAfter: '30',
      detail: 'slow down',
    })
    expect(error.toJSON()).toEqual({
      name: 'SentryApiError',
      code: 'RATE_LIMITED',
      status: 429,
      retryAfter: '30',
      detail: 'slow down',
    })
    expect(Object.keys(error.toJSON())).toHaveLength(5)
  })
})
