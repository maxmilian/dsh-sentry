import { SentryApiError } from './errors.js'

/** Locales offered for runtime tool metadata. */
export const LOCALES = ['en', 'zh-TW', 'zh-CN', 'ja'] as const

/** A locale accepted by the plugin configuration. */
export type Locale = (typeof LOCALES)[number]

/** Default Sentry site root. */
export const DEFAULT_BASE_URL = 'https://sentry.io/'

/** Default deadline for one whole tool call, in milliseconds. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000

/** Maximum accepted deadline for one whole tool call, in milliseconds. */
export const MAX_REQUEST_TIMEOUT_MS = 300_000

/** Default maximum successful response body size in bytes. */
export const DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024

/** Maximum accepted successful response body size in bytes. */
export const MAX_RESPONSE_BYTES = 50 * 1024 * 1024

/** Slug rule shared by Sentry organizations and projects. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/

/** Runtime configuration accepted by the client and plugin. */
export interface SentryConfig {
  /** Sentry site root URL. Falls back to SENTRY_URL. */
  readonly baseUrl?: string
  /** Sentry auth token. Falls back to SENTRY_AUTH_TOKEN. */
  readonly token?: string
  /** Sentry organization slug. Falls back to SENTRY_ORG. */
  readonly org?: string
  /** Language used for tool and parameter descriptions. */
  readonly locale?: Locale
  /** Whether stack frame local variables survive trimming. */
  readonly includeFrameVars?: boolean
  /** Deadline for one whole tool call, in milliseconds. */
  readonly requestTimeoutMs?: number
  /** Maximum successful response body size in bytes. */
  readonly maxResponseBytes?: number
}

/** Fully validated runtime configuration. */
export interface ResolvedSentryConfig {
  /** Normalized Sentry site root URL with a trailing slash. */
  readonly baseUrl: string
  /** Non-empty Sentry auth token. */
  readonly token: string
  /** Validated Sentry organization slug. */
  readonly org: string
  /** Validated tool metadata locale. */
  readonly locale: Locale
  /** Whether stack frame local variables survive trimming. */
  readonly includeFrameVars: boolean
  /** Validated deadline for one whole tool call, in milliseconds. */
  readonly requestTimeoutMs: number
  /** Validated maximum successful response body size in bytes. */
  readonly maxResponseBytes: number
}

/** Resolves plugin config over environment variables and validates safe bounds. */
export function resolveConfig(
  config: SentryConfig = {},
  env: NodeJS.ProcessEnv = process.env,
): ResolvedSentryConfig {
  return validateResolvedConfig({
    baseUrl: config.baseUrl?.trim() || env.SENTRY_URL?.trim() || DEFAULT_BASE_URL,
    token: config.token?.trim() || env.SENTRY_AUTH_TOKEN?.trim() || '',
    org: config.org?.trim() || env.SENTRY_ORG?.trim() || '',
    locale: config.locale ?? 'en',
    includeFrameVars: config.includeFrameVars ?? readBooleanEnv(env.SENTRY_INCLUDE_FRAME_VARS),
    requestTimeoutMs: config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    maxResponseBytes: config.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
  })
}

/** Validates and normalizes a fully specified client configuration. */
export function validateResolvedConfig(config: ResolvedSentryConfig): ResolvedSentryConfig {
  if (typeof config.token !== 'string' || !config.token.trim()) {
    throw configError('token or SENTRY_AUTH_TOKEN is required.')
  }
  if (config.token.length > 500) {
    throw configError('token must contain 1-500 characters.')
  }
  if (typeof config.org !== 'string' || !config.org.trim()) {
    throw configError('org or SENTRY_ORG is required.')
  }
  if (!SLUG_PATTERN.test(config.org)) {
    throw configError('org must be a valid Sentry slug.')
  }
  if (!LOCALES.includes(config.locale)) {
    throw configError('locale must be one of en, zh-TW, zh-CN, ja.')
  }
  assertBoundedInteger('requestTimeoutMs', config.requestTimeoutMs, MAX_REQUEST_TIMEOUT_MS)
  assertBoundedInteger('maxResponseBytes', config.maxResponseBytes, MAX_RESPONSE_BYTES)
  return { ...config, baseUrl: normalizeBaseUrl(config.baseUrl.trim()), token: config.token.trim() }
}

function readBooleanEnv(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true'
}

function normalizeBaseUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw configError('baseUrl must be a valid HTTP or HTTPS URL.')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw configError('baseUrl must be an HTTP(S) URL without embedded credentials.')
  }
  if (url.search || url.hash) {
    throw configError('baseUrl must not include a query string or fragment.')
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '').replace(/\/api\/0$/, '')}/`
  return url.toString()
}

function assertBoundedInteger(name: string, value: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw configError(`${name} must be an integer between 1 and ${maximum}.`)
  }
}

function configError(message: string): SentryApiError {
  return new SentryApiError(`Invalid Sentry configuration: ${message}`, { code: 'INVALID_CONFIG' })
}
