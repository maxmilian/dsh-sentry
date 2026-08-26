# dsh-sentry

[English](README.md) | [繁體中文](README.zh-TW.md) | 简体中文 | [日本語](README.ja.md)

`dsh-sentry` 是一个免费、开源、**只读**的 DeepSeek Harness 插件，对接 Sentry Web API。
每个工具都是 HTTP `GET`；本插件不会 resolve、指派、归档，也不会以任何方式改变 Sentry 的状态。

它的主要价值不是代理 API，而是**把响应裁剪到 agent 的 context 撑得住一份真实 stacktrace**。
原始的 `events/latest/` 响应动辄 200KB–2MB。本插件把它缩成真正有助于调试的 frame、源码行与
metadata，并在 `meta.trimmed` 告诉你它舍弃了什么。

## 工具

| 工具 | 用途 |
| --- | --- |
| `sentry_list_projects` | 列出所配置组织下最多 100 个项目。 |
| `sentry_search_issues` | 使用 Sentry search syntax 搜索 issue，可限定单个项目或搜索整个组织。 |
| `sentry_get_issue` | 以数字 id 或 short id 读取单个 issue，不含 event 内容。 |
| `sentry_get_latest_event` | 读取 issue 的最新 event，附裁剪后的 stacktrace。 |
| `sentry_get_event` | 按 event id 读取项目内的单个 event，套用相同裁剪。 |

所有工具均为只读。v0.1 不会修改 issue、不会创建 release、也不会发送 event。

## 需求

- 具备兼容 `@deepseek-ai/dsh-tools` API 的 DeepSeek Harness
- Node.js 22.19 以上（22.x 线）或 Node.js 24 以上
- 从 GitHub 源码安装或本地开发时需要 Bun 1.3.5 以上
- 一组对目标组织具备读取权限的 Sentry auth token

## Token scope

| Scope | 开启的 endpoint |
| --- | --- |
| `org:read` | `/organizations/{org}/projects/`、`/organizations/{org}/issues/`、`/organizations/{org}/shortids/{short_id}/` |
| `project:read` | `/projects/{org}/{project}/issues/` |
| `event:read` | `/issues/{id}/`、`/issues/{id}/events/latest/`、`/projects/{org}/{project}/events/{event_id}/` |

最简单又安全的做法是用 `sentry auth login --read-only` 生成 token，它恰好只请求
`project:read`、`org:read`、`event:read`、`member:read`、`team:read`。

## 配置

| 字段 | 环境变量 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `baseUrl` | `SENTRY_URL` | `https://sentry.io/` | 站点根 URL。欧盟区请用 `https://de.sentry.io/`。结尾的 `/api/0` 会自动剥除。 |
| `token` | `SENTRY_AUTH_TOKEN` | 必填 | User 或 Organization auth token。永不返回、永不写入日志。 |
| `org` | `SENTRY_ORG` | 必填 | 组织 slug，整个插件实例固定使用。 |
| `locale` | — | `en` | `en`、`zh-TW`、`zh-CN` 或 `ja`，决定工具与参数描述的语言。 |
| `includeFrameVars` | `SENTRY_INCLUDE_FRAME_VARS` | `false` | 是否保留 stacktrace 的局部变量。环境变量只有字符串 `true` 才会开启，agent 无法覆盖。 |
| `requestTimeoutMs` | — | `30000` | **单次工具调用**的总超时，包含 short id 需要的额外一次请求。范围 1–300000。 |
| `maxResponseBytes` | — | `5242880` | 单次 HTTP 响应内容的硬上限。范围 1–52428800。 |

插件配置一律覆盖环境变量。

```sh
export SENTRY_AUTH_TOKEN='your-token'
export SENTRY_ORG='your-org'
# 仅自建或欧盟区需要：
export SENTRY_URL='https://sentry.example.com'
```

## 自建与区域

- 自建：`baseUrl` 指向站点根 URL 即可，含子路径安装（例如 `https://example.com/sentry/`）。
- Sentry SaaS 欧盟区：`baseUrl` 必须是 `https://de.sentry.io/`。用 `https://sentry.io/` 访问欧盟区组织
  会表现为 401 或 404，因此这两种错误消息都会附上区域提示。
- 较旧的自建版本只是字段更少。本插件把所有响应字段都视为可选，绝不因缺字段而失败。两个已知的
  行为差异：`sort=recommended` 可能被拒绝（报告为 `UNSUPPORTED_BY_INSTANCE`），以及 `stats_period`
  仅限 `24h` 与 `14d`。

## 裁剪了什么

每个 event 都会无条件移除：

