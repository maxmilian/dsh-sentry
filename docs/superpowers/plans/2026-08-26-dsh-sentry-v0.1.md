# dsh-sentry v0.1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `dsh-sentry`, a read-only DeepSeek Harness plugin exposing five GET-only Sentry Web API tools whose responses are aggressively trimmed so an agent's context survives a real stacktrace.

**Architecture:** Three strictly separated layers. `client.ts` owns transport only (auth header, one shared deadline per tool call, bounded body reads, header parsing, short-id resolution) and returns **untrimmed** JSON. `trim.ts` is pure functions that reshape that JSON, enforce string caps, and run a three-level degradation ladder against a byte budget. `tools.ts` is the seam: it calls the client, hands the raw data to a `trim*` function, merges the two `meta` objects, and registers five `defineTool`s whose descriptions come from a locale table. `errors.ts` and `config.ts` are leaf modules with no dependencies on the other three.

**Tech Stack:** TypeScript 5.9 (NodeNext, strict), Bun 1.3.5 as package manager and script runner, Vitest 4 with mocked `fetch`, Biome 2.5 for lint+format, `@deepseek-ai/cordis` + `@deepseek-ai/dsh-tools` + `@deepseek-ai/schemastery` as peer dependencies.

**Spec:** `docs/superpowers/specs/2026-08-26-dsh-sentry-design.md` — read it alongside this plan. Section references below (§3.2, §4.9, …) point into that spec.

**Skeleton source:** `~/side/ankey/dsh-sonarqube` is the reference implementation of this exact plugin shape (six files, ~950 lines, read-only, same auth model). **Copy its files and edit them; do not reinvent.** `config.ts`, `errors.ts`, and `locales.ts` are the highest-reuse blocks. `~/side/ankey/dsh-forge/src/index.ts` is the reference for passing a locale into tool registration.

## Global Constraints

Every task's requirements implicitly include this section. Values are copied verbatim from the spec.

- **Read-only.** Every HTTP request is a `GET`. No `POST`/`PUT`/`DELETE` anywhere, not even in tests.
- **Package name** `dsh-sentry` (npm unscoped, publisher account `maxhsu`). GitHub repo `maxmilian/dsh-sentry`. License MIT.
- **`package.json` must declare** `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`. Declaring only `dsh.client` gets the package rejected by the registry.
- **`@deepseek-ai/*` go in `peerDependencies` with explicit prerelease branches**: `"@deepseek-ai/cordis": "^4.0.1"`, `"@deepseek-ai/dsh-tools": "^0.1.0-rc.8 || ^0.1.1-rc.2"`, `"@deepseek-ai/schemastery": "^3.18.1"`. Writing only `^0.1.0-rc.8` makes node-semver silently exclude `0.1.1-rc.2` and users hit ERESOLVE.
- **Node engines** `"^22.19.0 || >=24.0.0"`. **packageManager** `bun@1.3.5`.
- **Four READMEs**: `README.md` (en), `README.zh-TW.md`, `README.zh-CN.md`, `README.ja.md`.
- **Runtime tool metadata is four-language.** Tool *names* are always English and fixed. Tool and parameter *descriptions* switch on `config.locale` ∈ `en` | `zh-TW` | `zh-CN` | `ja`. **Error messages are always English** and are never localized.
- **Every tool** sets `isConcurrencySafe: () => true`, uses the single shared `OUTPUT_SCHEMA` object, and renders via `JSON.stringify` into one text block. **No `presentCall` in v0.1.**
- **Secrets never leave.** No error message, `toJSON()`, or tool output may contain the configured token. Response bodies are never embedded in errors **except** the filtered HTTP-400 `detail` path (§6.2).
- **Byte budgets are bytes** (`Buffer.byteLength(json, 'utf8')`); **string caps are characters** (§4.9). This asymmetry is deliberate.
- **Four green commands** gate every task: `bun run lint`, `bun run typecheck`, `bun run test`, `bun run build`.
- Coverage thresholds: branches / functions / lines / statements all ≥ 80%, `src/types.ts` excluded.
- Biome caps cognitive complexity at 10 per function. `trim.ts` must be split into small functions to pass.

## File Structure

| File | Responsibility | Depends on |
| --- | --- | --- |
| `src/types.ts` | `JsonValue` / `JsonObject`, `ApiResult`, `TransportMeta`, `TrimResult`, `TrimmedMeta`, per-tool param interfaces. Types only, no runtime code. | — |
| `src/errors.ts` | `SentryErrorCode` union, `SentryApiError`, `createHttpError(status, ctx)`, `sanitizeUpstreamDetail(body, token)`. | `types.ts` |
| `src/config.ts` | `Locale`, `SentryConfig`, `ResolvedSentryConfig`, bound constants, `resolveConfig`, `validateResolvedConfig`, `normalizeBaseUrl`. | `errors.ts` |
| `src/locales.ts` | `CONFIG_I18N` (7 Schemastery keys) and `TOOL_I18N` (exactly 4 locales). Data only. | `config.ts` (type import) |
| `src/client.ts` | `SentryClient`: shared deadline, `#get`, bounded body read, 400 body read, `Link`/`X-Hits` parsing, identifier regex constants, param validation, short-id resolution, five endpoint methods. Returns untrimmed JSON. | `config.ts`, `errors.ts`, `types.ts` |
| `src/trim.ts` | `MAX_TOOL_RESULT_BYTES`, string caps, `trimProjectList`, `trimIssueList`, `trimIssue`, `trimEvent` (frame selection, security stripping, degradation ladder). Pure functions. | `errors.ts`, `types.ts` |
| `src/tools.ts` | `OUTPUT_SCHEMA`, `registerSentryTools(ctx, client, locale)`, five `defineTool`s, the client→trim→meta-merge seam, `renderJson`. | all of the above |
| `src/index.ts` | `name`, `inject`, Schemastery `Config`, `apply()`, public re-exports. | all of the above |

Tests mirror the layers: `tests/errors.test.ts`, `tests/client.test.ts` (includes the `configuration` describe block, matching the skeleton), `tests/locales.test.ts`, `tests/trim.test.ts`, `tests/tools.test.ts`, `tests/plugin.test.ts`, plus hand-authored fixtures under `tests/fixtures/`.

**Fixture policy:** the plan builds fixtures by hand to the shapes documented in spec §4. They are *not* captured from a live Sentry during implementation. Task 14 (V9) validates those shapes against a real instance; a mismatch there is a blocking bug against §4, not a test tweak.

---

## Task 1: Repository scaffold and toolchain

**Files:**
- Create: `package.json`, `tsconfig.json`, `tsconfig.build.json`, `biome.json`, `vitest.config.ts`, `.gitignore`, `LICENSE`, `cordis.patch.yml`, `src/types.ts`, `tests/scaffold.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `JsonValue`, `JsonObject`, `ApiResult`, `TransportMeta`, `TrimmedMeta`, `TrimResult` from `src/types.ts`; the four npm scripts `lint` / `typecheck` / `test` / `build`.

- [ ] **Step 1: Copy the skeleton's config files**

```bash
cd ~/side/ankey/dsh-sentry
S=~/side/ankey/dsh-sonarqube
cp "$S/tsconfig.json" "$S/tsconfig.build.json" "$S/biome.json" "$S/vitest.config.ts" "$S/.gitignore" "$S/LICENSE" .
```

These need no edits: `tsconfig.json` (NodeNext, strict, `noUncheckedIndexedAccess`), `tsconfig.build.json` (rootDir `src`, outDir `lib`, declarations), `biome.json` (single quotes, no semicolons, complexity 10, `noConsole`/`noExplicitAny` as errors), `vitest.config.ts` (node env, v8 coverage, 80% thresholds, excludes `src/types.ts`), `.gitignore`, `LICENSE` (MIT).

- [ ] **Step 2: Write `package.json`**

```json
{
  "name": "dsh-sentry",
  "version": "0.1.0",
  "description": "Read-only Sentry issue and event tools for DeepSeek Harness.",
  "homepage": "https://github.com/maxmilian/dsh-sentry#readme",
  "bugs": { "url": "https://github.com/maxmilian/dsh-sentry/issues" },
  "repository": { "type": "git", "url": "git+https://github.com/maxmilian/dsh-sentry.git" },
  "author": "maxmilian",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "exports": {
    ".": { "types": "./lib/index.d.ts", "default": "./lib/index.js" },
    "./package.json": "./package.json"
  },
  "files": [
    "lib",
    "cordis.patch.yml",
    "README.md",
    "README.zh-TW.md",
    "README.zh-CN.md",
    "README.ja.md",
    "LICENSE"
  ],
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "format": "biome format --write .",
    "lint": "biome check .",
    "prepare": "bun run build",
    "test": "vitest run",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "keywords": ["deepseek-harness", "dsh-plugin", "sentry", "error-tracking", "observability"],
  "license": "MIT",
  "packageManager": "bun@1.3.5",
  "engines": { "node": "^22.19.0 || >=24.0.0" },
  "publishConfig": { "access": "public" },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-tools": "^0.1.0-rc.8 || ^0.1.1-rc.2",
    "@deepseek-ai/schemastery": "^3.18.1"
  },
  "devDependencies": {
    "@biomejs/biome": "^2.5.10",
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-tools": "^0.1.0-rc.8",
    "@deepseek-ai/schemastery": "^3.18.1",
    "@types/node": "^24.10.1",
    "@vitest/coverage-v8": "^4.0.18",
    "typescript": "^5.9.3",
    "vitest": "^4.0.18"
  },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

- [ ] **Step 3: Write `cordis.patch.yml`**

```yaml
- insert:
    - id: dsh-sentry
      name: dsh-sentry
```

- [ ] **Step 4: Install dependencies**

Run: `bun install`
Expected: creates `bun.lock` and `node_modules/`, exits 0.

- [ ] **Step 5: Write the failing scaffold test**

Create `tests/scaffold.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import type { JsonObject, TransportMeta, TrimResult } from '../src/types.js'

describe('scaffold', () => {
  it('exposes the shared JSON and layering types', () => {
    const data: JsonObject = { ok: true }
    const meta: TransportMeta = { nextCursor: '0:100:0', matchingCount: 7, hasMore: true }
    const trimmed: TrimResult = { data, trimmed: { omittedFrames: 3 }, truncated: true }

    expect(meta.matchingCount).toBe(7)
    expect(trimmed.trimmed?.omittedFrames).toBe(3)
  })
})
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `bun run test`
Expected: FAIL — cannot resolve `../src/types.js`.

- [ ] **Step 7: Write `src/types.ts`**

```ts
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
  /** True when more results exist but this tool exposes no cursor parameter. */
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
```

- [ ] **Step 8: Run the four gates**

Run: `bun run lint && bun run typecheck && bun run test && bun run build`
Expected: all four exit 0; `lib/types.js` and `lib/types.d.ts` exist.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "chore: scaffold dsh-sentry toolchain and shared types"
```

---

## Task 2: `errors.ts` — error codes, `SentryApiError`, 400 detail sanitizer

**Files:**
- Create: `src/errors.ts`, `tests/errors.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type SentryErrorCode` — the 15-member union in spec §6.1.
  - `class SentryApiError extends Error` with readonly `code: SentryErrorCode`, `status?: number`, `retryAfter?: string`, `detail?: string`, and `toJSON(): Record<string, number | string | undefined>` returning exactly `{ name, code, status, retryAfter, detail }`.
  - `interface HttpErrorContext { retryAfter?: string; detail?: string; isSearch?: boolean; usedRecommendedSort?: boolean }`
  - `createHttpError(status: number, ctx?: HttpErrorContext): SentryApiError`
  - `sanitizeUpstreamDetail(body: unknown, token: string): string | undefined`
  - `MAX_DETAIL_CHARS = 200`

- [ ] **Step 1: Write the failing test**

Create `tests/errors.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { createHttpError, sanitizeUpstreamDetail, SentryApiError } from '../src/errors.js'

const TOKEN = 'sntryu_supersecret'

describe('sanitizeUpstreamDetail', () => {
  it('returns the detail field verbatim', () => {
    const body = { detail: 'Invalid query. "foo" is not a supported search key' }
    expect(sanitizeUpstreamDetail(body, TOKEN)).toBe(
      'Invalid query. "foo" is not a supported search key',
    )
  })

  it('falls back to the error field and prefers detail when both exist', () => {
    expect(sanitizeUpstreamDetail({ error: 'bad request' }, TOKEN)).toBe('bad request')
    expect(sanitizeUpstreamDetail({ detail: 'first', error: 'second' }, TOKEN)).toBe('first')
  })

  it('rejects non-string and missing fields', () => {
    expect(sanitizeUpstreamDetail({ detail: { nested: true } }, TOKEN)).toBeUndefined()
    expect(sanitizeUpstreamDetail({ detail: ['a'] }, TOKEN)).toBeUndefined()
    expect(sanitizeUpstreamDetail({ detail: 42 }, TOKEN)).toBeUndefined()
    expect(sanitizeUpstreamDetail({ detail: null }, TOKEN)).toBeUndefined()
    expect(sanitizeUpstreamDetail({}, TOKEN)).toBeUndefined()
    expect(sanitizeUpstreamDetail('plain string', TOKEN)).toBeUndefined()
    expect(sanitizeUpstreamDetail(null, TOKEN)).toBeUndefined()
  })

  it('drops any detail containing the configured token', () => {
    expect(sanitizeUpstreamDetail({ detail: `bad token ${TOKEN}` }, TOKEN)).toBeUndefined()
  })

  it.each([
    'Bearer abc123 rejected',
    'missing Authorization header',
    'token sntryu_abc is invalid',
    'token sntrys_abc is invalid',
    'api_key not accepted',
    'api-key not accepted',
    'the secret is wrong',
    'password mismatch',
    'token=abc123',
    'token: abc123',
  ])('drops detail matching a secret pattern: %s', (detail) => {
    expect(sanitizeUpstreamDetail({ detail }, TOKEN)).toBeUndefined()
  })

  it('collapses control characters and repeated whitespace', () => {
    expect(sanitizeUpstreamDetail({ detail: '  a\r\nb\t\tc   d  ' }, TOKEN)).toBe('a b c d')
  })

  it('truncates to 200 characters after cleaning', () => {
    const result = sanitizeUpstreamDetail({ detail: 'x'.repeat(250) }, TOKEN)
    expect(result).toHaveLength(201)
    expect(result?.endsWith('…')).toBe(true)
  })
})

describe('createHttpError', () => {
  it('maps 400 with recommended sort to UNSUPPORTED_BY_INSTANCE', () => {
    const error = createHttpError(400, { isSearch: true, usedRecommendedSort: true })
    expect(error.code).toBe('UNSUPPORTED_BY_INSTANCE')
    expect(error.message).toBe('This Sentry instance does not support the requested sort order.')
  })

  it('maps a search 400 to INVALID_QUERY and appends the detail', () => {
    const error = createHttpError(400, { isSearch: true, detail: 'bad key' })
    expect(error.code).toBe('INVALID_QUERY')
    expect(error.message).toBe(
      'Sentry rejected the search query. Check the Sentry search syntax. Sentry said: bad key',
    )
    expect(error.detail).toBe('bad key')
  })

  it('omits the Sentry said clause when there is no detail', () => {
    const error = createHttpError(400, { isSearch: true })
    expect(error.message).toBe('Sentry rejected the search query. Check the Sentry search syntax.')
    expect(error.detail).toBeUndefined()
  })

  it('maps a non-search 400 to SENTRY_HTTP_ERROR', () => {
    expect(createHttpError(400, {}).code).toBe('SENTRY_HTTP_ERROR')
  })

  it.each([
    [401, 'AUTHENTICATION_FAILED'],
    [403, 'PERMISSION_DENIED'],
    [404, 'NOT_FOUND'],
    [429, 'RATE_LIMITED'],
    [500, 'SERVER_ERROR'],
    [503, 'SERVER_ERROR'],
    [418, 'SENTRY_HTTP_ERROR'],
  ])('maps HTTP %i to %s', (status, code) => {
    expect(createHttpError(status, {}).code).toBe(code)
  })

  it('mentions the region in 401 and 404 messages', () => {
    expect(createHttpError(401, {}).message).toContain('https://de.sentry.io/')
    expect(createHttpError(404, {}).message).toContain('region')
  })

  it('preserves Retry-After on 429', () => {
    expect(createHttpError(429, { retryAfter: '30' }).retryAfter).toBe('30')
  })
})

describe('SentryApiError', () => {
  it('serializes exactly five keys and nothing else', () => {
    const error = new SentryApiError('boom', {
      code: 'RATE_LIMITED',
      status: 429,
      retryAfter: '30',
      detail: 'slow down',
    })
    expect(error.toJSON()).toEqual({
      name: 'SentryApiError',
      code: 'RATE_LIMITED',
      status: 429,
      retryAfter: '30',
      detail: 'slow down',
    })
    expect(Object.keys(error.toJSON())).toHaveLength(5)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test tests/errors.test.ts`
