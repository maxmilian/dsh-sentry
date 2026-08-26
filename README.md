# dsh-sentry

English | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

`dsh-sentry` is a free, open-source, read-only DeepSeek Harness plugin for the Sentry Web API.
Every tool is an HTTP `GET`; the plugin never resolves, assigns, archives, or otherwise changes
Sentry state.

Its main job is not proxying the API — it is **trimming responses so an agent's context survives a
real stacktrace**. A raw `events/latest/` payload is routinely 200KB–2MB. This plugin reduces it to
the frames, source lines, and metadata that actually help debugging, and tells you in `meta.trimmed`
what it had to leave out.

## Tools

| Tool | Purpose |
| --- | --- |
| `sentry_list_projects` | List up to 100 projects in the configured organization. |
| `sentry_search_issues` | Search issues with Sentry search syntax, in one project or the whole organization. |
| `sentry_get_issue` | Read one issue by numeric id or short id, without event bodies. |
| `sentry_get_latest_event` | Read an issue's latest event with a trimmed stacktrace. |
| `sentry_get_event` | Read one event by id within a project, with the same trimming. |

All tools are read-only. Version 0.1 does not modify issues, create releases, or send events.

## Requirements

- DeepSeek Harness with compatible `@deepseek-ai/dsh-tools` APIs
- Node.js 22.19 or newer in the 22.x line, or Node.js 24 or newer
- Bun 1.3.5 or newer when installing from GitHub source or developing locally
- A Sentry auth token with read access to the requested organization

## Token scopes

| Scope | Unlocks |
| --- | --- |
| `org:read` | `/organizations/{org}/projects/`, `/organizations/{org}/issues/`, `/organizations/{org}/shortids/{short_id}/` |
| `project:read` | `/projects/{org}/{project}/issues/` |
| `event:read` | `/issues/{id}/`, `/issues/{id}/events/latest/`, `/projects/{org}/{project}/events/{event_id}/` |

The simplest safe token comes from `sentry auth login --read-only`, which requests exactly
`project:read`, `org:read`, `event:read`, `member:read`, and `team:read`.

## Configuration

| Field | Environment variable | Default | Notes |
| --- | --- | --- | --- |
| `baseUrl` | `SENTRY_URL` | `https://sentry.io/` | Site root URL. Use `https://de.sentry.io/` for the EU region. A trailing `/api/0` is stripped automatically. |
| `token` | `SENTRY_AUTH_TOKEN` | required | User or organization auth token. Never returned or logged. |
| `org` | `SENTRY_ORG` | required | Organization slug. Fixed for the whole plugin instance. |
| `locale` | — | `en` | `en`, `zh-TW`, `zh-CN`, or `ja`. Selects the language of tool and parameter descriptions. |
| `includeFrameVars` | `SENTRY_INCLUDE_FRAME_VARS` | `false` | Keep stack frame local variables. Only the literal string `true` enables it. Agents cannot override this. |
| `requestTimeoutMs` | — | `30000` | Deadline for **one whole tool call**, including the extra request a short id costs. Range 1–300000. |
| `maxResponseBytes` | — | `5242880` | Hard cap on a single HTTP response body. Range 1–52428800. |

Plugin configuration always wins over environment variables.

```sh
export SENTRY_AUTH_TOKEN='your-token'
export SENTRY_ORG='your-org'
# self-hosted or EU region only:
export SENTRY_URL='https://sentry.example.com'
```

## Self-hosted and regions

- Self-hosted: point `baseUrl` at the site root, including a sub-path install such as
  `https://example.com/sentry/`.
- Sentry SaaS EU region: `baseUrl` must be `https://de.sentry.io/`. Using `https://sentry.io/` for an
  EU organization surfaces as a 401 or 404, so both of those error messages repeat the region hint.
- Older self-hosted versions simply return fewer fields. The plugin treats every response field as
  optional and never fails because one is missing. Two known behavior differences: `sort=recommended`
  can be rejected (reported as `UNSUPPORTED_BY_INSTANCE`), and `stats_period` is limited to `24h` and
  `14d`.

