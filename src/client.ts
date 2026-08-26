import type { ResolvedSentryConfig, SentryConfig } from './config.js'
import { resolveConfig, SLUG_PATTERN, validateResolvedConfig } from './config.js'
import type { HttpErrorContext } from './errors.js'
import { createHttpError, SentryApiError, sanitizeUpstreamDetail } from './errors.js'
import type { ApiResult, JsonObject, JsonValue, TransportMeta } from './types.js'

export { resolveConfig, SLUG_PATTERN }

/** Numeric Sentry identifier, used for issue ids and resolved group ids. */
export const NUMERIC_ID_PATTERN = /^\d{1,20}$/

/** Sentry short id such as PROJ-ABC, matched after upper-casing. */
export const SHORT_ID_PATTERN = /^[A-Z0-9][A-Z0-9_]*-[A-Z0-9]+$/

/** Sentry event id: 32 hexadecimal characters. */
export const EVENT_ID_PATTERN = /^[0-9a-fA-F]{32}$/

/** Sentry pagination cursor: value:offset:isPrev. */
export const CURSOR_PATTERN = /^-?\d+:-?\d+:[01]$/

/** Upper bound on the HTTP 400 body read while looking for an explanation. */
export const ERROR_BODY_MAX_BYTES = 64 * 1024

const HITS_PATTERN = /^\d{1,10}$/
const MAX_QUERY_CHARS = 400
const MAX_ENVIRONMENT_CHARS = 100
const MAX_ISSUE_CHARS = 64
const MAX_LIMIT = 100
const DEFAULT_LIMIT = 25

type FetchImplementation = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/** One deadline shared by every HTTP request inside a single tool call. */
export interface RequestContext {
  readonly controller: AbortController
  readonly dispose: () => void
  readonly didTimeout: () => boolean
}

/** Search parameters accepted by `searchIssues`. */
export interface SearchIssuesParams {
  readonly projectSlug?: string
  readonly query?: string
  readonly statsPeriod?: string
  readonly sort?: string
  readonly environment?: string
  readonly limit?: number
  readonly cursor?: string
}

/** Read-only HTTP client for the Sentry Web API. Returns untrimmed JSON. */
export class SentryClient {
  readonly #config: ResolvedSentryConfig
  readonly #fetch: FetchImplementation

  /** Creates a client from resolved configuration. */
  constructor(config: ResolvedSentryConfig, fetchImplementation: FetchImplementation = fetch) {
    this.#config = validateResolvedConfig(config)
    this.#fetch = fetchImplementation
  }

  /** Creates one deadline for an entire tool call, including any follow-up request. */
  createCallContext(signal?: AbortSignal): RequestContext {
    return createRequestContext(signal, this.#config.requestTimeoutMs)
  }

  /** Lists the projects of the configured organization. */
  async listProjects(signal?: AbortSignal): Promise<ApiResult> {
    const context = this.createCallContext(signal)
    try {
      return await this.#request(
        `api/0/organizations/${this.#config.org}/projects/`,
        new URLSearchParams({ per_page: '100' }),
        context,
        signal,
        {},
      )
    } finally {
      context.dispose()
    }
  }

