import { isSecretName } from './secret-terms.js'
import { asObject, isJsonObject, putIfPresent, TITLE_CHARS, truncate } from './trim-shared.js'
import type { JsonObject, JsonValue, TrimmedMeta } from './types.js'

const EXCEPTION_VALUE_CHARS = 2000
const SOURCE_LINE_CHARS = 200
const SOURCE_CONTEXT_LINES = 11
const SOURCE_CONTEXT_FRAMES = 3
const TAG_KEY_CHARS = 64
const TAG_VALUE_CHARS = 200
const BREADCRUMB_MESSAGE_CHARS = 200
const REQUEST_URL_CHARS = 500
const MAX_TAGS = 30
const MAX_BREADCRUMBS = 20
const MAX_EXCEPTION_VALUES = 2
const TAIL_FRAMES = 2

const CONTEXT_WHITELIST = ['runtime', 'os', 'browser', 'device', 'trace'] as const
const TRACE_FIELDS = ['trace_id', 'span_id', 'op'] as const
const CONTEXT_FIELDS = ['type', 'name', 'version'] as const
const LIFTED_TAGS = ['release', 'environment', 'level'] as const
const FRAME_FIELDS = [
  'filename',
  'module',
  'function',
  'lineNo',
  'colNo',
  'inApp',
  'package',
] as const
const MECHANISM_FIELDS = ['type', 'handled', 'synthetic'] as const
const BREADCRUMB_FIELDS = ['timestamp', 'type', 'category', 'level'] as const
const TOP_FIELDS = [
  'id',
  'eventID',
  'groupID',
  'projectID',
  'platform',
  'dateCreated',
  'dateReceived',
] as const

/** One rung of the degradation ladder. */
export interface TrimPass {
  readonly maxFrames: number
  readonly includeBreadcrumbs: boolean
  readonly includeSourceContext: boolean
  readonly includeFrameVars: boolean
  readonly degraded?: TrimmedMeta['degraded']
}

/** Options accepted by `trimEvent`. */
export interface TrimEventOptions {
  readonly maxFrames: number
  readonly includeBreadcrumbs: boolean
  readonly includeFrameVars: boolean
  /** Test-only seam for injecting a smaller budget. tools.ts never passes it. */
  readonly maxBytes?: number
}

interface Counters {
  omittedFrames: number
  omittedExceptionValues: number
  omittedBreadcrumbs: number
  omittedTags: number
  eventProcessingErrors: number
  exceptionSource?: 'threads'
}

/** Builds one trimmed event for a single ladder rung. Pure and deterministic. */
export function buildEvent(
  raw: JsonValue,
  options: TrimEventOptions,
  pass: TrimPass,
): { readonly data: JsonObject; readonly trimmed?: TrimmedMeta } {
  const event = asObject(raw)
  const counters: Counters = {
    omittedFrames: 0,
    omittedExceptionValues: 0,
    omittedBreadcrumbs: 0,
    omittedTags: 0,
    eventProcessingErrors: Array.isArray(event.errors) ? event.errors.length : 0,
  }
  const entries = indexEntries(event.entries)
  const data: JsonObject = {}
  for (const field of TOP_FIELDS) putIfPresent(data, field, event[field])
  putIfPresent(data, 'title', truncateTo(event.title, TITLE_CHARS))
  putIfPresent(data, 'message', truncateTo(event.message, TITLE_CHARS))
  putIfPresent(data, 'culprit', truncateTo(event.culprit, TITLE_CHARS))
  putIfPresent(data, 'sdk', trimSdk(event.sdk))
  putIfPresent(data, 'user', trimUser(event.user))
  data.tags = applyLiftedTags(data, event.tags, counters)
  data.contexts = trimContexts(event.contexts)
  putIfPresent(data, 'exception', buildException(entries, options, pass, counters))
  if (pass.includeBreadcrumbs) {
    putIfPresent(data, 'breadcrumbs', trimBreadcrumbs(entries.get('breadcrumbs'), counters))
  } else {
    counters.omittedBreadcrumbs = countBreadcrumbs(entries.get('breadcrumbs'))
  }
  putIfPresent(data, 'request', trimRequest(entries.get('request')))
  return { data, trimmed: collectTrimmed(counters, pass.degraded) }
}