Expected: FAIL — cannot resolve `../src/errors.js`.

- [ ] **Step 3: Write `src/errors.ts`**

Start from `~/side/ankey/dsh-sonarqube/src/errors.ts` (rename the class, extend the code union, add `detail`), then add the two new functions. Key shapes:

```ts
export type SentryErrorCode =
  | 'AUTHENTICATION_FAILED'
  | 'INVALID_CONFIG'
  | 'INVALID_INPUT'
  | 'INVALID_QUERY'
  | 'INVALID_RESPONSE'
  | 'NETWORK_ERROR'
  | 'NOT_FOUND'
  | 'PERMISSION_DENIED'
  | 'RATE_LIMITED'
  | 'REQUEST_ABORTED'
  | 'REQUEST_TIMEOUT'
  | 'RESPONSE_TOO_LARGE'
  | 'SENTRY_HTTP_ERROR'
  | 'SERVER_ERROR'
  | 'UNSUPPORTED_BY_INSTANCE'

export const MAX_DETAIL_CHARS = 200

const SECRET_PATTERN =
  /(bearer\s|authorization|sntry[us]_|api[_-]?key|secret|password|token\s*[:=])/i

const REGION_HINT = 'Verify baseUrl matches your Sentry region (for example https://de.sentry.io/).'

export interface HttpErrorContext {
  readonly retryAfter?: string
  readonly detail?: string
  readonly isSearch?: boolean
  readonly usedRecommendedSort?: boolean
}

/** Extracts a safe, short upstream explanation from an HTTP 400 body. */
export function sanitizeUpstreamDetail(body: unknown, token: string): string | undefined {
  const raw = readDetailField(body)
  if (raw === undefined) return undefined
  const cleaned = raw.replace(/[ -]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!cleaned) return undefined
  if (token && cleaned.includes(token)) return undefined
  if (SECRET_PATTERN.test(cleaned)) return undefined
  return cleaned.length > MAX_DETAIL_CHARS ? `${cleaned.slice(0, MAX_DETAIL_CHARS)}…` : cleaned
}

function readDetailField(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined
  const record = body as Record<string, unknown>
  for (const key of ['detail', 'error']) {
    const value = record[key]
    if (typeof value === 'string') return value
  }
  return undefined
}
```

`createHttpError(status, ctx = {})` delegates to a `describeHttpError(status, ctx)` helper that returns `{ code, message }`. Order inside that helper, exactly:

1. `status === 400 && ctx.usedRecommendedSort` → `UNSUPPORTED_BY_INSTANCE`, `'This Sentry instance does not support the requested sort order.'`
2. `status === 400 && ctx.isSearch` → `INVALID_QUERY`, base message `'Sentry rejected the search query. Check the Sentry search syntax.'` plus `` ` Sentry said: ${ctx.detail}` `` when `ctx.detail` is set.
3. `status === 401` → `AUTHENTICATION_FAILED`, `` `Sentry authentication failed. Check the configured token. ${REGION_HINT}` ``
4. `status === 403` → `PERMISSION_DENIED`, `'Sentry denied access to this resource. Check the token scopes (org:read, project:read, event:read).'`
5. `status === 404` → `NOT_FOUND`, `'The requested Sentry resource was not found. Verify the org slug and that baseUrl matches your Sentry region.'`
6. `status === 429` → `RATE_LIMITED`, `'Sentry rate limit exceeded. Retry later.'`
7. `status >= 500` → `SERVER_ERROR`, `` `Sentry server error (HTTP ${status}).` ``
8. otherwise → `SENTRY_HTTP_ERROR`, `` `Sentry request failed (HTTP ${status}).` ``

`createHttpError` passes `status`, `ctx.retryAfter`, and `ctx.detail` (only when the code is `INVALID_QUERY`) into the `SentryApiError` constructor. Keep each helper under Biome's complexity 10 — the eight-way branch above must live in its own function.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test tests/errors.test.ts`
Expected: PASS, all cases green.

- [ ] **Step 5: Run the four gates and commit**

```bash
bun run lint && bun run typecheck && bun run test && bun run build
git add -A
git commit -m "feat: add Sentry error codes and 400 detail sanitizer"
```

---

## Task 3: `config.ts` — resolution, bounds, URL normalization

**Files:**
- Create: `src/config.ts`, `tests/client.test.ts` (the `configuration` describe block only; later tasks append to this file)

**Interfaces:**
- Consumes: `SentryApiError` from `errors.ts`.
- Produces:
  - `type Locale = 'en' | 'zh-TW' | 'zh-CN' | 'ja'`, `const LOCALES: readonly Locale[]`
  - `interface SentryConfig { baseUrl?, token?, org?, locale?, includeFrameVars?, requestTimeoutMs?, maxResponseBytes? }`
  - `interface ResolvedSentryConfig` — same fields, all required, `baseUrl` normalized with trailing slash.
  - `DEFAULT_BASE_URL = 'https://sentry.io/'`, `DEFAULT_REQUEST_TIMEOUT_MS = 30_000`, `MAX_REQUEST_TIMEOUT_MS = 300_000`, `DEFAULT_MAX_RESPONSE_BYTES = 5 * 1024 * 1024`, `MAX_RESPONSE_BYTES = 50 * 1024 * 1024`
  - `SLUG_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/`
  - `resolveConfig(config?: SentryConfig, env?: NodeJS.ProcessEnv): ResolvedSentryConfig`
  - `validateResolvedConfig(config: ResolvedSentryConfig): ResolvedSentryConfig`

- [ ] **Step 1: Write the failing test**

Create `tests/client.test.ts` with this content (later tasks append more `describe` blocks to the same file):

```ts
import { describe, expect, it } from 'vitest'

import { resolveConfig } from '../src/config.js'
import { SentryApiError } from '../src/errors.js'

const ENV = { SENTRY_AUTH_TOKEN: 'env-token', SENTRY_ORG: 'env-org' }

describe('configuration', () => {
  it('prefers plugin config over environment variables', () => {
    const resolved = resolveConfig(
      { baseUrl: 'https://self.example.com/sentry/', token: 'cfg-token', org: 'cfg-org' },
      { ...ENV, SENTRY_URL: 'https://env.example.com' },
    )

    expect(resolved.baseUrl).toBe('https://self.example.com/sentry/')
    expect(resolved.token).toBe('cfg-token')
    expect(resolved.org).toBe('cfg-org')
  })

  it('falls back to environment variables and defaults', () => {
    const resolved = resolveConfig({}, ENV)

    expect(resolved.baseUrl).toBe('https://sentry.io/')
    expect(resolved.token).toBe('env-token')
    expect(resolved.org).toBe('env-org')
    expect(resolved.locale).toBe('en')
    expect(resolved.includeFrameVars).toBe(false)
    expect(resolved.requestTimeoutMs).toBe(30_000)
    expect(resolved.maxResponseBytes).toBe(5 * 1024 * 1024)
  })

  it('strips a trailing api/0 segment and adds a trailing slash', () => {
    expect(resolveConfig({ baseUrl: 'https://sentry.io/api/0/' }, ENV).baseUrl).toBe(
      'https://sentry.io/',
    )
    expect(resolveConfig({ baseUrl: 'https://x.com/sentry' }, ENV).baseUrl).toBe(
      'https://x.com/sentry/',
    )
  })

  it.each([
    ['ftp://sentry.io/', 'protocol'],
    ['https://user:pw@sentry.io/', 'credentials'],
    ['https://sentry.io/?a=1', 'query'],
    ['https://sentry.io/#frag', 'fragment'],
    ['not a url', 'invalid'],
  ])('rejects unsafe baseUrl %s', (baseUrl) => {
    expect(() => resolveConfig({ baseUrl }, ENV)).toThrow(SentryApiError)
  })

  it('requires a token and an org', () => {
    expect(() => resolveConfig({}, { SENTRY_ORG: 'o' })).toThrow(/token/)
    expect(() => resolveConfig({}, { SENTRY_AUTH_TOKEN: 't' })).toThrow(/org/)
  })

  it.each(['Bad-Org', 'org/slash', '../escape', '-leading', 'x'.repeat(65)])(
    'rejects org slug %s',
    (org) => {
      expect(() => resolveConfig({ org }, ENV)).toThrow(SentryApiError)
    },
  )

  it('rejects an unknown locale', () => {
    // @ts-expect-error deliberately invalid locale
    expect(() => resolveConfig({ locale: 'fr' }, ENV)).toThrow(/locale/)
  })

  it('treats only the literal string true as includeFrameVars', () => {
    expect(resolveConfig({}, { ...ENV, SENTRY_INCLUDE_FRAME_VARS: 'TRUE' }).includeFrameVars).toBe(
      true,
    )
    expect(resolveConfig({}, { ...ENV, SENTRY_INCLUDE_FRAME_VARS: ' true ' }).includeFrameVars).toBe(
      true,
    )
    for (const value of ['1', 'yes', '', 'false']) {
      expect(
        resolveConfig({}, { ...ENV, SENTRY_INCLUDE_FRAME_VARS: value }).includeFrameVars,
      ).toBe(false)
    }
  })

  it.each([
    ['requestTimeoutMs', 0],
    ['requestTimeoutMs', 300_001],
    ['requestTimeoutMs', 1.5],
    ['maxResponseBytes', 0],
    ['maxResponseBytes', 50 * 1024 * 1024 + 1],
  ])('rejects out-of-bounds %s = %s', (field, value) => {
    expect(() => resolveConfig({ [field]: value }, ENV)).toThrow(SentryApiError)
  })

  it('reports configuration failures with the INVALID_CONFIG code', () => {
    try {
      resolveConfig({}, {})
      expect.unreachable('resolveConfig should have thrown')
    } catch (error) {
      expect((error as SentryApiError).code).toBe('INVALID_CONFIG')
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test tests/client.test.ts`
Expected: FAIL — cannot resolve `../src/config.js`.

- [ ] **Step 3: Write `src/config.ts`**

Start from `~/side/ankey/dsh-sonarqube/src/config.ts`. Keep `assertBoundedInteger`, `configError`, and the `normalizeBaseUrl` structure. Changes:

- Add `org` (validated with `SLUG_PATTERN`), `locale` (must be in `LOCALES`), `includeFrameVars`.
- `baseUrl` defaults to `DEFAULT_BASE_URL` instead of being required.
- In `normalizeBaseUrl`, after stripping trailing slashes, also strip a trailing `/api/0`:

```ts
function normalizeBaseUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw configError('baseUrl must be a valid HTTP or HTTPS URL.')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw configError('baseUrl must be an HTTP(S) URL without embedded credentials.')
  }
  if (url.search || url.hash) {
    throw configError('baseUrl must not include a query string or fragment.')
  }
  const path = url.pathname.replace(/\/+$/, '').replace(/\/api\/0$/, '')
  url.pathname = `${path}/`
  return url.toString()
}
```

- Boolean environment parsing:

```ts
function readBooleanEnv(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === 'true'
}
```

- `resolveConfig` composes: `config.includeFrameVars ?? readBooleanEnv(env.SENTRY_INCLUDE_FRAME_VARS)`, `config.locale ?? 'en'`, `config.org?.trim() || env.SENTRY_ORG?.trim() || ''`, `config.baseUrl?.trim() || env.SENTRY_URL?.trim() || DEFAULT_BASE_URL`, `config.token?.trim() || env.SENTRY_AUTH_TOKEN?.trim() || ''`.
- `validateResolvedConfig` throws `configError('token or SENTRY_AUTH_TOKEN is required.')`, `configError('org or SENTRY_ORG is required.')`, `configError('org must be a valid Sentry slug.')`, `configError('locale must be one of en, zh-TW, zh-CN, ja.')`, plus the two bounded-integer checks, then returns the normalized object.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test tests/client.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the four gates and commit**

```bash
bun run lint && bun run typecheck && bun run test && bun run build
git add -A
git commit -m "feat: add Sentry configuration resolution and validation"
```

---

## Task 4: `locales.ts` — four-language config and tool metadata

**Files:**
- Create: `src/locales.ts`, `tests/locales.test.ts`

