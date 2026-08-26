# dsh-sentry 設計 Spec

- 日期：2026-08-26（2026-08-26 依獨立 review 修訂）
- 狀態：**已定案**（僅設計，未寫任何程式碼）
- 套件名：`dsh-sentry`（npm unscoped，帳號 `maxhsu`；GitHub `maxmilian/dsh-sentry`）
- 骨架來源：`dsh-sonarqube`（六檔 950 行唯讀插件標準形）、`dsh-forge`（多工具 + runtime i18n 版）

---

## 1. 目的與差異化定位

### 目的

讓 DSH agent 能在**不改變 Sentry 任何狀態**的前提下，回答「線上現在在噴什麼錯、錯在哪一行、影響多大」，並把 stacktrace 直接餵進除錯流程。

### 差異化

- canonical registry 上 Sentry 相關插件目前是 **0**，這是最大的空白。
- 與 `sentry-cli` / 官方 Sentry MCP 的差異：
  - **純唯讀**：所有工具都是 HTTP GET，v0.1 沒有任何 resolve / assign / archive / merge。可安全發給只有 read-only token 的 agent。
  - **回應裁剪是第一等公民**：Sentry 的 `events/latest/` 原始回應動輒 200KB–2MB（breadcrumbs、modules、request headers、frame vars）。本插件的核心價值不是「代理 API」，而是**把一份 event 壓成 agent context 吃得下、且對除錯有用的形狀**。
  - **自架 Sentry 一等公民**：base URL 可指向 on-prem，欄位一律當 optional 處理，不假設 SaaS 才有的新欄位存在。
  - **runtime 四語 tool metadata**：tool description 依 `config.locale` 切換（en / zh-TW / zh-CN / ja），非英語使用者的 agent 讀到的是母語描述。
- 定位一句話：*Read-only Sentry error triage & stacktrace retrieval for coding agents.*

### 非差異化（刻意不做）

不做 Sentry UI 的鏡像、不做 dashboard、不做 metrics/performance 分析。詳見 §8 非目標。

---

## 2. Sentry API 前置研究

### 2.1 Base URL：SaaS vs 自架

| 情境 | Base URL | 備註 |
| --- | --- | --- |
| SaaS（US region） | `https://sentry.io/` 或 `https://us.sentry.io/` | `sentry.io` 對多數 org-scoped endpoint 會做 region routing，但官方建議用 region 專屬網域。 |
| SaaS（EU region） | `https://de.sentry.io/` | 用 `sentry.io` 存取 EU org 可能 404 / 401。 |
| 自架 on-prem | `https://sentry.example.com/` 或含子路徑 `https://example.com/sentry/` | 需支援子路徑安裝。 |

實作：config 只收「站台根 URL」，client 內部一律以 `new URL('api/0/<endpoint>', baseUrl)` 組出請求，baseUrl 正規化為結尾帶 `/`（沿用 `dsh-sonarqube` 的 `normalizeBaseUrl`）。使用者若誤填 `https://sentry.io/api/0/`，正規化時偵測 pathname 結尾為 `/api/0` 則剝除該段。

**預設值**：`baseUrl` 預設 `https://sentry.io/`。README 四語都明確提醒 EU region 使用者必須改成 `https://de.sentry.io/`，且 401/404 的錯誤訊息會附一句 `Verify baseUrl matches your Sentry region (for example https://de.sentry.io/).`

### 2.2 API 版本相容性

Sentry Web API 只有 `/api/0/` 一個版本，且沒有版本協商機制；自架版本落後時的差異是「欄位少」而不是「路徑不同」。因此：

- 所有回應欄位一律 optional，缺欄位就略過，**絕不因缺欄位丟 error**。
- 已知的新版限定欄位（自架舊版可能沒有）：`substatus`、`priority`、`isUnhandled`、`issueType`、`seerFixabilityScore`。
- 已知的行為差異，v0.1 一律**先照保守值定案**，實測若證明可放寬則在 v0.2 放寬（見 §9.8 驗證清單與回退方案）：
  - `sort` 預設 `date`；`recommended` 保留在 enum 中，工具描述註明「部分自架版本不支援」，收到 400 時映射為 `UNSUPPORTED_BY_INSTANCE`。
  - `statsPeriod` **只開放 `24h` / `14d`**（預設 `14d`）。更長區間需 `start`/`end`，列為非目標。

### 2.3 認證與 scope

- Header：`Authorization: Bearer <token>`（與 SonarQube 同形，client 幾乎可原樣複用）。
- Token 類型：**User Auth Token**（`sntryu_…`，scope 由使用者勾選）或 **Organization Auth Token**（`sntrys_…`，綁定單一 org、scope 固定，適合 CI / agent）。
- v0.1 工具所需最小 scope：

| Scope | 用途 |
| --- | --- |
| `org:read` | `/organizations/{org}/projects/`、`/organizations/{org}/issues/`、`/organizations/{org}/shortids/{short_id}/` |
| `project:read` | `/projects/{org}/{project}/issues/` |
| `event:read` | `/issues/{id}/`、`/issues/{id}/events/latest/`、`/projects/{org}/{project}/events/{event_id}/` |

README 四語都要列這張表，並建議使用 `sentry auth login --read-only` 產生的 read-only token（scope 集合：`project:read` `org:read` `event:read` `member:read` `team:read`）。

### 2.4 分頁

Sentry 用 cursor 分頁，資訊在 `Link` header：

```
Link: <https://…?&cursor=0:100:0>; rel="next"; results="true"; cursor="0:100:0"
```

- 請求參數：`cursor`（格式 `<value>:<offset>:<is_prev>`）、`per_page`（上限 100）。
- 實作：client 解析 `Link` header，只有在同時滿足 `rel="next"` 且 `results="true"` 時把該 cursor 放進 `meta.nextCursor`；否則不放此欄位。
- 輸入的 `cursor` 必須通過 `/^-?\d+:-?\d+:[01]$/` 驗證，否則丟 `INVALID_INPUT`。

### 2.5 共用識別碼格式常數

以下 regex 定義為 `client.ts` 的模組常數，**org slug 與 project slug 共用同一個常數**（Sentry 對兩者的 slug 規則相同，沒有理由分開）：

| 常數 | Regex | 用於 |
| --- | --- | --- |
| `SLUG_PATTERN` | `/^[a-z0-9][a-z0-9_.-]{0,63}$/` | `config.org`、`project_slug` 參數（同時擋掉 `/` 與 `..` 路徑穿越） |
| `NUMERIC_ID_PATTERN` | `/^\d{1,20}$/` | `issue` 參數的數字形式、shortids 回應的 `groupId` |
| `SHORT_ID_PATTERN` | `/^[A-Z0-9][A-Z0-9_]*-[A-Z0-9]+$/` | `issue` 參數的 short id 形式（比對前先 `toUpperCase()`） |
| `EVENT_ID_PATTERN` | `/^[0-9a-fA-F]{32}$/` | `event_id` 參數 |
| `CURSOR_PATTERN` | `/^-?\d+:-?\d+:[01]$/` | `cursor` 參數 |

`issue` 參數的判定順序：先試 `NUMERIC_ID_PATTERN`（純數字一律當數字 id，`123-456` 因此不會誤判成 short id）；不符則 `toUpperCase()` 後試 `SHORT_ID_PATTERN`；再不符丟 `INVALID_INPUT`。

---

## 3. v0.1 工具清單

共 **5 個工具**，全部 `isConcurrencySafe: () => true`，全部 GET，輸出走統一 `OUTPUT_SCHEMA`（§3.0.1）並以 `JSON.stringify` render 成單一 text block。

**v0.1 不實作 `presentCall`**（照 `dsh-sonarqube`；`dsh-forge` 有做但那是多工具寫入型插件的需求）。工具的可讀性完全由 description 承擔。

工具價值 / 回應大小評估（挑選依據）：

| 候選 | agent 價值 | 原始回應大小 | v0.1 |
| --- | --- | --- | --- |
| issue 搜尋 | 極高（入口） | 中（25 筆約 60–150KB，`stats` 時序陣列佔大半） | ✅ |
| issue 詳情 | 高 | 中（`stats` 24h/30d 陣列很肥） | ✅ |
| latest event（stacktrace） | **最高** | **極大（200KB–2MB）** | ✅（裁剪為設計重點） |
| 專案清單 | 中（探索用，也是 slug 正確性的第一線） | 小 | ✅ |
| 指定 event 詳情 | 中高（alert 信 / Slack 貼 event id 時） | 極大 | ✅（與 latest event 共用裁剪） |
| issue tags 分佈 | 中 | 中 | ❌ 非目標 |
| release 列表 / 詳情 | 低（agent 除錯少用） | 小 | ❌ 非目標 |
| event 統計 / metrics / discover | 低（介面複雜、描述難寫準） | 大 | ❌ 非目標 |

> 挑選原則：registry 審核會比對「工具描述 vs 程式碼行為」，而 Sentry 的 stats / discover API 語意複雜（欄位、時間對齊、rollup），描述寫不準的通用工具風險高。優先做語意單純、行為好描述的五個。

### 3.0 工具描述的四語規則（G1）

