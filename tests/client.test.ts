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

function neverCalled(): MockFetch {
  return () => {
    throw new Error('fetch must not be called for invalid input')
  }
}

describe('endpoints', () => {
  it('lists projects with a fixed page size', async () => {
    const fetchMock = vi.fn<MockFetch>().mockResolvedValue(jsonResponse([]))
    await createClient(fetchMock).listProjects()

    const url = calledUrl(fetchMock)
    expect(url.pathname).toBe('/api/0/organizations/acme/projects/')
    expect(url.searchParams.get('per_page')).toBe('100')
  })

  it('uses the project endpoint when a slug is given and the org endpoint otherwise', async () => {
    const scoped = vi.fn<MockFetch>().mockResolvedValue(jsonResponse([]))
    await createClient(scoped).searchIssues({ projectSlug: 'web-app' })
    expect(calledUrl(scoped).pathname).toBe('/api/0/projects/acme/web-app/issues/')

    const org = vi.fn<MockFetch>().mockResolvedValue(jsonResponse([]))
    await createClient(org).searchIssues({})
    expect(calledUrl(org).pathname).toBe('/api/0/organizations/acme/issues/')
  })

  it('applies search defaults and passes explicit values through', async () => {
    const defaults = vi.fn<MockFetch>().mockResolvedValue(jsonResponse([]))
    await createClient(defaults).searchIssues({})
    const defaulted = calledUrl(defaults).searchParams
    expect(defaulted.get('query')).toBe('is:unresolved')
    expect(defaulted.get('statsPeriod')).toBe('14d')
    expect(defaulted.get('sort')).toBe('date')
    expect(defaulted.get('per_page')).toBe('25')

    const explicit = vi.fn<MockFetch>().mockResolvedValue(jsonResponse([]))
    await createClient(explicit).searchIssues({
      query: 'is:resolved',
      statsPeriod: '24h',
      sort: 'freq',
      environment: 'production',
      limit: 100,
      cursor: '0:100:0',
    })
    const params = calledUrl(explicit).searchParams
    expect(params.get('query')).toBe('is:resolved')
    expect(params.get('statsPeriod')).toBe('24h')
    expect(params.get('sort')).toBe('freq')
    expect(params.get('environment')).toBe('production')
    expect(params.get('per_page')).toBe('100')
    expect(params.get('cursor')).toBe('0:100:0')
  })

  it('flags a recommended sort so a 400 becomes UNSUPPORTED_BY_INSTANCE', async () => {
    const fetchMock = vi
      .fn<MockFetch>()
      .mockResolvedValue(jsonResponse({ detail: 'nope' }, { status: 400 }))

    await expect(
      createClient(fetchMock).searchIssues({ sort: 'recommended' }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_BY_INSTANCE' })
  })

  it('maps a non-search 400 to SENTRY_HTTP_ERROR', async () => {
    const fetchMock = vi
      .fn<MockFetch>()
      .mockResolvedValue(jsonResponse({ detail: 'nope' }, { status: 400 }))

    await expect(createClient(fetchMock).getEvent('web-app', 'a'.repeat(32))).rejects.toMatchObject(
      {
        code: 'SENTRY_HTTP_ERROR',
      },
    )
  })

  it.each([
    ['limit 0', () => createClient(neverCalled()).searchIssues({ limit: 0 })],
    ['limit 101', () => createClient(neverCalled()).searchIssues({ limit: 101 })],
    ['bad cursor', () => createClient(neverCalled()).searchIssues({ cursor: 'nope' })],
    ['slash slug', () => createClient(neverCalled()).searchIssues({ projectSlug: 'a/b' })],
    ['dotdot slug', () => createClient(neverCalled()).searchIssues({ projectSlug: '../etc' })],
    ['upper slug', () => createClient(neverCalled()).searchIssues({ projectSlug: 'Web' })],
    ['long query', () => createClient(neverCalled()).searchIssues({ query: 'x'.repeat(401) })],
    ['short event id', () => createClient(neverCalled()).getEvent('web-app', 'abc')],
    ['non-hex event id', () => createClient(neverCalled()).getEvent('web-app', 'z'.repeat(32))],
    ['bad issue id', () => createClient(neverCalled()).getIssue('-A-1')],
    ['empty issue id', () => createClient(neverCalled()).getIssue('')],
  ])('rejects %s before sending a request', async (_label, call) => {
    await expect(call()).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('treats an all-digit issue as a numeric id with one request', async () => {
    const numeric = vi.fn<MockFetch>().mockResolvedValue(jsonResponse({ id: '123456' }))
    await createClient(numeric).getIssue('123456')
    expect(numeric).toHaveBeenCalledTimes(1)
    expect(calledUrl(numeric).pathname).toBe('/api/0/issues/123456/')

    // A Response body can only be read once, so each call needs a fresh Response.
    const dashed = vi.fn<MockFetch>().mockImplementation(async () => jsonResponse({ groupId: '9' }))
    await createClient(dashed).getIssue('123-456')
    expect(calledUrl(dashed).pathname).toBe('/api/0/organizations/acme/shortids/123-456/')
  })

  it('resolves a short id and upper-cases it first', async () => {
    const fetchMock = vi
      .fn<MockFetch>()
      .mockResolvedValueOnce(jsonResponse({ groupId: '987654' }))
      .mockResolvedValueOnce(jsonResponse({ id: '987654' }))

    const result = await createClient(fetchMock).getIssue('proj-abc')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(calledUrl(fetchMock, 0).pathname).toBe('/api/0/organizations/acme/shortids/PROJ-ABC/')
    expect(calledUrl(fetchMock, 1).pathname).toBe('/api/0/issues/987654/')
    expect(result.data).toEqual({ id: '987654' })
  })

  it('accepts a numeric groupId type', async () => {
    const fetchMock = vi
      .fn<MockFetch>()
      .mockResolvedValueOnce(jsonResponse({ groupId: 987654 }))
      .mockResolvedValueOnce(jsonResponse({ id: '987654' }))

    await createClient(fetchMock).getIssue('PROJ-ABC')
    expect(calledUrl(fetchMock, 1).pathname).toBe('/api/0/issues/987654/')
  })

  it.each([
    ['missing', {}],
    ['null', { groupId: null }],
    ['non numeric', { groupId: 'abc' }],
    ['nested', { group: { id: '5' } }],
    ['too long', { groupId: '1'.repeat(21) }],
  ])('rejects an unusable groupId (%s) without a second request', async (_label, body) => {
    const fetchMock = vi.fn<MockFetch>().mockResolvedValue(jsonResponse(body))

    await expect(createClient(fetchMock).getIssue('PROJ-ABC')).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('maps a shortids 404 to NOT_FOUND', async () => {
    const fetchMock = vi.fn<MockFetch>().mockResolvedValue(jsonResponse({}, { status: 404 }))

    await expect(createClient(fetchMock).getIssue('PROJ-ABC')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('shares one deadline across both requests of a short id call', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn<MockFetch>()
      .mockImplementationOnce(async () => {
        await vi.advanceTimersByTimeAsync(600)
        return jsonResponse({ groupId: '5' })
      })
      .mockImplementationOnce(hangUntilAborted)

    const pending = expect(createClient(fetchMock).getIssue('PROJ-ABC')).rejects.toMatchObject({
      code: 'REQUEST_TIMEOUT',
    })
    await vi.advanceTimersByTimeAsync(500)
    await pending
  })

  it('builds the event endpoints', async () => {
    const latest = vi.fn<MockFetch>().mockResolvedValue(jsonResponse({ eventID: 'a' }))
    await createClient(latest).getLatestEvent('123')
    expect(calledUrl(latest).pathname).toBe('/api/0/issues/123/events/latest/')

    const single = vi.fn<MockFetch>().mockResolvedValue(jsonResponse({ eventID: 'a' }))
    await createClient(single).getEvent('web-app', 'b'.repeat(32))
    expect(calledUrl(single).pathname).toBe(
      `/api/0/projects/acme/web-app/events/${'b'.repeat(32)}/`,
    )
  })
})