**Interfaces:**
- Consumes: `Locale` from `config.ts`.
- Produces:
  - `CONFIG_I18N` — `Record<'en' | 'en-US' | 'zh' | 'zh-CN' | 'zh-TW' | 'ja' | 'ja-JP', ConfigLocaleMessages>` where the alias keys are the **same object references** as their canonical keys.
  - `TOOL_I18N: Record<Locale, ToolMessages>` — exactly four keys.
  - `interface ToolMessages` with one entry per tool: `{ description: string; params: Record<string, string> }` keyed by tool name.

The parameter keys per tool are fixed and must be identical across all four locales:

| Tool | Parameter keys |
| --- | --- |
| `sentry_list_projects` | *(none)* |
| `sentry_search_issues` | `project_slug`, `query`, `stats_period`, `sort`, `environment`, `limit`, `cursor` |
| `sentry_get_issue` | `issue` |
| `sentry_get_latest_event` | `issue`, `max_frames`, `include_breadcrumbs` |
| `sentry_get_event` | `project_slug`, `event_id`, `max_frames`, `include_breadcrumbs` |

- [ ] **Step 1: Write the failing test**

Create `tests/locales.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { LOCALES } from '../src/config.js'
import { CONFIG_I18N, TOOL_I18N } from '../src/locales.js'

const TOOL_NAMES = [
  'sentry_list_projects',
  'sentry_search_issues',
  'sentry_get_issue',
  'sentry_get_latest_event',
  'sentry_get_event',
] as const

describe('TOOL_I18N', () => {
  it('has exactly the four supported locales and no aliases', () => {
    expect(Object.keys(TOOL_I18N).sort()).toEqual(['en', 'ja', 'zh-CN', 'zh-TW'])
    expect([...LOCALES].sort()).toEqual(['en', 'ja', 'zh-CN', 'zh-TW'])
  })

  it('describes every tool and every parameter in every locale', () => {
    for (const locale of LOCALES) {
      for (const tool of TOOL_NAMES) {
        const entry = TOOL_I18N[locale][tool]
        expect(entry.description.trim().length).toBeGreaterThan(0)
        for (const [param, text] of Object.entries(entry.params)) {
          expect(text.trim().length, `${locale}/${tool}/${param}`).toBeGreaterThan(0)
        }
      }
    }
  })

  it('uses identical parameter key sets across locales', () => {
    for (const tool of TOOL_NAMES) {
      const reference = Object.keys(TOOL_I18N.en[tool].params).sort()
      for (const locale of LOCALES) {
        expect(Object.keys(TOOL_I18N[locale][tool].params).sort(), `${locale}/${tool}`).toEqual(
          reference,
        )
      }
    }
  })

  it('actually translates rather than copying English', () => {
    for (const tool of TOOL_NAMES) {
      const texts = LOCALES.map((locale) => TOOL_I18N[locale][tool].description)
      expect(new Set(texts).size, tool).toBe(LOCALES.length)
    }
  })
})

describe('CONFIG_I18N', () => {
  it('exposes the seven Schemastery locale keys', () => {
    expect(Object.keys(CONFIG_I18N).sort()).toEqual([
      'en',
      'en-US',
      'ja',
      'ja-JP',
      'zh',
      'zh-CN',
      'zh-TW',
    ])
  })

  it('aliases share the same object reference as their canonical locale', () => {
    expect(CONFIG_I18N['en-US']).toBe(CONFIG_I18N.en)
    expect(CONFIG_I18N.zh).toBe(CONFIG_I18N['zh-CN'])
    expect(CONFIG_I18N['ja-JP']).toBe(CONFIG_I18N.ja)
  })

  it('documents every configuration field in every locale', () => {
    const fields = [
      '$description',
      'baseUrl',
      'token',
      'org',
      'locale',
      'includeFrameVars',
      'requestTimeoutMs',
      'maxResponseBytes',
    ] as const
    for (const [key, messages] of Object.entries(CONFIG_I18N)) {
      for (const field of fields) {
        expect(messages[field].trim().length, `${key}/${field}`).toBeGreaterThan(0)
      }
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test tests/locales.test.ts`
Expected: FAIL — cannot resolve `../src/locales.js`, and `LOCALES` is not exported from `config.ts` yet.

- [ ] **Step 3: Export `LOCALES` from `config.ts` and write `src/locales.ts`**

Add to `config.ts` if not already present:

```ts
export const LOCALES = ['en', 'zh-TW', 'zh-CN', 'ja'] as const
export type Locale = (typeof LOCALES)[number]
```

`src/locales.ts` follows the skeleton's shape (`const ENGLISH_CONFIG = {...} as const satisfies ConfigLocaleMessages`, one const per language, then the exported map). Example of the English config block and one tool entry — write the other three languages as faithful translations:

```ts
import type { Locale } from './config.js'

interface ConfigLocaleMessages {
  readonly $description: string
  readonly baseUrl: string
  readonly token: string
  readonly org: string
  readonly locale: string
  readonly includeFrameVars: string
  readonly requestTimeoutMs: string
  readonly maxResponseBytes: string
}

const ENGLISH_CONFIG = {
  $description: 'Read-only Sentry integration settings.',
  baseUrl: 'Sentry site root URL. Falls back to SENTRY_URL. Use https://de.sentry.io/ for the EU region.',
  token: 'Sentry auth token. Prefer the SENTRY_AUTH_TOKEN environment variable.',
  org: 'Sentry organization slug. Falls back to SENTRY_ORG.',
  locale: 'Language used for tool and parameter descriptions. Error messages stay in English.',
  includeFrameVars:
    'Include stack frame local variables. Off by default because they often carry tokens and personal data.',
  requestTimeoutMs:
    'Deadline in milliseconds for one whole tool call, including the extra request a short id needs.',
  maxResponseBytes: 'Maximum HTTP response body size in bytes.',
} as const satisfies ConfigLocaleMessages

interface ToolEntry {
  readonly description: string
  readonly params: Readonly<Record<string, string>>
}

interface ToolMessages {
  readonly sentry_list_projects: ToolEntry
  readonly sentry_search_issues: ToolEntry
  readonly sentry_get_issue: ToolEntry
  readonly sentry_get_latest_event: ToolEntry
  readonly sentry_get_event: ToolEntry
}

const ENGLISH_TOOLS = {
  sentry_list_projects: {
    description:
      'List the projects in the configured Sentry organization. Returns id, slug, name, platform, status, and team slugs for at most 100 projects; meta.truncated is true when the organization has more.',
    params: {},
  },
  sentry_search_issues: {
    description:
      'Search Sentry issues using Sentry search syntax. Returns a trimmed summary per issue: no event bodies, no stacktraces, no time-series stats. When project_slug is given the project-scoped endpoint is used; otherwise the whole organization is searched.',
    params: {
      project_slug: 'Project slug. Omit to search the whole organization.',
      query: 'Sentry search syntax. Defaults to is:unresolved.',
      stats_period: 'Time range, either 24h or 14d. Defaults to 14d.',
      sort: 'Sort order. Defaults to date. Some self-hosted versions reject recommended.',
      environment: 'Environment name.',
      limit: 'Results per page, 1 to 100. Defaults to 25.',
      cursor: 'Pagination cursor returned as meta.nextCursor by a previous call.',
    },
  },
  sentry_get_issue: {
    description:
      'Read one Sentry issue by numeric id or short id (for example PROJ-ABC). Returns counts, first and last seen, culprit, and release span. Does not include event bodies or stacktraces. A short id costs one extra request to resolve it to a numeric id.',
    params: { issue: 'Numeric issue id or short id such as PROJ-ABC.' },
  },
  sentry_get_latest_event: {
    description:
      'Read the latest event of a Sentry issue with a trimmed stacktrace. First-party frames are preserved, source context is limited to the innermost first-party frames, and local variables, request headers, request bodies, query strings, packages, and secret-looking tags are removed. Accepts a numeric issue id or a short id; a short id costs one extra request.',
    params: {
      issue: 'Numeric issue id or short id such as PROJ-ABC.',
      max_frames: 'Maximum stack frames kept per stacktrace, 1 to 100. Defaults to 20.',
      include_breadcrumbs: 'Keep the last 20 breadcrumbs. Defaults to true.',
    },
  },
  sentry_get_event: {
    description:
      'Read one Sentry event by event id within a project, applying the same stacktrace trimming as sentry_get_latest_event.',
    params: {
      project_slug: 'Project slug that owns the event.',
      event_id: 'Event id, 32 hexadecimal characters.',
      max_frames: 'Maximum stack frames kept per stacktrace, 1 to 100. Defaults to 20.',
      include_breadcrumbs: 'Keep the last 20 breadcrumbs. Defaults to true.',
    },
  },
} as const satisfies ToolMessages

export const CONFIG_I18N = {
  en: ENGLISH_CONFIG,
  'en-US': ENGLISH_CONFIG,
  zh: SIMPLIFIED_CHINESE_CONFIG,
  'zh-CN': SIMPLIFIED_CHINESE_CONFIG,
  'zh-TW': TRADITIONAL_CHINESE_CONFIG,
  ja: JAPANESE_CONFIG,
  'ja-JP': JAPANESE_CONFIG,
} as const satisfies Record<string, ConfigLocaleMessages>

export const TOOL_I18N = {
  en: ENGLISH_TOOLS,
  'zh-TW': TRADITIONAL_CHINESE_TOOLS,
  'zh-CN': SIMPLIFIED_CHINESE_TOOLS,
  ja: JAPANESE_TOOLS,
} as const satisfies Record<Locale, ToolMessages>
```

Write `TRADITIONAL_CHINESE_CONFIG`, `SIMPLIFIED_CHINESE_CONFIG`, `JAPANESE_CONFIG`, `TRADITIONAL_CHINESE_TOOLS`, `SIMPLIFIED_CHINESE_TOOLS`, and `JAPANESE_TOOLS` as complete faithful translations. The sentences describing trimming behavior (which frames survive, what is removed) must stay semantically identical across languages — the registry compares descriptions against code behavior.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test tests/locales.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the four gates and commit**

```bash
bun run lint && bun run typecheck && bun run test && bun run build
git add -A
git commit -m "feat: add four-language config and tool metadata"
```

---

## Task 5: `client.ts` transport core

**Files:**
- Create: `src/client.ts`
- Modify: `tests/client.test.ts` (append the `transport` describe block)

**Interfaces:**
- Consumes: `ResolvedSentryConfig`, `resolveConfig`, `validateResolvedConfig` from `config.ts`; `createHttpError`, `sanitizeUpstreamDetail`, `SentryApiError` from `errors.ts`; `ApiResult`, `JsonValue`, `TransportMeta` from `types.ts`.
- Produces:
  - `class SentryClient` with `constructor(config: ResolvedSentryConfig, fetchImplementation?: FetchImplementation)`.
  - `createSentryClient(config?: SentryConfig, env?: NodeJS.ProcessEnv, fetchImplementation?: FetchImplementation): SentryClient`
  - Identifier constants: `NUMERIC_ID_PATTERN`, `SHORT_ID_PATTERN`, `EVENT_ID_PATTERN`, `CURSOR_PATTERN` (`SLUG_PATTERN` is re-exported from `config.ts`).
  - `ERROR_BODY_MAX_BYTES = 64 * 1024`
  - A private `#request(endpoint, query, context, requestMeta)` used by every endpoint method in Task 6.
  - `RequestContext` — one per **tool call**, created by a public `createCallContext(signal?: AbortSignal): RequestContext` so a short-id flow can share one deadline across two HTTP requests.

- [ ] **Step 1: Write the failing test**

Append to `tests/client.test.ts`:

```ts
import { afterEach, vi } from 'vitest'

import { SentryClient } from '../src/client.js'

type MockFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

const BASE_CONFIG = {
  baseUrl: 'https://sentry.example.com/',
  token: 'secret-token',
  org: 'acme',
  locale: 'en',
  includeFrameVars: false,
  requestTimeoutMs: 1_000,
  maxResponseBytes: 10_000,
} as const

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

function createClient(fetchMock: MockFetch): SentryClient {
  return new SentryClient(BASE_CONFIG, fetchMock)
}

function calledUrl(fetchMock: ReturnType<typeof vi.fn<MockFetch>>, index = 0): URL {
  return new URL(String(fetchMock.mock.calls[index]?.[0]))
}

afterEach(() => {
  vi.useRealTimers()
})

describe('transport', () => {
  it('sends a bearer token and accepts a JSON object body', async () => {
    const fetchMock = vi.fn<MockFetch>().mockResolvedValue(jsonResponse({ id: '1' }))
    const result = await createClient(fetchMock).getIssue('123')

    expect(calledUrl(fetchMock).toString()).toBe('https://sentry.example.com/api/0/issues/123/')
    const init = fetchMock.mock.calls[0]?.[1]
    expect(init?.method).toBe('GET')
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer secret-token')
    expect(result.data).toEqual({ id: '1' })
  })

  it('accepts an array top level', async () => {
    const fetchMock = vi.fn<MockFetch>().mockResolvedValue(jsonResponse([{ id: '1' }]))
    const result = await createClient(fetchMock).searchIssues({})

    expect(result.data).toEqual([{ id: '1' }])
  })

  it.each([['"text"'], ['42'], ['null']])('rejects the scalar top level %s', async (body) => {
    const fetchMock = vi.fn<MockFetch>().mockResolvedValue(
      new Response(body, { headers: { 'content-type': 'application/json' } }),
    )

    await expect(createClient(fetchMock).getIssue('1')).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    })
  })

  it('rejects a non-JSON content type and broken JSON on 2xx', async () => {
    const html = vi.fn<MockFetch>().mockResolvedValue(
      new Response('<html>', { headers: { 'content-type': 'text/html' } }),
    )
    await expect(createClient(html).getIssue('1')).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    })

    const broken = vi.fn<MockFetch>().mockResolvedValue(
      new Response('{oops', { headers: { 'content-type': 'application/json' } }),
    )
    await expect(createClient(broken).getIssue('1')).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    })
  })

  it('parses the Link header only when more results exist', async () => {
    const withNext = vi.fn<MockFetch>().mockResolvedValue(
      jsonResponse([], {
        headers: {
          'content-type': 'application/json',
          link: '<https://x/?cursor=0:100:0>; rel="next"; results="true"; cursor="0:100:0"',
        },
      }),
    )
    expect((await createClient(withNext).searchIssues({})).meta.nextCursor).toBe('0:100:0')

    const exhausted = vi.fn<MockFetch>().mockResolvedValue(
      jsonResponse([], {
        headers: {
          'content-type': 'application/json',
          link: '<https://x/?cursor=0:100:0>; rel="next"; results="false"; cursor="0:100:0"',
        },
      }),
    )
    expect((await createClient(exhausted).searchIssues({})).meta.nextCursor).toBeUndefined()

    const malformed = vi.fn<MockFetch>().mockResolvedValue(
      jsonResponse([], { headers: { 'content-type': 'application/json', link: 'garbage' } }),
    )
    expect((await createClient(malformed).searchIssues({})).meta.nextCursor).toBeUndefined()
  })

  it('parses X-Hits only when it is a plausible integer', async () => {
    const good = vi.fn<MockFetch>().mockResolvedValue(
      jsonResponse([], { headers: { 'content-type': 'application/json', 'x-hits': '431' } }),
    )
    expect((await createClient(good).searchIssues({})).meta.matchingCount).toBe(431)

    for (const value of ['abc', '1'.repeat(11), '-1']) {
      const bad = vi.fn<MockFetch>().mockResolvedValue(
        jsonResponse([], { headers: { 'content-type': 'application/json', 'x-hits': value } }),
      )
      expect((await createClient(bad).searchIssues({})).meta.matchingCount).toBeUndefined()
    }
  })

  it('aborts on an oversized content-length and on an oversized stream', async () => {
    const declared = vi.fn<MockFetch>().mockResolvedValue(
      new Response('{}', {
        headers: { 'content-type': 'application/json', 'content-length': '999999' },
      }),
    )
    await expect(createClient(declared).getIssue('1')).rejects.toMatchObject({
      code: 'RESPONSE_TOO_LARGE',
      message: expect.stringContaining('configured maximum'),
    })

    const streamed = vi.fn<MockFetch>().mockResolvedValue(
      new Response(JSON.stringify({ pad: 'x'.repeat(20_000) }), {
        headers: { 'content-type': 'application/json' },
      }),
    )
    await expect(createClient(streamed).getIssue('1')).rejects.toMatchObject({
      code: 'RESPONSE_TOO_LARGE',
    })
  })

  it('reads a filtered detail from a 400 body on search', async () => {
    const fetchMock = vi.fn<MockFetch>().mockResolvedValue(
      jsonResponse({ detail: 'Invalid query. "foo" is not a supported search key' }, {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    )

    await expect(createClient(fetchMock).searchIssues({ query: 'foo:bar' })).rejects.toMatchObject({
      code: 'INVALID_QUERY',
      detail: 'Invalid query. "foo" is not a supported search key',
    })
  })

  it.each([
    ['html', new Response('<html>err</html>', { status: 400, headers: { 'content-type': 'text/html' } })],
    ['broken json', new Response('{oops', { status: 400, headers: { 'content-type': 'application/json' } })],
  ])('falls back to the static 400 message for a %s body', async (_label, response) => {
    const fetchMock = vi.fn<MockFetch>().mockResolvedValue(response)

    const error = await createClient(fetchMock)
      .searchIssues({})
      .catch((thrown: SentryApiError) => thrown)

    expect(error).toMatchObject({ code: 'INVALID_QUERY', detail: undefined })
    expect((error as SentryApiError).message).toBe(
      'Sentry rejected the search query. Check the Sentry search syntax.',
    )
  })

  it.each([401, 403, 404, 500])('never leaks a %i response body', async (status) => {
    const fetchMock = vi.fn<MockFetch>().mockResolvedValue(
      jsonResponse({ detail: 'leak-me' }, {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    )

    const error = await createClient(fetchMock)
      .getIssue('1')
      .catch((thrown: SentryApiError) => thrown)

    expect((error as SentryApiError).message).not.toContain('leak-me')
    expect(JSON.stringify((error as SentryApiError).toJSON())).not.toContain('leak-me')
  })

  it('never leaks the token in an error', async () => {
    const fetchMock = vi.fn<MockFetch>().mockResolvedValue(
      jsonResponse({}, { status: 500, headers: { 'content-type': 'application/json' } }),
    )

    const error = await createClient(fetchMock)
      .getIssue('1')
      .catch((thrown: SentryApiError) => thrown)

    expect((error as SentryApiError).message).not.toContain('secret-token')
    expect(JSON.stringify((error as SentryApiError).toJSON())).not.toContain('secret-token')
  })

  it('preserves Retry-After on 429', async () => {
    const fetchMock = vi.fn<MockFetch>().mockResolvedValue(
      jsonResponse({}, {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '30' },
      }),
    )

    await expect(createClient(fetchMock).getIssue('1')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfter: '30',
    })
  })

  it('times out, honours caller aborts, and reports network failures', async () => {
    vi.useFakeTimers()
    const hang = vi.fn<MockFetch>().mockImplementation(() => new Promise(() => {}))
    const timedOut = createClient(hang).getIssue('1')
    await vi.advanceTimersByTimeAsync(1_001)
    await expect(timedOut).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' })
    vi.useRealTimers()

    const controller = new AbortController()
    controller.abort()
    const aborted = vi.fn<MockFetch>().mockRejectedValue(new Error('aborted'))
    await expect(createClient(aborted).getIssue('1', controller.signal)).rejects.toMatchObject({
      code: 'REQUEST_ABORTED',
    })

    const offline = vi.fn<MockFetch>().mockRejectedValue(new TypeError('fetch failed'))
    await expect(createClient(offline).getIssue('1')).rejects.toMatchObject({
      code: 'NETWORK_ERROR',
    })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test tests/client.test.ts`
Expected: FAIL — cannot resolve `../src/client.js`.

- [ ] **Step 3: Write the transport half of `src/client.ts`**

Copy `~/side/ankey/dsh-sonarqube/src/client.ts` as the base. Keep verbatim: `createRequestContext`, `normalizeRequestError`, `safeHeader`, `readBoundedBody`, `isJsonContentType`. Rename `SonarQube*` to `Sentry*`. Then make these five changes:

1. **Shared deadline.** Export the context factory so one tool call can span two requests:

```ts
export interface RequestContext {
  readonly controller: AbortController
  readonly dispose: () => void
  readonly didTimeout: () => boolean
}

/** Creates one deadline for an entire tool call, including any follow-up request. */
createCallContext(signal?: AbortSignal): RequestContext {
  return createRequestContext(signal, this.#config.requestTimeoutMs)
}
```

Every public endpoint method creates a context, wraps its body in `try/finally { context.dispose() }`, and passes the same context into every `#request` call it makes.

2. **Request metadata carried to the error factory.** `#request` takes a fourth argument and forwards it:

```ts
interface RequestMeta {
  readonly isSearch?: boolean
  readonly usedRecommendedSort?: boolean
}
```

3. **Array or object top level.** Replace `parseJsonObject` with:

```ts
function parseJsonValue(text: string): JsonValue {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new SentryApiError('Sentry returned an unexpected response.', { code: 'INVALID_RESPONSE' })
  }
  if (typeof value !== 'object' || value === null) {
    throw new SentryApiError('Sentry returned an unexpected response.', { code: 'INVALID_RESPONSE' })
  }
  return value as JsonValue
}
```

4. **400 body read.** Replace the skeleton's unconditional `await response.body?.cancel()` in the `!response.ok` branch with:

```ts
async #handleErrorResponse(response: Response, meta: RequestMeta): Promise<never> {
  const retryAfter = safeHeader(response.headers, 'Retry-After', this.#config.token)
  const detail = response.status === 400 ? await this.#readErrorDetail(response) : undefined
  if (response.status !== 400) await response.body?.cancel()
  throw createHttpError(response.status, { ...meta, retryAfter, detail })
}

async #readErrorDetail(response: Response): Promise<string | undefined> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (!isJsonContentType(contentType)) {
    await response.body?.cancel()
    return undefined
  }
  try {
    const text = await readBoundedBody(response, ERROR_BODY_MAX_BYTES)
    return sanitizeUpstreamDetail(JSON.parse(text), this.#config.token)
  } catch {
    return undefined
  }
}
```

The `catch` swallows both `RESPONSE_TOO_LARGE` (body over 64KB) and `SyntaxError` (broken JSON) and yields "no detail" — it must **never** convert into `INVALID_RESPONSE`, which is reserved for 2xx.

5. **Header parsing helpers**:

```ts
const NEXT_CURSOR_PATTERN = /rel="next"/
const HITS_PATTERN = /^\d{1,10}$/

function parseTransportMeta(headers: Headers, token: string): TransportMeta {
  const meta: { nextCursor?: string; matchingCount?: number; hasMore?: boolean } = {}
  const cursor = parseNextCursor(headers.get('link'))
  if (cursor) {
    meta.nextCursor = cursor
    meta.hasMore = true
  }
  const hits = safeHeader(headers, 'X-Hits', token)
  if (hits && HITS_PATTERN.test(hits)) meta.matchingCount = Number(hits)
  return meta
}

function parseNextCursor(link: string | null): string | undefined {
  if (!link) return undefined
  for (const part of link.split(',')) {
    if (!NEXT_CURSOR_PATTERN.test(part) || !/results="true"/.test(part)) continue
    const match = /cursor="([^"]+)"/.exec(part)
    if (match?.[1]) return match[1]
  }
  return undefined
}
```

Also declare the identifier constants at module scope:

```ts
export const NUMERIC_ID_PATTERN = /^\d{1,20}$/
export const SHORT_ID_PATTERN = /^[A-Z0-9][A-Z0-9_]*-[A-Z0-9]+$/
export const EVENT_ID_PATTERN = /^[0-9a-fA-F]{32}$/
export const CURSOR_PATTERN = /^-?\d+:-?\d+:[01]$/
export const ERROR_BODY_MAX_BYTES = 64 * 1024
```

Add temporary stubs for `getIssue(issue, signal?)` and `searchIssues(params, signal?)` so this task's tests compile; Task 6 fills in the real parameter handling.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test tests/client.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the four gates and commit**

```bash
bun run lint && bun run typecheck && bun run test && bun run build
git add -A
git commit -m "feat: add Sentry transport client with bounded reads and 400 detail"
```

---

## Task 6: `client.ts` endpoint methods, validation, short-id resolution

**Files:**
- Modify: `src/client.ts`, `tests/client.test.ts` (append the `endpoints` describe block)

**Interfaces:**
- Consumes: everything from Task 5.
- Produces, all returning `Promise<ApiResult>`:
  - `listProjects(signal?: AbortSignal)`
  - `searchIssues(params: SearchIssuesParams, signal?: AbortSignal)` where `SearchIssuesParams = { projectSlug?, query?, statsPeriod?, sort?, environment?, limit?, cursor? }`
  - `getIssue(issue: string, signal?: AbortSignal)`
  - `getLatestEvent(issue: string, signal?: AbortSignal)`
  - `getEvent(projectSlug: string, eventId: string, signal?: AbortSignal)`

- [ ] **Step 1: Write the failing test**

Append to `tests/client.test.ts`:

