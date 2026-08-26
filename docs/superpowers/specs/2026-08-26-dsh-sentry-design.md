# dsh-sentry 設計 Spec

- 日期：2026-08-26
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

實作：config 只收「站台根 URL」，client 內部一律以 `new URL('api/0/<endpoint>', baseUrl)` 組出請求，baseUrl 正規化為結尾帶 `/`（沿用 `dsh-sonarqube` 的 `normalizeBaseUrl`）。使用者若誤填 `https://sentry.io/api/0/`，正規化時偵測 pathname 結尾為 `/api/0` 則剝除該段（額外 3 行，值得）。

**預設值**：`baseUrl` 預設 `https://sentry.io/`。README 四語都明確提醒 EU region 使用者必須改成 `https://de.sentry.io/`，且 401/404 的錯誤訊息會附一句 `Verify baseUrl matches your Sentry region (for example https://de.sentry.io/).`

### 2.2 API 版本相容性

Sentry Web API 只有 `/api/0/` 一個版本，且沒有版本協商機制；自架版本落後時的差異是「欄位少」而不是「路徑不同」。因此：

- 所有回應欄位一律 optional，缺欄位就略過，**絕不因缺欄位丟 error**。
- 已知的新版限定欄位（自架舊版可能沒有）：`substatus`、`priority`、`isUnhandled`、`seerFixabilityScore`、`issueType`。
- 已知的行為差異，v0.1 一律**先照保守值定案**，實測若證明可放寬則在 v0.2 放寬（見 §9.5 驗證清單與回退方案）：
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

---

## 3. v0.1 工具清單

共 **5 個工具**，全部 `isConcurrencySafe: () => true`，全部 GET，輸出走統一 `OUTPUT_SCHEMA`（`{ data, meta }`）並以 `JSON.stringify` render 成單一 text block。

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
- 註冊流程照 `dsh-forge`：`index.ts` 的 `apply()` 呼叫 `registerSentryTools(ctx, client, locale)`，locale 只在註冊當下讀取一次（工具 metadata 在註冊後不變）。
- 文案來源集中在 `src/locales.ts` 的 `TOOL_I18N`，型別為 `Record<Locale, ToolMessages>`，用 `satisfies` 強制四語欄位完全對齊 —— 少翻一句就編譯失敗。
- **錯誤訊息不隨 locale 改變，一律英文**。理由：錯誤訊息是穩定的診斷字串，測試與 registry 審核都以它為準；把它也四語化會讓錯誤比對變成四倍工作量而換不到多少價值。此規則要寫進 README。
- 下面各工具列出的是 `en` 文案；`zh-TW` / `zh-CN` / `ja` 為等義翻譯，語意不得偏離（尤其是描述裁剪行為的那幾句）。

### 3.1 `sentry_list_projects`

- **description（en）**：`List the projects in the configured Sentry organization. Returns slug, name, platform, status, and team for at most 100 projects.`
- **參數**：無。
- **Endpoint**：`GET /api/0/organizations/{org}/projects/?per_page=100`
- **回應裁剪**：白名單保留 `id` / `slug` / `name` / `platform` / `status` / `dateCreated` / `isMember` / `firstEvent` / `teams[].slug`，其餘全部丟棄（`features`、`options`、`latestDeploys`、`processingIssues`、`access`、`avatar` 等）。
- **分頁**：不接受 `cursor` 參數，單次最多 100 筆。若 `Link` header 顯示還有下一頁，`meta.nextCursor` 仍會帶出（供人類診斷），但沒有工具能吃它 —— 此行為要寫進工具描述與 README：**超過 100 個專案的 org 請直接用 `sentry_search_issues` 指定 `project_slug`**。
- **錯誤情境**：401 token 無效；403 缺 `org:read`；404 org slug 打錯（訊息指向 `org` 設定與 `baseUrl` region）。

### 3.2 `sentry_search_issues`

- **description（en）**：`Search Sentry issues using Sentry search syntax. Returns a trimmed summary per issue without event bodies or stacktraces. When project_slug is given the project-scoped endpoint is used; otherwise the whole organization is searched.`
- **參數**：

| 參數 | 型別 | 說明 |
| --- | --- | --- |
| `project_slug` | string | 選填。通過 `/^[a-z0-9_.-]{1,64}$/` 驗證（同時擋掉路徑穿越）。給了就打 project 層 endpoint；不給就打 org 層。 |
| `query` | string | 選填，Sentry search syntax，預設 `is:unresolved`。長度上限 400。 |
| `stats_period` | enum `24h` \| `14d` | 預設 `14d`。 |
| `sort` | enum `date` \| `new` \| `freq` \| `user` \| `recommended` | 預設 `date`；`recommended` 描述註明部分自架不支援。 |
| `environment` | string | 選填，長度上限 100。 |
| `limit` | integer 1–100 | 預設 25，對映 `per_page`。 |
| `cursor` | string | 選填，來自前一次回應的 `meta.nextCursor`。 |

- **Endpoint**：
  - 有 `project_slug` → `GET /api/0/projects/{org}/{project_slug}/issues/`
  - 無 → `GET /api/0/organizations/{org}/issues/`
