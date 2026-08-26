import { SentryApiError } from './errors.js'
import type { JsonObject, JsonValue } from './types.js'

/** Maximum serialized size of one tool result, in UTF-8 bytes. */
export const MAX_TOOL_RESULT_BYTES = 200_000

/** Character cap for titles, messages, culprits, and issue metadata values. */
export const TITLE_CHARS = 500

/** Truncates to a character budget, marking the cut with an ellipsis. */
export function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/**
 * Serialized size in UTF-8 bytes. Byte budgets and character caps are deliberately
 * different units: caps are a readability limit, budgets track real transfer size.
 */
export function measureBytes(value: JsonObject): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

/** Creates the trimming variant of RESPONSE_TOO_LARGE. */
export function tooLargeAfterTrimming(degraded?: string): SentryApiError {
  return new SentryApiError(
    `Sentry event was too large to summarize even after trimming (degraded: ${degraded ?? 'none'}).`,
    { code: 'RESPONSE_TOO_LARGE' },
  )
}

/** Throws when a trimmed payload still exceeds the tool result budget. */
export function assertWithinBudget(data: JsonObject, degraded?: string): void {
  if (measureBytes(data) <= MAX_TOOL_RESULT_BYTES) return
  throw tooLargeAfterTrimming(degraded)
}

/** Assigns a value only when it is neither undefined nor null, keeping payloads clean. */
export function putIfPresent(target: JsonObject, key: string, value: JsonValue | undefined): void {
  if (value === undefined || value === null) return
  target[key] = value
}

/** Type guard for plain JSON objects. */
export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Narrows a JSON value to an object, or throws INVALID_RESPONSE. */
export function asObject(raw: JsonValue): JsonObject {
  if (!isJsonObject(raw)) throw invalidResponse()
  return raw
}

/** Narrows a JSON value to an array, or throws INVALID_RESPONSE. */
export function asArray(raw: JsonValue): JsonValue[] {
  if (!Array.isArray(raw)) throw invalidResponse()
  return raw
}

/** Creates the INVALID_RESPONSE error shared by every trim function. */
export function invalidResponse(): SentryApiError {
  return new SentryApiError('Sentry returned an unexpected response.', { code: 'INVALID_RESPONSE' })
}