- **tool name 永遠是英文且固定**（`sentry_search_issues` 等），不隨 locale 改變 —— 它是 agent 的呼叫識別碼，改了會破壞 prompt 與既有對話。
- **tool description 與每個參數的 description 依 `config.locale` 切換**，四語齊備（`en` / `zh-TW` / `zh-CN` / `ja`）。
- **locale 的傳遞方式照 `dsh-forge`**（`apply()` 讀 `config.locale` → `registerSentryTools(ctx, client, locale)`）；**工具的註冊形狀照 `dsh-sonarqube`**（每個工具一個 `register*` 私有函式、`defineTool`、無 `presentCall`）。
- 文案來源集中在 `src/locales.ts` 的 `TOOL_I18N`，型別為 `Record<Locale, ToolMessages>`，用 `satisfies` 強制四語欄位完全對齊 —— 少翻一句就編譯失敗。
- **錯誤訊息不隨 locale 改變，一律英文**。理由：錯誤訊息是穩定的診斷字串，測試與 registry 審核都以它為準；四語化會讓錯誤比對變成四倍工作量而換不到多少價值。此規則要寫進 README。
- 下面各工具列出的是 `en` 文案；`zh-TW` / `zh-CN` / `ja` 為等義翻譯，語意不得偏離（尤其是描述裁剪行為的那幾句）。

#### 3.0.1 `OUTPUT_SCHEMA`（五個工具共用同一個物件參考）

`data` 對**所有**工具都是物件（search 的結果包成 `{ issues: [...] }`，見 §3.2），`meta` 的所有欄位都是 optional，五個工具取用其中的子集：