  /** Searches issues in one project or across the whole organization. */
  async searchIssues(params: SearchIssuesParams, signal?: AbortSignal): Promise<ApiResult> {
    const endpoint = params.projectSlug
      ? `api/0/projects/${this.#config.org}/${assertSlug(params.projectSlug)}/issues/`
      : `api/0/organizations/${this.#config.org}/issues/`
    const query = buildSearchQuery(params)
    const context = this.createCallContext(signal)
    try {
      return await this.#request(endpoint, query, context, signal, {
        isSearch: true,
        usedRecommendedSort: params.sort === 'recommended',
      })
    } finally {
      context.dispose()
    }
  }

  /** Reads one issue by numeric id or short id. */
  async getIssue(issue: string, signal?: AbortSignal): Promise<ApiResult> {
    const context = this.createCallContext(signal)
    try {
      const id = await this.#resolveIssueId(issue, context, signal)
      return await this.#request(`api/0/issues/${id}/`, new URLSearchParams(), context, signal, {})
    } finally {
      context.dispose()
    }
  }

  /** Reads the latest event of one issue. */
  async getLatestEvent(issue: string, signal?: AbortSignal): Promise<ApiResult> {
    const context = this.createCallContext(signal)
    try {
      const id = await this.#resolveIssueId(issue, context, signal)
      return await this.#request(
        `api/0/issues/${id}/events/latest/`,
        new URLSearchParams(),
        context,
        signal,
        {},
      )
    } finally {
      context.dispose()
    }
  }

  /** Reads one event by id within a project. */
  async getEvent(projectSlug: string, eventId: string, signal?: AbortSignal): Promise<ApiResult> {
    const slug = assertSlug(projectSlug)
    const id = assertPattern('event_id', eventId, EVENT_ID_PATTERN)
    const context = this.createCallContext(signal)
    try {
      return await this.#request(
        `api/0/projects/${this.#config.org}/${slug}/events/${id}/`,
        new URLSearchParams(),
        context,
        signal,
        {},
      )
    } finally {
      context.dispose()
    }
  }

  async #resolveIssueId(
    issue: string,
    context: RequestContext,
    signal?: AbortSignal,
  ): Promise<string> {
    const trimmed = issue.trim()
    if (NUMERIC_ID_PATTERN.test(trimmed)) return trimmed
    const shortId = trimmed.toUpperCase()
    if (!SHORT_ID_PATTERN.test(shortId) || shortId.length > MAX_ISSUE_CHARS) {
      throw inputError('issue must be a numeric issue id or a short id such as PROJ-ABC.')
    }
    const result = await this.#request(
      `api/0/organizations/${this.#config.org}/shortids/${encodeURIComponent(shortId)}/`,
      new URLSearchParams(),
      context,
      signal,
      {},
    )
    return readGroupId(result.data)
  }

  async #request(
    endpoint: string,
    query: URLSearchParams,
    context: RequestContext,
    signal: AbortSignal | undefined,
    meta: HttpErrorContext,
  ): Promise<ApiResult> {
    const url = new URL(endpoint, this.#config.baseUrl)
    url.search = query.toString()
    try {
      const response = await this.#fetch(url, {
        headers: { Accept: 'application/json', Authorization: `Bearer ${this.#config.token}` },
        method: 'GET',
        signal: context.controller.signal,
      })
      return await this.#readResponse(response, meta)
    } catch (error: unknown) {
      throw normalizeRequestError(error, signal, context, this.#config.requestTimeoutMs)
    }
  }

  async #readResponse(response: Response, meta: HttpErrorContext): Promise<ApiResult> {
    if (!response.ok) await this.#throwErrorResponse(response, meta)
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
    if (!isJsonContentType(contentType)) {
      await response.body?.cancel()
      throw invalidResponse()
    }
    const body = await readBoundedBody(response, this.#config.maxResponseBytes, tooLargeStream)
    return { data: parseJsonValue(body), meta: parseTransportMeta(response.headers, this.#config) }
  }

  async #throwErrorResponse(response: Response, meta: HttpErrorContext): Promise<never> {
    const retryAfter = safeHeader(response.headers, 'Retry-After', this.#config.token)
    const detail = response.status === 400 ? await this.#readErrorDetail(response) : undefined
    if (response.status !== 400) await response.body?.cancel()
    throw createHttpError(response.status, { ...meta, retryAfter, detail })
  }

  async #readErrorDetail(response: Response): Promise<string | undefined> {
    const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
    if (!isJsonContentType(contentType)) {
      await response.body?.cancel()
      return undefined
    }
    try {
      const text = await readBoundedBody(response, ERROR_BODY_MAX_BYTES, tooLargeStream)
      return sanitizeUpstreamDetail(JSON.parse(text), this.#config.token)
    } catch {
      return undefined
    }
  }
}

/** Creates a client using plugin config over environment variables. */
export function createSentryClient(
  config: SentryConfig = {},
  env: NodeJS.ProcessEnv = process.env,
  fetchImplementation: FetchImplementation = fetch,
): SentryClient {
  return new SentryClient(resolveConfig(config, env), fetchImplementation)
}

function buildSearchQuery(params: SearchIssuesParams): URLSearchParams {
  const query = new URLSearchParams({
    query: assertLength('query', params.query ?? 'is:unresolved', MAX_QUERY_CHARS),
    statsPeriod: params.statsPeriod ?? '14d',
    sort: params.sort ?? 'date',
    per_page: String(assertLimit(params.limit ?? DEFAULT_LIMIT)),
  })
  if (params.environment !== undefined) {
    query.set('environment', assertLength('environment', params.environment, MAX_ENVIRONMENT_CHARS))
  }
  if (params.cursor !== undefined) {
    query.set('cursor', assertPattern('cursor', params.cursor, CURSOR_PATTERN))
  }
  return query
}

function readGroupId(data: JsonValue): string {
  const value = isJsonObject(data) ? data.groupId : undefined
  const text = typeof value === 'number' ? String(value) : value
  if (typeof text !== 'string' || !NUMERIC_ID_PATTERN.test(text)) throw invalidResponse()
  return text
}

function inputError(message: string): SentryApiError {
  return new SentryApiError(`Invalid Sentry input: ${message}`, { code: 'INVALID_INPUT' })
}

function invalidResponse(): SentryApiError {
  return new SentryApiError('Sentry returned an unexpected response.', { code: 'INVALID_RESPONSE' })
}

function assertSlug(value: string): string {
  if (!SLUG_PATTERN.test(value)) throw inputError('project_slug must be a valid Sentry slug.')
  return value
}

function assertLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw inputError(`limit must be an integer between 1 and ${MAX_LIMIT}.`)
  }
  return value
}

