# Live verification — spec §9.8 (V1–V10)

Spec §9.8 requires this checklist to be measured against **two** environments before the v0.1.0 tag:

1. Sentry SaaS (`https://sentry.io/`) — **run on 2026-08-27, recorded below**
2. A self-hosted Sentry instance — **not yet run**

The unit test suite mocks `fetch` and cannot answer any of these questions.

## How to run

```bash
bun run build                        # the script imports lib/, so always build first
export SENTRY_TOKEN=...              # required
export SENTRY_ORG=...                # required
export SENTRY_URL=https://sentry.io/ # optional, defaults to sentry.io
export SENTRY_PROJECT=...            # optional, enables the project-scoped V4 check
export SENTRY_SHORT_ID=PROJ-1AB      # optional, enables V3
node scripts/live-verify.mjs
```

The script is read-only — every request is a GET through the plugin's own client. It exits 1 when a
required environment variable is missing or when any check throws.

## Environment A — Sentry SaaS

- Date run: **2026-08-27**
- Sentry version: SaaS (rolling)
- Organization: `commeet` (projects `apple-ios`, `apple-ios22222` — both iOS, no other platform)
- Token type: **User Auth Token** (`sntryu_`), scopes `event:read`, `org:read`, `project:read`
- Sample data used: issue `7692741675`, event `7c46babad81b445eabd02df9b7760857`, short id `APPLE-IOS-41`

| # | Hypothesis | Decided value | Observed on 2026-08-27 | Verdict |
| --- | --- | --- | --- | --- |
| V1 | `statsPeriod=24h` and `14d` accepted | enum keeps only these two | `24h` → 2 issues, `14d` → 13 issues | ✅ holds |
| V2 | wider `statsPeriod` available | not exposed in v0.1 | `7d`, `30d`, `90d` **all accepted** | ⚠️ decided value too conservative — see below |
| V3 | `shortids/{short_id}/` exists and returns a usable `groupId` | short ids resolve automatically | **failed**: `APPLE-IOS-41` rejected with `INVALID_INPUT` before any request | ❌ → fixed, see below |
| V4 | org-level issue search works with no `project` parameter | no project filter at org level | org level: 13 issues; project `apple-ios`: 12 issues | ✅ holds |
| V5 | an Org Auth Token reaches `/issues/{id}/` and `/events/latest/` | README recommends an org auth token | Org Auth Token (`sntrys_`) → **HTTP 403**; User Auth Token → issue `7692741675` and latest event `7c46babad81b445eabd02df9b7760857` both read fine | ⚠️ decided value wrong — fallback taken |
| V6 | `sort=recommended` returns HTTP 400 | mapped to `UNSUPPORTED_BY_INSTANCE` | SaaS **accepts** `sort=recommended`; no 400 raised | ⚠️ holds on SaaS by not applying; self-hosted **not verified** |
| V7 | list endpoints return a top-level array plus `Link` / `X-Hits` | client parses both headers | issues and projects both top-level arrays; `matchingCount` = 13; `nextCursor` absent | ✅ holds |
| V8 | a 400 body carries a string `detail` | `sanitizeUpstreamDetail` reads `detail` then `error` | **not verified** — the deliberately malformed query was accepted by Sentry, so no 400 body existed to inspect | ⚠️ unverified |
| V9 | event field shapes match §4 | all of §4 | partially verified — see below | ⚠️ partially verified |
| V10 | trimmed sizes land in range | `MAX_TOOL_RESULT_BYTES = 200_000` | issue list (25): **7610 bytes**; single event: **7255 bytes** | ✅ holds, far under budget |

### V2 — wider statsPeriod values are available

`7d`, `30d`, and `90d` were all accepted by SaaS. Per the spec's own fallback for this row, v0.1
does **not** change: the enum stays at `24h` / `14d`. Recorded here as a v0.2 candidate for
widening, once the same values are confirmed on a self-hosted instance.

### V3 — hyphenated project slugs broke every short id (blocker, fixed)

`SHORT_ID_PATTERN` was `/^[A-Z0-9][A-Z0-9_]*-[A-Z0-9]+$/`, which allows only one hyphen. A Sentry
short id is `<project slug upper-cased>-<counter>` and a project slug may itself contain hyphens, so
`APPLE-IOS-41` (project `apple-ios`) and `APPLE-IOS22222-5` were rejected as `INVALID_INPUT` before
any request went out. Every project with a hyphenated slug therefore lost the short id path — the
identifier humans actually paste, since it is what the Sentry UI and notification emails show.

Three rounds of code review did not catch this; only a real org did.

Fixed in `d3209ad` by widening the first segment to `/^[A-Z0-9][A-Z0-9_-]*-[A-Z0-9]+$/`. The
ambiguity that motivated the tighter pattern does not come back: `#resolveIssueId` tests
`NUMERIC_ID_PATTERN` first, so a purely numeric id never reaches this branch, and a leading hyphen
is still rejected.