```ts
const OUTPUT_SCHEMA = {
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

各工具實際會出現的 meta 欄位：

| 工具 | nextCursor | matchingCount | truncated | trimmed |
| --- | --- | --- | --- | --- |
| `sentry_list_projects` | — | — | ✅ | — |
| `sentry_search_issues` | ✅ | ✅ | — | — |
| `sentry_get_issue` | — | — | — | — |
| `sentry_get_latest_event` | — | — | — | ✅ |
| `sentry_get_event` | — | — | — | ✅ |

`meta` 物件本身必定存在（可能是 `{}`）。`trimmed` 宣告為 `{ type: 'json' }` 而非展開的巢狀 schema，因為它的欄位是動態的（§4.1），逐欄宣告只會製造一份必須跟著 `trim.ts` 同步維護的重複定義。

### 3.1 `sentry_list_projects`

- **description（en）**：`List the projects in the configured Sentry organization. Returns id, slug, name, platform, status, and team slugs for at most 100 projects; meta.truncated is true when the organization has more.`
- **參數**：無。
- **Endpoint**：`GET /api/0/organizations/{org}/projects/?per_page=100`
- **回應裁剪**：白名單保留 `id` / `slug` / `name` / `platform` / `status` / `dateCreated` / `isMember` / `firstEvent` / `teams[].slug`，其餘全部丟棄。輸出為 `{ projects: [...] }`。
- **分頁**：不接受 `cursor` 參數，單次最多 100 筆。**不帶出 `nextCursor`**（agent 拿到 cursor 會嘗試傳一個不存在的參數）；改為在 `Link` header 顯示還有下一頁時放 `meta.truncated: true`。超過 100 個專案的 org 請直接用 `sentry_search_issues` 指定 `project_slug` —— 此建議寫進工具描述與 README。
- **錯誤情境**：401 token 無效；403 缺 `org:read`；404 org slug 打錯（訊息指向 `org` 設定與 `baseUrl` region）。

### 3.2 `sentry_search_issues`

- **description（en）**：`Search Sentry issues using Sentry search syntax. Returns a trimmed summary per issue: no event bodies, no stacktraces, no time-series stats. When project_slug is given the project-scoped endpoint is used; otherwise the whole organization is searched.`
- **參數**：

| 參數 | 型別 | 說明 |
| --- | --- | --- |
| `project_slug` | string | 選填，通過 `SLUG_PATTERN`。給了就打 project 層 endpoint；不給就打 org 層。 |
| `query` | string | 選填，Sentry search syntax，預設 `is:unresolved`。長度上限 400 字元。 |
| `stats_period` | enum `24h` \| `14d` | 預設 `14d`。 |
| `sort` | enum `date` \| `new` \| `freq` \| `user` \| `recommended` | 預設 `date`；`recommended` 描述註明部分自架不支援。 |
| `environment` | string | 選填，長度上限 100 字元。 |
| `limit` | integer 1–100 | 預設 25，對映 `per_page`。 |
| `cursor` | string | 選填，來自前一次回應的 `meta.nextCursor`，通過 `CURSOR_PATTERN`。 |

- **Endpoint**：
  - 有 `project_slug` → `GET /api/0/projects/{org}/{project_slug}/issues/`
  - 無 → `GET /api/0/organizations/{org}/issues/`
- **HTTP 回應頂層是陣列**：這兩支 endpoint 的 JSON 頂層是陣列而非物件，**client 的回應解析必須同時支援陣列與物件頂層**（`dsh-sonarqube` 的 `parseJsonObject` 只收物件，照抄會壞）。這一點不因下面的包裝而消失：包裝發生在 `trim.ts`，解析發生在 `client.ts`。
- **輸出包裝**：`trimIssueList()` 回 `{ issues: [...] }`，讓 `data` 對所有工具恆為物件，`OUTPUT_SCHEMA` 才能共用同一個參考。
- **回應裁剪**：每筆 issue 白名單保留
  `id` / `shortId` / `title` / `culprit` / `level` / `status` / `substatus` / `priority` / `isUnhandled` / `count` / `userCount` / `firstSeen` / `lastSeen` / `permalink` / `project.slug` / `metadata.{type,value,filename}` / `assignedTo.{type,name}`。
  - 字串截斷依 §4.9。
  - **丟棄 `stats`（時序陣列）、`annotations`、`filtered`、`inbox`、`owners`、`pluginActions`、`shareId`、`hasSeen`、`subscriptionDetails`、`seerFixabilityScore`。**
  - 依據：`stats` 通常佔單筆 issue JSON 的 60–80%，砍掉後 25 筆約落在 12–20KB。
- **meta**：`{ nextCursor?, matchingCount? }`。`matchingCount` 來源是 `X-Hits` header：僅當該 header 存在且通過 `/^\d{1,10}$/` 時轉成 number 帶出，否則不帶。
- **錯誤情境**：
  - 400 且該次請求帶了 `sort=recommended` → `UNSUPPORTED_BY_INSTANCE`
  - 其他 400 → `INVALID_QUERY`，附上經過濾的上游 `detail`（見 §6.2）
  - 403 缺 scope、404 slug/org 錯、429 rate limit（附安全過的 `Retry-After`）

### 3.3 `sentry_get_issue`

- **description（en）**：`Read one Sentry issue by numeric id or short id (for example PROJ-ABC). Returns counts, first and last seen, culprit, and release span. Does not include event bodies or stacktraces. A short id costs one extra request to resolve it to a numeric id.`
- **參數**：`issue` (string, required, 長度 1–64)。
- **Endpoint**：
  - 數字 id → `GET /api/0/issues/{issue_id}/`
  - short id → 先 `GET /api/0/organizations/{org}/shortids/{short_id}/` 取 `groupId`，再打上面那支。
  - 判定與格式見 §2.5。
- **shortids 回應處理**：`groupId` 必須存在且通過 `NUMERIC_ID_PATTERN`（Sentry 可能回 number 或 string，兩者都接受並轉成 string 後比對）。不符（缺席 / null / 巢狀在別的物件裡 / 非數字）→ 丟 `INVALID_RESPONSE`，訊息 `Sentry returned an unexpected response.`。**絕不允許把 `undefined` 組進 `/issues/undefined/`。**
  第二次呼叫（`/issues/{id}/`）若回 404 / 403，沿用 §6.1 的通用映射，訊息不特別處理。
- **回應裁剪**：保留 3.2 的 issue 摘要欄位，另加 `firstRelease.version` / `lastRelease.version` / `activity` 最新 3 筆的 `{type, dateCreated}` / `participantCount`（由 `participants.length` 算出）/ `seenByCount`。
  **丟棄 `stats`、`pluginIssues`、`pluginContexts`、`tags` 完整分佈，以及 `participants` / `seenBy` 的明細（含 email，屬 PII）。**
- **錯誤情境**：404 issue 不存在 / 已刪除 / short id 查無此筆（訊息說明 short id 需要 `org` 設定正確）；403 缺 `event:read`。

### 3.4 `sentry_get_latest_event`

- **description（en）**：`Read the latest event of a Sentry issue with a trimmed stacktrace. First-party frames are preserved, source context is limited to the innermost first-party frames, and local variables, request headers, request bodies, query strings, packages, and secret-looking tags are removed. Accepts a numeric issue id or a short id; a short id costs one extra request.`
  （描述逐句對應 §4 的裁剪行為，registry 會比對。）
- **參數**：

| 參數 | 型別 | 說明 |
| --- | --- | --- |
| `issue` | string, required | 數字 id 或 short id，解析規則同 §2.5 / §3.3。 |
| `max_frames` | integer 1–100 | 預設 20。**對每一個 stacktrace 各自套用**（見 §4.2）。 |
| `include_breadcrumbs` | boolean | 預設 `true`，保留最後 20 筆。 |

- **Endpoint**：`GET /api/0/issues/{issue_id}/events/latest/`
- **回應裁剪**：見 §4，這是本插件的核心。
- **錯誤情境**：404（issue 沒有可取回的 event，例如已過保留期）；`RESPONSE_TOO_LARGE`（兩種來源、兩種訊息，見 §6.1）。

### 3.5 `sentry_get_event`

- **description（en）**：`Read one Sentry event by event id within a project, applying the same stacktrace trimming as sentry_get_latest_event.`
- **參數**：`project_slug`（string, required, `SLUG_PATTERN`）、`event_id`（string, required, `EVENT_ID_PATTERN`）、`max_frames`、`include_breadcrumbs`（同 3.4）。
- **Endpoint**：`GET /api/0/projects/{org}/{project_slug}/events/{event_id}/`
- **回應裁剪**：與 3.4 **完全共用** `trimEvent()`。
- **存在理由**：alert email / Slack 通知裡給的是 event id 而非 issue id。與 3.4 共用裁剪，邊際成本約 25 行。
- **錯誤情境**：404 event 不存在或不屬於該 project；`INVALID_INPUT`（event_id / project_slug 格式錯）。

---

## 4. Stacktrace 裁剪策略（核心設計）

原始 `events/latest/` 回應結構：`{ id, eventID, groupID, projectID, title, message, culprit, platform, dateCreated, dateReceived, tags[], entries[], contexts{}, packages{}, sdk{}, user{}, _meta{}, errors[] }`。

`entries` 是 `{type, data}` 陣列，type 可能為 `exception` / `threads` / `breadcrumbs` / `request` / `message` / `spans` / `csp`。

### 4.1 輸出形狀（`data`）

```
{
  id, eventID, groupID, projectID,
  title, message?, culprit?, platform?, level?,
  dateCreated, dateReceived?,
  release?, environment?,          // 從 tags 提取成頂層欄位
  sdk?: { name, version },
  user?: { id },                    // 只留 id
  tags: [{ key, value }],           // 見 4.5
  contexts: { runtime?, os?, browser?, device?, trace? },  // 見 4.6
  exception?: { values: [ { type, value, mechanism?, stacktrace: { frames: [...] } } ] },
  breadcrumbs?: [ { timestamp, type, category, level, message } ],
  request?: { method, url },        // 見 4.7
}
```

`exception` 缺席時退而取 `threads` entry 中 `crashed === true`（沒有就取第一個）的 thread stacktrace，包成同樣的 `exception.values` 形狀，並在 `meta.trimmed.exceptionSource` 記 `"threads"`。

`meta.trimmed` **只放動態值**（每次回應可能不同的數字與旗標）；靜態的「這個工具永遠會丟掉哪些欄位」寫在工具 description 裡一次講完，不在每次回應重複燒 context：

```
meta.trimmed = {
  omittedFrames?: number,             // 全 event 加總，見 4.2
  omittedExceptionValues?: number,    // 見 4.2
  omittedBreadcrumbs?: number,
  omittedTags?: number,               // 因命中機密樣式或超出 30 筆而丟棄的 tag 數
  eventProcessingErrors?: number,     // 原 errors[].length
  exceptionSource?: "threads",
  degraded?: "source_context" | "breadcrumbs" | "frames",
}
```

所有欄位為 0 / 未發生時**不輸出該 key**；全部都沒有時 `meta` 不含 `trimmed`。

### 4.2 exception values 與 frame 選取

**exception values**：`exception.values` 是陣列（Python `__cause__`、JS `Error.cause` 常見 2–4 個），Sentry 的排序是最外層在前、最內層（真正的 crash）在後。

- 至多保留**最後 2 個**（最內層優先）。
- `omittedExceptionValues = values.length - kept.length`。
- `max_frames` **對每一個保留下來的 stacktrace 各自套用**；`omittedFrames` 是全 event 各 stacktrace 被略過的 frame **加總**。

**frame 選取**：Sentry 的 `frames` 陣列是**由外而內、最內層（crash 點）在最後**。

決定性規則（無隨機性）：

1. 令 `N = max_frames`、`total = frames.length`。
2. `total <= N` → 全留。
3. 否則：
   a. 候選集合 `C = 所有 inApp === true 的 frames` ∪ `最尾端 2 個 frames`（不論 inApp）。
   b. `|C| >= N` → 從 `C` 中依原始索引取**最後 N 個**。
   c. `|C| < N` → 保留 `C` 全部，再從剩餘的非 inApp frames 中由**尾端往前**補足至 N 個。
4. 依原始索引排序輸出，維持原始由外而內的順序。

理由：第一方程式碼（`inApp`）是 agent 最需要的；框架 / node_modules / stdlib frames 是雜訊。規則 3a 無條件納入最尾端 2 個 frame，因為 crash 常發生在函式庫內部，緊鄰的那兩層有診斷價值 —— 這也是規則與理由不再互相矛盾的地方（舊版規則在 inApp 夠多時會把非 inApp 全數丟光）。

### 4.3 每個 frame 保留的欄位

- **保留**：`filename`、`module?`、`function`、`lineNo`、`colNo`、`inApp`、`package?`、`context?`（見 4.4）、`vars?`（僅 `includeFrameVars: true` 時）。
- **丟棄**：`absPath`（多半與 filename 重複且會洩漏建置機器的絕對路徑）、`rawFunction`、`symbol`、`symbolAddr`、`instructionAddr`、`trust`、`platform`、`errors`、`minGroupingLevel`、`origAbsPath`、`data`、`addrMode`。
- **`mechanism`**：不整包保留。只取 `{ type, handled, synthetic }`；**`mechanism.data` 一律丟棄**（它會塞任意內容：HTTP response body 片段、含 query 的 URL、handler 參數，是唯一還在原樣保留的巢狀結構）。

### 4.4 原始碼片段（`context`）

Sentry 每個 frame 的 `context` 是 `[[lineNo, sourceText], …]`，通常前後各 5 行共 11 行。

1. 只對 `inApp === true` 的 frame 保留 context。
2. 只對**最內層的 3 個** inApp frame 保留（常數 `SOURCE_CONTEXT_FRAMES = 3`，不開放設定）。
3. 每行 sourceText 依 §4.9 截斷。
4. 每個 frame 至多保留 11 行：以該 frame 的 `lineNo` 為中心取 ±5 行；**`lineNo` 缺席或非 number 時（minified JS / 無 source map 常見），改取 context 的前 11 行**。

理由：source context 是 event 裡體積成長最快的欄位（20 frames × 11 行 × 平均 80 字元 ≈ 18KB），但只有 crash 點附近的第一方程式碼真的有用。

### 4.5 tags

1. 先提取 `release` / `environment` / `level` 成頂層欄位，並從 tags 陣列中移除，避免重複。
2. 丟棄所有 `sentry:` 前綴的內部 tag。
3. **機密樣式過濾**：tag `key` 命中 `/(token|secret|password|api[_-]?key|auth|cookie|session|credential)/i` 即**整筆丟棄**（連 key 名都不輸出）。自訂 tag 是 `api_key` / `session_id` / `auth_token` / `user_email` 的重災區，這條與 §4.7 的 `frame.vars` 同等重要。
4. 其餘 tags 依原順序保留至多 30 筆，`key` 與 `value` 依 §4.9 截斷。
5. 因步驟 3、4 丟掉的筆數合計記入 `meta.trimmed.omittedTags`。

### 4.6 contexts

白名單 `runtime` / `os` / `browser` / `device` / `trace`；每個 context 物件只保留 `type` / `name` / `version`（`trace` 保留 `trace_id` / `span_id` / `op`）。丟棄 `state`（Redux/Vuex state dump，可以是幾百 KB 且必然含 PII）、`app`，以及所有自訂 context。

### 4.7 安全性裁剪（不可設定，強制）

以下欄位**無條件丟棄**，因為它們是憑證 / PII 洩漏的主要途徑：

| 欄位 | 處置 | 理由 |
| --- | --- | --- |
| `entries[request].headers` / `cookies` / `env` | 丟棄 | 幾乎必定含 `Authorization` / `Cookie` / session |
| `entries[request].data` | 丟棄 | POST body，含密碼 / token 的常見位置 |
| `entries[request].url` 的 **query string** | **整段丟棄**，只保留 `origin + pathname` | OAuth callback、簽章 URL、webhook URL 的密鑰全在 query 裡。連 key 名都不保留（key 名本身資訊價值低，而保留 key 名的實作會多一條可能寫錯的過濾路徑） |
| `frame.vars` | 丟棄 | 區域變數常含 token、連線字串、使用者資料。**唯一例外**：`config.includeFrameVars === true`（管理者明示承擔風險，agent 無法覆寫） |
| `mechanism.data` | 丟棄 | 見 §4.3 |
| tag key 命中機密樣式 | 整筆丟棄 | 見 §4.5 |
| `contexts.state` | 丟棄 | 完整前端 state dump |
| `user.email` / `user.ip_address` / `user.username` | 丟棄 | PII；`user.id` 保留（除錯需要辨識而非識別） |
| `packages` / `modules` | 丟棄 | 幾百個相依套件版本，體積大、除錯價值低 |
| `_meta` | 丟棄 | 純內部標註 |
| `errors[]` | 只留 `length` | 存成 `meta.trimmed.eventProcessingErrors` |

### 4.8 最終大小上限與降級

- 常數 `MAX_TOOL_RESULT_BYTES = 200_000`（**bytes**，定義於 `trim.ts`，不對使用者開放設定）。`trimEvent(raw, options)` 的 `options` 帶一個 optional 的 `maxBytes`，預設為此常數；**它只是給測試注入小上限用的接縫，`tools.ts` 一律不傳**，因此對使用者而言仍是硬常數。
- 大小的量測一律用 `Buffer.byteLength(JSON.stringify(payload), 'utf8')`。**大小檢查用 bytes、字串截斷用字元數（§4.9），兩者單位不同是刻意的** —— 截斷上限是給人 / agent 讀的語意界線，用字元較直覺；大小上限要對應真實傳輸量，中日文 stacktrace 在 UTF-8 下一字元 3 bytes，用字元數會低估 3 倍。
- **五個工具的最終輸出都要通過這個檢查**；但只有 `sentry_get_latest_event` / `sentry_get_event` 有降級路徑，其餘三個工具的輸出形狀固定且小，超標即直接丟 `RESPONSE_TOO_LARGE`（第二種訊息，見 §6.1）。
- event 工具的降級：`trimEvent()` 在記憶體中保有解析後的原始 event，序列化後若超標，依**固定順序**逐級重跑並記錄 `meta.trimmed.degraded`：
  1. 移除所有 frame 的 `context` → `"source_context"`
  2. 再移除 `breadcrumbs` → `"breadcrumbs"`
  3. 再以 `max_frames = 10` 重跑 §4.2 的選取 → `"frames"`
  - `degraded` 只記錄**最後套用到的那一級**（隱含前面幾級都已套用）。
  - **每次降級重跑後，`omittedFrames` / `omittedBreadcrumbs` / `omittedExceptionValues` / `omittedTags` 一律以「原始總數 − 最終保留數」重算**，不是累加、也不是只算「超出上限的部分」。
- 三級降級後仍超標 → 丟 `RESPONSE_TOO_LARGE`（第二種訊息）。

`maxResponseBytes`（預設 5MB）是**HTTP body 的硬上限**，用來擋住異常巨大的回應與惡意/故障的上游，不是常態的體積防線 —— 常態體積由 §4.9 的截斷與本節的降級負責。

### 4.9 字串截斷上限（字元數）

所有截斷都是「超過即截斷並在尾端加 `…`」，套用於**每一次**裁剪（含降級重跑）：

| 欄位 | 上限 |
| --- | --- |
| `exception.values[].value` | 2000 |
| `title` / `message` / `culprit` | 500 |
| issue 的 `metadata.value` | 500 |
| frame `context` 的每一行 sourceText | 200 |
| tag `key` | 64 |
| tag `value` | 200 |
| breadcrumb `message` | 200 |
| `request.url`（`origin + pathname` 之後） | 500 |

`exception.values[].value` 是 event 裡最大宗的單一字串（一條完整 SQL、一段 HTML 回應、一份 JSON payload 都可能整包進去），舊版 spec 漏了它，導致三級降級一次都碰不到最肥的那塊。此處以**無條件截斷**處理，而非放進降級路徑 —— 降級是例外處理，2000 字元對任何錯誤訊息都綽綽有餘，沒有理由讓它在正常情況下佔掉半份 context。

---

## 5. Config schema

```ts
interface SentryConfig {
  baseUrl?: string
  token?: string
  org?: string
  locale?: 'en' | 'zh-TW' | 'zh-CN' | 'ja'
  includeFrameVars?: boolean
  requestTimeoutMs?: number
  maxResponseBytes?: number
}
```

| 欄位 | 環境變數 | 預設值 | 驗證 / 上下界 | 說明 |
| --- | --- | --- | --- | --- |
| `baseUrl` | `SENTRY_URL` | `https://sentry.io/` | http(s)、無內嵌帳密、無 query/fragment；正規化為結尾 `/`；pathname 結尾為 `/api/0` 則剝除 | 自架填站台根 URL；EU region 填 `https://de.sentry.io/` |
| `token` | `SENTRY_AUTH_TOKEN` | 無（必填） | trim 後長度 1–500；`role('secret')` | User 或 Org Auth Token |
| `org` | `SENTRY_ORG` | 無（必填） | `SLUG_PATTERN`（§2.5） | 組織 slug，全域固定（§11 D1） |
| `locale` | — | `en` | enum **恰為** `en` / `zh-TW` / `zh-CN` / `ja` | 決定 runtime tool description 語言（G1）。不影響 tool name，也不影響錯誤訊息（一律英文） |
| `includeFrameVars` | `SENTRY_INCLUDE_FRAME_VARS` | `false` | 環境變數**只有字串 `'true'`（trim 後、大小寫不敏感）才視為開啟**，其餘一律 `false` | 是否保留 stacktrace 區域變數；管理者層級的風險決定，agent 不得覆寫 |
| `requestTimeoutMs` | — | `30_000` | 整數 1 – 300_000 | **是「單次工具呼叫」的總 deadline，不是單次 HTTP 的 deadline**（見下） |
| `maxResponseBytes` | — | `5 * 1024 * 1024` | 整數 1 – 50 * 1024 * 1024 | 單次 HTTP body 的硬上限 |

