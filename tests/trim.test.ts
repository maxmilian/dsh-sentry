import { describe, expect, it } from 'vitest'

import type { SentryApiError } from '../src/errors.js'
import type { TrimEventOptions } from '../src/trim.js'
import {
  MAX_TOOL_RESULT_BYTES,
  trimEvent,
  trimIssue,
  trimIssueList,
  trimProjectList,
} from '../src/trim.js'
import type { JsonValue } from '../src/types.js'
import rawEventBrowser from './fixtures/event-browser.json' with { type: 'json' }
import rawEventChained from './fixtures/event-chained.json' with { type: 'json' }
import rawEventNode from './fixtures/event-node.json' with { type: 'json' }
import rawEventOversized from './fixtures/event-oversized.json' with { type: 'json' }
import rawEventPython from './fixtures/event-python.json' with { type: 'json' }
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

const eventNode = rawEventNode as unknown as JsonValue
const eventPython = rawEventPython as unknown as JsonValue
const eventBrowser = rawEventBrowser as unknown as JsonValue
const eventChained = rawEventChained as unknown as JsonValue

const BASE: TrimEventOptions = { maxFrames: 20, includeBreadcrumbs: true, includeFrameVars: false }

interface TrimmedFrame {
  readonly inApp?: boolean
  readonly lineNo?: number | null
  readonly context?: [number, string][]
  readonly [key: string]: unknown
}

interface TrimmedEvent {
  readonly release?: string
  readonly environment?: string
  readonly level?: string
  readonly user?: Record<string, unknown>
  readonly tags: { key: string; value: string }[]
  readonly contexts: Record<string, unknown>
  readonly request?: { method: string; url: string }
  readonly exception?: {
    values: {
      value: string
      mechanism?: Record<string, unknown>
      stacktrace: { frames: TrimmedFrame[] }
    }[]
  }
  readonly breadcrumbs?: { message: string }[]
}

function trimNode(overrides: Partial<TrimEventOptions> = {}) {
  const result = trimEvent(eventNode, { ...BASE, ...overrides })
  return { event: result.data as unknown as TrimmedEvent, result }
}

function framesOf(event: TrimmedEvent, index = 0): TrimmedFrame[] {
  return event.exception?.values[index]?.stacktrace.frames ?? []
}