```ts
describe('endpoints', () => {
  it('lists projects with a fixed page size', async () => {
    const fetchMock = vi.fn<MockFetch>().mockResolvedValue(jsonResponse([]))
    await createClient(fetchMock).listProjects()

    const url = calledUrl(fetchMock)
    expect(url.pathname).toBe('/api/0/organizations/acme/projects/')
    expect(url.searchParams.get('per_page')).toBe('100')
  })

  it('uses the project endpoint when a slug is given and the org endpoint otherwise', async () => {
    const scoped = vi.fn<MockFetch>().mockResolvedValue(jsonResponse([]))
    await createClient(scoped).searchIssues({ projectSlug: 'web-app' })
    expect(calledUrl(scoped).pathname).toBe('/api/0/projects/acme/web-app/issues/')

    const org = vi.fn<MockFetch>().mockResolvedValue(jsonResponse([]))
    await createClient(org).searchIssues({})
    expect(calledUrl(org).pathname).toBe('/api/0/organizations/acme/issues/')
  })

  it('applies search defaults and passes explicit values through', async () => {
    const defaults = vi.fn<MockFetch>().mockResolvedValue(jsonResponse([]))
    await createClient(defaults).searchIssues({})
    const defaulted = calledUrl(defaults).searchParams
    expect(defaulted.get('query')).toBe('is:unresolved')
    expect(defaulted.get('statsPeriod')).toBe('14d')
    expect(defaulted.get('sort')).toBe('date')
    expect(defaulted.get('per_page')).toBe('25')

    const explicit = vi.fn<MockFetch>().mockResolvedValue(jsonResponse([]))
    await createClient(explicit).searchIssues({
      query: 'is:resolved',
      statsPeriod: '24h',
      sort: 'freq',
      environment: 'production',
      limit: 100,
      cursor: '0:100:0',
    })
    const params = calledUrl(explicit).searchParams
    expect(params.get('query')).toBe('is:resolved')
    expect(params.get('statsPeriod')).toBe('24h')
    expect(params.get('sort')).toBe('freq')
    expect(params.get('environment')).toBe('production')
    expect(params.get('per_page')).toBe('100')
    expect(params.get('cursor')).toBe('0:100:0')
  })

  it('flags a recommended sort so a 400 becomes UNSUPPORTED_BY_INSTANCE', async () => {
    const fetchMock = vi.fn<MockFetch>().mockResolvedValue(
      jsonResponse({ detail: 'nope' }, {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    )

    await expect(
      createClient(fetchMock).searchIssues({ sort: 'recommended' }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_BY_INSTANCE' })
  })

  it('maps a non-search 400 to SENTRY_HTTP_ERROR', async () => {
    const fetchMock = vi.fn<MockFetch>().mockResolvedValue(
      jsonResponse({ detail: 'nope' }, {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    )

    await expect(
      createClient(fetchMock).getEvent('web-app', 'a'.repeat(32)),
    ).rejects.toMatchObject({ code: 'SENTRY_HTTP_ERROR' })
  })

  it.each([
    ['limit 0', () => createClient(neverCalled()).searchIssues({ limit: 0 })],
    ['limit 101', () => createClient(neverCalled()).searchIssues({ limit: 101 })],
    ['bad cursor', () => createClient(neverCalled()).searchIssues({ cursor: 'nope' })],
    ['slash slug', () => createClient(neverCalled()).searchIssues({ projectSlug: 'a/b' })],
    ['dotdot slug', () => createClient(neverCalled()).searchIssues({ projectSlug: '../etc' })],
    ['upper slug', () => createClient(neverCalled()).searchIssues({ projectSlug: 'Web' })],
    ['long query', () => createClient(neverCalled()).searchIssues({ query: 'x'.repeat(401) })],
    ['short event id', () => createClient(neverCalled()).getEvent('web-app', 'abc')],
    ['non-hex event id', () => createClient(neverCalled()).getEvent('web-app', 'z'.repeat(32))],
    ['bad issue id', () => createClient(neverCalled()).getIssue('-A-1')],
    ['empty issue id', () => createClient(neverCalled()).getIssue('')],
  ])('rejects %s before sending a request', async (_label, call) => {
    await expect(call()).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('treats an all-digit issue as a numeric id with one request', async () => {
    const fetchMock = vi.fn<MockFetch>().mockResolvedValue(jsonResponse({ id: '123456' }))
    await createClient(fetchMock).getIssue('123-456'.replace('-', ''))
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const dashed = vi.fn<MockFetch>().mockResolvedValue(jsonResponse({ groupId: '9' }))
    await createClient(dashed).getIssue('123-456').catch(() => undefined)
    expect(calledUrl(dashed).pathname).toBe('/api/0/organizations/acme/shortids/123-456/')
  })

  it('resolves a short id and upper-cases it first', async () => {
    const fetchMock = vi
      .fn<MockFetch>()
      .mockResolvedValueOnce(jsonResponse({ groupId: '987654' }))
      .mockResolvedValueOnce(jsonResponse({ id: '987654' }))

    const result = await createClient(fetchMock).getIssue('proj-abc')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(calledUrl(fetchMock, 0).pathname).toBe('/api/0/organizations/acme/shortids/PROJ-ABC/')
    expect(calledUrl(fetchMock, 1).pathname).toBe('/api/0/issues/987654/')
    expect(result.data).toEqual({ id: '987654' })
  })

  it('accepts a numeric groupId type', async () => {
    const fetchMock = vi
      .fn<MockFetch>()
      .mockResolvedValueOnce(jsonResponse({ groupId: 987654 }))
      .mockResolvedValueOnce(jsonResponse({ id: '987654' }))

    await createClient(fetchMock).getIssue('PROJ-ABC')
    expect(calledUrl(fetchMock, 1).pathname).toBe('/api/0/issues/987654/')
  })

  it.each([
    ['missing', {}],
    ['null', { groupId: null }],
    ['non numeric', { groupId: 'abc' }],
    ['nested', { group: { id: '5' } }],
    ['too long', { groupId: '1'.repeat(21) }],
  ])('rejects an unusable groupId (%s) without a second request', async (_label, body) => {
    const fetchMock = vi.fn<MockFetch>().mockResolvedValue(jsonResponse(body))

    await expect(createClient(fetchMock).getIssue('PROJ-ABC')).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('maps a shortids 404 to NOT_FOUND', async () => {
    const fetchMock = vi.fn<MockFetch>().mockResolvedValue(
      jsonResponse({}, { status: 404, headers: { 'content-type': 'application/json' } }),
    )

    await expect(createClient(fetchMock).getIssue('PROJ-ABC')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('shares one deadline across both requests of a short id call', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .fn<MockFetch>()
      .mockImplementationOnce(async () => {
        await vi.advanceTimersByTimeAsync(600)
        return jsonResponse({ groupId: '5' })
      })
      .mockImplementationOnce(() => new Promise(() => {}))

    const pending = createClient(fetchMock).getIssue('PROJ-ABC')
    await vi.advanceTimersByTimeAsync(500)

    await expect(pending).rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' })
    vi.useRealTimers()
  })

  it('builds the event endpoints', async () => {
    const latest = vi.fn<MockFetch>().mockResolvedValue(jsonResponse({ eventID: 'a' }))
    await createClient(latest).getLatestEvent('123')
    expect(calledUrl(latest).pathname).toBe('/api/0/issues/123/events/latest/')

    const single = vi.fn<MockFetch>().mockResolvedValue(jsonResponse({ eventID: 'a' }))
    await createClient(single).getEvent('web-app', 'b'.repeat(32))
    expect(calledUrl(single).pathname).toBe(`/api/0/projects/acme/web-app/events/${'b'.repeat(32)}/`)
  })
})

function neverCalled(): MockFetch {
  return () => {
    throw new Error('fetch must not be called for invalid input')
  }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test tests/client.test.ts`
Expected: FAIL — the stubbed methods ignore parameters and no validation exists.

- [ ] **Step 3: Implement the endpoint methods**

Add to `SentryClient`, each following the same skeleton (create one call context, validate inputs, build the query, `try/finally` dispose):

```ts
async getIssue(issue: string, signal?: AbortSignal): Promise<ApiResult> {
  const context = this.createCallContext(signal)
  try {
    const id = await this.#resolveIssueId(issue, context, signal)
    return await this.#request(`api/0/issues/${id}/`, new URLSearchParams(), context, signal, {})
  } finally {
    context.dispose()
  }
}

async #resolveIssueId(issue: string, context: RequestContext, signal?: AbortSignal): Promise<string> {
  const trimmed = issue.trim()
  if (NUMERIC_ID_PATTERN.test(trimmed)) return trimmed
  const shortId = trimmed.toUpperCase()
  if (!SHORT_ID_PATTERN.test(shortId) || shortId.length > 64) {
    throw inputError('issue must be a numeric issue id or a short id such as PROJ-ABC.')
  }
  const result = await this.#request(
    `api/0/organizations/${this.#config.org}/shortids/${encodeURIComponent(shortId)}/`,
    new URLSearchParams(),
    context,
    signal,
    {},
  )
  return readGroupId(result.data)
}

function readGroupId(data: JsonValue): string {
  const value = isJsonObject(data) ? data.groupId : undefined
  const text = typeof value === 'number' ? String(value) : value
  if (typeof text !== 'string' || !NUMERIC_ID_PATTERN.test(text)) {
    throw new SentryApiError('Sentry returned an unexpected response.', { code: 'INVALID_RESPONSE' })
  }
  return text
}
```

`searchIssues` builds its query then dispatches on `projectSlug`:

```ts
async searchIssues(params: SearchIssuesParams, signal?: AbortSignal): Promise<ApiResult> {
  const query = new URLSearchParams({
    query: assertLength('query', params.query ?? 'is:unresolved', 400),
    statsPeriod: params.statsPeriod ?? '14d',
    sort: params.sort ?? 'date',
    per_page: String(assertLimit(params.limit ?? 25)),
  })
  if (params.environment) query.set('environment', assertLength('environment', params.environment, 100))
  if (params.cursor) query.set('cursor', assertPattern('cursor', params.cursor, CURSOR_PATTERN))
  const endpoint = params.projectSlug
    ? `api/0/projects/${this.#config.org}/${assertSlug(params.projectSlug)}/issues/`
    : `api/0/organizations/${this.#config.org}/issues/`
  const context = this.createCallContext(signal)
  try {
    return await this.#request(endpoint, query, context, signal, {
      isSearch: true,
      usedRecommendedSort: params.sort === 'recommended',
    })
  } finally {
    context.dispose()
  }
}
```

Validation helpers all throw `inputError(...)` with `code: 'INVALID_INPUT'`:

- `assertSlug(value)` → `SLUG_PATTERN`
- `assertLimit(value)` → `Number.isSafeInteger(value) && value >= 1 && value <= 100`
- `assertLength(name, value, max)` → non-empty after trim, `value.length <= max`
- `assertPattern(name, value, pattern)` → generic regex guard, used for `cursor` and `event_id`

`listProjects`, `getLatestEvent`, and `getEvent` follow the same shape with endpoints `api/0/organizations/{org}/projects/` (query `per_page=100`), `api/0/issues/{id}/events/latest/` (id via `#resolveIssueId`), and `api/0/projects/{org}/{slug}/events/{eventId}/` (slug via `assertSlug`, event id via `assertPattern` with `EVENT_ID_PATTERN`).

**Important:** all validation runs *before* any `fetch`, so the "rejects … before sending a request" cases never hit the network.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test tests/client.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the four gates and commit**

```bash
bun run lint && bun run typecheck && bun run test && bun run build
git add -A
git commit -m "feat: add Sentry endpoint methods and short id resolution"
```

---

## Task 7: `trim.ts` — projects, issues, and the byte budget

**Files:**
- Create: `src/trim.ts`, `tests/trim.test.ts`, `tests/fixtures/projects-list.json`, `tests/fixtures/issues-list.json`, `tests/fixtures/issue-detail.json`

**Interfaces:**
- Consumes: `SentryApiError` from `errors.ts`; `JsonObject`, `JsonValue`, `TrimResult` from `types.ts`.
- Produces:
  - `MAX_TOOL_RESULT_BYTES = 200_000`
  - `trimProjectList(raw: JsonValue, hasMore?: boolean): TrimResult`
  - `trimIssueList(raw: JsonValue): TrimResult`
  - `trimIssue(raw: JsonValue): TrimResult`
  - `measureBytes(value: JsonObject): number` (internal but exported for the byte-vs-character test)
  - `truncate(value: string, max: number): string`

- [ ] **Step 1: Write the fixtures**

`tests/fixtures/projects-list.json` — an array of two projects, each carrying at least one whitelisted field and several fields that must vanish (`features`, `options`, `latestDeploys`, `access`, `avatar`).

`tests/fixtures/issues-list.json` — an array of two issues. Include on the first issue: `stats` with a 336-point `24h` array, a `title` of 600 characters, `metadata.value` of 600 characters, `annotations`, `inbox`, `owners`, `shareId`, `hasSeen`, `subscriptionDetails`, `seerFixabilityScore`, and `assignedTo: { type: 'user', name: 'Ada', email: 'ada@example.com', id: '7' }`. Make the second issue a minimal one **without** `substatus`, `priority`, or `isUnhandled` to exercise the old-self-hosted path.

`tests/fixtures/issue-detail.json` — one issue object with `stats`, `firstRelease: { version: '1.0.0', dateCreated: '…' }`, `lastRelease: { version: '1.2.0' }`, `activity` of five entries, `participants` of three entries each carrying an `email`, `seenBy` of two entries, `pluginIssues`, and `pluginContexts`.

- [ ] **Step 2: Write the failing test**

Create `tests/trim.test.ts`:

```ts
import { describe, expect, it } from 'vitest'

import { SentryApiError } from '../src/errors.js'
import { MAX_TOOL_RESULT_BYTES, trimIssue, trimIssueList, trimProjectList } from '../src/trim.js'
import issueDetail from './fixtures/issue-detail.json' with { type: 'json' }
import issuesList from './fixtures/issues-list.json' with { type: 'json' }
import projectsList from './fixtures/projects-list.json' with { type: 'json' }

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
    expect(JSON.stringify(data)).not.toContain('latestDeploys')
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
  })

  it('truncates the title and metadata value to 500 characters', () => {
    const issues = (trimIssueList(issuesList).data as {
      issues: { title: string; metadata: { value: string } }[]
    }).issues

    expect(issues[0]?.title).toHaveLength(501)
    expect(issues[0]?.title.endsWith('…')).toBe(true)
    expect(issues[0]?.metadata.value).toHaveLength(501)
  })

  it('keeps only type and name from assignedTo', () => {
    const issues = (trimIssueList(issuesList).data as {
      issues: { assignedTo?: Record<string, unknown> }[]
    }).issues

    expect(issues[0]?.assignedTo).toEqual({ type: 'user', name: 'Ada' })
    expect(JSON.stringify(issues)).not.toContain('ada@example.com')
  })

  it('survives issues without substatus, priority, or isUnhandled', () => {
    expect(() => trimIssueList(issuesList)).not.toThrow()
    const issues = (trimIssueList(issuesList).data as { issues: Record<string, unknown>[] }).issues
    expect(issues[1]).not.toHaveProperty('substatus')
  })

  it('rejects a non-array payload', () => {
    expect(() => trimIssueList({ nope: true })).toThrow(SentryApiError)
  })
})

describe('trimIssue', () => {
  it('summarizes releases and counts participants without leaking emails', () => {
    const data = trimIssue(issueDetail).data as Record<string, unknown>

    expect(data.firstRelease).toBe('1.0.0')
    expect(data.lastRelease).toBe('1.2.0')
    expect(data.participantCount).toBe(3)
    expect(data.seenByCount).toBe(2)
    expect((data.activity as unknown[])).toHaveLength(3)
    expect(JSON.stringify(data)).not.toContain('@example.com')
    expect(JSON.stringify(data)).not.toContain('"stats"')
    expect(JSON.stringify(data)).not.toContain('pluginIssues')
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

    const error = (() => {
      try {
        trimIssueList(huge)
        return undefined
      } catch (thrown) {
        return thrown as SentryApiError
      }
    })()

    expect(error?.code).toBe('RESPONSE_TOO_LARGE')
    expect(error?.message).toContain('too large to summarize')
    expect(error?.message).not.toContain('configured maximum')
  })

  it('measures bytes rather than characters', () => {
    const characters = Math.floor(MAX_TOOL_RESULT_BYTES / 2)
    const cjk = [{ id: '1', shortId: 'P-1', title: '錯'.repeat(characters) }]

    expect(() => trimIssueList(cjk)).toThrow(/too large to summarize/)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun run test tests/trim.test.ts`
Expected: FAIL — cannot resolve `../src/trim.js`.

- [ ] **Step 4: Write the first half of `src/trim.ts`**

```ts
import { SentryApiError } from './errors.js'
import type { JsonObject, JsonValue, TrimResult } from './types.js'

/** Maximum serialized size of one tool result, in UTF-8 bytes. */
export const MAX_TOOL_RESULT_BYTES = 200_000

const TITLE_CHARS = 500
const METADATA_VALUE_CHARS = 500

/** Truncates to a character budget, marking the cut with an ellipsis. */
export function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/** Serialized size in UTF-8 bytes. Byte budgets and character caps are deliberately different units. */
export function measureBytes(value: JsonObject): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

function assertWithinBudget(data: JsonObject, degraded?: string): void {
  if (measureBytes(data) <= MAX_TOOL_RESULT_BYTES) return
  throw new SentryApiError(
    `Sentry event was too large to summarize even after trimming (degraded: ${degraded ?? 'none'}).`,
    { code: 'RESPONSE_TOO_LARGE' },
  )
}

function asArray(raw: JsonValue): JsonValue[] {
  if (!Array.isArray(raw)) {
    throw new SentryApiError('Sentry returned an unexpected response.', { code: 'INVALID_RESPONSE' })
  }
  return raw
}
```

