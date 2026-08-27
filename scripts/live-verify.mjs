#!/usr/bin/env node
/**
 * Live verification smoke script for the spec §9.8 checklist (V1–V10).
 *
 * Read-only: it issues GET requests through the plugin's own client and never
 * writes to Sentry. Run it once against Sentry SaaS and once against a
 * self-hosted instance, then record the results in
 * docs/live-verification.md.
 *
 * Usage:
 *   bun run build
 *   SENTRY_TOKEN=... SENTRY_ORG=... node scripts/live-verify.mjs
 *
 * Environment:
 *   SENTRY_TOKEN     (required) Sentry auth token, org or user scoped
 *   SENTRY_ORG       (required) organization slug
 *   SENTRY_URL       (optional) site root, defaults to https://sentry.io/
 *   SENTRY_PROJECT   (optional) project slug; enables the project-scoped checks
 *   SENTRY_SHORT_ID  (optional) a short id such as PROJ-1AB; enables V3
 */

import { SentryApiError, SentryClient } from '../lib/index.js'

const REQUIRED = ['SENTRY_TOKEN', 'SENTRY_ORG']

const missing = REQUIRED.filter((key) => !process.env[key])
if (missing.length > 0) {
  console.error(`Missing required environment variables: ${missing.join(', ')}`)
  console.error('See the header of this file for the full environment contract.')
  process.exit(1)
}

const config = {
  baseUrl: process.env.SENTRY_URL ?? 'https://sentry.io/',
  token: process.env.SENTRY_TOKEN,
  org: process.env.SENTRY_ORG,
  locale: 'en',
  includeFrameVars: false,
  requestTimeoutMs: 30_000,
  maxResponseBytes: 5_000_000,
}

const projectSlug = process.env.SENTRY_PROJECT
const shortId = process.env.SENTRY_SHORT_ID

let client
try {
  client = new SentryClient(config)
} catch (error) {
  console.error(describe(error))
  process.exit(1)
}

const results = []

/** Runs one check and records its outcome without ever aborting the run. */
async function check(id, hypothesis, run) {
  try {
    const note = await run()
    results.push({ id, hypothesis, status: 'PASS', note })
  } catch (error) {
    results.push({ id, hypothesis, status: 'FAIL', note: describe(error) })
  }
}

