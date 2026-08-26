import { afterEach, describe, expect, it, vi } from 'vitest'

import { SentryClient } from '../src/client.js'
import { resolveConfig } from '../src/config.js'
import { SentryApiError } from '../src/errors.js'

const ENV = { SENTRY_AUTH_TOKEN: 'env-token', SENTRY_ORG: 'env-org' }

type MockFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

const BASE_CONFIG = {
  baseUrl: 'https://sentry.example.com/',
  token: 'secret-token',
  org: 'acme',
  locale: 'en',
  includeFrameVars: false,
  requestTimeoutMs: 1_000,
  maxResponseBytes: 10_000,
} as const

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
}

function createClient(fetchMock: MockFetch): SentryClient {
  return new SentryClient(BASE_CONFIG, fetchMock)
}

function calledUrl(fetchMock: ReturnType<typeof vi.fn<MockFetch>>, index = 0): URL {
  return new URL(String(fetchMock.mock.calls[index]?.[0]))
}

/** Mimics real fetch: never settles until its AbortSignal fires, then rejects. */
function hangUntilAborted(_input: string | URL | Request, init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
  })
}

afterEach(() => {
  vi.useRealTimers()
})

describe('configuration', () => {
  it('prefers plugin config over environment variables', () => {
    const resolved = resolveConfig(
      { baseUrl: 'https://self.example.com/sentry/', token: 'cfg-token', org: 'cfg-org' },
      { ...ENV, SENTRY_URL: 'https://env.example.com' },
    )

    expect(resolved.baseUrl).toBe('https://self.example.com/sentry/')
    expect(resolved.token).toBe('cfg-token')
    expect(resolved.org).toBe('cfg-org')
  })

  it('falls back to environment variables and defaults', () => {
    const resolved = resolveConfig({}, ENV)

    expect(resolved.baseUrl).toBe('https://sentry.io/')
    expect(resolved.token).toBe('env-token')
    expect(resolved.org).toBe('env-org')
    expect(resolved.locale).toBe('en')
    expect(resolved.includeFrameVars).toBe(false)
    expect(resolved.requestTimeoutMs).toBe(30_000)
    expect(resolved.maxResponseBytes).toBe(5 * 1024 * 1024)
  })

  it('strips a trailing api/0 segment and adds a trailing slash', () => {
    expect(resolveConfig({ baseUrl: 'https://sentry.io/api/0/' }, ENV).baseUrl).toBe(
      'https://sentry.io/',
    )
    expect(resolveConfig({ baseUrl: 'https://x.com/sentry' }, ENV).baseUrl).toBe(
      'https://x.com/sentry/',
    )
  })

  it.each([
    ['ftp://sentry.io/', 'protocol'],
    ['https://user:pw@sentry.io/', 'credentials'],
    ['https://sentry.io/?a=1', 'query'],
    ['https://sentry.io/#frag', 'fragment'],
    ['not a url', 'invalid'],
  ])('rejects unsafe baseUrl %s', (baseUrl) => {
    expect(() => resolveConfig({ baseUrl }, ENV)).toThrow(SentryApiError)
  })

  it('requires a token and an org', () => {
    expect(() => resolveConfig({}, { SENTRY_ORG: 'o' })).toThrow(/token/)
    expect(() => resolveConfig({}, { SENTRY_AUTH_TOKEN: 't' })).toThrow(/org/)
  })

  it.each(['Bad-Org', 'org/slash', '../escape', '-leading', 'x'.repeat(65)])(
    'rejects org slug %s',
    (org) => {
      expect(() => resolveConfig({ org }, ENV)).toThrow(SentryApiError)
    },
  )

  it('rejects an unknown locale', () => {
    // @ts-expect-error deliberately invalid locale
    expect(() => resolveConfig({ locale: 'fr' }, ENV)).toThrow(/locale/)
  })

  it('treats only the literal string true as includeFrameVars', () => {
    expect(resolveConfig({}, { ...ENV, SENTRY_INCLUDE_FRAME_VARS: 'TRUE' }).includeFrameVars).toBe(
      true,
    )
    expect(
      resolveConfig({}, { ...ENV, SENTRY_INCLUDE_FRAME_VARS: ' true ' }).includeFrameVars,
    ).toBe(true)
    for (const value of ['1', 'yes', '', 'false']) {
      expect(resolveConfig({}, { ...ENV, SENTRY_INCLUDE_FRAME_VARS: value }).includeFrameVars).toBe(
        false,
      )
    }
  })

  it.each([
    ['requestTimeoutMs', 0],
    ['requestTimeoutMs', 300_001],
    ['requestTimeoutMs', 1.5],
    ['maxResponseBytes', 0],
    ['maxResponseBytes', 50 * 1024 * 1024 + 1],
  ])('rejects out-of-bounds %s = %s', (field, value) => {
    expect(() => resolveConfig({ [field]: value }, ENV)).toThrow(SentryApiError)
  })

  it('reports configuration failures with the INVALID_CONFIG code', () => {
    try {
      resolveConfig({}, {})
      expect.unreachable('resolveConfig should have thrown')
    } catch (error) {
      expect((error as SentryApiError).code).toBe('INVALID_CONFIG')
    }
  })
})