`trimProjectList(raw, hasMore)` maps each object through a nine-key whitelist (`id`, `slug`, `name`, `platform`, `status`, `dateCreated`, `isMember`, `firstEvent`, `teams` → `teams.map(t => t.slug)`), wraps as `{ projects }`, calls `assertWithinBudget`, and returns `{ data, ...(hasMore ? { truncated: true } : {}) }`.

`trimIssueList(raw)` maps `asArray(raw)` through `trimIssueSummary` (below), wraps as `{ issues }`, calls `assertWithinBudget`.

`trimIssueSummary(issue)` keeps `id`, `shortId`, `title` (truncated to `TITLE_CHARS`), `culprit` (truncated), `level`, `status`, `substatus`, `priority`, `isUnhandled`, `count`, `userCount`, `firstSeen`, `lastSeen`, `permalink`, `project.slug`, `metadata` reduced to `{ type, value: truncate(value, METADATA_VALUE_CHARS), filename }`, and `assignedTo` reduced to `{ type, name }`. **Absent keys must be omitted, never emitted as `undefined` or `null`** — write a small `putIfPresent(target, key, value)` helper and use it everywhere, so old self-hosted payloads produce clean objects.

`trimIssue(raw)` runs `trimIssueSummary` on the object, then adds `firstRelease`/`lastRelease` as bare version strings, `activity` as the first three `{ type, dateCreated }` pairs, `participantCount`, `seenByCount`, and calls `assertWithinBudget`.

Keep each function under complexity 10 — the whitelist loops belong in their own helpers.

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun run test tests/trim.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the four gates and commit**

```bash
bun run lint && bun run typecheck && bun run test && bun run build
git add -A
git commit -m "feat: add project and issue trimming with a byte budget"
```

---

## Task 8: `trim.ts` — event trimming core

**Files:**
- Modify: `src/trim.ts`, `tests/trim.test.ts`
- Create: `tests/fixtures/event-node.json`, `tests/fixtures/event-python.json`, `tests/fixtures/event-browser.json`, `tests/fixtures/event-chained.json`

**Interfaces:**
- Consumes: everything from Task 7.
- Produces: `trimEvent(raw: JsonValue, options: TrimEventOptions): TrimResult` where

```ts
export interface TrimEventOptions {
  readonly maxFrames: number
  readonly includeBreadcrumbs: boolean
  readonly includeFrameVars: boolean
  /** Test-only seam for injecting a smaller budget. tools.ts never passes it. */
  readonly maxBytes?: number
}
```

- [ ] **Step 1: Write the fixtures**

All four follow the real event shape: top-level `id`, `eventID`, `groupID`, `projectID`, `title`, `message`, `culprit`, `platform`, `dateCreated`, `dateReceived`, `tags` (array of `{ key, value }`), `entries` (array of `{ type, data }`), `contexts`, `packages`, `sdk`, `user`, `_meta`, `errors`.

- `event-node.json` — one `exception` entry, one exception value, 8 frames (frames 5–7 `inApp: true`), a `mechanism` carrying `{ type, handled, synthetic, data: { url: 'https://api.example.com/pay?api_key=SEKRET' } }`, a `request` entry with `url: 'https://app.example.com/checkout?token=SEKRET&x=1'`, `headers: [['Authorization', 'Bearer SEKRET']]`, `cookies`, `env`, and `data`. `user` carries `id`, `email: 'user@example.com'`, `ip_address`, `username`. `contexts` includes `runtime`, `os`, `trace`, and a `state` blob containing the string `SEKRET`. Tags include `release`, `environment`, `level`, `sentry:release`, `session_id: 'SEKRET'`, `auth_token: 'SEKRET'`, plus 40 innocuous tags. `errors` has two entries. One frame carries `vars: { token: 'SEKRET' }`.
- `event-python.json` — 30 frames, of which 4 are `inApp` with an 11-entry `context` each; the innermost inApp frame has one source line 300 characters long; one inApp frame has `lineNo: null` with a 15-entry `context`. `exception.values[0].value` is 2500 characters.
- `event-browser.json` — no `exception` entry; a `threads` entry with two threads, the second having `crashed: true`; a `breadcrumbs` entry with 45 crumbs, each with `timestamp`, `type`, `category`, `level`, `message` (one 400 characters long).
- `event-chained.json` — one `exception` entry with three values (outermost first), each with its own 25-frame stacktrace.

- [ ] **Step 2: Write the failing test**

Append to `tests/trim.test.ts`:

```ts
import { trimEvent } from '../src/trim.js'
import eventBrowser from './fixtures/event-browser.json' with { type: 'json' }
import eventChained from './fixtures/event-chained.json' with { type: 'json' }
import eventNode from './fixtures/event-node.json' with { type: 'json' }
import eventPython from './fixtures/event-python.json' with { type: 'json' }

const BASE = { maxFrames: 20, includeBreadcrumbs: true, includeFrameVars: false } as const

type TrimmedEvent = {
  release?: string
  environment?: string
  level?: string
  user?: Record<string, unknown>
  tags: { key: string; value: string }[]
  contexts: Record<string, unknown>
  request?: { method: string; url: string }
  exception?: {
    values: {
      value: string
      mechanism?: Record<string, unknown>
      stacktrace: { frames: Record<string, unknown>[] }
    }[]
  }
  breadcrumbs?: { message: string }[]
}

function trimNode(overrides: Partial<typeof BASE> = {}) {
  const result = trimEvent(eventNode, { ...BASE, ...overrides })
  return { event: result.data as unknown as TrimmedEvent, result }
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
  })

  it('keeps only the user id', () => {
    expect(trimNode().event.user).toEqual({ id: '42' })
  })

  it('strips the query string from the request url', () => {
    expect(trimNode().event.request?.url).toBe('https://app.example.com/checkout')
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
    const frames = trimNode().event.exception?.values[0]?.stacktrace.frames ?? []
    expect(frames).toHaveLength(8)
  })

  it('always keeps the two innermost frames even when they are not in-app', () => {
    const event = trimEvent(eventPython, { ...BASE, maxFrames: 6 }).data as unknown as TrimmedEvent
    const frames = event.exception?.values[0]?.stacktrace.frames ?? []

    expect(frames).toHaveLength(6)
    expect(frames.at(-1)?.inApp).toBe(false)
    expect(frames.at(-2)?.inApp).toBe(false)
    expect(frames.filter((frame) => frame.inApp === true).length).toBe(4)
  })

  it('preserves outermost-to-innermost order', () => {
    const event = trimEvent(eventPython, { ...BASE, maxFrames: 6 }).data as unknown as TrimmedEvent
    const lines = (event.exception?.values[0]?.stacktrace.frames ?? []).map(
      (frame) => frame.lineNo as number | null,
    )
    const numeric = lines.filter((line): line is number => typeof line === 'number')

    expect(numeric).toEqual([...numeric].sort((a, b) => a - b))
  })

  it('reports omitted frames', () => {
    const result = trimEvent(eventPython, { ...BASE, maxFrames: 6 })
    expect(result.trimmed?.omittedFrames).toBe(24)
  })

  it('drops frame fields that leak build paths', () => {
    const frame = trimNode().event.exception?.values[0]?.stacktrace.frames[0] ?? {}
    expect(frame).not.toHaveProperty('absPath')
    expect(frame).not.toHaveProperty('instructionAddr')
  })
})

describe('trimEvent chained exceptions', () => {
  it('keeps the two innermost values and counts the rest', () => {
    const result = trimEvent(eventChained, BASE)
    const event = result.data as unknown as TrimmedEvent

    expect(event.exception?.values).toHaveLength(2)
    expect(result.trimmed?.omittedExceptionValues).toBe(1)
  })

  it('applies max_frames per stacktrace and sums omitted frames', () => {
    const result = trimEvent(eventChained, { ...BASE, maxFrames: 10 })
    const event = result.data as unknown as TrimmedEvent

    expect(event.exception?.values[0]?.stacktrace.frames).toHaveLength(10)
    expect(event.exception?.values[1]?.stacktrace.frames).toHaveLength(10)
    expect(result.trimmed?.omittedFrames).toBe(30)
  })
})

describe('trimEvent source context', () => {
  it('keeps context only on the three innermost in-app frames', () => {
    const event = trimEvent(eventPython, BASE).data as unknown as TrimmedEvent
    const frames = event.exception?.values[0]?.stacktrace.frames ?? []
    const withContext = frames.filter((frame) => frame.context !== undefined)

    expect(withContext).toHaveLength(3)
    expect(withContext.every((frame) => frame.inApp === true)).toBe(true)
  })

  it('caps each source line at 200 characters and each frame at 11 lines', () => {
    const event = trimEvent(eventPython, BASE).data as unknown as TrimmedEvent
    const frames = event.exception?.values[0]?.stacktrace.frames ?? []
    for (const frame of frames) {
      const context = frame.context as [number, string][] | undefined
      if (!context) continue
      expect(context.length).toBeLessThanOrEqual(11)
      for (const [, text] of context) expect(text.length).toBeLessThanOrEqual(201)
    }
  })

  it('falls back to the first eleven lines when lineNo is missing', () => {
    const event = trimEvent(eventPython, BASE).data as unknown as TrimmedEvent
    const frames = event.exception?.values[0]?.stacktrace.frames ?? []
    const frame = frames.find((candidate) => candidate.lineNo === null)
    const context = frame?.context as [number, string][] | undefined

    expect(context).toHaveLength(11)
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
    expect(result.trimmed?.exceptionSource).toBe('threads')
    expect((result.data as unknown as TrimmedEvent).exception?.values).toHaveLength(1)
  })
})

describe('trimEvent resilience', () => {
  it.each(['entries', 'contexts', 'tags', 'sdk', 'user'])(
    'survives a payload with no %s',
    (key) => {
      const stripped = { ...(eventNode as Record<string, unknown>) }
      delete stripped[key]
      expect(() => trimEvent(stripped as never, BASE)).not.toThrow()
    },
  )

  it('omits zero-valued trimmed keys and drops trimmed entirely when nothing was cut', () => {
    const minimal = { id: '1', eventID: 'a', entries: [], tags: [], contexts: {} }
    expect(trimEvent(minimal as never, BASE).trimmed).toBeUndefined()
  })

  it('never emits static dropped-field lists', () => {
    const serialized = JSON.stringify(trimNode().result.trimmed ?? {})
    expect(serialized).not.toContain('droppedFields')
    expect(serialized).not.toContain('droppedEntries')
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun run test tests/trim.test.ts`
Expected: FAIL — `trimEvent` is not exported.

- [ ] **Step 4: Implement `trimEvent` (without degradation)**

Add these constants and the pipeline. Split into one small function per concern so Biome's complexity 10 holds:

```ts
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

const SECRET_TAG_PATTERN = /(token|secret|password|api[_-]?key|auth|cookie|session|credential)/i
const CONTEXT_WHITELIST = ['runtime', 'os', 'browser', 'device', 'trace'] as const
const LIFTED_TAGS = ['release', 'environment', 'level'] as const
```

Frame selection, verbatim logic:

```ts
function selectFrames(frames: JsonObject[], maxFrames: number): JsonObject[] {
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
    return candidates.slice(candidates.length - maxFrames).map((index) => frames[index] as JsonObject)
  }
  for (let index = frames.length - 1; index >= 0 && kept.size < maxFrames; index -= 1) {
    kept.add(index)
  }
  return [...kept].sort((a, b) => a - b).map((index) => frames[index] as JsonObject)
}
```

Source context, verbatim logic:

```ts
function selectContext(frame: JsonObject): JsonValue | undefined {
  const context = frame.context
  if (!Array.isArray(context)) return undefined
  const lineNo = typeof frame.lineNo === 'number' ? frame.lineNo : undefined
  const window =
    lineNo === undefined
      ? context.slice(0, SOURCE_CONTEXT_LINES)
      : centerOn(context, lineNo, SOURCE_CONTEXT_LINES)
  return window.map((entry) =>
    Array.isArray(entry) && typeof entry[1] === 'string'
      ? [entry[0], truncate(entry[1], SOURCE_LINE_CHARS)]
      : entry,
  ) as JsonValue
}
```

`centerOn(lines, lineNo, size)` finds the index whose first element equals `lineNo` (falling back to the middle when absent) and slices `±Math.floor(size / 2)` clamped to the array bounds.

The pipeline order inside `trimEvent`:

1. Guard that `raw` is an object; otherwise throw `INVALID_RESPONSE`.
2. Read `entries` into a map by `type`.
3. Build `exception.values` from the `exception` entry; if absent, from the `threads` entry (prefer `crashed === true`, else index 0) and set `exceptionSource: 'threads'`.
4. Slice values to the last `MAX_EXCEPTION_VALUES`, recording `omittedExceptionValues`.
5. Per value: truncate `value` to `EXCEPTION_VALUE_CHARS`, reduce `mechanism` to `{ type, handled, synthetic }`, run `selectFrames`, then per frame apply the field whitelist plus `selectContext` for the innermost `SOURCE_CONTEXT_FRAMES` in-app frames only, and include `vars` only when `options.includeFrameVars`.
6. Tags: lift `LIFTED_TAGS`, drop `sentry:` prefixes, drop `SECRET_TAG_PATTERN` key matches, cap at `MAX_TAGS`, truncate key and value, accumulate `omittedTags`.
7. Contexts: whitelist, then keep `type`/`name`/`version` (`trace` keeps `trace_id`/`span_id`/`op`).
8. Breadcrumbs: when `options.includeBreadcrumbs`, take the last `MAX_BREADCRUMBS` of `{ timestamp, type, category, level, message }` with the message truncated; record `omittedBreadcrumbs`.
9. Request: `{ method, url }` where url is `${new URL(raw).origin}${new URL(raw).pathname}` truncated to `REQUEST_URL_CHARS`, guarded by try/catch for unparseable URLs (drop the field on failure).
10. Top level: `id`, `eventID`, `groupID`, `projectID`, `title`/`message`/`culprit` truncated to `TITLE_CHARS`, `platform`, `dateCreated`, `dateReceived`, `sdk` → `{ name, version }`, `user` → `{ id }`, `eventProcessingErrors` from `errors.length`.
11. Assemble `TrimmedMeta` by dropping every zero/undefined entry; if the object ends up empty, omit `trimmed` from the result.
12. `assertWithinBudget` — Task 9 replaces this call with the degradation ladder.

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun run test tests/trim.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the four gates and commit**

```bash
bun run lint && bun run typecheck && bun run test && bun run build
git add -A
git commit -m "feat: add event trimming with frame selection and secret stripping"
```

---