function indexEntries(value: JsonValue | undefined): Map<string, JsonValue> {
  const entries = new Map<string, JsonValue>()
  if (!Array.isArray(value)) return entries
  for (const entry of value) {
    if (!isJsonObject(entry) || typeof entry.type !== 'string') continue
    if (!entries.has(entry.type) && entry.data !== undefined) entries.set(entry.type, entry.data)
  }
  return entries
}

function buildException(
  entries: Map<string, JsonValue>,
  options: TrimEventOptions,
  pass: TrimPass,
  counters: Counters,
): JsonValue | undefined {
  const values = readExceptionValues(entries, counters)
  if (values.length === 0) return undefined
  const kept = values.slice(Math.max(0, values.length - MAX_EXCEPTION_VALUES))
  counters.omittedExceptionValues = values.length - kept.length
  return { values: kept.map((value) => trimExceptionValue(value, options, pass, counters)) }
}

function readExceptionValues(entries: Map<string, JsonValue>, counters: Counters): JsonValue[] {
  const exception = entries.get('exception')
  const fromException = isJsonObject(exception) ? exception.values : undefined
  if (Array.isArray(fromException) && fromException.length > 0) return fromException
  const thread = pickCrashedThread(entries.get('threads'))
  if (!thread) return []
  counters.exceptionSource = 'threads'
  const value: JsonObject = { stacktrace: thread.stacktrace ?? { frames: [] } }
  putIfPresent(value, 'type', thread.name)
  return [value]
}

function pickCrashedThread(value: JsonValue | undefined): JsonObject | undefined {
  const values = isJsonObject(value) ? value.values : undefined
  if (!Array.isArray(values)) return undefined
  const threads = values.filter(isJsonObject)
  return threads.find((thread) => thread.crashed === true) ?? threads[0]
}

function trimExceptionValue(
  raw: JsonValue,
  options: TrimEventOptions,
  pass: TrimPass,
  counters: Counters,
): JsonValue {
  const value = isJsonObject(raw) ? raw : {}
  const trimmed: JsonObject = {}
  putIfPresent(trimmed, 'type', value.type)
  putIfPresent(trimmed, 'value', truncateTo(value.value, EXCEPTION_VALUE_CHARS))
  putIfPresent(trimmed, 'mechanism', trimMechanism(value.mechanism))
  trimmed.stacktrace = trimStacktrace(value.stacktrace, options, pass, counters)
  return trimmed
}

function trimMechanism(value: JsonValue | undefined): JsonValue | undefined {
  if (!isJsonObject(value)) return undefined
  const mechanism: JsonObject = {}
  for (const field of MECHANISM_FIELDS) putIfPresent(mechanism, field, value[field])
  return Object.keys(mechanism).length > 0 ? mechanism : undefined
}

function trimStacktrace(
  value: JsonValue | undefined,
  options: TrimEventOptions,
  pass: TrimPass,
  counters: Counters,
): JsonValue {
  const frames =
    isJsonObject(value) && Array.isArray(value.frames) ? value.frames.filter(isJsonObject) : []
  const kept = selectFrames(frames, pass.maxFrames)
  counters.omittedFrames += frames.length - kept.length
  const contextIndexes = pickContextFrames(kept, pass.includeSourceContext)
  return {
    frames: kept.map((frame, index) => trimFrame(frame, options, pass, contextIndexes.has(index))),
  }
}

