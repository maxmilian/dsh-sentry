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
  baseUrl:
    'Sentry site root URL. Falls back to SENTRY_URL. Use https://de.sentry.io/ for the EU region.',
  token: 'Sentry auth token. Prefer the SENTRY_AUTH_TOKEN environment variable.',
  org: 'Sentry organization slug. Falls back to SENTRY_ORG.',
  locale: 'Language used for tool and parameter descriptions. Error messages stay in English.',
  includeFrameVars:
    'Include stack frame local variables. Off by default because they often carry tokens and personal data.',
  requestTimeoutMs:
    'Deadline in milliseconds for one whole tool call, including the extra request a short id needs.',
  maxResponseBytes: 'Maximum HTTP response body size in bytes.',
} as const satisfies ConfigLocaleMessages

const TRADITIONAL_CHINESE_CONFIG = {
  $description: 'Sentry 唯讀整合設定。',
  baseUrl: 'Sentry 站台根網址；未設定時讀取 SENTRY_URL。歐盟區請填 https://de.sentry.io/。',
  token: 'Sentry auth token；建議使用 SENTRY_AUTH_TOKEN 環境變數。',
  org: 'Sentry 組織 slug；未設定時讀取 SENTRY_ORG。',
  locale: '工具與參數描述使用的語言。錯誤訊息一律維持英文。',
  includeFrameVars:
    '是否保留 stacktrace 的區域變數。預設關閉，因為區域變數常夾帶 token 與個人資料。',
  requestTimeoutMs: '單次工具呼叫的總逾時（毫秒），包含 short id 需要的額外一次請求。',
  maxResponseBytes: 'HTTP 回應內容的大小上限（位元組）。',
} as const satisfies ConfigLocaleMessages

const SIMPLIFIED_CHINESE_CONFIG = {
  $description: 'Sentry 只读集成设置。',
  baseUrl: 'Sentry 站点根 URL；未设置时读取 SENTRY_URL。欧盟区请填 https://de.sentry.io/。',
  token: 'Sentry auth token；建议使用 SENTRY_AUTH_TOKEN 环境变量。',
  org: 'Sentry 组织 slug；未设置时读取 SENTRY_ORG。',
  locale: '工具与参数描述使用的语言。错误消息一律保持英文。',
  includeFrameVars:
    '是否保留 stacktrace 的局部变量。默认关闭，因为局部变量常夹带 token 与个人数据。',
  requestTimeoutMs: '单次工具调用的总超时（毫秒），包含 short id 需要的额外一次请求。',
  maxResponseBytes: 'HTTP 响应内容的大小上限（字节）。',
} as const satisfies ConfigLocaleMessages

