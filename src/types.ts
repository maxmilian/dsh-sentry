import type { JsonValue as DshJsonValue } from '@deepseek-ai/dsh-tools'

/** The canonical lossless JSON value accepted by DeepSeek Harness tool output. */
export type JsonValue = DshJsonValue

/** A JSON object with string keys. */
export type JsonObject = { [key: string]: JsonValue }

/** Metadata derived purely from HTTP response headers. */
export interface TransportMeta {
  /** Opaque cursor for the next page, present only when the Link header advertises more results. */
  readonly nextCursor?: string
  /** Total matching count parsed from the X-Hits header. */
  readonly matchingCount?: number
  /** True when more results exist but the calling tool exposes no cursor parameter. */
  readonly hasMore?: boolean
}

/** Untrimmed transport result returned by every SentryClient method. */
export interface ApiResult {
  readonly data: JsonValue
  readonly meta: TransportMeta
}

/** Dynamic-only description of what a trim pass discarded. Zero-valued keys are omitted. */
export interface TrimmedMeta {
  readonly omittedFrames?: number
  readonly omittedExceptionValues?: number
  readonly omittedBreadcrumbs?: number
  readonly omittedTags?: number
  readonly eventProcessingErrors?: number
  readonly exceptionSource?: 'threads'
  readonly degraded?: 'source_context' | 'breadcrumbs' | 'frames'
}

/** Result of a pure trim pass. `data` is always an object. */
export interface TrimResult {
  readonly data: JsonObject
  readonly trimmed?: TrimmedMeta
  readonly truncated?: boolean
}
