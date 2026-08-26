import type { TrimEventOptions, TrimPass } from './trim-event.js'
import { buildEvent } from './trim-event.js'
import {
  asArray,
  asObject,
  assertWithinBudget,
  isJsonObject,
  MAX_TOOL_RESULT_BYTES,
  measureBytes,
  putIfPresent,
  TITLE_CHARS,
  tooLargeAfterTrimming,
  truncate,
} from './trim-shared.js'
import type { JsonObject, JsonValue, TrimResult } from './types.js'

export type { TrimEventOptions }
export { MAX_TOOL_RESULT_BYTES, measureBytes, TITLE_CHARS, truncate }

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

/** Frame cap used by the last rung of the degradation ladder. */
const DEGRADED_MAX_FRAMES = 10

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

/** Reduces one event payload, degrading in fixed steps until it fits the byte budget. */
export function trimEvent(raw: JsonValue, options: TrimEventOptions): TrimResult {
  const budget = options.maxBytes ?? MAX_TOOL_RESULT_BYTES
  for (const pass of degradationLadder(options)) {
    const built = buildEvent(raw, options, pass)
    if (measureBytes(built.data) <= budget) {
      return built.trimmed ? { data: built.data, trimmed: built.trimmed } : { data: built.data }
    }
  }
  throw tooLargeAfterTrimming('frames')
}

/**
 * Each rung rebuilds from the raw event rather than mutating the previous result, so the
 * omitted counters are always "original total minus final kept" with no accumulation.
 */
function degradationLadder(options: TrimEventOptions): readonly TrimPass[] {
  return [
    {
      maxFrames: options.maxFrames,
      includeBreadcrumbs: options.includeBreadcrumbs,
      includeSourceContext: true,
    },
    {
      maxFrames: options.maxFrames,
      includeBreadcrumbs: options.includeBreadcrumbs,
      includeSourceContext: false,
      degraded: 'source_context',
    },
    {
      maxFrames: options.maxFrames,
      includeBreadcrumbs: false,
      includeSourceContext: false,
      degraded: 'breadcrumbs',
    },
    {
      maxFrames: DEGRADED_MAX_FRAMES,
      includeBreadcrumbs: false,
      includeSourceContext: false,
      degraded: 'frames',
    },
  ]
}