/** Keeps in-app frames plus the two innermost frames, then fills from the tail. */
export function selectFrames(frames: JsonObject[], maxFrames: number): JsonObject[] {
  if (frames.length <= maxFrames) return frames
  const kept = new Set<number>()
  frames.forEach((frame, index) => {
    if (frame.inApp === true) kept.add(index)
  })
  for (let index = Math.max(0, frames.length - TAIL_FRAMES); index < frames.length; index += 1) {
    kept.add(index)
  }
  const candidates = [...kept].sort((a, b) => a - b)
  if (candidates.length >= maxFrames) {
    return candidates
      .slice(candidates.length - maxFrames)
      .map((index) => frames[index] as JsonObject)
  }
  for (let index = frames.length - 1; index >= 0 && kept.size < maxFrames; index -= 1) {
    kept.add(index)
  }
  return [...kept].sort((a, b) => a - b).map((index) => frames[index] as JsonObject)
}

function pickContextFrames(frames: JsonObject[], enabled: boolean): ReadonlySet<number> {
  const indexes = new Set<number>()
  if (!enabled) return indexes
  for (
    let index = frames.length - 1;
    index >= 0 && indexes.size < SOURCE_CONTEXT_FRAMES;
    index -= 1
  ) {
    if (frames[index]?.inApp === true) indexes.add(index)
  }
  return indexes
}

function trimFrame(
  frame: JsonObject,
  options: TrimEventOptions,
  pass: TrimPass,
  withContext: boolean,
): JsonValue {
  const trimmed: JsonObject = {}
  for (const field of FRAME_FIELDS) putIfPresent(trimmed, field, frame[field])
  if (withContext) putIfPresent(trimmed, 'context', selectContext(frame))
  if (options.includeFrameVars && pass.includeFrameVars) putIfPresent(trimmed, 'vars', frame.vars)
  return trimmed
}

/** Takes the source window around the frame line, or the first lines when there is none. */
export function selectContext(frame: JsonObject): JsonValue | undefined {
  const context = frame.context
  if (!Array.isArray(context) || context.length === 0) return undefined
  const lineNo = typeof frame.lineNo === 'number' ? frame.lineNo : undefined
  const window =
    lineNo === undefined ? context.slice(0, SOURCE_CONTEXT_LINES) : centerOn(context, lineNo)
  return window.map(truncateSourceLine)
}

function centerOn(context: JsonValue[], lineNo: number): JsonValue[] {
  if (context.length <= SOURCE_CONTEXT_LINES) return context
  const half = Math.floor(SOURCE_CONTEXT_LINES / 2)
  const found = context.findIndex((entry) => Array.isArray(entry) && entry[0] === lineNo)
  const center = found >= 0 ? found : Math.floor(context.length / 2)
  const start = Math.min(Math.max(0, center - half), context.length - SOURCE_CONTEXT_LINES)
  return context.slice(start, start + SOURCE_CONTEXT_LINES)
}

function truncateSourceLine(entry: JsonValue): JsonValue {
  if (!Array.isArray(entry) || typeof entry[1] !== 'string') return entry
  return [entry[0] ?? null, truncate(entry[1], SOURCE_LINE_CHARS)]
}

function applyLiftedTags(
  data: JsonObject,
  raw: JsonValue | undefined,
  counters: Counters,
): JsonValue {
  const tags = Array.isArray(raw) ? raw.filter(isJsonObject) : []
  const remaining: JsonValue[] = []
  for (const tag of tags) {
    const pair = readTagPair(tag)
    if (!pair) continue
    if ((LIFTED_TAGS as readonly string[]).includes(pair.key)) {
      putIfPresent(data, pair.key, pair.value)
    } else if (isDroppableTagKey(pair.key)) {
      counters.omittedTags += 1
    } else {
      remaining.push({
        key: truncate(pair.key, TAG_KEY_CHARS),
        value: truncate(pair.value, TAG_VALUE_CHARS),
      })
    }
  }
  if (remaining.length > MAX_TAGS) counters.omittedTags += remaining.length - MAX_TAGS
  return remaining.slice(0, MAX_TAGS)
}