**`requestTimeoutMs` 的語意（唯一解讀）**：short id 路徑一次工具呼叫會發兩次 HTTP，若逐次計時最壞會是 2× timeout。定義為**整個工具呼叫共用一個 deadline**：`client` 在工具方法入口建立一次 `RequestContext`（timer + `AbortController`，沿用 `dsh-sonarqube` 的 `createRequestContext`），兩次 HTTP 共用同一個 signal，逾時只可能發生一次。這也讓 `exec.signal` 的串接維持單一路徑。config 說明與 README 都要寫明這一句。

解析順序：**plugin config 覆蓋環境變數**（`config.x?.trim() || env.X?.trim() || default`），與 `dsh-sonarqube` 的 `resolveConfig` 一致。`locale` 無環境變數對應 —— 它是 harness 使用者的介面偏好，屬 plugin config 的範疇，不需要第二條設定路徑。

`max_frames` / `include_breadcrumbs` **不放 config，放工具參數** —— 那是「這次要看多深」的臨場判斷，該由 agent 決定。`includeFrameVars` 與 `locale` 是部署層級設定，只在 config。

Schemastery 的 config 欄位說明（`CONFIG_I18N`）四語齊備，放 `src/locales.ts`。

---

## 6. 錯誤碼清單

### 6.1 清單

沿用 `dsh-sonarqube` 的 13 個碼（含 3 個非 HTTP 碼），新增 2 個 Sentry 專屬，共 15 個。訊息一律英文（§3.0）。

| Code | 觸發條件 | 訊息 |
| --- | --- | --- |
| `INVALID_CONFIG` | baseUrl / token / org / locale 驗證失敗 | `Invalid Sentry configuration: …` |
| `INVALID_INPUT` | 工具參數驗證失敗（slug、event_id、cursor、limit、`issue` 既非數字也非 short id） | `Invalid Sentry input: …` |
| `INVALID_QUERY` | issue 搜尋 endpoint 回 400，且非 `sort=recommended` 造成 | 有 detail：`Sentry rejected the search query. Check the Sentry search syntax. Sentry said: {detail}`；無 detail：同句去掉後半 |
| `UNSUPPORTED_BY_INSTANCE` | 400 且該次請求帶了 `sort=recommended` | `This Sentry instance does not support the requested sort order.` |
| `AUTHENTICATION_FAILED` | 401 | `Sentry authentication failed. Check the configured token. Verify baseUrl matches your Sentry region (for example https://de.sentry.io/).` |
| `PERMISSION_DENIED` | 403 | `Sentry denied access to this resource. Check the token scopes (org:read, project:read, event:read).` |
| `NOT_FOUND` | 404 | `The requested Sentry resource was not found. Verify the org slug and that baseUrl matches your Sentry region.` |
| `RATE_LIMITED` | 429 | `Sentry rate limit exceeded. Retry later.`（附安全過的 `Retry-After`） |
| `SERVER_ERROR` | >= 500 | `Sentry server error (HTTP {status}).` |
| `SENTRY_HTTP_ERROR` | 其他非 2xx（含非搜尋 endpoint 的 400） | `Sentry request failed (HTTP {status}).` |
| `INVALID_RESPONSE` | **僅 2xx 回應**：非 JSON content-type / JSON parse 失敗 / 頂層既非物件也非陣列 / shortids 的 `groupId` 不合法 | `Sentry returned an unexpected response.` |
| `RESPONSE_TOO_LARGE`（來源 A：串流） | HTTP body 超過 `maxResponseBytes` | `Sentry response exceeded the configured maximum of {maxResponseBytes} bytes.` |
| `RESPONSE_TOO_LARGE`（來源 B：裁剪後） | 裁剪（含三級降級）後序列化仍超過 `MAX_TOOL_RESULT_BYTES` | `Sentry event was too large to summarize even after trimming (degraded: {degraded ?? "none"}).` |
| `REQUEST_TIMEOUT` | 工具呼叫的共用 deadline 觸發 abort | `Sentry request timed out after {ms} ms.` |
| `REQUEST_ABORTED` | caller 的 `exec.signal` abort | `Sentry request was cancelled.` |
| `NETWORK_ERROR` | fetch throw 且非上述 | `Unable to reach the Sentry server.` |