## Task 9: `trim.ts` — the degradation ladder

**Files:**
- Modify: `src/trim.ts`, `tests/trim.test.ts`
- Create: `tests/fixtures/event-oversized.json`

**Interfaces:**
- Consumes: `trimEvent` from Task 8.
- Produces: no new exports. `trimEvent` now honours `options.maxBytes` and populates `trimmed.degraded`.

- [ ] **Step 1: Write the oversized fixture**

`tests/fixtures/event-oversized.json` — one exception value whose `value` is 1900 characters, a stacktrace of **60 frames all `inApp: true`**, each carrying an 11-line `context` with 190-character lines, plus a `breadcrumbs` entry of 100 crumbs each with a 190-character message. Sized so that:

- full trim ≈ 150KB (over a 60KB injected budget, under 200KB),
- minus source context ≈ 35KB,
- minus breadcrumbs ≈ 17KB.

This lets each ladder rung be reached by injecting a different `maxBytes` rather than by building four fixtures.

- [ ] **Step 2: Write the failing test**

Append to `tests/trim.test.ts`:

```ts
import eventOversized from './fixtures/event-oversized.json' with { type: 'json' }

describe('trimEvent degradation ladder', () => {
  it('does not degrade when the payload fits', () => {
    expect(trimEvent(eventOversized, { ...BASE, maxBytes: 400_000 }).trimmed?.degraded)
      .toBeUndefined()
  })

  it('drops source context first', () => {
    const result = trimEvent(eventOversized, { ...BASE, maxBytes: 60_000 })
    const event = result.data as unknown as TrimmedEvent

    expect(result.trimmed?.degraded).toBe('source_context')
    expect(event.breadcrumbs).toBeDefined()
    expect(
      (event.exception?.values[0]?.stacktrace.frames ?? []).every(
        (frame) => frame.context === undefined,
      ),
    ).toBe(true)
  })

  it('drops breadcrumbs second', () => {
    const result = trimEvent(eventOversized, { ...BASE, maxBytes: 25_000 })
    const event = result.data as unknown as TrimmedEvent

    expect(result.trimmed?.degraded).toBe('breadcrumbs')
    expect(event.breadcrumbs).toBeUndefined()
    expect(event.exception?.values[0]?.stacktrace.frames).toHaveLength(20)
  })

  it('reduces frames to ten last and recomputes the counters', () => {
    const result = trimEvent(eventOversized, { ...BASE, maxBytes: 12_000 })
    const event = result.data as unknown as TrimmedEvent

    expect(result.trimmed?.degraded).toBe('frames')
    expect(event.exception?.values[0]?.stacktrace.frames).toHaveLength(10)
    expect(result.trimmed?.omittedFrames).toBe(50)
    expect(result.trimmed?.omittedBreadcrumbs).toBe(100)
  })

  it('throws when even the last rung is too big', () => {
    const error = (() => {
      try {
        trimEvent(eventOversized, { ...BASE, maxBytes: 500 })
        return undefined
      } catch (thrown) {
        return thrown as SentryApiError
      }
    })()

    expect(error?.code).toBe('RESPONSE_TOO_LARGE')
    expect(error?.message).toBe(
      'Sentry event was too large to summarize even after trimming (degraded: frames).',
    )
  })
})
```

Note the two counter expectations in the third case: after the `frames` rung, `omittedFrames` is `60 − 10 = 50` (original total minus final kept, **not** cumulative across rungs) and `omittedBreadcrumbs` is `100 − 0 = 100` (all of them, because the rung removed the section entirely).

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun run test tests/trim.test.ts`
Expected: FAIL — `degraded` is never set and oversized payloads throw immediately.

- [ ] **Step 4: Implement the ladder**

Refactor `trimEvent` so the whole build is a pure function of a settings record, then loop over four rungs:

```ts
interface TrimPass {
  readonly maxFrames: number
  readonly includeBreadcrumbs: boolean
  readonly includeSourceContext: boolean
  readonly degraded?: TrimmedMeta['degraded']
}

export function trimEvent(raw: JsonValue, options: TrimEventOptions): TrimResult {
  const budget = options.maxBytes ?? MAX_TOOL_RESULT_BYTES
  const passes: TrimPass[] = [
    { maxFrames: options.maxFrames, includeBreadcrumbs: options.includeBreadcrumbs, includeSourceContext: true },
    { maxFrames: options.maxFrames, includeBreadcrumbs: options.includeBreadcrumbs, includeSourceContext: false, degraded: 'source_context' },
    { maxFrames: options.maxFrames, includeBreadcrumbs: false, includeSourceContext: false, degraded: 'breadcrumbs' },
    { maxFrames: 10, includeBreadcrumbs: false, includeSourceContext: false, degraded: 'frames' },
  ]

  let last: TrimResult | undefined
  for (const pass of passes) {
    last = buildEvent(raw, options, pass)
    if (measureBytes(last.data) <= budget) return last
  }
  throw new SentryApiError(
    `Sentry event was too large to summarize even after trimming (degraded: ${passes.at(-1)?.degraded}).`,
    { code: 'RESPONSE_TOO_LARGE' },
  )
}
```

`buildEvent(raw, options, pass)` is Task 8's pipeline, parameterized by `pass`, and it stamps `pass.degraded` into `TrimmedMeta` when set. Because every rung rebuilds from `raw`, the counters are naturally "original total − final kept" with no accumulation bookkeeping — that is the whole reason for rebuilding rather than mutating.

Replace the `assertWithinBudget(data)` call at the end of the Task 8 pipeline; `trimProjectList` / `trimIssueList` / `trimIssue` keep using it unchanged.

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun run test tests/trim.test.ts`
Expected: PASS.

- [ ] **Step 6: Run the four gates and commit**

```bash
bun run lint && bun run typecheck && bun run test && bun run build
git add -A
git commit -m "feat: add the event trimming degradation ladder"
```

---

## Task 10: `tools.ts` — schema, registration, and the client→trim seam

**Files:**
- Create: `src/tools.ts`, `tests/tools.test.ts`

**Interfaces:**
- Consumes: `SentryClient` from `client.ts`; every `trim*` from `trim.ts`; `TOOL_I18N` from `locales.ts`; `Locale` from `config.ts`.
- Produces:
  - `OUTPUT_SCHEMA` — one frozen object shared by all five tools.
  - `registerSentryTools(ctx: Context, client: SentryClient, locale: Locale, includeFrameVars: boolean): void`
  - `renderJson(args: unknown, value: JsonValue): { type: 'text'; text: string }[]`

- [ ] **Step 1: Write the failing test**

Create `tests/tools.test.ts`:

```ts
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
    stats: { '24h': Array.from({ length: 336 }, (_v, i) => [i, i]) },
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
      expect(tool.isConcurrencySafe?.()).toBe(true)
      expect(tool.output?.schema).toBe(OUTPUT_SCHEMA)
      expect(tool.presentCall).toBeUndefined()
    }
  })

  it('trims the client payload instead of forwarding it', async () => {
    const searchIssues = vi.fn().mockResolvedValue({ data: RAW_ISSUE_LIST, meta: {} })
    const tools = register({ searchIssues })
    const result = await run(tools.get('sentry_search_issues') as ToolDefinition, {})

    expect(JSON.stringify(result.data)).not.toContain('"stats"')
    expect(result.data).toHaveProperty('issues')
  })

  it('merges cursor and hit metadata from the client', async () => {
    const searchIssues = vi
      .fn()
      .mockResolvedValue({ data: [], meta: { nextCursor: '0:100:0', matchingCount: 9, hasMore: true } })
    const tools = register({ searchIssues })
    const result = await run(tools.get('sentry_search_issues') as ToolDefinition, {})

    expect(result.meta).toEqual({ nextCursor: '0:100:0', matchingCount: 9 })
  })

  it('translates hasMore into truncated and hides the cursor for projects', async () => {
    const listProjects = vi
      .fn()
      .mockResolvedValue({ data: [], meta: { nextCursor: '0:100:0', hasMore: true } })
    const tools = register({ listProjects })
    const result = await run(tools.get('sentry_list_projects') as ToolDefinition, {})

    expect(result.meta).toEqual({ truncated: true })
  })

  it('emits no meta keys outside the schema', async () => {
    const getIssue = vi.fn().mockResolvedValue({ data: { id: '1' }, meta: { nextCursor: 'x' } })
    const tools = register({ getIssue })
    const result = await run(tools.get('sentry_get_issue') as ToolDefinition, { issue: '1' })

    expect(Object.keys(result.meta)).toEqual([])
  })

  it('passes the abort signal through to the client', async () => {
    const getIssue = vi.fn().mockResolvedValue({ data: { id: '1' }, meta: {} })
    const tools = register({ getIssue })
    await run(tools.get('sentry_get_issue') as ToolDefinition, { issue: '1' })

    expect(getIssue).toHaveBeenCalledWith('1', expect.any(AbortSignal))
  })

  it('lets trimming errors escape', async () => {
    const searchIssues = vi.fn().mockResolvedValue({ data: { notAnArray: true }, meta: {} })
    const tools = register({ searchIssues })

    await expect(
      run(tools.get('sentry_search_issues') as ToolDefinition, {}),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
  })

  it('forwards trimmed metadata from the event tools', async () => {
    const getLatestEvent = vi.fn().mockResolvedValue({
      data: { id: '1', eventID: 'a', entries: [], tags: [], contexts: {}, errors: [1, 2] },
      meta: {},
    })
    const tools = register({ getLatestEvent })
    const result = await run(tools.get('sentry_get_latest_event') as ToolDefinition, {
      issue: '1',
    })

    expect(result.meta.trimmed).toMatchObject({ eventProcessingErrors: 2 })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test tests/tools.test.ts`
Expected: FAIL — cannot resolve `../src/tools.js`.

- [ ] **Step 3: Write `src/tools.ts`**

```ts
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
```

Registration follows `dsh-sonarqube`: one private `register*` function per tool, each pulling its text from `TOOL_I18N[locale][name]`:

```ts
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
```

The seam lives in each `execute`. Example for search, the pattern every tool repeats:

```ts
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
}
```

`pickMeta(candidate)` drops every `undefined` entry so the `additionalProperties: false` schema never sees a stray key. Per-tool meta mapping:

- `sentry_list_projects` → `pickMeta({ truncated: trimmed.truncated })`, built from `trimProjectList(result.data, result.meta.hasMore)`. Never forwards `nextCursor`.
- `sentry_search_issues` → `nextCursor` + `matchingCount` only.
- `sentry_get_issue` → `pickMeta({})`, always `{}`.
- `sentry_get_latest_event` / `sentry_get_event` → `pickMeta({ trimmed: trimResult.trimmed })`, calling `trimEvent(result.data, { maxFrames: args.max_frames ?? 20, includeBreadcrumbs: args.include_breadcrumbs ?? true, includeFrameVars })`. **Never pass `maxBytes`.**

Parameter declarations mirror spec §3, with `description` pulled from `text[name].params[key]`. Enums: `stats_period` ∈ `['24h','14d']`, `sort` ∈ `['date','new','freq','user','recommended']`.

`renderJson` is copied verbatim from the skeleton.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test tests/tools.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the four gates and commit**

```bash
bun run lint && bun run typecheck && bun run test && bun run build
git add -A
git commit -m "feat: register the five read-only Sentry tools"
```

---

## Task 11: `index.ts` — plugin entry and Schemastery config

**Files:**
- Create: `src/index.ts`, `tests/plugin.test.ts`

**Interfaces:**
- Consumes: everything.
- Produces: `name`, `inject`, `Config` (type and Schemastery value), `apply(ctx, config)`, plus re-exports of `SentryClient`, `createSentryClient`, `resolveConfig`, `SentryApiError`, `createHttpError`, and the public types.

- [ ] **Step 1: Write the failing test**

Create `tests/plugin.test.ts`:

```ts
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'

import { apply, Config, inject, name } from '../src/index.js'
import { OUTPUT_SCHEMA } from '../src/tools.js'

const pluginIt = Object.hasOwn(globalThis, 'Bun') ? it.skip : it

const BASE = { token: 't', org: 'acme' } as const

function registerWith(config: Record<string, unknown>): Map<string, ToolDefinition> {
  const tools = new Map<string, ToolDefinition>()
  const ctx = {
    tools: { register: (tool: ToolDefinition) => tools.set(tool.name, tool) },
  } as unknown as Context
  apply(ctx, config as never)
  return tools
}

describe('DSH plugin entry', () => {
  it('exports the required identity and tools injection', () => {
    expect(name).toBe('dsh-sentry')
    expect(inject).toEqual(['tools'])
    expect(Config).toBeDefined()
  })

  pluginIt('exposes localized plugin configuration descriptions', () => {
    expect(Config.meta.description).toMatchObject({
      en: 'Read-only Sentry integration settings.',
      'zh-TW': expect.any(String),
      'zh-CN': expect.any(String),
      'ja-JP': expect.any(String),
    })
    expect(Config.dict?.token?.meta.role).toBe('secret')
  })

  pluginIt('offers exactly the four selectable locales', () => {
    expect(Config.dict?.locale?.list?.map((item) => item.value).sort()).toEqual([
      'en',
      'ja',
      'zh-CN',
      'zh-TW',
    ])
  })

  pluginIt('registers five tools sharing one schema and no presentCall', () => {
    const tools = registerWith({ ...BASE })

    expect(tools.size).toBe(5)
    for (const tool of tools.values()) {
      expect(tool.isConcurrencySafe?.()).toBe(true)
      expect(tool.output?.schema).toBe(OUTPUT_SCHEMA)
      expect(tool.presentCall).toBeUndefined()
    }
  })

  pluginIt('keeps tool names in English while switching descriptions by locale', () => {
    const english = registerWith({ ...BASE })
    const traditional = registerWith({ ...BASE, locale: 'zh-TW' })
    const japanese = registerWith({ ...BASE, locale: 'ja' })

    expect([...traditional.keys()].sort()).toEqual([...english.keys()].sort())

    const key = 'sentry_search_issues'
    const englishText = english.get(key)?.description ?? ''
    expect(traditional.get(key)?.description).not.toBe(englishText)
    expect(japanese.get(key)?.description).not.toBe(englishText)
    expect(japanese.get(key)?.description).not.toBe(traditional.get(key)?.description)
    expect(englishText.startsWith('Search Sentry issues')).toBe(true)
  })

  pluginIt('renders output as a single text block', () => {
    const tool = registerWith({ ...BASE }).get('sentry_get_issue')
    const rendered = tool?.output?.render?.({}, { data: { id: '1' }, meta: {} } as never)

    expect(rendered).toEqual([{ type: 'text', text: '{"data":{"id":"1"},"meta":{}}' }])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test tests/plugin.test.ts`