- Request 的 headers、cookies、环境变量与 body。Request URL 只保留 origin 与 path —— query string
  整段丢弃，因为 OAuth callback 与签名 URL 的密钥都藏在那里。
- Stacktrace 的局部变量，除非开启 `includeFrameVars`。
- `mechanism.data`、`contexts.state`、`packages`、`modules` 与 `_meta`。
- `user.email`、`user.ip_address` 与 `user.username`，只保留 `user.id`。
- Key 看起来像机密或直接 PII 的 tag（`token`、`secret`、`password`、`passwd`、`api_key`、`auth`、
  `cookie`、`session`、`credential`、private/access key、JWT、DSN、signature、email、IP address、
  username），以及所有 `sentry:` 前缀的内部 tag。
- 会泄漏构建路径的 frame 字段，例如 `absPath`。

会缩减而非整个移除：

- **Frames。** Frame 由外而内排列。数量超过 `max_frames` 时，本插件优先保留 in-app frame、必定纳入
  最内层两个 frame，有空位时再从尾部往前补足，且绝不超过上限；输出保持原始顺序。
- **源码片段。** 只保留最内层 3 个 in-app frame，每个至多 11 行，每行至多 200 字符。
- **Chained exception。** 至多保留最内层的 2 个 `exception.values`；`max_frames` 对每个 stacktrace
  各自套用。
- **Breadcrumbs。** 最后 20 条，消息至多 200 字符。
- **字符串。** Exception value 上限 2000 字符；title、message、culprit 上限 500 字符。

若裁剪后仍超过 200KB 的工具结果上限，本插件会按固定顺序降级 —— 先源码片段、再 breadcrumbs、
再把 frame 压到最多 10 个（不会提高调用端原本更低的上限）；若管理员开启的 frame vars 仍使结果过大，最后会移除 vars。最后套用的层级会记录在
`meta.trimmed.degraded`。像 `omittedFrames` 这类计数一律是「原始总数减去你实际收到的数量」，不是逐级累加。

## 语言

工具与参数描述依 `locale` 切换。**工具名称永远是英文、永不改变**，因为那是 agent 的调用标识符。
**错误消息同样一律英文**：它们是稳定的诊断字符串，测试与审查都以它为比对基准。

## 安全性与错误行为

- 使用 `Authorization: Bearer ...`，永不返回或记录 token。
- 遵守 DSH 工具的 `AbortSignal` 与单次调用的 deadline；short id 会多发一次 HTTP 请求，但共用同一个
  deadline。
- 把 HTTP 401、403、404、429 与 5xx 转成安全的结构化错误，绝不夹带 response body。
- **一个刻意的例外：** issue 搜索收到 HTTP 400 时，本插件最多读取 64KB 的 body，只取结构化的
  `detail` 或 `error` 字符串；若其中含有 token 或看起来像机密就整条丢弃，并截断至 200 字符后以
  `Sentry said: ...` 附加。没有这一段，agent 面对 search syntax 错误只能盲猜。当 body 是 HTML、
  无法解析或被过滤掉时，消息会退回静态版本 —— 所以 `INVALID_QUERY` 的消息有两种形状。
- v0.1 不支持关闭 TLS 验证或跳过自签证书。

## 限制（v0.1）

- 完全不做任何写入：没有 resolve、unresolve、归档、指派、合并、删除、创建 release，也不发送 event。
- 每个插件实例只服务单个组织；工具不接受组织参数。
- 不支持 Seer AI、Performance、Discover、Metrics、Dashboards、Replay、Trace 或 Span 相关 endpoint。
- 不支持 release、deploy 或 issue tag 分布查询。
- `stats_period` 仅限 `24h` 与 `14d`，不支持自定义 `start`/`end` 区间。
- 不做自动翻页。`sentry_search_issues` 只返回一页加上 `meta.nextCursor`；`sentry_list_projects`
  完全不收 cursor 参数，改以 `meta.truncated` 报告。
- 不做本地缓存、不下载 attachment 或 source map、不提供未裁剪的直通模式。

## 开发

本项目使用 Bun 作为包管理器与 script runner；发布后的插件 runtime 以上述 Node.js 版本为准：

```sh
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test --coverage
bun run build
bun pm pack
```

测试使用 Vitest 搭配 mock `fetch`，不需要真实的 Sentry 实例。lines、statements、functions、branches
四项覆盖率门槛都设在 80% 以上。

本版本尚未记录对 Sentry SaaS 与自建实例的实机兼容性验证；在 CI 中依赖本插件之前，请先针对你自己的
实例验证。

## 许可

MIT