> `RESPONSE_TOO_LARGE` 的兩種訊息刻意分開：來源 A 的 `{maxResponseBytes}` 是使用者可調的 config，訊息引導他去調是對的；來源 B 的上限是硬常數，若沿用同一句話，使用者會照著調 `maxResponseBytes`、調了沒用。

**400 的判定優先序（唯一解讀）**：`sort=recommended` → `UNSUPPORTED_BY_INSTANCE`；否則若請求來自 `sentry_search_issues` → `INVALID_QUERY`；否則 → `SENTRY_HTTP_ERROR`。

**`createHttpError` 介面擴充**：骨架是 `createHttpError(status, retryAfter, tokenExpiration)`，純由 status 決定 code；本插件的 400 優先序需要 request 端上下文，因此改為

```ts
createHttpError(status: number, ctx: {
  retryAfter?: string
  detail?: string
  isSearch?: boolean
  usedRecommendedSort?: boolean
}): SentryApiError
```

`client.#get()` 負責把這份 context 從呼叫端一路帶下來（每個 client 方法在組 query 時就知道自己是不是 search、有沒有帶 `sort=recommended`）。

`SentryApiError` 欄位：`code` / `status` / `retryAfter` / `detail`，`toJSON()` 只吐這四項 + `name`。Header 回傳前先過 `safeHeader(headers, name, token)`（長度 <= 128 且不含 token，沿用骨架）。**不收集 `X-Sentry-Rate-Limit-Reset`** —— `SentryApiError` 沒有欄位放它，為它加一個欄位換不到相應價值，`Retry-After` 已足夠。

### 6.2 400 錯誤訊息透出規則（G2）

> **與 `dsh-sonarqube` 不同，此處為刻意例外。** `dsh-sonarqube` 的慣例是「error 永不夾帶 response body」；本插件在 HTTP 400 這一種情況下打破它，理由是 Sentry search syntax 的錯誤若不回饋（例如 `Invalid query. "foo" is not a supported search key`），agent 只能盲猜，往往連續呼叫失敗數次。此例外的範圍被嚴格框死如下。

**讀取規則**（骨架在 `!response.ok` 時是 `await response.body?.cancel()` 後直接丟錯、從不讀 body；這段必須改寫，改寫的邊界如下）：

- 只有 `status === 400` 會讀 body；其他所有非 2xx 維持骨架行為（`cancel()` 後丟錯，永不夾帶 body）。
- 400 的 body 以**固定小上限 `ERROR_BODY_MAX_BYTES = 64 * 1024`** 讀取（不使用 `maxResponseBytes`；5MB 對一句錯誤訊息是荒謬的上限）。超過即中止讀取並視為「無 detail」。
- content-type 非 JSON（反向代理回 HTML 錯誤頁是常見情況）→ 視為「無 detail」。
- body parse 失敗 → 視為「無 detail」。
- **「無 detail」一律退回不含 `Sentry said:` 的靜態訊息，絕不因此轉成 `INVALID_RESPONSE`** —— `INVALID_RESPONSE` 只適用 2xx 回應（見 §6.1）。

**過濾規則** `sanitizeUpstreamDetail(body: unknown, token: string): string | undefined`（`token` 由 `client` 以 `this.#config.token` 傳入；沒有 token 參數就無法實作第 3 條）：

1. **只取結構化欄位**：依序嘗試 `body.detail`、`body.error`；必須是 string，否則回 `undefined`。**絕不整包序列化 response body。**
2. **控制字元清洗**：移除 `\r` `\n` 與其他 ASCII 控制字元，連續空白壓成單一空格，前後 trim。
3. **過濾疑似機密**：若該字串包含 `token` 的字面值，或命中 `/(bearer\s|authorization|sntry[us]_|api[_-]?key|secret|password|token\s*[:=])/i` → **整條放棄**（回 `undefined`）。
4. **長度上限 200 字元**：超過即截斷並在尾端加 `…`。
5. 結果同時放進 `SentryApiError.detail` 與訊息尾端的 `Sentry said: {detail}`。

agent 拿到的 `INVALID_QUERY` 訊息因此有兩種形狀（含 / 不含 `Sentry said:`），這點要寫進 README。

---

## 7. 檔案結構與職責

```
dsh-sentry/
├─ src/
│  ├─ index.ts        插件入口：name / inject / Config schema / apply()（讀 locale 傳給 registerSentryTools）
│  ├─ config.ts       config 型別、Locale 型別、預設值、上下界常數、resolveConfig / validateResolvedConfig
│  ├─ errors.ts       SentryErrorCode、SentryApiError、createHttpError(status, ctx)、sanitizeUpstreamDetail(body, token)
│  ├─ client.ts       SentryClient：共用 deadline、HTTP GET、串流大小上限、400 body 讀取、Link/X-Hits 解析、short id 解析、參數驗證、格式常數
│  ├─ trim.ts         trimProjectList / trimIssueList / trimIssue / trimEvent、MAX_TOOL_RESULT_BYTES、三級降級
│  ├─ tools.ts        registerSentryTools(ctx, client, locale)、5 個 defineTool、OUTPUT_SCHEMA、renderJson
│  ├─ locales.ts      CONFIG_I18N + TOOL_I18N（en / zh-TW / zh-CN / ja，含每個參數的 description）
│  └─ types.ts        JsonValue/JsonObject、ApiResult、TransportMeta、TrimResult、各工具參數介面
├─ tests/
│  ├─ client.test.ts
│  ├─ trim.test.ts
│  ├─ errors.test.ts
│  ├─ tools.test.ts
│  ├─ locales.test.ts
│  ├─ plugin.test.ts
│  └─ fixtures/       event-node.json / event-python.json / event-browser.json / event-chained.json /
│                     event-oversized.json / issues-list.json / projects-list.json
├─ .github/workflows/ ci.yml、release.yml
├─ cordis.patch.yml
├─ package.json、tsconfig.json、tsconfig.build.json、biome.json、vitest.config.ts
├─ README.md / README.zh-TW.md / README.zh-CN.md / README.ja.md
└─ LICENSE (MIT)
```

### 7.1 分層與接縫（誰呼叫誰）

這是實作最容易走偏的地方，明確定義如下：

1. **`client.ts` 只管 transport，不裁剪。** 每個 client 方法（`listProjects` / `searchIssues` / `getIssue` / `getLatestEvent` / `getEvent`）回傳

   ```ts
   interface ApiResult { readonly data: JsonValue; readonly meta: TransportMeta }
   interface TransportMeta { readonly nextCursor?: string; readonly matchingCount?: number; readonly hasMore?: boolean }
   ```

   `data` 是**未經裁剪的原始 JSON**（可能是物件，也可能是陣列 —— 見 §3.2）。`meta` 只放從 HTTP header 解析出來的東西。
2. **`trim.ts` 是純函式，且大小檢查與降級都在這裡。** 每個 `trimXxx(raw, options)` 回傳

   ```ts
   interface TrimResult { readonly data: JsonObject; readonly trimmed?: TrimmedMeta; readonly truncated?: boolean }
   ```

   `data` 恆為物件（§3.0.1）。`MAX_TOOL_RESULT_BYTES` 常數定義在 `trim.ts`，序列化量測與三級降級也在 `trim.ts` 內完成；超標時由 `trim.ts` 丟 `RESPONSE_TOO_LARGE`（來源 B）。
3. **`tools.ts` 的 `execute` 負責接縫**：呼叫 `client.xxx(params, exec.signal)` → 把 `result.data` 交給對應的 `trimXxx()` → 合併 meta：

   ```
   { data: trim.data, meta: { ...client.meta 中該工具會用的欄位, ...(trim.trimmed && { trimmed: trim.trimmed }), ...(trim.truncated && { truncated: true }) } }
   ```

   `sentry_list_projects` 的 `hasMore` 在這一層被翻譯成 `meta.truncated`，`nextCursor` 不輸出（§3.1）。
4. **`errors.ts` 不依賴前三者**，只被 `client.ts` 與 `config.ts` 呼叫。

這個接縫由 `tests/tools.test.ts` 專責覆蓋（§9.5）—— `client.test.ts` 只測 transport、`trim.test.ts` 只測純函式，兩邊都不碰這條線。

### 7.2 預估行數

