import { containsCredentialTerm } from './secret-terms.js'

/** Stable error codes produced by the Sentry client. */
export type SentryErrorCode =
  | 'AUTHENTICATION_FAILED'
  | 'INVALID_CONFIG'
  | 'INVALID_INPUT'
  | 'INVALID_QUERY'
  | 'INVALID_RESPONSE'
  | 'NETWORK_ERROR'
  | 'NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'RATE_LIMITED'
  | 'REQUEST_ABORTED'
  | 'REQUEST_TIMEOUT'
  | 'RESPONSE_TOO_LARGE'
  | 'SENTRY_HTTP_ERROR'
  | 'SERVER_ERROR'
  | 'UNSUPPORTED_BY_INSTANCE'

/** Maximum length of an upstream explanation echoed back to the caller. */
export const MAX_DETAIL_CHARS = 200

const REGION_HINT = 'Verify baseUrl matches your Sentry region (for example https://de.sentry.io/).'

const SEARCH_400_MESSAGE = 'Sentry rejected the search query. Check the Sentry search syntax.'

/** Safe structured details for a Sentry failure. */
export interface SentryApiErrorOptions {
  readonly code: SentryErrorCode
  readonly status?: number
  readonly retryAfter?: string
  readonly detail?: string
}

/** Request-side context needed to classify an HTTP 400. */
export interface HttpErrorContext {
  readonly retryAfter?: string
  readonly detail?: string
  readonly isSearch?: boolean
  readonly usedRecommendedSort?: boolean
}

/** Structured API error that never embeds credentials or raw response bodies. */
export class SentryApiError extends Error {
  readonly code: SentryErrorCode
  readonly status?: number
  readonly retryAfter?: string
  readonly detail?: string

  /** Creates a safe Sentry API error. */
  constructor(message: string, options: SentryApiErrorOptions) {
    super(message)
    this.name = 'SentryApiError'
    this.code = options.code
    this.status = options.status
    this.retryAfter = options.retryAfter
    this.detail = options.detail
  }

  /** Returns JSON-safe error details suitable for diagnostics. */
  toJSON(): Record<string, number | string | undefined> {
    return {
      name: this.name,
      code: this.code,
      status: this.status,
      retryAfter: this.retryAfter,
      detail: this.detail,
    }
  }
}

/** Creates a safe error for an unsuccessful HTTP response. */
export function createHttpError(status: number, ctx: HttpErrorContext = {}): SentryApiError {
  const descriptor = describeHttpError(status, ctx)
  return new SentryApiError(descriptor.message, {
    code: descriptor.code,
    status,
    retryAfter: ctx.retryAfter,
    detail: descriptor.code === 'INVALID_QUERY' ? ctx.detail : undefined,
  })
}

function describeHttpError(
  status: number,
  ctx: HttpErrorContext,
): { readonly code: SentryErrorCode; readonly message: string } {
  if (status === 400) return describeBadRequest(ctx)
  if (status === 401) {
    return {
      code: 'AUTHENTICATION_FAILED',
      message: `Sentry authentication failed. Check the configured token. ${REGION_HINT}`,
    }
  }
  if (status === 403) {
    return {
      code: 'PERMISSION_DENIED',
      message:
        'Sentry denied access to this resource. Check the token scopes (org:read, project:read, event:read).',
    }
  }
  if (status === 404) {
    return {
      code: 'NOT_FOUND',
      message:
        'The requested Sentry resource was not found. Verify the org slug and that baseUrl matches your Sentry region.',
    }
  }
  if (status === 429) {
    return { code: 'RATE_LIMITED', message: 'Sentry rate limit exceeded. Retry later.' }
  }
  if (status >= 500) {
    return { code: 'SERVER_ERROR', message: `Sentry server error (HTTP ${status}).` }
  }
  return { code: 'SENTRY_HTTP_ERROR', message: `Sentry request failed (HTTP ${status}).` }
}

function describeBadRequest(ctx: HttpErrorContext): {
  readonly code: SentryErrorCode
  readonly message: string
} {
  if (ctx.usedRecommendedSort) {
    return {
      code: 'UNSUPPORTED_BY_INSTANCE',
      message: 'This Sentry instance does not support the requested sort order.',
    }
  }
  if (ctx.isSearch) {
    return {
      code: 'INVALID_QUERY',
      message: ctx.detail ? `${SEARCH_400_MESSAGE} Sentry said: ${ctx.detail}` : SEARCH_400_MESSAGE,
    }
  }
  return { code: 'SENTRY_HTTP_ERROR', message: 'Sentry request failed (HTTP 400).' }
}

/** Extracts a safe, short upstream explanation from an HTTP 400 body. */
export function sanitizeUpstreamDetail(body: unknown, token: string): string | undefined {
  const raw = readDetailField(body)
  if (raw === undefined) return undefined
  const cleaned = raw
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!cleaned) return undefined
  if (token && cleaned.includes(token)) return undefined
  if (containsCredentialTerm(cleaned)) return undefined
  return cleaned.length > MAX_DETAIL_CHARS ? `${cleaned.slice(0, MAX_DETAIL_CHARS)}…` : cleaned
}

function readDetailField(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined
  const record = body as Record<string, unknown>
  for (const key of ['detail', 'error']) {
    const value = record[key]
    if (typeof value === 'string') return value
  }
  return undefined
}
