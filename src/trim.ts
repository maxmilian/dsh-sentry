import { SentryApiError } from './errors.js'
import type { JsonObject, JsonValue, TrimResult } from './types.js'

/** Maximum serialized size of one tool result, in UTF-8 bytes. */
export const MAX_TOOL_RESULT_BYTES = 200_000

/** Character cap for titles, messages, culprits, and issue metadata values. */
export const TITLE_CHARS = 500

const PROJECT_FIELDS = [
  'id',
  'slug',
  'name',
  'platform',
  'status',
  'dateCreated',
  'isMember',
  'firstEvent',
] as const

const ISSUE_FIELDS = [
  'id',
  'shortId',
  'level',
  'status',
  'substatus',
  'priority',
  'isUnhandled',
  'count',
  'userCount',
  'firstSeen',
  'lastSeen',
  'permalink',
] as const

const MAX_ACTIVITY_ENTRIES = 3

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

/** Throws when a trimmed payload still exceeds the tool result budget. */
export function assertWithinBudget(data: JsonObject, degraded?: string): void {
  if (measureBytes(data) <= MAX_TOOL_RESULT_BYTES) return
  throw tooLargeAfterTrimming(degraded)
}

/** Creates the trimming variant of RESPONSE_TOO_LARGE. */
export function tooLargeAfterTrimming(degraded?: string): SentryApiError {
  return new SentryApiError(
    `Sentry event was too large to summarize even after trimming (degraded: ${degraded ?? 'none'}).`,
    { code: 'RESPONSE_TOO_LARGE' },
  )
}

/** Reduces the organization project list to a small, stable shape. */
export function trimProjectList(raw: JsonValue, hasMore?: boolean): TrimResult {
  const projects = asArray(raw).map(trimProject)
  const data: JsonObject = { projects }
  assertWithinBudget(data)
  return hasMore ? { data, truncated: true } : { data }
}

/** Reduces an issue search result to per-issue summaries. */
export function trimIssueList(raw: JsonValue): TrimResult {
  const issues = asArray(raw).map(trimIssueSummary)
  const data: JsonObject = { issues }
  assertWithinBudget(data)
  return { data }
}

/** Reduces one issue detail payload, adding release and participant summaries. */
export function trimIssue(raw: JsonValue): TrimResult {
  const issue = asObject(raw)
  const data = trimIssueSummary(issue)
  putIfPresent(data, 'firstRelease', releaseVersion(issue.firstRelease))
  putIfPresent(data, 'lastRelease', releaseVersion(issue.lastRelease))
  putIfPresent(data, 'activity', trimActivity(issue.activity))
  putIfPresent(data, 'participantCount', countOf(issue.participants))
  putIfPresent(data, 'seenByCount', countOf(issue.seenBy))
  assertWithinBudget(data)
  return { data }
}

function trimProject(raw: JsonValue): JsonObject {
  const project = asObject(raw)
  const trimmed: JsonObject = {}
  for (const field of PROJECT_FIELDS) putIfPresent(trimmed, field, project[field])
  putIfPresent(trimmed, 'teams', teamSlugs(project.teams))
  return trimmed
}

function teamSlugs(value: JsonValue | undefined): JsonValue | undefined {
  if (!Array.isArray(value)) return undefined
  const slugs = value
    .map((team) => (isJsonObject(team) ? team.slug : undefined))
    .filter((slug): slug is string => typeof slug === 'string')
  return slugs.length > 0 ? slugs : undefined
}

function trimIssueSummary(raw: JsonValue): JsonObject {
  const issue = asObject(raw)
  const trimmed: JsonObject = {}
  for (const field of ISSUE_FIELDS) putIfPresent(trimmed, field, issue[field])
  putIfPresent(trimmed, 'title', truncateField(issue.title))
  putIfPresent(trimmed, 'culprit', truncateField(issue.culprit))
  putIfPresent(trimmed, 'project', projectSlug(issue.project))
  putIfPresent(trimmed, 'metadata', trimMetadata(issue.metadata))
  putIfPresent(trimmed, 'assignedTo', trimAssignee(issue.assignedTo))
  return trimmed
}

function projectSlug(value: JsonValue | undefined): JsonValue | undefined {
  const slug = isJsonObject(value) ? value.slug : undefined
  return typeof slug === 'string' ? { slug } : undefined
}

function trimMetadata(value: JsonValue | undefined): JsonValue | undefined {
  if (!isJsonObject(value)) return undefined
  const metadata: JsonObject = {}
  putIfPresent(metadata, 'type', value.type)
  putIfPresent(metadata, 'value', truncateField(value.value))
  putIfPresent(metadata, 'filename', value.filename)
  return Object.keys(metadata).length > 0 ? metadata : undefined
}

function trimAssignee(value: JsonValue | undefined): JsonValue | undefined {
  if (!isJsonObject(value)) return undefined
  const assignee: JsonObject = {}
  putIfPresent(assignee, 'type', value.type)
  putIfPresent(assignee, 'name', value.name)
  return Object.keys(assignee).length > 0 ? assignee : undefined
}

function trimActivity(value: JsonValue | undefined): JsonValue | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined
  return value.slice(0, MAX_ACTIVITY_ENTRIES).map((entry) => {
    const item: JsonObject = {}
    if (isJsonObject(entry)) {
      putIfPresent(item, 'type', entry.type)
      putIfPresent(item, 'dateCreated', entry.dateCreated)
    }
    return item
  })
}

function releaseVersion(value: JsonValue | undefined): JsonValue | undefined {
  const version = isJsonObject(value) ? value.version : undefined
  return typeof version === 'string' ? version : undefined
}

function countOf(value: JsonValue | undefined): number | undefined {
  return Array.isArray(value) ? value.length : undefined
}

function truncateField(value: JsonValue | undefined): JsonValue | undefined {
  return typeof value === 'string' ? truncate(value, TITLE_CHARS) : undefined
}

/** Assigns a value only when it is neither undefined nor null, keeping payloads clean. */
export function putIfPresent(target: JsonObject, key: string, value: JsonValue | undefined): void {
  if (value === undefined || value === null) return
  target[key] = value
}

/** Narrows a JSON value to an object, or throws INVALID_RESPONSE. */
export function asObject(raw: JsonValue): JsonObject {
  if (!isJsonObject(raw)) throw invalidResponse()
  return raw
}

function asArray(raw: JsonValue): JsonValue[] {
  if (!Array.isArray(raw)) throw invalidResponse()
  return raw
}

/** Type guard for plain JSON objects. */
export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function invalidResponse(): SentryApiError {
  return new SentryApiError('Sentry returned an unexpected response.', { code: 'INVALID_RESPONSE' })
}