function readTagPair(tag: JsonObject): { key: string; value: string } | undefined {
  const { key, value } = tag
  if (typeof key !== 'string' || !key || typeof value !== 'string') return undefined
  return { key, value }
}

function isDroppableTagKey(key: string): boolean {
  return key.startsWith('sentry:') || isSecretName(key)
}

function trimContexts(raw: JsonValue | undefined): JsonValue {
  const contexts: JsonObject = {}
  if (!isJsonObject(raw)) return contexts
  for (const name of CONTEXT_WHITELIST) {
    const value = raw[name]
    if (!isJsonObject(value)) continue
    const trimmed: JsonObject = {}
    const fields = name === 'trace' ? [...CONTEXT_FIELDS, ...TRACE_FIELDS] : CONTEXT_FIELDS
    for (const field of fields) putIfPresent(trimmed, field, value[field])
    if (Object.keys(trimmed).length > 0) contexts[name] = trimmed
  }
  return contexts
}

function trimBreadcrumbs(raw: JsonValue | undefined, counters: Counters): JsonValue | undefined {
  const values = isJsonObject(raw) ? raw.values : undefined
  if (!Array.isArray(values) || values.length === 0) return undefined
  const kept = values.slice(Math.max(0, values.length - MAX_BREADCRUMBS)).filter(isJsonObject)
  counters.omittedBreadcrumbs = values.length - kept.length
  return kept.map((crumb) => {
    const trimmed: JsonObject = {}
    for (const field of BREADCRUMB_FIELDS) putIfPresent(trimmed, field, crumb[field])
    putIfPresent(trimmed, 'message', truncateTo(crumb.message, BREADCRUMB_MESSAGE_CHARS))
    return trimmed
  })
}

function countBreadcrumbs(raw: JsonValue | undefined): number {
  const values = isJsonObject(raw) ? raw.values : undefined
  return Array.isArray(values) ? values.length : 0
}

function trimRequest(raw: JsonValue | undefined): JsonValue | undefined {
  if (!isJsonObject(raw)) return undefined
  const request: JsonObject = {}
  putIfPresent(request, 'method', raw.method)
  putIfPresent(request, 'url', stripQuery(raw.url))
  return Object.keys(request).length > 0 ? request : undefined
}

function stripQuery(value: JsonValue | undefined): JsonValue | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value)
    return truncate(`${url.origin}${url.pathname}`, REQUEST_URL_CHARS)
  } catch {
    return undefined
  }
}

function trimSdk(raw: JsonValue | undefined): JsonValue | undefined {
  if (!isJsonObject(raw)) return undefined
  const sdk: JsonObject = {}
  putIfPresent(sdk, 'name', raw.name)
  putIfPresent(sdk, 'version', raw.version)
  return Object.keys(sdk).length > 0 ? sdk : undefined
}

function trimUser(raw: JsonValue | undefined): JsonValue | undefined {
  const id = isJsonObject(raw) ? raw.id : undefined
  return id === undefined || id === null ? undefined : { id }
}

function truncateTo(value: JsonValue | undefined, max: number): JsonValue | undefined {
  return typeof value === 'string' ? truncate(value, max) : undefined
}

function collectTrimmed(
  counters: Counters,
  degraded?: TrimmedMeta['degraded'],
): TrimmedMeta | undefined {
  const trimmed: Record<string, number | string> = {}
  const numbers = {
    omittedFrames: counters.omittedFrames,
    omittedExceptionValues: counters.omittedExceptionValues,
    omittedBreadcrumbs: counters.omittedBreadcrumbs,
    omittedTags: counters.omittedTags,
    eventProcessingErrors: counters.eventProcessingErrors,
  }
  for (const [key, value] of Object.entries(numbers)) {
    if (value > 0) trimmed[key] = value
  }
  if (counters.exceptionSource) trimmed.exceptionSource = counters.exceptionSource
  if (degraded) trimmed.degraded = degraded
  return Object.keys(trimmed).length > 0 ? (trimmed as TrimmedMeta) : undefined
}