| 檔案 | 行數 | 說明 |
| --- | --- | --- |
| `config.ts` | ~130 | 比 sonarqube 多 `org` / `locale` / `includeFrameVars` 三欄與 slug、boolean env 驗證 |
| `errors.ts` | ~170 | 15 個碼 + `createHttpError` 的 400 優先序 + `sanitizeUpstreamDetail` |
| `client.ts` | ~310 | 骨架的 request context / 串流讀取，加上共用 deadline、400 body 讀取、Link + X-Hits 解析、陣列頂層支援、short id 解析 |
| `trim.ts` | ~290 | **本插件價值所在**（含字串截斷表、tag 過濾、三級降級、大小量測） |
| `tools.ts` | ~230 | 5 個工具 + §7.1 的接縫 |
| `locales.ts` | ~320 | config 7 欄 + 5 個工具的 description 與參數 description，× 四語 |
| `types.ts` | ~90 | |
| `index.ts` | ~85 | |
| **合計** | **~1625** | 比 dsh-forge（1001 行）多，多出來的大半在 `locales.ts` 的四語文案 |

`biome.json` 沿用 `dsh-sonarqube`（`noExcessiveCognitiveComplexity: 10`）—— `trim.ts` 必須拆成多個小函式才過得了 lint，這正是我們要的。

---

## 8. 非目標（v0.1 明確不做）

1. **任何寫入操作**：resolve / unresolve / archive / assign / merge / delete / 建立 release / 送 event。整個插件沒有非 GET 的請求。
2. **Seer AI**（`issue explain` / `issue plan`）：會觸發付費運算且非唯讀語意。
3. **Performance / Discover / Metrics / Dashboards / Replay / Trace / Span** 相關 endpoint。
4. **Release 與 deploy 查詢**。
5. **Issue tag 分佈**（`/issues/{id}/tags/`）與 tag value 列表。
6. **多 org**：`org` 由 config 固定，工具參數不接受覆寫。也不支援在同一個 harness 內載入兩份實例來跨 org（`cordis.patch.yml` 的 id 會衝突）。
7. **自訂時間區間**（`start` / `end` / 絕對日期）：只開放 `24h` / `14d`。
8. **自動翻頁 / 聚合**：不做 client 端自動抓完所有頁；`sentry_search_issues` 只回一頁 + `nextCursor`，`sentry_list_projects` 連 cursor 參數都不收。
9. **本地快取**。
10. **DSN / event ingestion**：不送任何 event 到 Sentry，也不讀 `SENTRY_DSN`。
11. **attachment / minidump / source map 下載**。
12. **`raw: true` 直通模式**：不提供「回傳未裁剪原始 JSON」的逃生門（裁剪是本插件的核心價值；有此需求者請用 `sentry api`）。
13. **錯誤訊息的四語化**：錯誤訊息一律英文（§3.0）。
14. **`presentCall`**：v0.1 不做（§3）。

---

## 9. 測試策略

框架：**vitest**（`vitest run`，coverage v8，門檻 branches/functions/lines/statements 皆 80%，`src/types.ts` 排除）—— 沿用 `dsh-sonarqube/vitest.config.ts`。

### 9.1 `tests/client.test.ts`（mock `fetch`，只測 transport）

client 建構子接受 `fetchImplementation` 注入（同 sonarqube），測試傳入 `vi.fn<MockFetch>()`。**斷言 client 方法回的 `data` 是未裁剪的原始 JSON**（例如原始 `stats` 欄位還在），確立 §7.1 的分層。

- config 解析：plugin config 覆蓋 env；缺 token / 缺 org 各丟 `INVALID_CONFIG`；baseUrl 非 http(s) / 含帳密 / 含 query 各丟錯；`https://sentry.io/api/0/` 正規化成 `https://sentry.io/`；子路徑 `https://x.com/sentry/` 組出 `https://x.com/sentry/api/0/…`；`SENTRY_INCLUDE_FRAME_VARS='TRUE'` 開啟、`'1'` / `'yes'` / 空字串不開啟；`locale` 非四語之一 → `INVALID_CONFIG`。
- 格式常數（§2.5）：`org` 與 `project_slug` 用**同一個** `SLUG_PATTERN`（同一組非法值對兩者都丟 `INVALID_INPUT`）；`123-456` 判定為數字 id 而非 short id（只發一次 fetch）；`proj-abc` 小寫經 `toUpperCase()` 後仍判定為 short id；`-A-1` 丟 `INVALID_INPUT`。
- URL 組裝：每個工具打到正確 endpoint、帶對 query（`per_page` / `statsPeriod` / `query` / `environment` / `cursor` / `sort`）。
- `Authorization: Bearer` header 正確；**斷言 error 訊息與 `toJSON()` 都不含 token 字串**。
- 參數驗證：`limit` 0 / 101、`cursor` 格式錯、`event_id` 非 32 hex、`project_slug` 含 `/` 或 `..` → 各丟 `INVALID_INPUT`。
- HTTP 狀態映射與 400 優先序：400 + `sort=recommended` → `UNSUPPORTED_BY_INSTANCE`；400 於搜尋 → `INVALID_QUERY`；400 於 `sentry_get_event` → `SENTRY_HTTP_ERROR`；401 / 403 / 404 / 429（含 `Retry-After`）/ 500 / 418。斷言 `createHttpError` 收到的 ctx 旗標正確（`isSearch` / `usedRecommendedSort`）。
- **400 body 讀取**（§6.2）：JSON body 有 `detail` → 進入訊息；body 為 HTML content-type → 無 detail 的靜態訊息且**不是** `INVALID_RESPONSE`；body 為壞掉的 JSON → 同上；body 超過 64KB → 中止讀取、無 detail；**401/403/404/500 帶 `{detail:"leak"}` → 最終訊息與 `toJSON()` 都不含 `leak`**（斷言 body 被 `cancel()`）。
- 回應解析：頂層為陣列（issue 列表、projects 列表）與頂層為物件（issue 詳情、event）都要成功；頂層為字串 / 數字 → `INVALID_RESPONSE`；2xx 非 JSON content-type、2xx 壞掉的 JSON → `INVALID_RESPONSE`。
- `Link` header：`results="true"` 取 cursor、`results="false"` 不放 `nextCursor`、header 缺失、header 格式異常。`X-Hits`：合法數字帶出、非數字 / 超長不帶出。
- 大小上限：`content-length` 超標即中止；串流累積（byteLength）超標中止；兩者都丟 `RESPONSE_TOO_LARGE`（來源 A 訊息）且有呼叫 `reader.cancel()`。
- 共用 deadline：`vi.useFakeTimers()`；**short id 路徑下推進時間跨越兩次 HTTP，只觸發一次 `REQUEST_TIMEOUT`，且總時長不超過 `requestTimeoutMs`**；caller signal abort → `REQUEST_ABORTED`；fetch reject → `NETWORK_ERROR`。
- short id 解析：`PROJ-ABC` 觸發兩次 fetch（shortids → issues）且第二次 URL 用解析出的 `groupId`；shortids 回 404 → `NOT_FOUND`；shortids 回 200 但 `groupId` 缺席 / null / 非數字 / 巢狀在 `group` 物件裡 → **`INVALID_RESPONSE`，且第二次 fetch 從未發生**（斷言 `fetchMock` 只被呼叫一次，確保沒有 `/issues/undefined/`）；`groupId` 為 number 型別也接受。

### 9.2 `tests/trim.test.ts`（純函式，用 fixture）

`trim.ts` 全是純函式，**不需要 mock 任何東西** —— 這是把裁剪抽成獨立檔案的主要理由。

Fixtures：`event-node.json`（Node.js 未捕捉例外）、`event-python.json`（有 source context、frame 多）、`event-browser.json`（breadcrumbs + request + 自訂 tags）、`event-chained.json`（3 層 chained exception）、`event-oversized.json`（**60 個 frames 各帶滿 11 行 context、100 筆 breadcrumbs、多個接近 2000 字元上限的 exception value**，用來真正走完三級降級）。真實 event 從 Sentry 抓下後**手動清洗掉真實憑證與 PII** 再入庫。