- **回應頂層型別**：這兩支 endpoint 的 JSON 頂層**是陣列**（不是物件），client 的回應解析必須同時支援陣列與物件頂層 —— 這點與 `dsh-sonarqube` 不同，是最容易照抄出錯的地方。
- **回應裁剪**：每筆 issue 白名單保留
  `id` / `shortId` / `title` / `culprit` / `level` / `status` / `substatus` / `priority` / `isUnhandled` / `count` / `userCount` / `firstSeen` / `lastSeen` / `permalink` / `project.slug` / `metadata.{type,value,filename}` / `assignedTo.{type,name}`。
  - `title` 與 `metadata.value` 各截斷至 500 字元。
  - **丟棄 `stats`（時序陣列）、`annotations`、`filtered`、`inbox`、`owners`、`pluginActions`、`shareId`、`hasSeen`、`subscriptionDetails`、`seerFixabilityScore`。**
  - 依據：`stats` 通常佔單筆 issue JSON 的 60–80%，砍掉後 25 筆約落在 12–20KB。
- **meta**：`{ nextCursor?, matchingCount?, trimmed: { droppedFields: string[] } }`。
  `matchingCount` 的來源是 `X-Hits` header：僅當該 header 存在、通過 `/^\d{1,10}$/` 時轉成 number 帶出，否則不帶此欄位。
- **錯誤情境**：
  - 400 且帶了 `sort=recommended` → `UNSUPPORTED_BY_INSTANCE`
  - 其他 400 → `INVALID_QUERY`，**附上經過濾的上游 `detail` 訊息**（見 §6.2）
  - 403 缺 scope、404 slug/org 錯、429 rate limit（附安全過的 `Retry-After`）

### 3.3 `sentry_get_issue`

- **description（en）**：`Read one Sentry issue by numeric id or short id (for example PROJ-ABC). Returns counts, first and last seen, culprit, and release span. Does not include event bodies or stacktraces.`
- **參數**：`issue` (string, required, 長度 1–64)。
- **Endpoint**：
  - 純數字（`/^\d{1,20}$/`）→ `GET /api/0/issues/{issue_id}/`
  - short id（`/^[A-Za-z0-9_-]+-[A-Za-z0-9]+$/` 且非純數字）→ 先 `GET /api/0/organizations/{org}/shortids/{short_id}/` 取 `groupId`，再打上面那支。**一次工具呼叫因此可能是兩次 HTTP**，此事實要寫進工具描述。
  - 兩者皆不符 → `INVALID_INPUT`
- **回應裁剪**：保留 3.2 的 issue 摘要欄位，另加 `firstRelease.version` / `lastRelease.version` / `activity` 最新 3 筆的 `{type, dateCreated}` / `participantCount`（由 `participants.length` 算出）/ `seenByCount`。
  **丟棄 `stats`、`pluginIssues`、`pluginContexts`、`tags` 完整分佈，以及 `participants` / `seenBy` 的明細（含 email，屬 PII）。**
- **錯誤情境**：404 issue 不存在 / 已刪除 / short id 解析失敗（訊息說明 short id 需要 `org` 設定正確）；403 缺 `event:read`。

### 3.4 `sentry_get_latest_event`

- **description（en）**：`Read the latest event of a Sentry issue with a trimmed stacktrace. First-party frames are preserved, source context is limited to the innermost first-party frames, local variables and request headers are removed. Accepts a numeric issue id or a short id.`
  （描述逐句對應 §4 的裁剪行為，registry 會比對。）
- **參數**：

| 參數 | 型別 | 說明 |
| --- | --- | --- |
| `issue` | string, required | 數字 id 或 short id，解析規則同 3.3。 |
| `max_frames` | integer 1–100 | 預設 20。 |
| `include_breadcrumbs` | boolean | 預設 `true`，保留最後 20 筆。 |

- **Endpoint**：`GET /api/0/issues/{issue_id}/events/latest/`
- **回應裁剪**：見 §4，這是本插件的核心。
- **錯誤情境**：404（issue 沒有可取回的 event，例如已過保留期）；`RESPONSE_TOO_LARGE`（原始 body 超過 `maxResponseBytes`，讀取串流時即中止；或三級降級後仍超過 `MAX_TOOL_RESULT_BYTES`）。

### 3.5 `sentry_get_event`