Expected: FAIL — cannot resolve `../src/index.js`.

- [ ] **Step 3: Write `src/index.ts`**

Model it on `~/side/ankey/dsh-sonarqube/src/index.ts`:

```ts
export const name = 'dsh-sentry'
export const inject = ['tools']

export type Config = SentryConfig

export const Config: Schema<Config> = Schema.object({
  baseUrl: Schema.string().default(DEFAULT_BASE_URL),
  token: Schema.string().role('secret'),
  org: Schema.string(),
  locale: Schema.union(LOCALES.map((locale) => Schema.const(locale))).default('en'),
  includeFrameVars: Schema.boolean().default(false),
  requestTimeoutMs: Schema.number()
    .step(1)
    .min(1)
    .max(MAX_REQUEST_TIMEOUT_MS)
    .default(DEFAULT_REQUEST_TIMEOUT_MS),
  maxResponseBytes: Schema.number()
    .step(1)
    .min(1)
    .max(MAX_RESPONSE_BYTES)
    .default(DEFAULT_MAX_RESPONSE_BYTES),
}).i18n(CONFIG_I18N)

/** Creates the client and registers all read-only tools. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const client = new SentryClient(resolved)
  registerSentryTools(ctx, client, resolved.locale, resolved.includeFrameVars)
}
```

`apply` resolves config **once** and passes `locale` and `includeFrameVars` down, so the client and the tools always agree on the same resolved values.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun run test tests/plugin.test.ts`
Expected: PASS.

- [ ] **Step 5: Verify the whole suite and coverage gate**

Run: `bun run test --coverage`
Expected: PASS with all four coverage metrics ≥ 80%. If a metric falls short, add the missing cases to the owning test file — do not lower the threshold.

- [ ] **Step 6: Run the four gates and commit**

```bash
bun run lint && bun run typecheck && bun run test && bun run build
git add -A
git commit -m "feat: add the dsh-sentry plugin entry point"
```

---

## Task 12: Four-language README

**Files:**
- Create: `README.md`, `README.zh-TW.md`, `README.zh-CN.md`, `README.ja.md`

**Interfaces:**
- Consumes: the finished tool set and config schema.
- Produces: documentation only.

- [ ] **Step 1: Write `README.md`**

Base the structure on `~/side/ankey/dsh-sonarqube/README.md`. Required sections, in order:

1. Title plus the four-language link line: `English | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)`.
2. One-paragraph description: read-only, GET-only, trims responses so an agent's context survives.
3. **Tools** table — five rows, name plus one-line purpose.
4. **Requirements** — DSH with compatible `@deepseek-ai/dsh-tools`, Node 22.19+/24+, Bun 1.3.5 for source installs, a Sentry auth token.
5. **Token scopes** table — `org:read`, `project:read`, `event:read` with the endpoints each unlocks; recommend `sentry auth login --read-only`.
6. **Configuration** table — every field from spec §5 including `locale`, with defaults and env var names. Call out that `requestTimeoutMs` is a deadline for the **whole tool call**, including the extra request a short id costs.
7. **Self-hosted and regions** — self-hosted root URL, sub-path installs, `https://de.sentry.io/` for the EU region, and the note that a wrong region shows up as 401/404.
8. **What gets trimmed** — the static discard list (frame vars, request headers/bodies/query strings, packages, `contexts.state`, user email/IP/username, secret-looking tags, `mechanism.data`), the frame selection rule, and the source-context limits. This is the section that replaces per-response `droppedFields`.
9. **Localization** — descriptions switch on `locale`; **tool names and error messages stay English**.
10. **Security and error behavior** — bearer token never returned or logged; honours the tool `AbortSignal`; error bodies are never embedded **except** the filtered HTTP-400 `detail`, which is capped at 200 characters and dropped entirely when it looks like it contains a secret; therefore `INVALID_QUERY` messages come in two shapes.
11. **Limitations (v0.1)** — the non-goals list from spec §8, notably: no writes, one organization only, `24h`/`14d` only, no auto-pagination, `sentry_list_projects` caps at 100 projects.
12. **Development** — the four commands plus `bun pm pack`; tests use mocked `fetch` and need no live Sentry.
13. **License** — MIT.

Leave the live-verification line as a placeholder sentence pointing at Task 14; that task fills in the real date and version.

- [ ] **Step 2: Write the three translations**

`README.zh-TW.md`, `README.zh-CN.md`, `README.ja.md` carry the same 13 sections with the language link line reordered so the current language is plain text. Tool names, config keys, env var names, endpoint paths, and error codes stay in English in all four files.

- [ ] **Step 3: Verify the language links resolve**

Run:

```bash
for f in README.md README.zh-TW.md README.zh-CN.md README.ja.md; do
  grep -o 'README\.[a-zA-Z-]*\.md' "$f" | sort -u | while read -r link; do
    test -f "$link" || echo "BROKEN $f -> $link"
  done
done
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs: add four-language README"
```

---

## Task 13: CI and release workflows

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/release.yml`

**Interfaces:**
- Consumes: the npm scripts from Task 1 and the `files` array from `package.json`.
- Produces: CI gates and a tag-triggered release.

- [ ] **Step 1: Write `.github/workflows/ci.yml`**

Copy `~/side/ankey/dsh-sonarqube/.github/workflows/ci.yml` and change the tarball glob and the packed-file assertions:

```yaml
      - name: Pack smoke test
        run: |
          mkdir -p artifacts
          bun pm pack --destination artifacts
          tarball="$(find artifacts -name 'dsh-sentry-*.tgz' -print -quit)"
          test -n "$tarball"
          tar -tzf "$tarball" | tee /tmp/package-files.txt
          grep -q 'package/lib/index.js' /tmp/package-files.txt
          grep -q 'package/lib/index.d.ts' /tmp/package-files.txt
          grep -q 'package/lib/locales.js' /tmp/package-files.txt
          grep -q 'package/lib/locales.d.ts' /tmp/package-files.txt
          grep -q 'package/cordis.patch.yml' /tmp/package-files.txt
          grep -q 'package/README.md' /tmp/package-files.txt
          grep -q 'package/README.zh-TW.md' /tmp/package-files.txt
          grep -q 'package/README.zh-CN.md' /tmp/package-files.txt
          grep -q 'package/README.ja.md' /tmp/package-files.txt
          grep -q 'package/LICENSE' /tmp/package-files.txt
```

Keep the second job unchanged: Node `22.19.0` and `24` matrix, `bun run build`, `node node_modules/vitest/vitest.mjs run`, then `node --input-type=module --eval "await import('./lib/index.js')"`.

- [ ] **Step 2: Write `.github/workflows/release.yml`**

```yaml
name: Release

on:
  push:
    tags:
      - 'v*'

permissions:
  contents: write

jobs:
  release:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.5
      - run: bun install --frozen-lockfile
      - run: bun run lint
      - run: bun run typecheck
      - run: bun run test --coverage
      - run: bun run build
      - name: Verify tag and build tarball
        run: |
          PACKAGE_VERSION="$(node --print "require('./package.json').version")"
          test "$GITHUB_REF_NAME" = "v${PACKAGE_VERSION}"
          bun pm pack
          PACKAGE_TARBALL="dsh-sentry-${PACKAGE_VERSION}.tgz"
          tar --list --gzip --file "$PACKAGE_TARBALL"
          cp "$PACKAGE_TARBALL" dsh-sentry.tgz
          sha256sum "$PACKAGE_TARBALL" dsh-sentry.tgz >SHA256SUMS
          echo "PACKAGE_TARBALL=$PACKAGE_TARBALL" >>"$GITHUB_ENV"
      - name: Publish GitHub release
        env:
          GH_TOKEN: ${{ github.token }}
        run: >-
          gh release create "$GITHUB_REF_NAME" "$PACKAGE_TARBALL" dsh-sentry.tgz SHA256SUMS
          --verify-tag --generate-notes
```

Two things here are load-bearing and must not be "simplified":

- `echo "PACKAGE_TARBALL=…" >>"$GITHUB_ENV"` — shell variables do not survive across steps. `dsh-forge` v0.3.2 broke on exactly this.
- The `cp` to the unversioned `dsh-sentry.tgz` — it keeps `releases/latest/download/dsh-sentry.tgz` working across versions.

- [ ] **Step 3: Verify the pack assertions locally**

Run:

```bash
bun run build
mkdir -p artifacts && bun pm pack --destination artifacts
tar -tzf artifacts/dsh-sentry-0.1.0.tgz | grep -E 'lib/index\.(js|d\.ts)|lib/locales\.(js|d\.ts)|cordis\.patch\.yml|README|LICENSE'
rm -rf artifacts
```

Expected: every asserted path appears in the listing.

- [ ] **Step 4: Commit and push**

```bash
git add -A
git commit -m "ci: add verification and release workflows"
git push
```

Then confirm the CI run is green: `gh run watch` (or `gh run list --limit 1`).

---

## Task 14: Live verification and v0.1.0 release

**Files:**
- Modify: `README.md`, `README.zh-TW.md`, `README.zh-CN.md`, `README.ja.md`, and — only if a check fails — `src/client.ts`, `src/trim.ts`, `src/locales.ts`

**Interfaces:**
- Consumes: the built plugin.
- Produces: a verified, released v0.1.0.

This task runs against a real Sentry. Spec §9.8 is the authority; each row there names the fallback if a check fails. Work through V1–V10 in order.

- [ ] **Step 1: Prepare two live targets**

```bash
export SENTRY_AUTH_TOKEN='<read-only token>'
export SENTRY_ORG='<org slug>'
# SaaS first, then repeat everything against the self-hosted instance:
export SENTRY_URL='https://sentry.io/'
```

- [ ] **Step 2: Run the checks**

Drive the built client from a scratch Node script (outside the repo, or delete it afterwards — it is not part of the package):

```bash
node --input-type=module --eval "
  const { createSentryClient } = await import('./lib/index.js')
  const client = createSentryClient()
  console.log(JSON.stringify((await client.listProjects()).data).slice(0, 400))
"
```

Cover, in order: V1 (`statsPeriod` `24h` and `14d` both accepted), V2 (whether `7d`/`30d`/`90d` also work — record only), V3 (`shortids` exists and returns a numeric `groupId`), V4 (org-level search with no `project` parameter returns results), V5 (an org auth token reaches `/issues/{id}/` and `/events/latest/`), V6 (`sort=recommended` returns 400 on self-hosted), V7 (list endpoints return a JSON array and carry `Link`/`X-Hits`), V8 (a deliberately malformed query returns a `detail` string), V9 (**blocking** — a real event's `entries`/`context`/frame ordering matches spec §4), V10 (measure real trimmed sizes).

- [ ] **Step 3: Apply any fallbacks**

For each failed check, apply that row's fallback from spec §9.8 and add a regression test to the owning test file. **V9 is blocking**: a shape mismatch means spec §4 is wrong, so stop, fix the spec, then fix `trim.ts` and the fixtures. Do not adjust a fixture to match a broken assumption.

- [ ] **Step 4: Record the results in all four READMEs**

Replace the placeholder line from Task 12 with the real sentence, in each language:

> Live compatibility was manually validated on YYYY-MM-DD against Sentry SaaS and self-hosted Sentry `<version>`. This does not imply compatibility with every Sentry release; verify the plugin against your own instance before relying on it in CI.

- [ ] **Step 5: Commit, tag, and release**

```bash
bun run lint && bun run typecheck && bun run test --coverage && bun run build
git add -A
git commit -m "docs: record live Sentry verification results"
git push
git tag v0.1.0
git push origin v0.1.0
gh run watch
```

Expected: the Release workflow publishes a GitHub release carrying `dsh-sentry-0.1.0.tgz`, `dsh-sentry.tgz`, and `SHA256SUMS`.

- [ ] **Step 6: Publish to npm**

```bash
npm whoami   # must print: maxhsu
npm publish
```

Expected: `dsh-sentry@0.1.0` is public on npm. Confirm the tarball carries `cordis.patch.yml`:

```bash
npm pack dsh-sentry@0.1.0 --dry-run
```

---

## Self-Review

**Spec coverage.** Every spec section maps to a task: §2.1/§2.2 → Task 3 (`normalizeBaseUrl`, optional-field tolerance) and Task 12 (region docs); §2.3 → Task 5 (bearer header) and Task 12 (scope table); §2.4 → Task 5 (`Link`, `X-Hits`); §2.5 → Tasks 3 and 5 (pattern constants); §3.0/§3.0.1 → Tasks 4 and 10; §3.1–§3.5 → Tasks 6 and 10; §4.1–§4.7 and §4.9 → Task 8; §4.8 → Task 9; §5 → Tasks 3 and 11; §6.1 → Task 2; §6.2 → Tasks 2 and 5; §7.1 → Task 10 (seam) verified by `tests/tools.test.ts`; §8 → Tasks 10 and 12 (nothing to implement — the "no writes / no presentCall" constraints are asserted in `tests/tools.test.ts` and `tests/plugin.test.ts`); §9.1–§9.7 → Tasks 2–13; §9.8 → Task 14; §10 → Tasks 1 and 13.

**Placeholder scan.** No "TBD", no "add error handling", no "similar to Task N", no test step without runnable code. The four translation blocks in Task 4 and the three README translations in Task 12 are the only prose-authoring steps; both name their exact required keys and sections, so neither is open-ended.

**Type consistency.** `TransportMeta.hasMore` is produced in Task 5's `parseTransportMeta`, consumed in Task 10's `trimProjectList(result.data, result.meta.hasMore)`, and never leaves as `hasMore` — it becomes `meta.truncated`. `TrimResult.trimmed` is `TrimmedMeta | undefined` throughout. `trimEvent`'s option bag is `TrimEventOptions` in Tasks 8, 9, and 10, and `maxBytes` is passed only by tests. `SLUG_PATTERN` is defined once in `config.ts` and re-exported from `client.ts` so `org` and `project_slug` cannot drift apart. `createHttpError(status, ctx)` has the same two-argument shape in Tasks 2, 5, and 6.

**One deliberate ordering note.** Task 5's tests call `getIssue` and `searchIssues` before Task 6 implements their parameter handling; Task 5 Step 3 therefore ends by adding minimal stubs for exactly those two methods. That is intentional — it keeps the transport contract testable without dragging endpoint validation into the same red-green cycle.