**Verified against the built `lib/`** (mocked transport, both directions): `APPLE-IOS-41`,
`APPLE-IOS22222-5`, `MY_PROJ-WEB-1A` and their lower-case forms all take
`/organizations/{org}/shortids/…/` then `/issues/{groupId}/`; `123456` stays on the single-request
numeric path; `-A-1`, `-APPLE-IOS-41`, `APPLE-IOS-`, `APPLE.IOS-41`, empty, and over-long input are
still rejected before any request.

**Live re-run against sentry.io: still pending.** Re-run `SENTRY_SHORT_ID=APPLE-IOS-41
node scripts/live-verify.mjs` and replace this paragraph with the observed `groupId`. Until then V3
counts as fixed-but-unconfirmed against a real instance.

### V5 — Org Auth Tokens cannot read issues (decided value wrong, fallback taken)

The Org Auth Token (`sntrys_`) returned **HTTP 403** on `/issues/{id}/`. This is by design, not a
misconfiguration: Sentry's *Create Organization Token* page fixes the scope set to `org:ci`
(Source Map Upload, Release Creation, Code Mappings) with no way to add read scopes. Organization
tokens are a CI-upload credential and cannot serve this plugin's read paths at all.

Spec §9.8's fallback for V5 applies: **the README now recommends a User Auth Token** (`sntryu_`)
with `event:read`, `org:read`, `project:read`. Verified working on issue `7692741675` and latest
event `7c46babad81b445eabd02df9b7760857`. All four READMEs and spec §9.8 were updated to match.

### V6 — sort=recommended is accepted on SaaS

SaaS did not return 400. `createHttpError` only maps this to `UNSUPPORTED_BY_INSTANCE` when the
status *is* 400, so nothing misfires — the mapping simply never triggers on SaaS. **The self-hosted
behaviour that motivated the mapping remains unverified**; keep the mapping until Environment B is
run.

### V8 — not verified

The check sends a deliberately malformed query and inspects the resulting 400 body. SaaS **accepted**
the malformed query, so there was no 400 response and no body to read. The assumption behind
`sanitizeUpstreamDetail` — that a 400 body carries a string `detail` field, with `error` as the
fallback — is therefore **still unverified against a real Sentry**. It needs either a query Sentry
genuinely rejects or a self-hosted instance that is stricter.

### V9 — partially verified

Confirmed against the real event:

- `entries` is an array, with entry types `exception`, `threads`, `breadcrumbs`, `debugmeta`
- `exception.values` is an array
- the stacktrace carried 24 frames, ordered as §4 assumes

**Not verified: the `context` field's `[lineNo, sourceText]` pair shape.** The org contains only iOS
projects, and natively symbolicated stacktraces carry no source context, so no frame in the sample
had a `context` field at all. The *absent*-context path is well covered — V9 and V10 both completed
successfully on this data — but the *present*-context path, which §4's centering and line-truncation
rules exist for, has still only ever been exercised against fixtures. Re-run V9 against an org with
a JavaScript, Python, or other source-mapped project to close this.

Spec §9.8 marks a V9 mismatch as blocking. Nothing mismatched here; one sub-assumption is simply
unmeasured, which is why this row is ⚠️ rather than ✅.

## Environment B — self-hosted

**Not yet run.** Every row below is unverified.

- Date run: _not yet run_
- Sentry version: _fill in — the READMEs must record this_
- Token type: _fill in_

| # | Hypothesis | Decided value | Observed | Verdict |
| --- | --- | --- | --- | --- |
| V1 | `statsPeriod=24h` and `14d` accepted | enum keeps only these two | _not verified_ | _pending_ |
| V2 | wider `statsPeriod` available | not exposed in v0.1 | _not verified_ | _pending_ |
| V3 | `shortids/{short_id}/` exists and returns a usable `groupId` | short ids resolve automatically | _not verified_ | _pending_ |
| V4 | org-level issue search works with no `project` parameter | no project filter at org level | _not verified_ | _pending_ |
| V5 | the recommended token reaches issue and event endpoints | User Auth Token, `event:read` / `org:read` / `project:read` | _not verified_ | _pending_ |
| V6 | `sort=recommended` returns HTTP 400 | mapped to `UNSUPPORTED_BY_INSTANCE` | _not verified — this is the environment the mapping was written for_ | _pending_ |
| V7 | list endpoints return a top-level array plus `Link` / `X-Hits` | client parses both headers | _not verified_ | _pending_ |
| V8 | a 400 body carries a string `detail` | `sanitizeUpstreamDetail` reads `detail` then `error` | _not verified — also unverified on SaaS_ | _pending_ |
| V9 | event field shapes match §4 | all of §4 | _not verified_ | **blocking if it fails** |
| V10 | trimmed sizes land in range | `MAX_TOOL_RESULT_BYTES = 200_000` | _not verified_ | _pending_ |

## Outstanding before v0.1.0

1. Re-run V3 against sentry.io and record the resolved `groupId`.
2. Run the whole checklist against a self-hosted instance and record its version in all four READMEs.
3. Close V8 (400 body shape) and the V9 source-`context` sub-assumption — neither is measured yet.