- **exception values**（§4.2）：`event-chained.json` 3 個 values → 只留最後 2 個、`omittedExceptionValues === 1`；`max_frames` 對兩個 stacktrace 各自套用（輸出 frame 總數可以是 2×N）；`omittedFrames` 是兩者加總。
- **frame 選取**三條分支：`total <= N` 全留；`|C| >= N` 取候選集合最後 N 個，且**輸出必定包含最尾端 2 個 frame**（即使它們 `inApp === false`）；`|C| < N` 由尾端補足；輸出順序恆為原始由外而內。
- source context：只出現在最內層 3 個 inApp frame；非 inApp frame 沒有 context；`lineNo` 為 null 的 frame 取 context 前 11 行；行數上限 11；單行超過 200 字元被截斷。
- **字串截斷**（§4.9）：2500 字元的 `exception.values[].value` 被截到 2000 + `…`；`title` / `culprit` 截到 500；breadcrumb message 截到 200。
- **安全裁剪**（§4.7）：fixture 含 `request.headers.Authorization`、`request.url` 的 `?api_key=…`、`frame.vars.token`、`mechanism.data.url`、`contexts.state`、`user.email`、tag key `session_id` / `auth_token`，斷言 `JSON.stringify(out)` **完全找不到**那些值；`request.url` 只剩 `origin + pathname`；`mechanism` 只剩 `{type, handled, synthetic}`；`omittedTags` 計入被丟棄的機密 tag。
- `includeFrameVars: true` 時 `vars` 才出現。
- breadcrumbs：`include_breadcrumbs: false` 完全不出現；`true` 只留最後 20 筆且欄位正確；`omittedBreadcrumbs === 原始總數 − 20`。
- `exception` 缺席但有 `threads` → 取 `crashed === true` 的 thread；都沒 `crashed` → 取第一個；`meta.trimmed.exceptionSource === 'threads'`。
- **三級降級**（§4.8）：`event-oversized.json` 驗證 `degraded` 依序為 `source_context` → `breadcrumbs` → `frames`（用不同的 `MAX_TOOL_RESULT_BYTES` 注入值或不同 fixture 尺寸各測一級），`degraded` 只記最後一級；**降級後 `omittedFrames` / `omittedBreadcrumbs` 以「原始總數 − 最終保留數」重算**（明確斷言數字，例如第三級後 `omittedFrames === 60 - 10`）；仍超標時丟 `RESPONSE_TOO_LARGE`（來源 B 訊息，含 `degraded: frames`）。
- 大小量測用 bytes：一份**只含中日文、字元數遠低於上限但 UTF-8 bytes 超標**的 fixture 必須觸發降級（若用字元數量測則不會觸發，此測試即為 §4.8 單位規則的防迴歸）。
- 非 event 工具超標即丟（不降級），訊息為來源 B。
- `meta.trimmed` 只含動態欄位：正常情況下不出現 `droppedFields` / `droppedEntries` 這類靜態清單；所有計數為 0 時該 key 不輸出；全部沒有時不輸出 `trimmed`。
- 缺欄位韌性：把 fixture 的 `entries` / `contexts` / `tags` / `sdk` / `user` / `mechanism` 逐一刪掉，斷言不 throw（模擬自架舊版）。
- issue 裁剪：輸出為 `{ issues: [...] }`（物件而非陣列）；`stats` 被移除；`metadata.value` 截斷；缺 `substatus` / `priority` 不 throw；`participants` 只剩 count。
- projects 裁剪：輸出為 `{ projects: [...] }`；白名單以外欄位不存在。

### 9.3 `tests/errors.test.ts`（G2 專測）

`sanitizeUpstreamDetail(body, token)` 是安全敏感函式，獨立一檔測到底：

- `{detail: "Invalid query..."}` → 原樣透出；`{error: "..."}`（無 `detail`）→ 透出；兩者都有 → 取 `detail`。
- `detail` 非 string（物件 / 陣列 / number / null）→ `undefined`。
- **含 token 字面值 → `undefined`**（此案例證明 `token` 參數確實有被使用；簽章若少了 token，此測試無法通過）。
- 命中 `bearer ` / `Authorization` / `sntryu_` / `sntrys_` / `api_key` / `secret` / `password` / `token=` 各關鍵字 → 全數 `undefined`（逐一 case）。
- 含 `\n` `\r` `\t` 與連續空白 → 清洗成單行單空格。
- 250 字元 → 截斷成 200 字元 + `…`（截斷發生在清洗之後）。
- `createHttpError` 的 400 優先序三分支（`usedRecommendedSort` / `isSearch` / 兩者皆無）。
- `SentryApiError.toJSON()` 只含 `name` / `code` / `status` / `retryAfter` / `detail`，**不含** rate-limit reset 之類的額外欄位。

### 9.4 `tests/locales.test.ts`（G1 專測）

- **`TOOL_I18N` 的 key 集合恰為 `['en','zh-TW','zh-CN','ja']`**（四語，無別名）。
- **`CONFIG_I18N` 的 key 集合恰為 Schemastery 慣用的七個**：`en` / `en-US` / `zh` / `zh-CN` / `zh-TW` / `ja` / `ja-JP`（照 `dsh-sonarqube` 的 `locales.ts`），且斷言 `CONFIG_I18N['en-US'] === CONFIG_I18N.en`、`CONFIG_I18N.zh === CONFIG_I18N['zh-CN']`、`CONFIG_I18N['ja-JP'] === CONFIG_I18N.ja`（**同一個物件參考**，不是內容相等）。
- `config.locale` 的 Schemastery enum **只收四語**（`en-US` 等別名是 Schemastery 的 i18n key，不是使用者可填的值）—— 斷言 enum 成員恰為四個。
- 對每個 locale：五個工具的 description 與**每一個參數**的 description 都存在且非空白字串。
- 四語之間的參數 key 集合完全一致（用 `Object.keys` 互比），確保沒有漏翻。
- 各語言的 description 互不相同（防止複製貼上時忘了翻譯）。

### 9.5 `tests/tools.test.ts`（§7.1 接縫專測）

以 stub client（回固定原始 JSON）＋ fake `ctx.tools.register` 驅動每個工具的 `execute`：

- **client 回的原始欄位（如 `stats`）在工具輸出中消失** —— 證明 `execute` 真的呼叫了 `trimXxx()`，而不是把原始 data 直接吐出去。
- meta 合併正確：`searchIssues` 的 `nextCursor` / `matchingCount` 從 client meta 穿過來；event 工具的 `trimmed` 從 trim 結果穿過來；`listProjects` 的 `hasMore: true` 被翻譯成 `meta.truncated: true` 且**輸出不含 `nextCursor`**。
- 每個工具的輸出通過 `OUTPUT_SCHEMA` 的形狀檢查：`data` 恆為物件；`meta` 只出現 §3.0.1 表格允許的欄位（`additionalProperties: false` 下多帶一個欄位就會壞）。
- `exec.signal` 有被傳進 client 方法。
- `trim` 丟 `RESPONSE_TOO_LARGE` 時，錯誤原樣往外傳（`execute` 不吞例外）。

### 9.6 `tests/plugin.test.ts`

沿用 `dsh-sonarqube` 的做法（含 `Object.hasOwn(globalThis, 'Bun') ? it.skip : it` 的 Bun 規避）：

- `name === 'dsh-sentry'`、`inject === ['tools']`、`Config` 已定義。
- `Config.meta.description` 與各欄位描述四語齊全。
- `apply()` 以 fake `ctx.tools.register` 註冊出 **5 個**工具，逐一斷言 `name`、`isConcurrencySafe() === true`、`output.schema === OUTPUT_SCHEMA`（**同一個物件參考**）、**`presentCall === undefined`**。
- **locale 切換**：`apply(ctx, {locale: 'zh-TW', …})` 註冊出的工具 `name` 仍是英文、`description` 是繁中；`locale: 'ja'` 是日文；不給 locale 時是英文。
- `renderJson` 回傳單一 `{ type: 'text' }` block。

### 9.7 CI

`ci.yml` 沿用 `dsh-sonarqube`：`lint` → `typecheck` → `test --coverage` → `build` → **pack smoke test**（`bun pm pack` 後 `tar -tzf` 斷言 `lib/index.js`、`lib/index.d.ts`、`lib/locales.js`、`lib/locales.d.ts`、`cordis.patch.yml`、四份 README、`LICENSE` 都在 tarball 裡）＋ Node 22.19 / 24 雙版本 runtime job（`node --input-type=module --eval "await import('./lib/index.js')"`）。

### 9.8 上線前 live 驗證清單（手動，不進 CI）

**Sentry 實例可用**，以下項目在發 v0.1.0 tag 前必須實測；每項都已有定案值，實測只是確認，不符時走列出的回退方案。

環境：(1) sentry.io SaaS 一個 org；(2) 一台自架 Sentry（版本記進 README）。

| # | 要驗證的假設 | 定案值 | 實測不符時的回退方案 |
| --- | --- | --- | --- |
| V1 | `/organizations/{org}/issues/` 接受 `statsPeriod=24h` 與 `14d` | enum 只開這兩個 | 某值被拒 → 移出 enum、預設改為仍可用者；兩者皆被拒 → 移除 `stats_period` 參數，改用 endpoint 預設 |
| V2 | 是否有更寬鬆的 `statsPeriod`（`7d` / `30d` / `90d`）可用 | v0.1 不開放 | 確認可用則記錄於 spec 附註，v0.2 放寬（不改 v0.1） |
| V3 | `/organizations/{org}/shortids/{short_id}/` 在自架存在且回合法 `groupId` | 自動解析 short id | 不存在 → 保留解析路徑，但把該 endpoint 的 404 特別映射成訊息「此 Sentry 版本不支援 short id，請改用數字 issue id」；回應形狀不同（`group.id` 巢狀）→ 在 §3.3 的取值路徑追加該欄位，仍以 `NUMERIC_ID_PATTERN` 驗證 |
| V4 | org 層 issue 搜尋不帶 `project` 參數時能正常回全 org 結果 | org 層不做專案過濾 | **回退一**：若該版本要求必帶 → 固定附 `project=-1`（Sentry 的「全部專案」慣用值）；**回退二**：若 `project=-1` 也不被接受 → `project_slug` 改為必填、移除 org 層路徑，並同步修改 §3.2 的 description 與 D4 |
| V5 | Org Auth Token（`sntrys_`）對 `/issues/{id}/` 與 `/issues/{id}/events/latest/` 可用 | README 建議 Org Auth Token | 不可用 → README 改建議 User Auth Token，scope 表註明 |
| V6 | `sort=recommended` 在自架回 400 | 映射為 `UNSUPPORTED_BY_INSTANCE` | 回其他狀態碼 → 依實際狀態碼調整映射條件 |
| V7 | issue / projects 列表 endpoint 的 JSON 頂層確為陣列，且 `Link` / `X-Hits` header 存在 | client 支援陣列頂層、解析兩個 header | `X-Hits` 不存在 → `matchingCount` 自然不帶出，無需改碼（已是 optional） |
| V8 | 400 的 body 確實有 `detail` 欄位且為 string | `sanitizeUpstreamDetail` 優先取 `detail`、次取 `error` | 欄位名不同 → 在 §6.2 過濾規則第 1 條的欄位清單追加該欄位名 |
| V9 | 三份 event fixture 的欄位形狀與 §4 假設一致（`entries` 陣列、`context` 為 `[lineNo, text]` 配對、frames 由外而內、`exception.values` 由外而內） | §4 全部規則 | 任一不符 → **阻斷性**問題，須回頭修 §4 後再實作 |
| V10 | 實際裁剪後的輸出大小落在預期（issue 列表 25 筆 12–20KB、單一 event < 60KB） | `MAX_TOOL_RESULT_BYTES = 200_000` | 普遍逼近上限 → 下修 `max_frames` 預設值（20 → 12），常數不動 |