describe('trimEvent security stripping', () => {
  it('removes every secret-bearing field', () => {
    const serialized = JSON.stringify(trimNode().event)

    expect(serialized).not.toContain('SEKRET')
    expect(serialized).not.toContain('user@example.com')
    expect(serialized).not.toContain('ip_address')
    expect(serialized).not.toContain('username')
    expect(serialized).not.toContain('packages')
    expect(serialized).not.toContain('_meta')
    expect(serialized).not.toContain('absPath')
  })

  it('keeps only the user id', () => {
    expect(trimNode().event.user).toEqual({ id: '42' })
  })

  it('strips the query string from the request url', () => {
    expect(trimNode().event.request).toEqual({
      method: 'POST',
      url: 'https://app.example.com/checkout',
    })
  })

  it('reduces mechanism to three fields', () => {
    expect(Object.keys(trimNode().event.exception?.values[0]?.mechanism ?? {}).sort()).toEqual([
      'handled',
      'synthetic',
      'type',
    ])
  })

  it('drops secret-looking tags and counts them', () => {
    const { event, result } = trimNode()

    expect(event.tags.some((tag) => /session_id|auth_token/.test(tag.key))).toBe(false)
    expect(event.tags.some((tag) => tag.key.startsWith('sentry:'))).toBe(false)
    expect(event.tags.length).toBeLessThanOrEqual(30)
    expect(result.trimmed?.omittedTags).toBeGreaterThan(0)
  })

  const SECRET_TAG_BAITS = [
    // separator variants of the compound credential names spelled out in the spec
    'api_key',
    'api-key',
    'api.key',
    'api key',
    'apiKey',
    'private_key',
    'private.key',
    'private key',
    'privateKey',
    'access_key',
    'access.key',
    'access key',
    'accessKey',
    'access_key_id',
    'ssh_key',
    'ssh.key',
    'ssh key',
    'sshKey',
    'signing_key',
    'signing.key',
    'signing key',
    'signingKey',
    'encryption_key',
    'encryption.key',
    'encryptionKey',
    // bare credential words
    'bearer',
    'Bearer',
    'authorization',
    'jwt',
    'dsn',
    'passwd',
    'passphrase',
    'pwd',
    'x-amz-signature',
    'accessToken',
    'apiToken',
    // connection-string style names that embed credentials in their value
    'connection_string',
    'connectionString',
    'database_url',
    'databaseUrl',
    'webhook_url',
    'webhookUrl',
    // PII
    'e.mail',
    'e_mail',
    'eMail',
    'user_email',
    'user.name',
    'user name',
    'userName',
    'user_ip',
    'creditcard',
    'credit_card',
    'creditCard',
    'ssn',
  ]

  it.each(SECRET_TAG_BAITS)('drops the secret-looking tag %s entirely', (key) => {
    const value = `BAIT_${key}_VALUE`
    const adversarial = {
      ...(eventNode as Record<string, unknown>),
      tags: [{ key, value }],
    } as JsonValue
    const serialized = JSON.stringify(trimEvent(adversarial, BASE).data)

    expect(serialized).not.toContain(value)
    expect(serialized).not.toContain(key)
  })

  it('keeps ordinary tags that merely look similar to secret names', () => {
    const safeKeys = ['transaction', 'browser.name', 'server_name', 'url', 'handled', 'mechanism']
    const adversarial = {
      ...(eventNode as Record<string, unknown>),
      tags: safeKeys.map((key) => ({ key, value: `KEEP_${key}` })),
    } as JsonValue
    const serialized = JSON.stringify(trimEvent(adversarial, BASE).data)

    for (const key of safeKeys) expect(serialized).toContain(`KEEP_${key}`)
  })

  it('lifts release, environment, and level to the top level', () => {
    const { event } = trimNode()

    expect(event.release).toBe('1.2.0')
    expect(event.environment).toBe('production')
    expect(event.level).toBe('error')
    expect(event.tags.some((tag) => tag.key === 'release')).toBe(false)
  })

  it('whitelists contexts', () => {
    expect(Object.keys(trimNode().event.contexts).sort()).toEqual(['os', 'runtime', 'trace'])
  })

  it('records the event processing error count', () => {
    expect(trimNode().result.trimmed?.eventProcessingErrors).toBe(2)
  })

  it('includes frame vars only when the config allows it', () => {
    expect(JSON.stringify(trimNode({ includeFrameVars: true }).event)).toContain('SEKRET')
  })
})

describe('trimEvent frame selection', () => {
  it('keeps every frame when the stacktrace is short', () => {
    expect(framesOf(trimNode().event)).toHaveLength(8)
  })

  it('always keeps the two innermost frames even when they are not in-app', () => {
    const event = trimEvent(eventPython, { ...BASE, maxFrames: 6 }).data as unknown as TrimmedEvent
    const frames = framesOf(event)

    expect(frames).toHaveLength(6)
    expect(frames.at(-1)?.inApp).toBe(true)
    expect(frames.filter((f) => f.inApp === true)).toHaveLength(4)
    expect(frames.filter((f) => f.inApp === false)).toHaveLength(2)
  })

  it('preserves outermost-to-innermost order', () => {
    const event = trimEvent(eventPython, { ...BASE, maxFrames: 6 }).data as unknown as TrimmedEvent
    const numeric = framesOf(event)
      .map((f) => f.lineNo)
      .filter((line): line is number => typeof line === 'number')

    expect(numeric).toEqual([...numeric].sort((a, b) => a - b))
  })

  it('reports omitted frames', () => {
    expect(trimEvent(eventPython, { ...BASE, maxFrames: 6 }).trimmed?.omittedFrames).toBe(24)
  })
})