/** Renders any thrown value as one safe line. */
function describe(error) {
  if (error instanceof SentryApiError) {
    return `${error.code}${error.status ? ` (HTTP ${error.status})` : ''}: ${error.message}`
  }
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/** Reports the JSON shape of a value one level deep, for the V7/V9 field-shape questions. */
function shapeOf(value) {
  if (Array.isArray(value))
    return `array[${value.length}] of ${value.length ? shapeOf(value[0]) : 'nothing'}`
  if (value === null) return 'null'
  if (typeof value !== 'object') return typeof value
  return `object{${Object.keys(value).slice(0, 12).join(', ')}}`
}

await check('V1', 'issues endpoint accepts statsPeriod=24h and 14d', async () => {
  const notes = []
  for (const statsPeriod of ['24h', '14d']) {
    const result = await client.searchIssues({ statsPeriod, limit: 1 })
    notes.push(`${statsPeriod}: ok, ${result.data.length ?? 0} issue(s)`)
  }
  return notes.join('; ')
})

await check('V2', 'wider statsPeriod values are available (v0.1 keeps them closed)', async () => {
  const notes = []
  for (const statsPeriod of ['7d', '30d', '90d']) {
    try {
      await client.searchIssues({ statsPeriod, limit: 1 })
      notes.push(`${statsPeriod}: accepted`)
    } catch (error) {
      notes.push(`${statsPeriod}: ${describe(error)}`)
    }
  }
  return notes.join('; ')
})

await check('V3', 'shortids endpoint exists and returns a usable groupId', async () => {
  if (!shortId) return 'SKIPPED — set SENTRY_SHORT_ID to run this check'
  const result = await client.getIssue(shortId)
  return `resolved to issue id ${result.data.id}; shape ${shapeOf(result.data)}`
})

await check('V4', 'org-level issue search works without a project parameter', async () => {
  const result = await client.searchIssues({ query: 'is:unresolved', limit: 5 })
  const note = `org-level: ${result.data.length ?? 0} issue(s)`
  if (!projectSlug) return `${note}; set SENTRY_PROJECT to also check the project-scoped path`
  const scoped = await client.searchIssues({ projectSlug, query: 'is:unresolved', limit: 5 })
  return `${note}; project ${projectSlug}: ${scoped.data.length ?? 0} issue(s)`
})

await check('V5', 'the configured token reaches issue and latest-event endpoints', async () => {
  const list = await client.searchIssues({ limit: 1 })
  const first = Array.isArray(list.data) ? list.data[0] : undefined
  if (!first) return 'SKIPPED — the org has no issues to read'
  const issue = await client.getIssue(String(first.id))
  const event = await client.getLatestEvent(String(first.id))
  return `issue ${issue.data.id} ok; latest event ${event.data.eventID ?? event.data.id} ok`
})

await check('V6', 'sort=recommended is rejected with HTTP 400 on this instance', async () => {
  try {
    await client.searchIssues({ sort: 'recommended', limit: 1 })
    return 'accepted — this instance supports sort=recommended'
  } catch (error) {
    return describe(error)
  }
})

await check('V7', 'list endpoints return a top-level array with Link and X-Hits', async () => {
  const issues = await client.searchIssues({ limit: 2 })
  const projects = await client.listProjects()
  return [
    `issues: ${shapeOf(issues.data)}, nextCursor=${issues.meta.nextCursor ?? 'absent'}, matchingCount=${issues.meta.matchingCount ?? 'absent'}`,
    `projects: ${shapeOf(projects.data)}`,
  ].join('; ')
})

await check('V8', 'a 400 body carries a string detail field', async () => {
  try {
    await client.searchIssues({ query: 'nonsense:::key', limit: 1 })
    return 'the deliberately malformed query was accepted; no 400 body to inspect'
  } catch (error) {
    if (error instanceof SentryApiError) {
      return `${error.code}; detail ${error.detail === undefined ? 'absent or suppressed' : `present: ${error.detail}`}`
    }
    return describe(error)
  }
})

await check('V9', 'event field shapes match the §4 assumptions', async () => {
  const list = await client.searchIssues({ limit: 1 })
  const first = Array.isArray(list.data) ? list.data[0] : undefined
  if (!first) return 'SKIPPED — the org has no issues to read'
  const event = await client.getLatestEvent(String(first.id))
  const entries = Array.isArray(event.data.entries) ? event.data.entries : undefined
  if (!entries) return `BLOCKER — entries is ${shapeOf(event.data.entries)}, expected an array`
  const exception = entries.find((entry) => entry?.type === 'exception')
  const frames = exception?.data?.values?.[0]?.stacktrace?.frames
  const context = Array.isArray(frames) ? frames.at(-1)?.context : undefined
  return [
    `entry types: ${entries.map((entry) => entry?.type).join(', ')}`,
    `exception.values: ${shapeOf(exception?.data?.values)}`,
    `frames: ${Array.isArray(frames) ? frames.length : 'absent'}`,
    `first context row: ${Array.isArray(context) ? JSON.stringify(context[0]) : 'absent'}`,
  ].join('; ')
})

await check('V10', 'trimmed payload sizes stay well under the 200KB budget', async () => {
  const { trimEvent, trimIssueList } = await import('../lib/index.js')
  const list = await client.searchIssues({ limit: 25 })
  const listBytes = Buffer.byteLength(JSON.stringify(trimIssueList(list.data).data), 'utf8')
  const first = Array.isArray(list.data) ? list.data[0] : undefined
  if (!first) return `issue list: ${listBytes} bytes; no issue available for the event check`
  const event = await client.getLatestEvent(String(first.id))
  const trimmed = trimEvent(event.data, {
    maxFrames: 20,
    includeBreadcrumbs: true,
    includeFrameVars: false,
  })
  const eventBytes = Buffer.byteLength(JSON.stringify(trimmed.data), 'utf8')
  return `issue list (25): ${listBytes} bytes; single event: ${eventBytes} bytes`
})

console.log(`\nSentry live verification — ${config.baseUrl} (org: ${config.org})\n`)
for (const { id, hypothesis, status, note } of results) {
  console.log(`${status === 'PASS' ? '✓' : '✗'} ${id} ${hypothesis}`)
  console.log(`    ${note}`)
}

const failed = results.filter((result) => result.status === 'FAIL')
console.log(
  `\n${results.length - failed.length}/${results.length} checks completed without an error.`,
)
console.log('Record the observed values in docs/live-verification.md.')
process.exit(failed.length > 0 ? 1 : 0)