- **description（en）**：`Read one Sentry event by event id within a project, applying the same stacktrace trimming as sentry_get_latest_event.`
- **參數**：`project_slug`（string, required, 同 3.2 的 regex）、`event_id`（string, required, `/^[0-9a-fA-F]{32}$/`）、`max_frames`、`include_breadcrumbs`（同 3.4）。
- **Endpoint**：`GET /api/0/projects/{org}/{project_slug}/events/{event_id}/`
- **回應裁剪**：與 3.4 **完全共用** `trimEvent()`。
- **存在理由**：alert email / Slack 通知裡給的是 event id 而非 issue id。與 3.4 共用裁剪，邊際成本約 25 行。
- **錯誤情境**：404 event 不存在或不屬於該 project；`INVALID_INPUT`（event_id 非 32 hex、project_slug 格式錯）。

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
  request?: { method, url },        // headers / cookies / env / data 一律丟棄
}
```

`exception` 缺席時退而取 `threads` entry 中 `crashed === true`（沒有就取第一個）的 thread stacktrace，包成同樣的 `exception.values` 形狀，並在 `meta.trimmed.droppedFields` 記 `"exception→threads"`。

`meta` 額外帶 `trimmed` 描述被砍掉了什麼：

```
meta.trimmed = {
  omittedFrames: number,
  omittedBreadcrumbs: number,
  droppedEntries: string[],           // e.g. ["spans", "csp"]
  droppedFields: string[],            // e.g. ["packages", "request.headers", "frame.vars"]
  eventProcessingErrors: number,      // 原 errors[].length
  degraded?: "source_context" | "breadcrumbs" | "frames"
}
```

讓 agent 清楚知道「我看到的不是全部」，避免據此下錯結論。

### 4.2 frame 選取（最重要的一條規則）

Sentry 的 `frames` 陣列是 **由外而內、最內層（crash 點）在最後**。

決定性規則（無隨機性）：

1. 令 `N = max_frames`（預設 20）、`total = frames.length`。
2. `total <= N` → 全留。
3. 否則：
   a. `inApp = frames.filter(f => f.inApp === true)`
   b. `inApp.length >= N` → 取 `inApp` 的**最後 N 個**
   c. 否則 → 保留全部 `inApp`，再從**尾端**往前補入非 inApp frames 直到湊滿 N 個；最後依原始索引重新排序，維持原始由外而內的順序。
4. `omittedFrames = total - kept.length`。

理由：第一方程式碼（`inApp`）永遠是 agent 最需要的；框架 / node_modules / stdlib frames 是雜訊。同時保留最尾端的非 inApp frames，因為 crash 常發生在函式庫內部、緊鄰的那幾層有診斷價值。

### 4.3 每個 frame 保留的欄位

- **保留**：`filename`、`module?`、`function`、`lineNo`、`colNo`、`inApp`、`package?`、`context?`（見 4.4）、`vars?`（僅 `includeFrameVars: true` 時）。
- **丟棄**：`absPath`（多半與 filename 重複且會洩漏建置機器的絕對路徑）、`rawFunction`、`symbol`、`symbolAddr`、`instructionAddr`、`trust`、`platform`、`errors`、`minGroupingLevel`、`origAbsPath`、`data`、`addrMode`。

### 4.4 原始碼片段（`context`）

Sentry 每個 frame 的 `context` 是 `[[lineNo, sourceText], …]`，通常前後各 5 行共 11 行。

1. 只對 `inApp === true` 的 frame 保留 context。
2. 只對**最內層的 3 個** inApp frame 保留（常數 `SOURCE_CONTEXT_FRAMES = 3`，不開放設定）。
3. 每行 sourceText 截斷至 200 字元（超過者尾端加 `…`）。
4. 每個 frame 至多保留 11 行；超過時取以該 frame 的 `lineNo` 為中心的 ±5 行。

理由：source context 是 event 裡體積成長最快的欄位（20 frames × 11 行 × 平均 80 字元 ≈ 18KB），但只有 crash 點附近的第一方程式碼真的有用。

### 4.5 tags

- 先提取 `release` / `environment` / `level` 成頂層欄位，並從 tags 陣列中移除，避免重複。
- 其餘 tags 保留至多 30 筆（依原順序取前 30），`key` 上限 64 字元、`value` 上限 200 字元。
- 丟棄所有 `sentry:` 前綴的內部 tag。

### 4.6 contexts

白名單 `runtime` / `os` / `browser` / `device` / `trace`；每個 context 物件只保留 `type` / `name` / `version`（`trace` 保留 `trace_id` / `span_id` / `op`）。丟棄 `state`（Redux/Vuex state dump，可以是幾百 KB 且必然含 PII）、`app`，以及所有自訂 context。

### 4.7 安全性裁剪（不可設定，強制）

以下欄位**無條件丟棄**，因為它們是憑證 / PII 洩漏的主要途徑：

| 欄位 | 理由 |
| --- | --- |
| `entries[request].headers` / `cookies` / `env` | 幾乎必定含 `Authorization` / `Cookie` / session |
| `entries[request].data` | POST body，含密碼 / token 的常見位置 |
| `frame.vars` | 區域變數常含 token、連線字串、使用者資料。**唯一例外**：`config.includeFrameVars === true`（管理者明示承擔風險，agent 無法覆寫） |
| `contexts.state` | 完整前端 state dump |
| `user.email` / `user.ip_address` / `user.username` | PII；`user.id` 保留（除錯需要辨識而非識別） |
| `packages` / `modules` | 幾百個相依套件版本，體積大、除錯價值低 |
| `_meta` | 純內部標註 |
| `errors[]` | 只保留 `errors.length` 成 `meta.trimmed.eventProcessingErrors` |

### 4.8 最終大小上限與降級

- 常數 `MAX_TOOL_RESULT_BYTES = 200_000`（不開放設定）。
- **五個工具的最終輸出都要通過這個檢查**；但只有 `sentry_get_latest_event` / `sentry_get_event` 有降級路徑，其餘三個工具的輸出形狀固定且小，超標即直接丟 `RESPONSE_TOO_LARGE`。
- event 工具的降級：`trimEvent()` 在記憶體中保有解析後的原始 event，序列化後若超標，依**固定順序**逐級重跑並記錄 `meta.trimmed.degraded`：
  1. 移除所有 frame 的 `context` → `"source_context"`
  2. 再移除 `breadcrumbs` → `"breadcrumbs"`
  3. 再以 `max_frames = 10` 重跑 §4.2 的選取 → `"frames"`
  - `degraded` 只記錄**最後套用到的那一級**（隱含前面幾級都已套用）。
- 三級降級後仍超標 → 丟 `RESPONSE_TOO_LARGE`。
- 更早的一層防線：HTTP 讀取串流時就以 `maxResponseBytes`（預設 5MB）中止，避免把 2MB+ 的 body 讀進記憶體再裁剪。

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
| `org` | `SENTRY_ORG` | 無（必填） | `/^[a-z0-9_-]{1,64}$/` | 組織 slug，全域固定（見 §11 D1） |
| `locale` | — | `en` | enum `en` / `zh-TW` / `zh-CN` / `ja` | **決定 runtime tool description 語言**（G1）。不影響 tool name，也不影響錯誤訊息（一律英文） |
| `includeFrameVars` | `SENTRY_INCLUDE_FRAME_VARS` | `false` | 環境變數**只有字串 `'true'`（trim 後、大小寫不敏感）才視為開啟**，其餘一律視為 `false` | 是否保留 stacktrace 區域變數；管理者層級的風險決定，agent 不得覆寫 |
| `requestTimeoutMs` | — | `30_000` | 整數 1 – 300_000 | |
| `maxResponseBytes` | — | `5 * 1024 * 1024` | 整數 1 – 50 * 1024 * 1024 | HTTP body 硬上限 |

解析順序：**plugin config 覆蓋環境變數**（`config.x?.trim() || env.X?.trim() || default`），與 `dsh-sonarqube` 的 `resolveConfig` 一致。`locale` 無環境變數對應 —— 它是 harness 使用者的介面偏好，屬 plugin config 的範疇，不需要第二條設定路徑。

`max_frames` / `include_breadcrumbs` **不放 config，放工具參數** —— 那是「這次要看多深」的臨場判斷，該由 agent 決定。`includeFrameVars` 與 `locale` 則是部署層級設定，只在 config。

Schemastery 的 config 欄位說明（`CONFIG_I18N`）四語齊備，放 `src/locales.ts`。

---

## 6. 錯誤碼清單

### 6.1 清單

沿用 `dsh-sonarqube` 的 13 個碼（含 3 個非 HTTP 碼），新增 2 個 Sentry 專屬，共 15 個。訊息一律英文（見 §3.0）。

| Code | 觸發條件 | 訊息 |
| --- | --- | --- |
| `INVALID_CONFIG` | baseUrl / token / org / locale 驗證失敗 | `Invalid Sentry configuration: …` |
| `INVALID_INPUT` | 工具參數驗證失敗（slug 格式、event_id 非 32 hex、cursor 格式、limit 越界、issue 既非數字也非 short id） | `Invalid Sentry input: …` |
| `INVALID_QUERY` | **新增**。issue 搜尋 endpoint 回 400，且非 `sort=recommended` 造成 | `Sentry rejected the search query. Check the Sentry search syntax. Sentry said: {detail}`（`{detail}` 見 §6.2；無法取得時退回不含後半句的靜態訊息） |
| `UNSUPPORTED_BY_INSTANCE` | **新增**。400 且該次請求帶了 `sort=recommended` | `This Sentry instance does not support the requested sort order.` |
| `AUTHENTICATION_FAILED` | 401 | `Sentry authentication failed. Check the configured token. Verify baseUrl matches your Sentry region (for example https://de.sentry.io/).` |
| `PERMISSION_DENIED` | 403 | `Sentry denied access to this resource. Check the token scopes (org:read, project:read, event:read).` |
| `NOT_FOUND` | 404 | `The requested Sentry resource was not found. Verify the org slug and that baseUrl matches your Sentry region.` |
| `RATE_LIMITED` | 429 | `Sentry rate limit exceeded. Retry later.`（附安全過的 `Retry-After`、`X-Sentry-Rate-Limit-Reset`） |
| `SERVER_ERROR` | >= 500 | `Sentry server error (HTTP {status}).` |
| `SENTRY_HTTP_ERROR` | 其他非 2xx（含非搜尋 endpoint 的 400） | `Sentry request failed (HTTP {status}).` |
| `INVALID_RESPONSE` | 非 JSON content-type / JSON parse 失敗 / 頂層既非物件也非陣列 | `Sentry returned an unexpected response.` |
| `RESPONSE_TOO_LARGE` | body 超過 `maxResponseBytes`，或裁剪三級降級後仍超過 `MAX_TOOL_RESULT_BYTES` | `Sentry response exceeded the configured maximum of {n} bytes.` |
| `REQUEST_TIMEOUT` | 內部 timer 觸發 abort | `Sentry request timed out after {ms} ms.` |
| `REQUEST_ABORTED` | caller 的 `exec.signal` abort | `Sentry request was cancelled.` |
| `NETWORK_ERROR` | fetch throw 且非上述 | `Unable to reach the Sentry server.` |

**400 的判定優先序（唯一解讀）**：`sort=recommended` → `UNSUPPORTED_BY_INSTANCE`；否則若請求來自 `sentry_search_issues` → `INVALID_QUERY`；否則 → `SENTRY_HTTP_ERROR`。

`SentryApiError` 類別結構比照 `SonarQubeApiError`：`code` / `status` / `retryAfter` / `detail`，`toJSON()` 只吐這些欄位。Header 回傳前先過 `safeHeader()`（長度 <= 128 且不含 token）。

### 6.2 400 錯誤訊息透出規則（G2）

> **與 `dsh-sonarqube` 不同，此處為刻意例外。** `dsh-sonarqube` 的慣例是「error 永不夾帶 response body」；本插件在 HTTP 400 這一種情況下打破它，理由是 Sentry search syntax 的錯誤若不回饋（例如 `Invalid query. "foo" is not a supported search key`），agent 只能盲猜，往往連續呼叫失敗數次。此例外的範圍被嚴格框死如下。

透出流程 `sanitizeUpstreamDetail(body: unknown): string | undefined`：

1. **只在 HTTP 400 時執行**。401 / 403 / 404 / 429 / 5xx 一律維持靜態訊息，永不夾帶 body。
2. **只取結構化欄位**：依序嘗試 `body.detail`、`body.error`；必須是 string，否則放棄（回 `undefined`）。**絕不整包序列化 response body。**
3. **過濾疑似機密**：若該字串
   - 包含 config 的 `token` 字面值，或
   - 命中 `/(bearer\s|authorization|sntry[us]_|sntrys_|api[_-]?key|secret|password|token\s*[:=])/i`
   則整條放棄（回 `undefined`），退回靜態訊息。
4. **控制字元清洗**：移除 `\r` `\n` 與其他 ASCII 控制字元，連續空白壓成單一空格。
5. **長度上限 200 字元**：超過即截斷並在尾端加 `…`。
6. 結果同時放進 `SentryApiError.detail` 與訊息尾端的 `Sentry said: {detail}`。

未通過任何一關時，訊息就是不含 `Sentry said:` 的靜態版本 —— agent 拿到的訊息形狀因此有兩種，這點要寫進 README。

---

## 7. 檔案結構與職責

```
dsh-sentry/
├─ src/
│  ├─ index.ts        插件入口：name / inject / Config schema / apply()（讀 locale 傳給 registerSentryTools）
│  ├─ config.ts       config 型別、Locale 型別、預設值、上下界常數、resolveConfig / validateResolvedConfig
│  ├─ errors.ts       SentryErrorCode、SentryApiError、createHttpError、sanitizeUpstreamDetail
│  ├─ client.ts       SentryClient：HTTP GET、逾時、串流大小上限、Link/X-Hits header 解析、short id 解析、參數驗證
│  ├─ trim.ts         trimProjectList / trimIssueList / trimIssue / trimEvent（frame 選取、安全裁剪、三級降級）
│  ├─ tools.ts        registerSentryTools(ctx, client, locale)、5 個 defineTool、OUTPUT_SCHEMA、renderJson
│  ├─ locales.ts      CONFIG_I18N + TOOL_I18N（en / zh-TW / zh-CN / ja，含每個參數的 description）
│  └─ types.ts        JsonValue/JsonObject、ApiResult、各工具參數介面
├─ tests/
│  ├─ client.test.ts
│  ├─ trim.test.ts
│  ├─ errors.test.ts
│  ├─ locales.test.ts
│  ├─ plugin.test.ts
│  └─ fixtures/       event-node.json / event-python.json / event-browser.json / issues-list.json / event-huge.json
├─ .github/workflows/ ci.yml、release.yml
├─ cordis.patch.yml
├─ package.json、tsconfig.json、tsconfig.build.json、biome.json、vitest.config.ts
├─ README.md / README.zh-TW.md / README.zh-CN.md / README.ja.md
└─ LICENSE (MIT)
```

預估行數：

| 檔案 | 行數 | 說明 |
| --- | --- | --- |
| `config.ts` | ~130 | 比 sonarqube 多 `org` / `locale` / `includeFrameVars` 三欄與 slug、boolean env 驗證 |
| `errors.ts` | ~150 | 15 個碼 + `sanitizeUpstreamDetail` |
| `client.ts` | ~290 | 沿用 sonarqube 的 request context / 串流讀取，新增 Link + X-Hits 解析、陣列頂層支援、short id 解析 |
| `trim.ts` | ~240 | **本插件價值所在** |
| `tools.ts` | ~210 | 5 個工具，description 從 `TOOL_I18N[locale]` 取 |
| `locales.ts` | ~320 | config 7 欄 + 5 個工具的 description 與參數 description，× 四語 |
| `types.ts` | ~80 | |
| `index.ts` | ~85 | |
| **合計** | **~1505** | 比 dsh-forge（1001 行）多，多出來的幾乎全在 `locales.ts` 的四語文案 |

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
8. **自動翻頁 / 聚合**：不做 client 端自動抓完所有頁；只回一頁 + `nextCursor`。`sentry_list_projects` 更是連 cursor 參數都不收。
9. **本地快取**。
10. **DSN / event ingestion**：不送任何 event 到 Sentry，也不讀 `SENTRY_DSN`。
11. **attachment / minidump / source map 下載**。
12. **`raw: true` 直通模式**：不提供「回傳未裁剪原始 JSON」的逃生門（裁剪是本插件的核心價值；有此需求者請用 `sentry api`）。
13. **錯誤訊息的四語化**：錯誤訊息一律英文（§3.0）。

---

## 9. 測試策略

框架：**vitest**（`vitest run`，coverage v8，門檻 branches/functions/lines/statements 皆 80%，`src/types.ts` 排除）—— 沿用 `dsh-sonarqube/vitest.config.ts`。

### 9.1 `tests/client.test.ts`（mock `fetch`）

client 建構子接受 `fetchImplementation` 注入（同 sonarqube），測試傳入 `vi.fn<MockFetch>()`。

- config 解析：plugin config 覆蓋 env；缺 token / 缺 org 各丟 `INVALID_CONFIG`；baseUrl 非 http(s) / 含帳密 / 含 query 各丟錯；`https://sentry.io/api/0/` 正規化成 `https://sentry.io/`；子路徑 `https://x.com/sentry/` 組出 `https://x.com/sentry/api/0/…`；`SENTRY_INCLUDE_FRAME_VARS='TRUE'` 開啟、`'1'` / `'yes'` / 空字串不開啟。
- URL 組裝：每個工具打到正確 endpoint、帶對 query（`per_page` / `statsPeriod` / `query` / `environment` / `cursor` / `sort`）。
- `Authorization: Bearer` header 正確；**斷言 error 訊息與 `toJSON()` 都不含 token 字串**。
- 參數驗證：`limit` 0 / 101、`cursor` 格式錯、`event_id` 非 hex、`project_slug` 含 `/` 或 `..`（路徑穿越）、`issue` 既非數字也非 short id → 各丟 `INVALID_INPUT`。
- HTTP 狀態映射與 400 優先序：400 + `sort=recommended` → `UNSUPPORTED_BY_INSTANCE`；400 於搜尋 → `INVALID_QUERY`；400 於 `sentry_get_event` → `SENTRY_HTTP_ERROR`；401 / 403 / 404 / 429（含 `Retry-After`）/ 500 / 418。
- 回應解析：**頂層為陣列**（issue 列表）與頂層為物件（issue 詳情）都要成功；頂層為字串/數字 → `INVALID_RESPONSE`；非 JSON content-type、壞掉的 JSON。
- `Link` header：`results="true"` 取 cursor、`results="false"` 不放 `nextCursor`、header 缺失、header 格式異常。`X-Hits`：合法數字帶出、非數字 / 超長不帶出。
- 大小上限：`content-length` 超標即中止；串流累積超標中止；兩者都丟 `RESPONSE_TOO_LARGE` 且有呼叫 `reader.cancel()`。
- 逾時：`vi.useFakeTimers()` 推進時間 → `REQUEST_TIMEOUT`；caller signal abort → `REQUEST_ABORTED`；fetch reject → `NETWORK_ERROR`。
- short id 解析：`PROJ-ABC` 觸發兩次 fetch（shortids → issues）且第二次 URL 用解析出的 `groupId`；數字 id 只觸發一次；shortids 回 404 → `NOT_FOUND`。

### 9.2 `tests/trim.test.ts`（純函式，用 fixture）

`trim.ts` 全是純函式，**不需要 mock 任何東西** —— 這是把裁剪抽成獨立檔案的主要理由。

Fixtures：3 份真實形狀的 event JSON（Node.js 未捕捉例外、Python 有 source context、瀏覽器 JS 有 breadcrumbs + request），各自從真實 Sentry 抓下後**手動清洗掉真實憑證與 PII** 再入庫；另 1 份人工放大的 `event-huge.json`（塞入 300KB 的 exception value）供降級測試。

- frame 選取三條分支：`total <= N` 全留；`inApp >= N` 取最後 N 個 inApp；混合情形保留全部 inApp + 尾端補滿，且**輸出順序仍是原始由外而內**。`omittedFrames` 數字正確。
- source context 只出現在最內層 3 個 inApp frame；非 inApp frame 沒有 context；單行超過 200 字元被截斷；行數上限 11。
- 安全裁剪：fixture 含 `request.headers.Authorization` / `frame.vars.token` / `contexts.state` / `user.email`，斷言 `JSON.stringify(out)` **完全找不到**那些值。
- `includeFrameVars: true` 時 `vars` 才出現。
- breadcrumbs：`include_breadcrumbs: false` 完全不出現；`true` 只留最後 20 筆且欄位正確；`omittedBreadcrumbs` 正確。
- `exception` 缺席但有 `threads` → 取 `crashed === true` 的 thread；都沒 `crashed` → 取第一個；`droppedFields` 記 `"exception→threads"`。
- 三級降級：`event-huge.json` 驗證 `degraded` 依序為 `source_context` → `breadcrumbs` → `frames`，且 `degraded` 只記最後一級；仍超標時丟 `RESPONSE_TOO_LARGE`。
- 非 event 工具超標即丟（不降級）。
- 缺欄位韌性：把 fixture 的 `entries` / `contexts` / `tags` / `sdk` / `user` 逐一刪掉，斷言不 throw（模擬自架舊版）。
- issue 裁剪：`stats` 被移除、`title` 與 `metadata.value` 截斷、缺 `substatus` / `priority` 不 throw、`participants` 只剩 count。

### 9.3 `tests/errors.test.ts`（G2 專測）

`sanitizeUpstreamDetail` 是安全敏感函式，獨立一檔測到底：

- `{detail: "Invalid query..."}` → 原樣透出。
- `{error: "..."}`（無 `detail`）→ 透出。
- `detail` 非 string（物件 / 陣列 / number）→ `undefined`。
- 含 config token 字面值 → `undefined`。
- 命中 `bearer ` / `Authorization` / `sntryu_` / `api_key` / `secret` / `password` / `token=` 各關鍵字 → 全數 `undefined`（逐一 case）。
- 含 `\n` `\r` `\t` 與連續空白 → 清洗成單行單空格。
- 250 字元 → 截斷成 200 字元 + `…`。
- **只在 400 執行**：401 / 403 / 404 / 500 帶了 `{detail: "leak"}` 的 body，斷言最終錯誤訊息與 `toJSON()` 都不含 `"leak"`。

### 9.4 `tests/locales.test.ts`（G1 專測）

- `CONFIG_I18N` 與 `TOOL_I18N` 的 key 集合完全等於 `['en','zh-TW','zh-CN','ja']`（外加 Schemastery 慣用的 `en-US` / `zh` / `ja-JP` 別名指向同一份，僅 `CONFIG_I18N` 需要）。
- 對每個 locale：五個工具的 description 與**每一個參數**的 description 都存在且非空白字串。
- 四語之間的參數 key 集合完全一致（用 `Object.keys` 互比），確保沒有漏翻。
- 各語言的 description 互不相同（防止複製貼上時忘了翻譯）。

### 9.5 `tests/plugin.test.ts`

沿用 `dsh-sonarqube` 的做法（含 `Object.hasOwn(globalThis, 'Bun') ? it.skip : it` 的 Bun 規避）：

- `name === 'dsh-sentry'`、`inject === ['tools']`、`Config` 已定義。
- `Config.meta.description` 與各欄位描述四語齊全。
- `apply()` 以 fake `ctx.tools.register` 註冊出 **5 個**工具，逐一斷言 `name`、`isConcurrencySafe() === true`、`output.schema === OUTPUT_SCHEMA`。
- **locale 切換**：`apply(ctx, {locale: 'zh-TW', …})` 註冊出的工具，`name` 仍是英文、`description` 是繁中；`locale: 'ja'` 是日文；不給 locale 時是英文。
- `renderJson` 回傳單一 `{ type: 'text' }` block。

### 9.6 CI

`ci.yml` 沿用 `dsh-sonarqube`：`lint` → `typecheck` → `test --coverage` → `build` → **pack smoke test**（`bun pm pack` 後 `tar -tzf` 斷言 `lib/index.js`、`lib/index.d.ts`、`lib/locales.js`、`lib/locales.d.ts`、`cordis.patch.yml`、四份 README、`LICENSE` 都在 tarball 裡）＋ Node 22.19 / 24 雙版本 runtime job（`node --input-type=module --eval "await import('./lib/index.js')"`）。

### 9.7 上線前 live 驗證清單（手動，不進 CI）

**Sentry 實例可用**，以下項目在發 v0.1.0 tag 前必須實測；每項都已有定案值，實測只是確認，不符時走列出的回退方案。

環境：(1) sentry.io SaaS 一個 org；(2) 一台自架 Sentry（版本記進 README）。

| # | 要驗證的假設 | 定案值 | 實測不符時的回退方案 |
| --- | --- | --- | --- |
| V1 | `/organizations/{org}/issues/` 接受 `statsPeriod=24h` 與 `14d` | enum 只開這兩個 | 若某值被拒 → 該值移出 enum，預設改為仍可用者；若兩者皆被拒 → 移除 `stats_period` 參數，改用 endpoint 預設 |
| V2 | 是否有更寬鬆的 `statsPeriod`（`7d` / `30d` / `90d`）可用 | v0.1 不開放 | 若確認可用，記錄於 spec 附註，v0.2 放寬（不改 v0.1） |
| V3 | `/organizations/{org}/shortids/{short_id}/` 在自架版本存在且回 `groupId` | `sentry_get_issue` / `sentry_get_latest_event` 自動解析 short id | 若不存在 → 保留自動解析路徑，但把該 endpoint 的 404 特別映射成訊息「此 Sentry 版本不支援 short id，請改用數字 issue id」 |
| V4 | org 層 issue 搜尋是否需要數字 `project` id 才能過濾專案 | v0.1 靠 `project_slug` 切 endpoint，org 層不做專案過濾 | 無需回退（設計已規避）；僅確認 org 層不帶 `project` 參數時能正常回全 org 結果 |
| V5 | Org Auth Token（`sntrys_`）對 `/issues/{id}/` 與 `/issues/{id}/events/latest/` 可用 | README 建議 Org Auth Token | 若不可用 → README 改為建議 User Auth Token，並在 scope 表註明 |
| V6 | `sort=recommended` 在自架回 400 | 映射為 `UNSUPPORTED_BY_INSTANCE` | 若回的是其他狀態碼 → 依實際狀態碼調整映射條件 |
| V7 | issue 列表 endpoint 的 JSON 頂層確為陣列，且 `Link` / `X-Hits` header 存在 | client 支援陣列頂層、解析兩個 header | 若 `X-Hits` 不存在 → `matchingCount` 自然不帶出，無需改碼（已是 optional） |
| V8 | 400 的 body 確實有 `detail` 欄位且為 string | `sanitizeUpstreamDetail` 優先取 `detail`、次取 `error` | 若欄位名不同 → 在 §6.2 步驟 2 的欄位清單追加該欄位名 |
| V9 | 三份 event fixture 的欄位形狀與 §4 假設一致（`entries` 陣列、`context` 為 `[lineNo, text]` 配對、frames 由外而內） | §4 全部規則 | 任一不符 → 這是**阻斷性**問題，須回頭修 §4 後再實作 |
| V10 | 實際裁剪後的輸出大小落在預期（issue 列表 25 筆 12–20KB、單一 event < 60KB） | `MAX_TOOL_RESULT_BYTES = 200_000` | 若普遍逼近上限 → 下修 `max_frames` 預設值（20 → 12），常數不動 |

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
- 四語 README：`README.md`（en）/ `README.zh-TW.md` / `README.zh-CN.md` / `README.ja.md`，頂部互相連結，內容須含：工具表、所需 scope 表、config 表（含 `locale`）、「錯誤訊息一律英文」說明、400 訊息兩種形狀的說明、非目標段落、live 驗證日期與 Sentry 版本。

---

## 11. 決策紀錄

### 全域慣例（三插件一致）

- **已定：G1 runtime tool metadata 四語 —— 採 `config.locale`（`createXxxTools(client, locale)`）** —— tool name 固定英文、description 與參數說明依 locale 切換，是硬性要求；文案集中於 `locales.ts` 並以 `satisfies` 強制四語對齊，漏翻即編譯失敗。
- **已定：G2 上游錯誤訊息 —— 僅 HTTP 400 過濾後透出** —— 只取結構化欄位（`detail` / `error`）、上限 200 字元、命中機密樣式即整條放棄；其餘狀態碼維持靜態訊息。**與 `dsh-sonarqube` 不同，此處為刻意例外，理由是 query 語法錯誤若不回饋，agent 只能盲猜。**

### 本插件

- **已定：D1 org slug —— config 固定 `org`，工具參數不接受覆寫** —— 自架幾乎都是單 org，SaaS 也極少在同一 session 跨 org；少一個參數就少一種 404 錯法，也與 Org Auth Token 綁單一 org 的語意一致。
- **已定：D2 `frame.vars` —— 預設丟棄，只給 config 開關 `includeFrameVars`（預設 `false`），agent 不得覆寫** —— vars 是 event 中最容易夾帶 token 與個資的欄位，風險該由管理者承擔而非 agent 自行決定。
- **已定：D3 第 5 個工具 —— `sentry_get_event`** —— alert email 與 Slack 通知給的是 event id，缺這支 agent 會卡住；且與 `sentry_get_latest_event` 共用 `trimEvent()`，邊際成本約 25 行，投報比最高。
- **已定：D4 issue 搜尋 endpoint —— `project_slug` 選填，有給打 project 層、沒給打 org 層** —— 跨專案 triage 與單專案 triage 都是真實需求，兩支 endpoint 語意幾乎相同，成本只多約 6 行；代價是工具描述必須明寫這個分歧行為（已寫入 §3.2）。
- **已定：D5 short id —— 自動解析（`/organizations/{org}/shortids/{short_id}/` → 數字 id）** —— 人類貼給 agent 的幾乎都是 `PROJ-ABC`；代價是單次工具呼叫可能發兩次 HTTP，此事實已寫進工具描述，自架相容性列為驗證項 V3。
- **已定：D6 400 訊息透出 —— 採 G2（過濾後透出）** —— 見上方 G2；本插件的 `INVALID_QUERY` 是此規則的主要受益者。
- **已定：D7 `baseUrl` 預設 `https://sentry.io/`** —— Sentry 有明確公有雲主站，預設值省掉多數 SaaS 使用者一項設定；代價是 EU region 使用者可能拿到 401/404，已用「401/404 訊息附 region 提示 + README 明寫」緩解。
- **已定：D8 `statsPeriod` —— 只開放 `24h` / `14d`，預設 `14d`** —— 工具描述與實際行為必須對得起來（registry 會比對），保守值最安全；是否可放寬列為驗證項 V1 / V2，確認後於 v0.2 處理。