describe('trimEvent chained exceptions', () => {
  it('keeps the two innermost values and counts the rest', () => {
    const result = trimEvent(eventChained, BASE)
    const event = result.data as unknown as TrimmedEvent

    expect(event.exception?.values).toHaveLength(2)
    expect(event.exception?.values[1]?.value).toBe('chained failure 2')
    expect(result.trimmed?.omittedExceptionValues).toBe(1)
  })

  it('applies max_frames per stacktrace and sums omitted frames', () => {
    const result = trimEvent(eventChained, { ...BASE, maxFrames: 10 })
    const event = result.data as unknown as TrimmedEvent

    expect(framesOf(event, 0)).toHaveLength(10)
    expect(framesOf(event, 1)).toHaveLength(10)
    expect(result.trimmed?.omittedFrames).toBe(30)
  })
})

describe('trimEvent source context', () => {
  it('keeps context only on the three innermost in-app frames', () => {
    const event = trimEvent(eventPython, BASE).data as unknown as TrimmedEvent
    const withContext = framesOf(event).filter((frame) => frame.context !== undefined)

    expect(withContext).toHaveLength(3)
    expect(withContext.every((frame) => frame.inApp === true)).toBe(true)
  })

  it('caps each source line at 200 characters and each frame at 11 lines', () => {
    const event = trimEvent(eventPython, BASE).data as unknown as TrimmedEvent
    for (const frame of framesOf(event)) {
      if (!frame.context) continue
      expect(frame.context.length).toBeLessThanOrEqual(11)
      for (const [, text] of frame.context) expect(text.length).toBeLessThanOrEqual(201)
    }
  })

  it('falls back to the first eleven lines when lineNo is missing', () => {
    const event = trimEvent(eventPython, BASE).data as unknown as TrimmedEvent
    const frame = framesOf(event).find((candidate) => candidate.lineNo === undefined)

    expect(frame?.context).toHaveLength(11)
    expect(frame?.context?.[0]?.[0]).toBe(400)
  })
})

describe('trimEvent strings and breadcrumbs', () => {
  it('caps the exception value at 2000 characters', () => {
    const event = trimEvent(eventPython, BASE).data as unknown as TrimmedEvent
    expect(event.exception?.values[0]?.value).toHaveLength(2001)
  })

  it('keeps the last twenty breadcrumbs and caps their messages', () => {
    const result = trimEvent(eventBrowser, BASE)
    const event = result.data as unknown as TrimmedEvent

    expect(event.breadcrumbs).toHaveLength(20)
    expect(result.trimmed?.omittedBreadcrumbs).toBe(25)
    for (const crumb of event.breadcrumbs ?? []) {
      expect(crumb.message.length).toBeLessThanOrEqual(201)
    }
  })

  it('omits breadcrumbs entirely when asked', () => {
    const event = trimEvent(eventBrowser, { ...BASE, includeBreadcrumbs: false })
      .data as unknown as TrimmedEvent
    expect(event.breadcrumbs).toBeUndefined()
  })
})

describe('trimEvent threads fallback', () => {
  it('uses the crashed thread when there is no exception entry', () => {
    const result = trimEvent(eventBrowser, BASE)
    const event = result.data as unknown as TrimmedEvent

    expect(result.trimmed?.exceptionSource).toBe('threads')
    expect(event.exception?.values).toHaveLength(1)
    expect(framesOf(event)).toHaveLength(6)
  })
})

describe('trimEvent resilience', () => {
  it.each(['entries', 'contexts', 'tags', 'sdk', 'user'])(
    'survives a payload with no %s',
    (key) => {
      const stripped = { ...(eventNode as Record<string, unknown>) }
      delete stripped[key]
      expect(() => trimEvent(stripped as JsonValue, BASE)).not.toThrow()
    },
  )

  it('omits zero-valued trimmed keys and drops trimmed entirely when nothing was cut', () => {
    const minimal = { id: '1', eventID: 'a', entries: [], tags: [], contexts: {} }
    expect(trimEvent(minimal as JsonValue, BASE).trimmed).toBeUndefined()
  })

  it('never emits static dropped-field lists', () => {
    const serialized = JSON.stringify(trimNode().result.trimmed ?? {})
    expect(serialized).not.toContain('droppedFields')
    expect(serialized).not.toContain('droppedEntries')
  })
})