describe('transport', () => {
  it('sends a bearer token and accepts a JSON object body', async () => {
    const fetchMock = vi.fn<MockFetch>().mockResolvedValue(jsonResponse({ id: '1' }))
    const result = await createClient(fetchMock).getIssue('123')

    expect(calledUrl(fetchMock).toString()).toBe('https://sentry.example.com/api/0/issues/123/')
    const init = fetchMock.mock.calls[0]?.[1]
    expect(init?.method).toBe('GET')
    expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBe(
      'Bearer secret-token',
    )
    expect(result.data).toEqual({ id: '1' })
  })

  it('accepts an array top level', async () => {
    const fetchMock = vi.fn<MockFetch>().mockResolvedValue(jsonResponse([{ id: '1' }]))
    const result = await createClient(fetchMock).searchIssues({})

    expect(result.data).toEqual([{ id: '1' }])
  })

  it.each(['"text"', '42', 'null'])('rejects the scalar top level %s', async (body) => {
    const fetchMock = vi
      .fn<MockFetch>()
      .mockResolvedValue(new Response(body, { headers: { 'content-type': 'application/json' } }))

    await expect(createClient(fetchMock).getIssue('1')).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    })
  })

  it('rejects a non-JSON content type and broken JSON on 2xx', async () => {
    const html = vi
      .fn<MockFetch>()
      .mockResolvedValue(new Response('<html>', { headers: { 'content-type': 'text/html' } }))
    await expect(createClient(html).getIssue('1')).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    })

    const broken = vi
      .fn<MockFetch>()
      .mockResolvedValue(new Response('{oops', { headers: { 'content-type': 'application/json' } }))
    await expect(createClient(broken).getIssue('1')).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    })
  })

  it('parses the Link header only when more results exist', async () => {
    const withNext = vi.fn<MockFetch>().mockResolvedValue(
      jsonResponse([], {
        headers: {
          link: '<https://x/?cursor=0:100:0>; rel="next"; results="true"; cursor="0:100:0"',
        },
      }),
    )
    expect((await createClient(withNext).searchIssues({})).meta.nextCursor).toBe('0:100:0')

    const exhausted = vi.fn<MockFetch>().mockResolvedValue(
      jsonResponse([], {
        headers: {
          link: '<https://x/?cursor=0:100:0>; rel="next"; results="false"; cursor="0:100:0"',
        },
      }),
    )
    expect((await createClient(exhausted).searchIssues({})).meta.nextCursor).toBeUndefined()

    const malformed = vi
      .fn<MockFetch>()
      .mockResolvedValue(jsonResponse([], { headers: { link: 'garbage' } }))
    expect((await createClient(malformed).searchIssues({})).meta.nextCursor).toBeUndefined()
  })

  it('parses X-Hits only when it is a plausible integer', async () => {
    const good = vi
      .fn<MockFetch>()
      .mockResolvedValue(jsonResponse([], { headers: { 'x-hits': '431' } }))
    expect((await createClient(good).searchIssues({})).meta.matchingCount).toBe(431)

    for (const value of ['abc', '1'.repeat(11), '-1']) {
      const bad = vi
        .fn<MockFetch>()
        .mockResolvedValue(jsonResponse([], { headers: { 'x-hits': value } }))
      expect((await createClient(bad).searchIssues({})).meta.matchingCount).toBeUndefined()
    }
  })

  it('aborts on an oversized content-length and on an oversized stream', async () => {
    const declared = vi.fn<MockFetch>().mockResolvedValue(
      new Response('{}', {
        headers: { 'content-type': 'application/json', 'content-length': '999999' },
      }),
    )
    await expect(createClient(declared).getIssue('1')).rejects.toMatchObject({
      code: 'RESPONSE_TOO_LARGE',
      message: expect.stringContaining('configured maximum'),
    })

    const streamed = vi.fn<MockFetch>().mockResolvedValue(jsonResponse({ pad: 'x'.repeat(20_000) }))
    await expect(createClient(streamed).getIssue('1')).rejects.toMatchObject({
      code: 'RESPONSE_TOO_LARGE',
    })
  })

  it('reads a filtered detail from a 400 body on search', async () => {
    const fetchMock = vi.fn<MockFetch>().mockResolvedValue(
      jsonResponse(
        { detail: 'Invalid query. "foo" is not a supported search key' },
        {
          status: 400,
        },
      ),
    )

    await expect(createClient(fetchMock).searchIssues({ query: 'foo:bar' })).rejects.toMatchObject({
      code: 'INVALID_QUERY',
      detail: 'Invalid query. "foo" is not a supported search key',
    })
  })

  it.each([
    [
      'html',
      new Response('<html>err</html>', { status: 400, headers: { 'content-type': 'text/html' } }),
    ],
    [
      'broken json',
      new Response('{oops', { status: 400, headers: { 'content-type': 'application/json' } }),
    ],
  ])('falls back to the static 400 message for a %s body', async (_label, response) => {
    const fetchMock = vi.fn<MockFetch>().mockResolvedValue(response)

    const error = await createClient(fetchMock)
      .searchIssues({})
      .catch((thrown: SentryApiError) => thrown)

    expect(error).toMatchObject({ code: 'INVALID_QUERY', detail: undefined })
    expect((error as SentryApiError).message).toBe(
      'Sentry rejected the search query. Check the Sentry search syntax.',
    )
  })

  it.each([401, 403, 404, 500])('never leaks a %i response body', async (status) => {
    const fetchMock = vi
      .fn<MockFetch>()
      .mockResolvedValue(jsonResponse({ detail: 'leak-me' }, { status }))

    const error = await createClient(fetchMock)
      .getIssue('1')
      .catch((thrown: SentryApiError) => thrown)

    expect((error as SentryApiError).message).not.toContain('leak-me')
    expect(JSON.stringify((error as SentryApiError).toJSON())).not.toContain('leak-me')
  })

  it('never leaks the token in an error', async () => {
    const fetchMock = vi.fn<MockFetch>().mockResolvedValue(jsonResponse({}, { status: 500 }))

    const error = await createClient(fetchMock)
      .getIssue('1')
      .catch((thrown: SentryApiError) => thrown)

    expect((error as SentryApiError).message).not.toContain('secret-token')
    expect(JSON.stringify((error as SentryApiError).toJSON())).not.toContain('secret-token')
  })

  it('preserves Retry-After on 429', async () => {
    const fetchMock = vi
      .fn<MockFetch>()
      .mockResolvedValue(jsonResponse({}, { status: 429, headers: { 'retry-after': '30' } }))

    await expect(createClient(fetchMock).getIssue('1')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfter: '30',
    })
  })

  it('reports a timeout', async () => {
    vi.useFakeTimers()
    const hang = vi.fn<MockFetch>().mockImplementation(hangUntilAborted)
    // Attach the rejection handler before advancing time, or Node flags it unhandled.
    const timedOut = expect(createClient(hang).getIssue('1')).rejects.toMatchObject({
      code: 'REQUEST_TIMEOUT',
    })
    await vi.advanceTimersByTimeAsync(1_001)
    await timedOut
  })

  it('honours caller aborts and reports network failures', async () => {
    const controller = new AbortController()
    controller.abort()
    const aborted = vi.fn<MockFetch>().mockRejectedValue(new Error('aborted'))
    await expect(createClient(aborted).getIssue('1', controller.signal)).rejects.toMatchObject({
      code: 'REQUEST_ABORTED',
    })

    const offline = vi.fn<MockFetch>().mockRejectedValue(new TypeError('fetch failed'))
    await expect(createClient(offline).getIssue('1')).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
    })
  })
})