---

## 10. 打包與發佈慣例（硬性）

### 10.1 `package.json` 關鍵欄位

```jsonc
{
  "name": "dsh-sentry",                    // unscoped，npm 帳號 maxhsu
  "license": "MIT",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/index.d.ts",
  "files": ["lib", "cordis.patch.yml", "README.md", "README.zh-TW.md", "README.zh-CN.md", "README.ja.md", "LICENSE"],
  "keywords": ["deepseek-harness", "dsh-plugin", "sentry", "error-tracking", "observability"],
  "engines": { "node": "^22.19.0 || >=24.0.0" },
  "packageManager": "bun@1.3.5",
  "publishConfig": { "access": "public" },
  "peerDependencies": {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-tools": "^0.1.0-rc.8 || ^0.1.1-rc.2",
    "@deepseek-ai/schemastery": "^3.18.1"
  },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

**兩個不可省略的地雷**：

1. `dsh.bundle.patch` 必須指向 `./cordis.patch.yml`。registry 硬性要求，只宣告 `dsh.client` 會被退件。
2. `@deepseek-ai/*` **一律放 `peerDependencies`**，且範圍必須寫出**顯式 prerelease 分支**：`^0.1.0-rc.8 || ^0.1.1-rc.2`。只寫 `^0.1.0-rc.8` 會被 node-semver 靜默排除 `0.1.1-rc.2`，使用者安裝時直接 ERESOLVE（`dsh-sonarqube` 實際踩過）。

### 10.2 `cordis.patch.yml`

```yaml
- insert:
    - id: dsh-sentry
      name: dsh-sentry
```

### 10.3 `release.yml`

`v*` tag 觸發 → 驗 tag 與 `package.json` 版本一致 → lint / typecheck / test / build → `bun pm pack` → 發 release。

**兩個不可省略的地雷**：

1. tarball 檔名必須透過 `$GITHUB_ENV` 傳給 publish step（`echo "PACKAGE_TARBALL=$PACKAGE_TARBALL" >>"$GITHUB_ENV"`）。跨 step 的 shell 變數不保留，`dsh-forge` v0.3.2 因此掛過。
2. release 要附一個**穩定檔名 asset** `dsh-sentry.tgz`（由版本化 tarball `cp` 而來），讓 `releases/latest/download/dsh-sentry.tgz` 跨版本不壞。同時附 `SHA256SUMS`。

### 10.4 GitHub repo

- topics：`dsh-plugin` + `sentry`（另加 `error-tracking`、`deepseek-harness`）。
- LICENSE：MIT。
- 四語 README：`README.md`（en）/ `README.zh-TW.md` / `README.zh-CN.md` / `README.ja.md`，頂部互相連結，內容須含：工具表、所需 scope 表、config 表（含 `locale` 與 `requestTimeoutMs` 的共用 deadline 語意）、「錯誤訊息一律英文」說明、`INVALID_QUERY` 兩種訊息形狀的說明、裁剪政策摘要（哪些欄位永遠被丟）、非目標段落、live 驗證日期與 Sentry 版本。

---

## 11. 決策紀錄

### 全域慣例（三插件一致）

- **已定：G1 runtime tool metadata 四語 —— 採 `config.locale`** —— tool name 固定英文、description 與參數說明依 locale 切換，是硬性要求；locale 傳遞照 `dsh-forge`、註冊形狀照 `dsh-sonarqube`；文案集中於 `locales.ts` 並以 `satisfies` 強制四語對齊，漏翻即編譯失敗。
- **已定：G2 上游錯誤訊息 —— 僅 HTTP 400 過濾後透出** —— 只讀 400 的 body（64KB 上限）、只取結構化欄位（`detail` / `error`）、上限 200 字元、命中機密樣式或含 token 即整條放棄；讀不到就退回靜態訊息、絕不轉成 `INVALID_RESPONSE`；其餘狀態碼維持靜態訊息。**與 `dsh-sonarqube` 不同，此處為刻意例外，理由是 query 語法錯誤若不回饋，agent 只能盲猜。**

### 本插件

- **已定：D1 org slug —— config 固定 `org`，工具參數不接受覆寫** —— 自架幾乎都是單 org，SaaS 也極少在同一 session 跨 org；少一個參數就少一種 404 錯法，也與 Org Auth Token 綁單一 org 的語意一致。
- **已定：D2 `frame.vars` —— 預設丟棄，只給 config 開關 `includeFrameVars`（預設 `false`），agent 不得覆寫** —— vars 是 event 中最容易夾帶 token 與個資的欄位，風險該由管理者承擔而非 agent 自行決定。
- **已定：D3 第 5 個工具 —— `sentry_get_event`** —— alert email 與 Slack 通知給的是 event id，缺這支 agent 會卡住；且與 `sentry_get_latest_event` 共用 `trimEvent()`，邊際成本約 25 行，投報比最高。
- **已定：D4 issue 搜尋 endpoint —— `project_slug` 選填，有給打 project 層、沒給打 org 層** —— 跨專案 triage 與單專案 triage 都是真實需求，兩支 endpoint 語意幾乎相同，成本只多約 6 行；代價是工具描述必須明寫這個分歧行為（已寫入 §3.2），且 org 層路徑的可用性列為驗證項 V4（含兩層回退）。
- **已定：D5 short id —— 自動解析（`/organizations/{org}/shortids/{short_id}/` → 數字 id）** —— 人類貼給 agent 的幾乎都是 `PROJ-ABC`；代價是單次工具呼叫可能發兩次 HTTP（共用同一個 deadline，見 §5），此事實已寫進工具描述，自架相容性列為驗證項 V3。
- **已定：D6 400 訊息透出 —— 採 G2** —— 本插件的 `INVALID_QUERY` 是此規則的主要受益者。
- **已定：D7 `baseUrl` 預設 `https://sentry.io/`** —— Sentry 有明確公有雲主站，預設值省掉多數 SaaS 使用者一項設定；代價是 EU region 使用者可能拿到 401/404，已用「401/404 訊息附 region 提示 + README 明寫」緩解。
- **已定：D8 `statsPeriod` —— 只開放 `24h` / `14d`，預設 `14d`** —— 工具描述與實際行為必須對得起來（registry 會比對），保守值最安全；是否可放寬列為驗證項 V1 / V2，確認後於 v0.2 處理。

### review 修訂（2026-08-26）

獨立 reviewer 指出 27 項問題，全數修入本 spec。其中改變**設計決定**（而非補充定義）的有：

- `data` 對所有工具恆為物件（search 包成 `{issues:[…]}`、projects 包成 `{projects:[…]}`），`OUTPUT_SCHEMA` 因此可共用同一個參考（§3.0.1）。
- `exception.values[].value` 等字串的無條件截斷表（§4.9）—— 舊版三級降級碰不到 event 裡最大宗的字串。
- frame 選取規則 3 改為「候選集合 = 全部 inApp ∪ 最尾端 2 個」，消除規則與理由的矛盾（§4.2）。
- chained exception：values 至多留最後 2 個，`max_frames` 逐 stacktrace 套用（§4.2）。
- tag key 的機密樣式過濾、`request.url` 只留 `origin + pathname`、`mechanism` 只留 `{type, handled, synthetic}`（§4.5 / §4.7）。
- `meta.trimmed` 只放動態值，靜態的丟棄清單移進 tool description（§4.1）。
- `requestTimeoutMs` 定義為整個工具呼叫的共用 deadline（§5）。
- `RESPONSE_TOO_LARGE` 拆成兩種訊息、移除 `X-Sentry-Rate-Limit-Reset`、`createHttpError` 改收 ctx 物件（§6.1）。
- 分層接縫明確化（client 回原始 JSON、trim 負責裁剪與大小、tools 負責合併），並新增 `tests/tools.test.ts` 專測這條線（§7.1 / §9.5）。
- `sentry_list_projects` 不再帶出 `nextCursor`，改為 `meta.truncated`（§3.1）。
- 明確不做 `presentCall`（§3 / §8）。
