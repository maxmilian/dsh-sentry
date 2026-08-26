import { describe, expect, it } from 'vitest'

import type { SentryApiError } from '../src/errors.js'
import { MAX_TOOL_RESULT_BYTES, trimIssue, trimIssueList, trimProjectList } from '../src/trim.js'
import type { JsonValue } from '../src/types.js'
import rawIssueDetail from './fixtures/issue-detail.json' with { type: 'json' }
import rawIssuesList from './fixtures/issues-list.json' with { type: 'json' }
import rawProjectsList from './fixtures/projects-list.json' with { type: 'json' }

// JSON imports infer literal types without an index signature, so they need one cast.
const issueDetail = rawIssueDetail as unknown as JsonValue
const issuesList = rawIssuesList as unknown as JsonValue
const projectsList = rawProjectsList as unknown as JsonValue

function caught(run: () => unknown): SentryApiError | undefined {
  try {
    run()
    return undefined
  } catch (thrown) {
    return thrown as SentryApiError
  }
}

describe('trimProjectList', () => {
  it('wraps the array in an object and keeps only whitelisted fields', () => {
    const { data } = trimProjectList(projectsList)
    const projects = (data as { projects: Record<string, unknown>[] }).projects

    expect(Array.isArray(projects)).toBe(true)
    expect(Object.keys(projects[0] ?? {}).sort()).toEqual([
      'dateCreated',
      'firstEvent',
      'id',
      'isMember',
      'name',
      'platform',
      'slug',
      'status',
      'teams',
    ])
    expect(projects[0]?.teams).toEqual(['frontend'])
    expect(JSON.stringify(data)).not.toContain('latestDeploys')
    expect(JSON.stringify(data)).not.toContain('avatarType')
  })

  it('omits absent optional fields instead of emitting null', () => {
    const projects = (
      trimProjectList(projectsList).data as {
        projects: Record<string, unknown>[]
      }
    ).projects

    expect(projects[1]).not.toHaveProperty('firstEvent')
  })

  it('reports truncation only when the caller saw more pages', () => {
    expect(trimProjectList(projectsList, true).truncated).toBe(true)
    expect(trimProjectList(projectsList, false).truncated).toBeUndefined()
  })
})

describe('trimIssueList', () => {
  it('wraps issues in an object and drops the stats time series', () => {
    const { data } = trimIssueList(issuesList)
    const issues = (data as { issues: Record<string, unknown>[] }).issues

    expect(issues).toHaveLength(2)
    expect(JSON.stringify(data)).not.toContain('"stats"')
    expect(JSON.stringify(data)).not.toContain('subscriptionDetails')
    expect(JSON.stringify(data)).not.toContain('seerFixabilityScore')
    expect(JSON.stringify(data)).not.toContain('annotations')
  })

  it('truncates the title and metadata value to 500 characters', () => {
    const issues = (
      trimIssueList(issuesList).data as {
        issues: { title: string; metadata: { value: string } }[]
      }
    ).issues

    expect(issues[0]?.title).toHaveLength(501)
    expect(issues[0]?.title.endsWith('…')).toBe(true)
    expect(issues[0]?.metadata.value).toHaveLength(501)
  })

  it('keeps only type and name from assignedTo', () => {
    const issues = (
      trimIssueList(issuesList).data as {
        issues: { assignedTo?: Record<string, unknown> }[]
      }
    ).issues

    expect(issues[0]?.assignedTo).toEqual({ type: 'user', name: 'Ada' })
    expect(JSON.stringify(issues)).not.toContain('ada@example.com')
  })

  it('survives issues without substatus, priority, or isUnhandled', () => {
    const issues = (trimIssueList(issuesList).data as { issues: Record<string, unknown>[] }).issues

    expect(issues[1]).not.toHaveProperty('substatus')
    expect(issues[1]).not.toHaveProperty('priority')
    expect(issues[1]).not.toHaveProperty('assignedTo')
  })

  it('rejects a non-array payload', () => {
    expect(caught(() => trimIssueList({ nope: true }))?.code).toBe('INVALID_RESPONSE')
  })
})

describe('trimIssue', () => {
  it('summarizes releases and counts participants without leaking emails', () => {
    const data = trimIssue(issueDetail).data as Record<string, unknown>

    expect(data.firstRelease).toBe('1.0.0')
    expect(data.lastRelease).toBe('1.2.0')
    expect(data.participantCount).toBe(3)
    expect(data.seenByCount).toBe(2)
    expect(data.activity).toHaveLength(3)
    expect(JSON.stringify(data)).not.toContain('@example.com')
    expect(JSON.stringify(data)).not.toContain('"stats"')
    expect(JSON.stringify(data)).not.toContain('pluginIssues')
  })

  it('keeps only type and dateCreated on each activity entry', () => {
    const data = trimIssue(issueDetail).data as { activity: Record<string, unknown>[] }

    expect(Object.keys(data.activity[0] ?? {}).sort()).toEqual(['dateCreated', 'type'])
  })
})

describe('byte budget', () => {
  it('throws the trimming variant of RESPONSE_TOO_LARGE for oversized non-event output', () => {
    const huge = Array.from({ length: 4_000 }, (_value, index) => ({
      id: String(index),
      shortId: `PROJ-${index}`,
      title: 'x'.repeat(400),
      culprit: 'y'.repeat(400),
    }))

    const error = caught(() => trimIssueList(huge))

    expect(error?.code).toBe('RESPONSE_TOO_LARGE')
    expect(error?.message).toContain('too large to summarize')
    expect(error?.message).not.toContain('configured maximum')
  })

  it('measures bytes rather than characters', () => {
    // 150 issues x 500 CJK characters = 75k characters but 225k UTF-8 bytes.
    // Counting characters would keep this under the budget; counting bytes must not.
    const cjk = Array.from({ length: 150 }, (_value, index) => ({
      id: String(index),
      shortId: `P-${index}`,
      title: '錯'.repeat(500),
    }))
    const raw = JSON.stringify(cjk)

    expect(raw.length).toBeLessThan(MAX_TOOL_RESULT_BYTES)
    expect(Buffer.byteLength(raw, 'utf8')).toBeGreaterThan(MAX_TOOL_RESULT_BYTES)
    expect(caught(() => trimIssueList(cjk))?.code).toBe('RESPONSE_TOO_LARGE')
  })
})