## What gets trimmed

Removed from every event, unconditionally:

- Request headers, cookies, environment, and body. The request URL keeps only origin and path — the
  query string is dropped whole, because OAuth callbacks and signed URLs carry secrets there.
- Stack frame local variables, unless `includeFrameVars` is on.
- `mechanism.data`, `contexts.state`, `packages`, `modules`, and `_meta`.
- `user.email`, `user.ip_address`, and `user.username`. Only `user.id` survives.
- Any tag whose key looks like a secret (`token`, `secret`, `password`, `api_key`, `auth`, `cookie`,
  `session`, `credential`), plus every `sentry:`-prefixed internal tag.
- Frame fields that leak build paths, such as `absPath`.

Reduced rather than removed:

- **Frames.** Frames run outermost to innermost. When there are more than `max_frames`, the plugin
  keeps every in-app frame plus the two innermost frames, then fills from the tail, and preserves the
  original order.
- **Source context.** Kept only for the three innermost in-app frames, at most 11 lines each, each
  line capped at 200 characters.
- **Chained exceptions.** At most the two innermost `exception.values`; `max_frames` applies to each
  stacktrace separately.
- **Breadcrumbs.** The last 20, messages capped at 200 characters.
- **Strings.** Exception values cap at 2000 characters; titles, messages, and culprits at 500.

If the result still exceeds the 200KB tool-result budget, the plugin degrades in fixed steps —
source context, then breadcrumbs, then frames down to 10 — and reports the last step it applied in
`meta.trimmed.degraded`. Counters such as `omittedFrames` are always "original total minus what you
received", never a running tally.

## Localization

Tool and parameter descriptions follow `locale`. **Tool names are always English and never change**,
because they are the agent's calling identifiers. **Error messages are always English** as well: they
are stable diagnostic strings that tests and reviews compare against.

## Security and error behavior

- Uses `Authorization: Bearer ...` and never returns or logs the token.
- Honors the DSH tool `AbortSignal` and a per-call deadline; a short id costs a second HTTP request
  but shares the same deadline.
- Converts HTTP 401, 403, 404, 429, and 5xx into safe structured errors that never carry a response
  body.
- **One deliberate exception:** on HTTP 400 from an issue search, the plugin reads at most 64KB of
  the body, takes only the structured `detail` or `error` string, drops it entirely if it contains
  the token or looks like it carries a secret, caps it at 200 characters, and appends it as
  `Sentry said: ...`. Without that, an agent can only guess at a search-syntax error. When the body
  is HTML, unparseable, or filtered out, the message falls back to the static form — so
  `INVALID_QUERY` messages come in two shapes.
- Does not support disabling TLS verification or self-signed certificate bypass in v0.1.

## Limitations (v0.1)

- No writes of any kind: no resolve, unresolve, archive, assign, merge, delete, release creation, or
  event ingestion.
- One organization per plugin instance; tools do not accept an organization parameter.
- No Seer AI, Performance, Discover, Metrics, Dashboards, Replay, Trace, or Span endpoints.
- No release, deploy, or issue-tag-distribution queries.
- `stats_period` is limited to `24h` and `14d`; custom `start`/`end` ranges are not supported.
- No automatic pagination. `sentry_search_issues` returns one page plus `meta.nextCursor`;
  `sentry_list_projects` accepts no cursor at all and reports `meta.truncated` instead.
- No local caching, no attachment or source map downloads, and no raw passthrough mode.

## Development

This project uses Bun exclusively:

```sh
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test --coverage
bun run build
bun pm pack
```

Tests use Vitest with mocked `fetch` and do not require a live Sentry instance. Coverage gates for
lines, statements, functions, and branches are all set to at least 80%.

Live compatibility against Sentry SaaS and a self-hosted instance has not been recorded for this
release yet; verify the plugin against your own instance before relying on it in CI.

## License

MIT
