# Live verification — spec §9.8 (V1–V10)

Spec §9.8 requires this checklist to be run against **two** environments before the v0.1.0 tag:

1. Sentry SaaS (`https://sentry.io/`)
2. A self-hosted Sentry instance (record its version)

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

Run it once per environment and paste the observed values into the tables below.

## Environment A — Sentry SaaS

- Date run: _not yet run_
- Sentry version: SaaS (rolling)
- Token type: _org auth token / user auth token_
- Runner: _name_

| # | Hypothesis | Decided value | Observed | Verdict |
| --- | --- | --- | --- | --- |
| V1 | `statsPeriod=24h` and `14d` accepted | enum keeps only these two | _fill in_ | _pass / fail_ |
| V2 | wider `statsPeriod` (`7d`/`30d`/`90d`) available | not exposed in v0.1 | _fill in_ | _note only_ |
| V3 | `shortids/{short_id}/` exists and returns a usable `groupId` | short ids resolve automatically | _fill in_ | _pass / fail_ |
| V4 | org-level issue search works with no `project` parameter | no project filter at org level | _fill in_ | _pass / fail_ |
| V5 | the token reaches `/issues/{id}/` and `/events/latest/` | README recommends an org auth token | _fill in_ | _pass / fail_ |
| V6 | `sort=recommended` returns HTTP 400 | mapped to `UNSUPPORTED_BY_INSTANCE` | _fill in_ | _pass / fail_ |
| V7 | list endpoints return a top-level array plus `Link` / `X-Hits` | client parses both headers | _fill in_ | _pass / fail_ |
| V8 | a 400 body carries a string `detail` | `sanitizeUpstreamDetail` reads `detail` then `error` | _fill in_ | _pass / fail_ |
| V9 | event field shapes match §4 (`entries` array, `[lineNo, text]` context pairs, frames outermost first, `exception.values` outermost first) | all of §4 | _fill in_ | **blocking if it fails** |
| V10 | trimmed sizes land in range (issue list of 25: 12–20KB, single event < 60KB) | `MAX_TOOL_RESULT_BYTES = 200_000` | _fill in_ | _pass / fail_ |

## Environment B — self-hosted

- Date run: _not yet run_
- Sentry version: _fill in_
- Token type: _fill in_
- Runner: _name_

| # | Hypothesis | Decided value | Observed | Verdict |
| --- | --- | --- | --- | --- |
| V1 | `statsPeriod=24h` and `14d` accepted | enum keeps only these two | _fill in_ | _pass / fail_ |
| V2 | wider `statsPeriod` (`7d`/`30d`/`90d`) available | not exposed in v0.1 | _fill in_ | _note only_ |
| V3 | `shortids/{short_id}/` exists and returns a usable `groupId` | short ids resolve automatically | _fill in_ | _pass / fail_ |
| V4 | org-level issue search works with no `project` parameter | no project filter at org level | _fill in_ | _pass / fail_ |
| V5 | the token reaches `/issues/{id}/` and `/events/latest/` | README recommends an org auth token | _fill in_ | _pass / fail_ |
| V6 | `sort=recommended` returns HTTP 400 | mapped to `UNSUPPORTED_BY_INSTANCE` | _fill in_ | _pass / fail_ |
| V7 | list endpoints return a top-level array plus `Link` / `X-Hits` | client parses both headers | _fill in_ | _pass / fail_ |
| V8 | a 400 body carries a string `detail` | `sanitizeUpstreamDetail` reads `detail` then `error` | _fill in_ | _pass / fail_ |
| V9 | event field shapes match §4 | all of §4 | _fill in_ | **blocking if it fails** |
| V10 | trimmed sizes land in range | `MAX_TOOL_RESULT_BYTES = 200_000` | _fill in_ | _pass / fail_ |

## Fallbacks when a check fails

Spec §9.8 lists a decided fallback per row. The two that gate the release:

- **V9** — a field-shape mismatch is a blocker: fix §4 and the trimmer before tagging, do not paper over it.
- **V4** — if the instance demands a `project` parameter, either always send `project=-1` or make
  `project_slug` required and drop the org-level path (§3.2 and D4 change with it).

## After both environments pass

Update the verification paragraph in all four READMEs (`README.md`, `README.zh-TW.md`,
`README.zh-CN.md`, `README.ja.md`) with the run date and the self-hosted Sentry version.
