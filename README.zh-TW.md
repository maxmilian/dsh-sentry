# dsh-sentry

[English](README.md) | 繁體中文 | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

`dsh-sentry` 是一個免費、開源、**唯讀**的 DeepSeek Harness 外掛，對接 Sentry Web API。
每個工具都是 HTTP `GET`；本外掛不會 resolve、指派、封存，也不會以任何方式改變 Sentry 的狀態。

它的主要價值不是代理 API，而是**把回應裁剪到 agent 的 context 撐得住一份真實 stacktrace**。
原始的 `events/latest/` 回應動輒 200KB–2MB。本外掛把它縮成真正有助於除錯的 frame、原始碼行與
metadata，並在 `meta.trimmed` 告訴你它捨棄了什麼。

## 工具

| 工具 | 用途 |
| --- | --- |
| `sentry_list_projects` | 列出設定的組織底下最多 100 個專案。 |
| `sentry_search_issues` | 以 Sentry search syntax 搜尋 issue，可限定單一專案或搜尋整個組織。 |
| `sentry_get_issue` | 以數字 id 或 short id 讀取單一 issue，不含 event 內容。 |
| `sentry_get_latest_event` | 讀取 issue 的最新 event，附裁剪後的 stacktrace。 |
| `sentry_get_event` | 依 event id 讀取專案內的單一 event，套用相同裁剪。 |

所有工具皆為唯讀。v0.1 不會修改 issue、不會建立 release、也不會送出 event。

## 需求

- 具備相容 `@deepseek-ai/dsh-tools` API 的 DeepSeek Harness
- Node.js 22.19 以上（22.x 線）或 Node.js 24 以上
- 從 GitHub 原始碼安裝或本機開發時需要 Bun 1.3.5 以上
- 一組對目標組織具備讀取權限的 Sentry auth token

## Token scope

| Scope | 開啟的 endpoint |
| --- | --- |
| `org:read` | `/organizations/{org}/projects/`、`/organizations/{org}/issues/`、`/organizations/{org}/shortids/{short_id}/` |
| `project:read` | `/projects/{org}/{project}/issues/` |
| `event:read` | `/issues/{id}/`、`/issues/{id}/events/latest/`、`/projects/{org}/{project}/events/{event_id}/` |

最單純又安全的做法是用 `sentry auth login --read-only` 產生 token，它剛好只要求
`project:read`、`org:read`、`event:read`、`member:read`、`team:read`。

## 設定

| 欄位 | 環境變數 | 預設值 | 說明 |
| --- | --- | --- | --- |
| `baseUrl` | `SENTRY_URL` | `https://sentry.io/` | 站台根網址。歐盟區請用 `https://de.sentry.io/`。結尾的 `/api/0` 會自動剝除。 |
| `token` | `SENTRY_AUTH_TOKEN` | 必填 | User 或 Organization auth token。永不回傳、永不寫入日誌。 |
| `org` | `SENTRY_ORG` | 必填 | 組織 slug，整個外掛實例固定使用。 |
| `locale` | — | `en` | `en`、`zh-TW`、`zh-CN` 或 `ja`，決定工具與參數描述的語言。 |
| `includeFrameVars` | `SENTRY_INCLUDE_FRAME_VARS` | `false` | 是否保留 stacktrace 的區域變數。環境變數只有字串 `true` 才會開啟，agent 無法覆寫。 |
| `requestTimeoutMs` | — | `30000` | **單次工具呼叫**的總逾時，包含 short id 需要的額外一次請求。範圍 1–300000。 |
| `maxResponseBytes` | — | `5242880` | 單次 HTTP 回應內容的硬上限。範圍 1–52428800。 |

外掛設定一律覆蓋環境變數。

```sh
export SENTRY_AUTH_TOKEN='your-token'
export SENTRY_ORG='your-org'
# 僅自架或歐盟區需要：
export SENTRY_URL='https://sentry.example.com'
```

## 自架與區域

- 自架：`baseUrl` 指向站台根網址即可，含子路徑安裝（例如 `https://example.com/sentry/`）。
- Sentry SaaS 歐盟區：`baseUrl` 必須是 `https://de.sentry.io/`。用 `https://sentry.io/` 存取歐盟區組織
  會以 401 或 404 呈現，因此這兩種錯誤訊息都會附上區域提示。
- 較舊的自架版本只是欄位比較少。本外掛把所有回應欄位都視為選填，絕不因缺欄位而失敗。兩個已知的
  行為差異：`sort=recommended` 可能被拒絕（回報為 `UNSUPPORTED_BY_INSTANCE`），以及 `stats_period`
  僅限 `24h` 與 `14d`。

## 裁剪了什麼

每個 event 都會無條件移除：

- Request 的 headers、cookies、環境變數與 body。Request URL 只保留 origin 與 path —— query string
  整段丟棄，因為 OAuth callback 與簽章 URL 的密鑰都藏在那裡。
