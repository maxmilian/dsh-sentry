import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

import type { SentryClient } from './client.js'
import type { Locale } from './config.js'
import { TOOL_I18N } from './locales.js'
import { trimEvent, trimIssue, trimIssueList, trimProjectList } from './trim.js'
import type { JsonObject, JsonValue, TrimmedMeta } from './types.js'

const STATS_PERIODS = ['24h', '14d'] as const
const SORT_ORDERS = ['date', 'new', 'freq', 'user', 'recommended'] as const
const DEFAULT_MAX_FRAMES = 20

/** Shared output contract: `data` is always an object, every `meta` field is optional. */
export const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    data: { type: 'json', required: true },
    meta: {
      type: 'object',
      additionalProperties: false,
      required: true,
      properties: {
        nextCursor: { type: 'string' },
        matchingCount: { type: 'integer' },
        truncated: { type: 'boolean' },
        trimmed: { type: 'json' },
      },
    },
  },
} as const

type ToolText = (typeof TOOL_I18N)[Locale]

/** Registers all read-only Sentry tools on a DSH tools service. */
export function registerSentryTools(
  ctx: Context,
  client: SentryClient,
  locale: Locale,
  includeFrameVars: boolean,
): void {
  const text = TOOL_I18N[locale]
  registerListProjects(ctx, client, text)
  registerSearchIssues(ctx, client, text)
  registerGetIssue(ctx, client, text)
  registerGetLatestEvent(ctx, client, text, includeFrameVars)
  registerGetEvent(ctx, client, text, includeFrameVars)
}

function registerListProjects(ctx: Context, client: SentryClient, text: ToolText): void {
  ctx.tools.register(
    defineTool({
      name: 'sentry_list_projects',
      description: text.sentry_list_projects.description,
      parameters: {},
      output: { schema: OUTPUT_SCHEMA, render: renderJson },
      execute: async (_args, exec) => {
        const result = await client.listProjects(exec.signal)
        const trimmed = trimProjectList(result.data, result.meta.hasMore)
        return { data: trimmed.data, meta: pickMeta({ truncated: trimmed.truncated }) }
      },
      isConcurrencySafe: () => true,
    }),
  )
}

function registerSearchIssues(ctx: Context, client: SentryClient, text: ToolText): void {
  const params = text.sentry_search_issues.params
  ctx.tools.register(
    defineTool({
      name: 'sentry_search_issues',
      description: text.sentry_search_issues.description,
      parameters: {
        project_slug: { type: 'string', description: params.project_slug },
        query: { type: 'string', description: params.query },
        stats_period: { type: 'string', enum: STATS_PERIODS, description: params.stats_period },
        sort: { type: 'string', enum: SORT_ORDERS, description: params.sort },
        environment: { type: 'string', description: params.environment },
        limit: { type: 'integer', description: params.limit },
        cursor: { type: 'string', description: params.cursor },
      },
      output: { schema: OUTPUT_SCHEMA, render: renderJson },
      execute: async (args, exec) => {
        const result = await client.searchIssues(
          {
            projectSlug: args.project_slug,
            query: args.query,
            statsPeriod: args.stats_period,
            sort: args.sort,
            environment: args.environment,
            limit: args.limit,
            cursor: args.cursor,
          },
          exec.signal,
        )
        const trimmed = trimIssueList(result.data)
        return {
          data: trimmed.data,
          meta: pickMeta({
            nextCursor: result.meta.nextCursor,
            matchingCount: result.meta.matchingCount,
          }),
        }
      },
      isConcurrencySafe: () => true,
    }),
  )
}

function registerGetIssue(ctx: Context, client: SentryClient, text: ToolText): void {
  ctx.tools.register(
    defineTool({
      name: 'sentry_get_issue',
      description: text.sentry_get_issue.description,
      parameters: {
        issue: { type: 'string', required: true, description: text.sentry_get_issue.params.issue },
      },
      output: { schema: OUTPUT_SCHEMA, render: renderJson },
      execute: async (args, exec) => {
        const result = await client.getIssue(args.issue, exec.signal)
        return { data: trimIssue(result.data).data, meta: pickMeta({}) }
      },
      isConcurrencySafe: () => true,
    }),
  )
}

function registerGetLatestEvent(
  ctx: Context,
  client: SentryClient,
  text: ToolText,
  includeFrameVars: boolean,
): void {
  const params = text.sentry_get_latest_event.params
  ctx.tools.register(
    defineTool({
      name: 'sentry_get_latest_event',
      description: text.sentry_get_latest_event.description,
      parameters: {
        issue: { type: 'string', required: true, description: params.issue },
        max_frames: { type: 'integer', description: params.max_frames },
        include_breadcrumbs: { type: 'boolean', description: params.include_breadcrumbs },
      },
      output: { schema: OUTPUT_SCHEMA, render: renderJson },
      execute: async (args, exec) => {
        const result = await client.getLatestEvent(args.issue, exec.signal)
        return renderEvent(result.data, args, includeFrameVars)
      },
      isConcurrencySafe: () => true,
    }),
  )
}

function registerGetEvent(
  ctx: Context,
  client: SentryClient,
  text: ToolText,
  includeFrameVars: boolean,
): void {
  const params = text.sentry_get_event.params
  ctx.tools.register(
    defineTool({
      name: 'sentry_get_event',
      description: text.sentry_get_event.description,
      parameters: {
        project_slug: { type: 'string', required: true, description: params.project_slug },
        event_id: { type: 'string', required: true, description: params.event_id },
        max_frames: { type: 'integer', description: params.max_frames },
        include_breadcrumbs: { type: 'boolean', description: params.include_breadcrumbs },
      },
      output: { schema: OUTPUT_SCHEMA, render: renderJson },
      execute: async (args, exec) => {
        const result = await client.getEvent(args.project_slug, args.event_id, exec.signal)
        return renderEvent(result.data, args, includeFrameVars)
      },
      isConcurrencySafe: () => true,
    }),
  )
}

interface EventArgs {
  readonly max_frames?: number
  readonly include_breadcrumbs?: boolean
}

function renderEvent(
  raw: JsonValue,
  args: EventArgs,
  includeFrameVars: boolean,
): { data: JsonObject; meta: JsonObject } {
  const trimmed = trimEvent(raw, {
    maxFrames: args.max_frames ?? DEFAULT_MAX_FRAMES,
    includeBreadcrumbs: args.include_breadcrumbs ?? true,
    includeFrameVars,
  })
  return { data: trimmed.data, meta: pickMeta({ trimmed: trimmed.trimmed }) }
}

interface MetaCandidate {
  readonly nextCursor?: string
  readonly matchingCount?: number
  readonly truncated?: boolean
  readonly trimmed?: TrimmedMeta
}

/** Drops undefined entries so the additionalProperties:false schema never sees a stray key. */
function pickMeta(candidate: MetaCandidate): JsonObject {
  const meta: JsonObject = {}
  if (candidate.nextCursor !== undefined) meta.nextCursor = candidate.nextCursor
  if (candidate.matchingCount !== undefined) meta.matchingCount = candidate.matchingCount
  if (candidate.truncated !== undefined) meta.truncated = candidate.truncated
  if (candidate.trimmed !== undefined) meta.trimmed = candidate.trimmed as JsonObject
  return meta
}

function renderJson(_args: unknown, value: JsonValue) {
  return [{ type: 'text' as const, text: JSON.stringify(value) }]
}
