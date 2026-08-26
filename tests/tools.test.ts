import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'

import type { SentryClient } from '../src/client.js'
import { OUTPUT_SCHEMA, registerSentryTools } from '../src/tools.js'

const RAW_ISSUE_LIST = [
  {
    id: '1',
    shortId: 'PROJ-1',
    title: 'boom',
    stats: { '24h': Array.from({ length: 336 }, (_value, index) => [index, index]) },
  },
]

function register(clientOverrides: Partial<SentryClient>): Map<string, ToolDefinition> {
  const tools = new Map<string, ToolDefinition>()
  const ctx = {
    tools: { register: (tool: ToolDefinition) => tools.set(tool.name, tool) },
  } as unknown as Context
  registerSentryTools(ctx, clientOverrides as SentryClient, 'en', false)
  return tools
}

async function run(tool: ToolDefinition, args: Record<string, unknown>) {
  const signal = new AbortController().signal
  return (await tool.execute(args as never, { signal } as never)) as {
    data: Record<string, unknown>
    meta: Record<string, unknown>
  }
}

function toolOf(tools: Map<string, ToolDefinition>, name: string): ToolDefinition {
  const tool = tools.get(name)
  if (!tool) throw new Error(`tool ${name} was not registered`)
  return tool
}

describe('registerSentryTools', () => {
  it('registers exactly the five read-only tools', () => {
    const tools = register({ listProjects: vi.fn() })
    expect([...tools.keys()].sort()).toEqual([
      'sentry_get_event',
      'sentry_get_issue',
      'sentry_get_latest_event',
      'sentry_list_projects',
      'sentry_search_issues',
    ])
  })

  it('marks every tool concurrency safe, schema-shared, and without presentCall', () => {
    for (const tool of register({ listProjects: vi.fn() }).values()) {
      expect(tool.isConcurrencySafe?.({})).toBe(true)
      expect(tool.output?.schema).toBe(OUTPUT_SCHEMA)
      expect(tool.presentCall).toBeUndefined()
    }
  })

  it('trims the client payload instead of forwarding it', async () => {
    const searchIssues = vi.fn().mockResolvedValue({ data: RAW_ISSUE_LIST, meta: {} })
    const tools = register({ searchIssues })
    const result = await run(toolOf(tools, 'sentry_search_issues'), {})

    expect(JSON.stringify(result.data)).not.toContain('"stats"')
    expect(result.data).toHaveProperty('issues')
  })

  it('merges cursor and hit metadata from the client', async () => {
    const searchIssues = vi.fn().mockResolvedValue({
      data: [],
      meta: { nextCursor: '0:100:0', matchingCount: 9, hasMore: true },
    })
    const tools = register({ searchIssues })
    const result = await run(toolOf(tools, 'sentry_search_issues'), {})

    expect(result.meta).toEqual({ nextCursor: '0:100:0', matchingCount: 9 })
  })

  it('translates hasMore into truncated and hides the cursor for projects', async () => {
    const listProjects = vi
      .fn()
      .mockResolvedValue({ data: [], meta: { nextCursor: '0:100:0', hasMore: true } })
    const tools = register({ listProjects })
    const result = await run(toolOf(tools, 'sentry_list_projects'), {})

    expect(result.meta).toEqual({ truncated: true })
  })

  it('emits no meta keys outside the schema', async () => {
    const getIssue = vi.fn().mockResolvedValue({ data: { id: '1' }, meta: { nextCursor: 'x' } })
    const tools = register({ getIssue })
    const result = await run(toolOf(tools, 'sentry_get_issue'), { issue: '1' })

    expect(Object.keys(result.meta)).toEqual([])
  })

  it('passes the abort signal through to the client', async () => {
    const getIssue = vi.fn().mockResolvedValue({ data: { id: '1' }, meta: {} })
    const tools = register({ getIssue })
    await run(toolOf(tools, 'sentry_get_issue'), { issue: '1' })

    expect(getIssue).toHaveBeenCalledWith('1', expect.any(AbortSignal))
  })

  it('forwards event tool parameters to the client and the trimmer', async () => {
    const getEvent = vi.fn().mockResolvedValue({
      data: { id: '1', eventID: 'a', entries: [], tags: [], contexts: {} },
      meta: {},
    })
    const tools = register({ getEvent })
    await run(toolOf(tools, 'sentry_get_event'), {
      project_slug: 'web-app',
      event_id: 'a'.repeat(32),
      max_frames: 5,
      include_breadcrumbs: false,
    })

    expect(getEvent).toHaveBeenCalledWith('web-app', 'a'.repeat(32), expect.any(AbortSignal))
  })

  it('lets trimming errors escape', async () => {
    const searchIssues = vi.fn().mockResolvedValue({ data: { notAnArray: true }, meta: {} })
    const tools = register({ searchIssues })

    await expect(run(toolOf(tools, 'sentry_search_issues'), {})).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    })
  })

  it('forwards trimmed metadata from the event tools', async () => {
    const getLatestEvent = vi.fn().mockResolvedValue({
      data: { id: '1', eventID: 'a', entries: [], tags: [], contexts: {}, errors: [1, 2] },
      meta: {},
    })
    const tools = register({ getLatestEvent })
    const result = await run(toolOf(tools, 'sentry_get_latest_event'), { issue: '1' })

    expect(result.meta.trimmed).toMatchObject({ eventProcessingErrors: 2 })
  })
})