- Stacktrace 的區域變數，除非開啟 `includeFrameVars`。
- `mechanism.data`、`contexts.state`、`packages`、`modules` 與 `_meta`。
- `user.email`、`user.ip_address` 與 `user.username`，只保留 `user.id`。
- Key 看起來像機密或直接 PII 的 tag（`token`、`secret`、`password`、`passwd`、`api_key`、`auth`、
  `cookie`、`session`、`credential`、private/access key、JWT、DSN、signature、email、IP address、
  username），以及所有 `sentry:` 前綴的內部 tag。
- 會洩漏建置路徑的 frame 欄位，例如 `absPath`。

會縮減而非整個移除：

- **Frames。** Frame 由外而內排列。數量超過 `max_frames` 時，本外掛優先保留 in-app frame、必定納入
  最內層兩個 frame，有空位時再從尾端往前補足，且絕不超過上限；輸出維持原始順序。
- **原始碼片段。** 只保留最內層 3 個 in-app frame，每個至多 11 行，每行至多 200 字元。
- **Chained exception。** 至多保留最內層的 2 個 `exception.values`；`max_frames` 對每個 stacktrace
  各自套用。
- **Breadcrumbs。** 最後 20 筆，訊息至多 200 字元。
- **字串。** Exception value 上限 2000 字元；title、message、culprit 上限 500 字元。

若裁剪後仍超過 200KB 的工具結果上限，本外掛會依固定順序降級 —— 先原始碼片段、再 breadcrumbs、
再把 frame 壓到最多 10 個（不會提高呼叫端原本更低的上限）；若管理者開啟的 frame vars 仍讓結果過大，最後會移除 vars。最後套用的層級會記在
`meta.trimmed.degraded`。像 `omittedFrames` 這類計數一律是「原始總數減去你實際收到的數量」，不是逐級累加。

## 語言

工具與參數描述依 `locale` 切換。**工具名稱永遠是英文、永不改變**，因為那是 agent 的呼叫識別碼。
**錯誤訊息同樣一律英文**：它們是穩定的診斷字串，測試與審查都以它為比對基準。

## 安全性與錯誤行為

- 使用 `Authorization: Bearer ...`，永不回傳或記錄 token。
- 遵守 DSH 工具的 `AbortSignal` 與單次呼叫的 deadline；short id 會多發一次 HTTP 請求，但共用同一個
  deadline。
- 把 HTTP 401、403、404、429 與 5xx 轉成安全的結構化錯誤，絕不夾帶 response body。
- **一個刻意的例外：** issue 搜尋收到 HTTP 400 時，本外掛最多讀取 64KB 的 body，只取結構化的
  `detail` 或 `error` 字串；若其中含有 token 或看起來像機密就整條丟棄，並截斷至 200 字元後以
  `Sentry said: ...` 附加。沒有這一段，agent 面對 search syntax 錯誤只能盲猜。當 body 是 HTML、
  無法解析或被過濾掉時，訊息會退回靜態版本 —— 所以 `INVALID_QUERY` 的訊息有兩種形狀。
- v0.1 不支援關閉 TLS 驗證或略過自簽憑證。

## 限制（v0.1）

- 完全不做任何寫入：沒有 resolve、unresolve、封存、指派、合併、刪除、建立 release，也不送 event。
- 每個外掛實例只服務單一組織；工具不接受組織參數。
- 不支援 Seer AI、Performance、Discover、Metrics、Dashboards、Replay、Trace 或 Span 相關 endpoint。
- 不支援 release、deploy 或 issue tag 分佈查詢。
- `stats_period` 僅限 `24h` 與 `14d`，不支援自訂 `start`/`end` 區間。
- 不做自動翻頁。`sentry_search_issues` 只回一頁加上 `meta.nextCursor`；`sentry_list_projects`
  完全不收 cursor 參數，改以 `meta.truncated` 回報。
- 不做本地快取、不下載 attachment 或 source map、不提供未裁剪的直通模式。

## 開發

本專案使用 Bun 作為套件管理器與 script runner；發布後的外掛 runtime 以上述 Node.js 版本為準：

```sh
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test --coverage
bun run build
bun pm pack
```

測試使用 Vitest 搭配 mock `fetch`，不需要真實的 Sentry 實例。lines、statements、functions、branches
四項覆蓋率門檻都設在 80% 以上。

本版本尚未記錄對 Sentry SaaS 與自架實例的實機相容性驗證。發 v0.1.0 tag 前必須完成的檢查清單放在
[`docs/live-verification.md`](docs/live-verification.md)；請針對你自己的實例執行：

```bash
bun run build
SENTRY_TOKEN=... SENTRY_ORG=... node scripts/live-verify.mjs
```

該腳本純唯讀，缺少憑證時以 exit 1 結束。

## 授權

MIT