const eventOversized = rawEventOversized as unknown as JsonValue

// Measured rung sizes for event-oversized.json, in UTF-8 bytes:
//   full 17513 -> no source context 10712 -> no breadcrumbs 4756 -> 10 frames 3596
describe('trimEvent degradation ladder', () => {
  it('does not degrade when the payload fits', () => {
    const result = trimEvent(eventOversized, { ...BASE, maxBytes: 20_000 })

    expect(result.trimmed?.degraded).toBeUndefined()
    expect(framesOf(result.data as unknown as TrimmedEvent)).toHaveLength(20)
  })

  it('drops source context first', () => {
    const result = trimEvent(eventOversized, { ...BASE, maxBytes: 12_000 })
    const event = result.data as unknown as TrimmedEvent

    expect(result.trimmed?.degraded).toBe('source_context')
    expect(event.breadcrumbs).toBeDefined()
    expect(framesOf(event).every((frame) => frame.context === undefined)).toBe(true)
  })

  it('drops breadcrumbs second', () => {
    const result = trimEvent(eventOversized, { ...BASE, maxBytes: 6_000 })
    const event = result.data as unknown as TrimmedEvent

    expect(result.trimmed?.degraded).toBe('breadcrumbs')
    expect(event.breadcrumbs).toBeUndefined()
    expect(framesOf(event)).toHaveLength(20)
  })

  it('reduces frames to ten last and recomputes the counters', () => {
    const result = trimEvent(eventOversized, { ...BASE, maxBytes: 4_000 })
    const event = result.data as unknown as TrimmedEvent

    expect(result.trimmed?.degraded).toBe('frames')
    expect(framesOf(event)).toHaveLength(10)
    expect(result.trimmed?.omittedFrames).toBe(50)
    expect(result.trimmed?.omittedBreadcrumbs).toBe(100)
  })

  it('throws when even the last rung is too big', () => {
    const error = caught(() => trimEvent(eventOversized, { ...BASE, maxBytes: 500 }))

    expect(error?.code).toBe('RESPONSE_TOO_LARGE')
    expect(error?.message).toBe(
      'Sentry event was too large to summarize even after trimming (degraded: frames).',
    )
  })

  it('drops opted-in frame vars as a final availability fallback', () => {
    const event = {
      entries: [
        {
          type: 'exception',
          data: {
            values: [
              {
                stacktrace: {
                  frames: [
                    { filename: 'app.js', inApp: true, vars: { payload: 'x'.repeat(250_000) } },
                  ],
                },
              },
            ],
          },
        },
      ],
      tags: [],
      contexts: {},
    } as JsonValue

    const result = trimEvent(event, { ...BASE, includeFrameVars: true })

    expect(result.trimmed?.degraded).toBe('frame_vars')
    expect(JSON.stringify(result.data)).not.toContain('payload')
  })

  it('never raises a caller max_frames cap while degrading frame vars', () => {
    const frames = Array.from({ length: 20 }, (_value, index) => ({
      filename: `${index}-${'x'.repeat(30_000)}`,
      inApp: true,
      vars: { payload: 'v'.repeat(250_000) },
    }))
    const event = {
      entries: [{ type: 'exception', data: { values: [{ stacktrace: { frames } }] } }],
      tags: [],
      contexts: {},
    } as JsonValue

    const result = trimEvent(event, {
      ...BASE,
      maxFrames: 1,
      includeFrameVars: true,
    })
    const trimmed = result.data as unknown as TrimmedEvent

    expect(result.trimmed?.degraded).toBe('frame_vars')
    expect(framesOf(trimmed)).toHaveLength(1)
  })
})