const JAPANESE_CONFIG = {
  $description: 'Sentry の読み取り専用連携設定。',
  baseUrl:
    'Sentry サイトのルート URL。未設定の場合は SENTRY_URL を使用します。EU リージョンでは https://de.sentry.io/ を指定してください。',
  token: 'Sentry の auth token。SENTRY_AUTH_TOKEN 環境変数の使用を推奨します。',
  org: 'Sentry の組織 slug。未設定の場合は SENTRY_ORG を使用します。',
  locale: 'ツールとパラメータの説明に使用する言語。エラーメッセージは常に英語のままです。',
  includeFrameVars:
    'スタックフレームのローカル変数を含めるかどうか。トークンや個人情報を含みやすいため既定では無効です。',
  requestTimeoutMs:
    'ツール呼び出し全体の制限時間（ミリ秒）。short id の解決に必要な追加リクエストも含みます。',
  maxResponseBytes: 'HTTP レスポンス本文の最大サイズ（バイト）。',
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

const TRADITIONAL_CHINESE_TOOLS = {
  sentry_list_projects: {
    description:
      '列出設定的 Sentry 組織底下的專案。最多回傳 100 個專案的 id、slug、名稱、平台、狀態與團隊 slug；組織專案數超過時 meta.truncated 為 true。',
    params: {},
  },
  sentry_search_issues: {
    description:
      '以 Sentry search syntax 搜尋 issue。每筆只回裁剪後的摘要：不含 event 內容、不含 stacktrace、不含時序統計。有給 project_slug 時打專案層 endpoint，否則搜尋整個組織。',
    params: {
      project_slug: '專案 slug。省略則搜尋整個組織。',
      query: 'Sentry search syntax。預設 is:unresolved。',
      stats_period: '時間範圍，24h 或 14d。預設 14d。',
      sort: '排序方式。預設 date。部分自架版本不接受 recommended。',
      environment: '環境名稱。',
      limit: '每頁筆數，1 到 100。預設 25。',
      cursor: '前一次呼叫回傳的 meta.nextCursor 分頁游標。',
    },
  },
  sentry_get_issue: {
    description:
      '以數字 id 或 short id（例如 PROJ-ABC）讀取單一 Sentry issue。回傳次數、首次與最後出現時間、culprit 與版本區間。不含 event 內容與 stacktrace。使用 short id 會多花一次請求解析成數字 id。',
    params: { issue: '數字 issue id，或 PROJ-ABC 這類 short id。' },
  },
  sentry_get_latest_event: {
    description:
      '讀取 Sentry issue 的最新 event，並裁剪 stacktrace。保留第一方 frame，原始碼片段只保留最內層的第一方 frame，並移除區域變數、request headers、request body、query string、套件清單與疑似機密的 tag。接受數字 issue id 或 short id；使用 short id 會多花一次請求。',
    params: {
      issue: '數字 issue id，或 PROJ-ABC 這類 short id。',
      max_frames: '每個 stacktrace 保留的 frame 數上限，1 到 100。預設 20。',
      include_breadcrumbs: '是否保留最後 20 筆 breadcrumb。預設 true。',
    },
  },
  sentry_get_event: {
    description:
      '依 event id 讀取專案內的單一 Sentry event，套用與 sentry_get_latest_event 相同的 stacktrace 裁剪。',
    params: {
      project_slug: '該 event 所屬的專案 slug。',
      event_id: 'Event id，32 個十六進位字元。',
      max_frames: '每個 stacktrace 保留的 frame 數上限，1 到 100。預設 20。',
      include_breadcrumbs: '是否保留最後 20 筆 breadcrumb。預設 true。',
    },
  },
} as const satisfies ToolMessages

const SIMPLIFIED_CHINESE_TOOLS = {
  sentry_list_projects: {
    description:
      '列出所配置的 Sentry 组织下的项目。最多返回 100 个项目的 id、slug、名称、平台、状态与团队 slug；组织项目数超出时 meta.truncated 为 true。',
    params: {},
  },
  sentry_search_issues: {
    description:
      '使用 Sentry search syntax 搜索 issue。每条仅返回裁剪后的摘要：不含 event 内容、不含 stacktrace、不含时序统计。给出 project_slug 时使用项目级 endpoint，否则搜索整个组织。',
    params: {
      project_slug: '项目 slug。省略则搜索整个组织。',
      query: 'Sentry search syntax。默认 is:unresolved。',
      stats_period: '时间范围，24h 或 14d。默认 14d。',
      sort: '排序方式。默认 date。部分自建版本不接受 recommended。',
      environment: '环境名称。',
      limit: '每页条数，1 到 100。默认 25。',
      cursor: '上一次调用返回的 meta.nextCursor 分页游标。',
    },
  },
  sentry_get_issue: {
    description:
      '以数字 id 或 short id（例如 PROJ-ABC）读取单个 Sentry issue。返回次数、首次与最后出现时间、culprit 与版本区间。不含 event 内容与 stacktrace。使用 short id 会多花一次请求解析成数字 id。',
    params: { issue: '数字 issue id，或 PROJ-ABC 这类 short id。' },
  },
  sentry_get_latest_event: {
    description:
      '读取 Sentry issue 的最新 event，并裁剪 stacktrace。保留第一方 frame，源码片段只保留最内层的第一方 frame，并移除局部变量、request headers、request body、query string、依赖包清单与疑似机密的 tag。接受数字 issue id 或 short id；使用 short id 会多花一次请求。',
    params: {
      issue: '数字 issue id，或 PROJ-ABC 这类 short id。',
      max_frames: '每个 stacktrace 保留的 frame 数上限，1 到 100。默认 20。',
      include_breadcrumbs: '是否保留最后 20 条 breadcrumb。默认 true。',
    },
  },
  sentry_get_event: {
    description:
      '按 event id 读取项目内的单个 Sentry event，套用与 sentry_get_latest_event 相同的 stacktrace 裁剪。',
    params: {
      project_slug: '该 event 所属的项目 slug。',
      event_id: 'Event id，32 个十六进制字符。',
      max_frames: '每个 stacktrace 保留的 frame 数上限，1 到 100。默认 20。',
      include_breadcrumbs: '是否保留最后 20 条 breadcrumb。默认 true。',
    },
  },
} as const satisfies ToolMessages

const JAPANESE_TOOLS = {
  sentry_list_projects: {
    description:
      '設定された Sentry 組織のプロジェクトを一覧します。最大 100 件について id、slug、名前、プラットフォーム、状態、チーム slug を返します。組織にそれ以上ある場合は meta.truncated が true になります。',
    params: {},
  },
  sentry_search_issues: {
    description:
      'Sentry search syntax で issue を検索します。各 issue は要約のみを返し、イベント本文、スタックトレース、時系列統計は含みません。project_slug を指定するとプロジェクト単位のエンドポイントを、省略すると組織全体を検索します。',
    params: {
      project_slug: 'プロジェクト slug。省略すると組織全体を検索します。',
      query: 'Sentry search syntax。既定値は is:unresolved です。',
      stats_period: '期間。24h または 14d。既定値は 14d です。',
      sort: '並び順。既定値は date。一部のセルフホスト版は recommended を拒否します。',
      environment: '環境名。',
      limit: '1 ページあたりの件数、1 から 100。既定値は 25 です。',
      cursor: '前回の呼び出しが meta.nextCursor として返したページングカーソル。',
    },
  },
  sentry_get_issue: {
    description:
      '数値 id または short id（例: PROJ-ABC）で Sentry issue を 1 件読み取ります。件数、初回と最終の発生時刻、culprit、リリース範囲を返します。イベント本文やスタックトレースは含みません。short id を使うと数値 id への解決で追加のリクエストが 1 回発生します。',
    params: { issue: '数値の issue id、または PROJ-ABC のような short id。' },
  },
  sentry_get_latest_event: {
    description:
      'Sentry issue の最新イベントをスタックトレースを削減して読み取ります。ファーストパーティのフレームは残し、ソースコード断片は最も内側のファーストパーティフレームに限定し、ローカル変数、リクエストヘッダ、リクエストボディ、クエリ文字列、パッケージ一覧、機密らしいタグは削除します。数値 issue id と short id のどちらも受け付けます。short id は追加のリクエストを 1 回要します。',
    params: {
      issue: '数値の issue id、または PROJ-ABC のような short id。',
      max_frames: 'スタックトレースごとに残すフレーム数の上限、1 から 100。既定値は 20 です。',
      include_breadcrumbs: '直近 20 件の breadcrumb を残すかどうか。既定値は true です。',
    },
  },
  sentry_get_event: {
    description:
      'プロジェクト内の Sentry イベントを event id で 1 件読み取り、sentry_get_latest_event と同じスタックトレース削減を適用します。',
    params: {
      project_slug: 'そのイベントが属するプロジェクト slug。',
      event_id: 'Event id、16 進数 32 文字。',
      max_frames: 'スタックトレースごとに残すフレーム数の上限、1 から 100。既定値は 20 です。',
      include_breadcrumbs: '直近 20 件の breadcrumb を残すかどうか。既定値は true です。',
    },
  },
} as const satisfies ToolMessages

/** Localized descriptions consumed by the Schemastery configuration schema. */
export const CONFIG_I18N = {
  en: ENGLISH_CONFIG,
  'en-US': ENGLISH_CONFIG,
  zh: SIMPLIFIED_CHINESE_CONFIG,
  'zh-CN': SIMPLIFIED_CHINESE_CONFIG,
  'zh-TW': TRADITIONAL_CHINESE_CONFIG,
  ja: JAPANESE_CONFIG,
  'ja-JP': JAPANESE_CONFIG,
} as const satisfies Record<string, ConfigLocaleMessages>

/** Localized tool and parameter descriptions selected by config.locale. */
export const TOOL_I18N = {
  en: ENGLISH_TOOLS,
  'zh-TW': TRADITIONAL_CHINESE_TOOLS,
  'zh-CN': SIMPLIFIED_CHINESE_TOOLS,
  ja: JAPANESE_TOOLS,
} as const satisfies Record<Locale, ToolMessages>