function assertLength(name: string, value: string, maximum: number): string {
  if (!value.trim() || value.length > maximum) {
    throw inputError(`${name} must contain 1-${maximum} characters.`)
  }
  return value
}

function assertPattern(name: string, value: string, pattern: RegExp): string {
  if (!pattern.test(value)) throw inputError(`${name} has an unsupported format.`)
  return value
}

function isJsonContentType(value: string): boolean {
  const mediaType = value.split(';', 1)[0]?.trim()
  return (
    mediaType === 'application/json' ||
    (mediaType?.startsWith('application/') === true && mediaType.endsWith('+json'))
  )
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseJsonValue(text: string): JsonValue {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw invalidResponse()
  }
  if (typeof value !== 'object' || value === null) throw invalidResponse()
  return value as JsonValue
}

function parseTransportMeta(headers: Headers, config: ResolvedSentryConfig): TransportMeta {
  const meta: { nextCursor?: string; matchingCount?: number; hasMore?: boolean } = {}
  const cursor = parseNextCursor(headers.get('link'))
  if (cursor) {
    meta.nextCursor = cursor
    meta.hasMore = true
  }
  const hits = safeHeader(headers, 'X-Hits', config.token)
  if (hits && HITS_PATTERN.test(hits)) meta.matchingCount = Number(hits)
  return meta
}

function parseNextCursor(link: string | null): string | undefined {
  if (!link) return undefined
  for (const part of link.split(',')) {
    if (!part.includes('rel="next"') || !part.includes('results="true"')) continue
    const match = /cursor="([^"]+)"/.exec(part)
    if (match?.[1]) return match[1]
  }
  return undefined
}

function createRequestContext(signal: AbortSignal | undefined, timeoutMs: number): RequestContext {
  const controller = new AbortController()
  let timedOut = false
  const abortFromCaller = (): void => controller.abort(signal?.reason)
  if (signal?.aborted) abortFromCaller()
  else signal?.addEventListener('abort', abortFromCaller, { once: true })
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  return {
    controller,
    didTimeout: () => timedOut,
    dispose: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abortFromCaller)
    },
  }
}

function normalizeRequestError(
  error: unknown,
  callerSignal: AbortSignal | undefined,
  context: RequestContext,
  timeoutMs: number,
): SentryApiError {
  if (error instanceof SentryApiError) return error
  if (context.didTimeout()) {
    return new SentryApiError(`Sentry request timed out after ${timeoutMs} ms.`, {
      code: 'REQUEST_TIMEOUT',
    })
  }
  if (callerSignal?.aborted) {
    return new SentryApiError('Sentry request was cancelled.', { code: 'REQUEST_ABORTED' })
  }
  return new SentryApiError('Unable to reach the Sentry server.', { code: 'NETWORK_ERROR' })
}

function safeHeader(headers: Headers, name: string, token: string): string | undefined {
  const value = headers.get(name)?.trim()
  if (!value || value.length > 128 || value.includes(token)) return undefined
  return value
}

function tooLargeStream(maximum: number): SentryApiError {
  return new SentryApiError(
    `Sentry response exceeded the configured maximum of ${maximum} bytes.`,
    { code: 'RESPONSE_TOO_LARGE' },
  )
}

async function readBoundedBody(
  response: Response,
  maximum: number,
  onTooLarge: (maximum: number) => SentryApiError,
): Promise<string> {
  const contentLength = response.headers.get('content-length')
  if (contentLength && Number(contentLength) > maximum) {
    await response.body?.cancel()
    throw onTooLarge(maximum)
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let text = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) return text + decoder.decode()
    total += value.byteLength
    if (total > maximum) {
      await reader.cancel()
      throw onTooLarge(maximum)
    }
    text += decoder.decode(value, { stream: true })
  }
}
