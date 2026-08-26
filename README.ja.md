# dsh-sentry

[English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | 日本語

`dsh-sentry` は Sentry Web API 向けの、無料・オープンソース・**読み取り専用**の DeepSeek Harness
プラグインです。すべてのツールは HTTP `GET` であり、issue の resolve、担当者の割り当て、アーカイブ
など、Sentry の状態を変更する操作は一切行いません。

主な役割は API のプロキシではなく、**実際のスタックトレースを扱ってもエージェントのコンテキストが
破綻しないようレスポンスを削減すること**です。生の `events/latest/` レスポンスは日常的に 200KB〜2MB
に達します。本プラグインはそれをデバッグに本当に役立つフレーム、ソース行、メタデータへと縮小し、
何を落としたかを `meta.trimmed` で伝えます。

## ツール

| ツール | 用途 |
| --- | --- |
| `sentry_list_projects` | 設定された組織のプロジェクトを最大 100 件一覧します。 |
| `sentry_search_issues` | Sentry search syntax で issue を検索します。単一プロジェクトにも組織全体にも対応します。 |
| `sentry_get_issue` | 数値 id または short id で issue を 1 件読み取ります。イベント本文は含みません。 |
| `sentry_get_latest_event` | issue の最新イベントを、削減済みスタックトレース付きで読み取ります。 |
| `sentry_get_event` | プロジェクト内のイベントを event id で 1 件読み取り、同じ削減を適用します。 |

すべてのツールは読み取り専用です。v0.1 は issue を変更せず、リリースも作成せず、イベントも送信しません。

## 要件

- 互換性のある `@deepseek-ai/dsh-tools` API を備えた DeepSeek Harness
- Node.js 22.19 以上（22.x 系）または Node.js 24 以上
- GitHub ソースからのインストールやローカル開発には Bun 1.3.5 以上
- 対象組織への読み取り権限を持つ Sentry auth token

## トークンのスコープ

| スコープ | 利用可能になるエンドポイント |
| --- | --- |
| `org:read` | `/organizations/{org}/projects/`、`/organizations/{org}/issues/`、`/organizations/{org}/shortids/{short_id}/` |
| `project:read` | `/projects/{org}/{project}/issues/` |
| `event:read` | `/issues/{id}/`、`/issues/{id}/events/latest/`、`/projects/{org}/{project}/events/{event_id}/` |

最も簡単で安全なのは `sentry auth login --read-only` で発行するトークンです。これは
`project:read`、`org:read`、`event:read`、`member:read`、`team:read` のみを要求します。

## 設定

| 項目 | 環境変数 | 既定値 | 備考 |
| --- | --- | --- | --- |
| `baseUrl` | `SENTRY_URL` | `https://sentry.io/` | サイトのルート URL。EU リージョンでは `https://de.sentry.io/` を使用します。末尾の `/api/0` は自動的に取り除かれます。 |
| `token` | `SENTRY_AUTH_TOKEN` | 必須 | User または Organization の auth token。返却もログ出力もされません。 |
| `org` | `SENTRY_ORG` | 必須 | 組織 slug。プラグインインスタンス全体で固定されます。 |
| `locale` | — | `en` | `en`、`zh-TW`、`zh-CN`、`ja` のいずれか。ツールとパラメータの説明の言語を選びます。 |
| `includeFrameVars` | `SENTRY_INCLUDE_FRAME_VARS` | `false` | スタックフレームのローカル変数を残すかどうか。環境変数は文字列 `true` のときのみ有効で、エージェントからは変更できません。 |
| `requestTimeoutMs` | — | `30000` | **ツール呼び出し全体**の制限時間。short id の解決に必要な追加リクエストも含みます。範囲は 1〜300000。 |
| `maxResponseBytes` | — | `5242880` | 単一 HTTP レスポンス本文の上限。範囲は 1〜52428800。 |

プラグイン設定は常に環境変数より優先されます。

```sh
export SENTRY_AUTH_TOKEN='your-token'
export SENTRY_ORG='your-org'
# セルフホストまたは EU リージョンの場合のみ:
export SENTRY_URL='https://sentry.example.com'
```

## セルフホストとリージョン

- セルフホスト: `baseUrl` にサイトのルート URL を指定します。`https://example.com/sentry/` のような
  サブパス構成にも対応します。
- Sentry SaaS の EU リージョン: `baseUrl` は `https://de.sentry.io/` である必要があります。EU の組織へ
  `https://sentry.io/` でアクセスすると 401 または 404 として現れるため、この 2 つのエラーメッセージには
  リージョンに関する注意書きが含まれます。
- 古いセルフホスト版は単にフィールドが少ないだけです。本プラグインはすべてのレスポンスフィールドを
  任意として扱い、欠落を理由に失敗することはありません。既知の挙動差は 2 点、`sort=recommended` が
  拒否されうること（`UNSUPPORTED_BY_INSTANCE` として報告）と、`stats_period` が `24h` と `14d` に
  限られることです。

## 何を削減するか

すべてのイベントから無条件に削除されるもの:

- リクエストのヘッダ、クッキー、環境変数、ボディ。リクエスト URL は origin とパスのみを残し、
  クエリ文字列は丸ごと破棄します。OAuth コールバックや署名付き URL は秘密情報をそこに持つためです。
- スタックフレームのローカル変数（`includeFrameVars` が有効な場合を除く）。
- `mechanism.data`、`contexts.state`、`packages`、`modules`、`_meta`。
- `user.email`、`user.ip_address`、`user.username`。残るのは `user.id` のみです。
- キーが秘密情報らしいタグ（`token`、`secret`、`password`、`api_key`、`auth`、`cookie`、`session`、
  `credential`）と、`sentry:` 接頭辞の内部タグすべて。
- `absPath` のような、ビルドパスを漏らすフレームフィールド。

削除ではなく縮小されるもの:

- **フレーム。** フレームは外側から内側の順に並びます。`max_frames` を超える場合、すべての in-app
  フレームと最も内側の 2 フレームを残し、続けて末尾側から補充し、元の順序を保ちます。
- **ソースコード断片。** 最も内側の in-app フレーム 3 つにのみ、各 11 行まで、1 行 200 文字までで残します。
- **連鎖した例外。** `exception.values` は最も内側の 2 件まで。`max_frames` は各スタックトレースへ
  個別に適用されます。
- **Breadcrumbs。** 直近 20 件、メッセージは 200 文字まで。
- **文字列。** 例外の value は 2000 文字、title・message・culprit は 500 文字が上限です。

削減後もツール結果の上限 200KB を超える場合、本プラグインは決まった順序で段階的に切り詰めます。
まずソースコード断片、次に breadcrumbs、最後にフレームを 10 件まで減らし、最後に適用した段階を
`meta.trimmed.degraded` で報告します。`omittedFrames` などのカウンタは常に「元の総数から実際に
受け取った数を引いた値」であり、段階ごとの累計ではありません。

## 多言語対応

ツールとパラメータの説明は `locale` に従います。**ツール名は常に英語で、変化しません。**
エージェントの呼び出し識別子だからです。**エラーメッセージも常に英語です。** これらはテストや
レビューが比較対象とする安定した診断文字列だからです。

## セキュリティとエラーの扱い

- `Authorization: Bearer ...` を使用し、トークンを返却することもログに残すこともありません。
- DSH ツールの `AbortSignal` と呼び出し単位の制限時間を尊重します。short id では HTTP リクエストが
  1 回増えますが、制限時間は共有されます。
- HTTP 401、403、404、429、5xx を安全な構造化エラーへ変換し、レスポンス本文を一切含めません。
- **意図的な例外が 1 つあります。** issue 検索が HTTP 400 を返した場合、本プラグインは本文を最大
  64KB まで読み、構造化された `detail` または `error` の文字列だけを取り出します。トークンを含むか
  秘密情報らしい場合は丸ごと破棄し、200 文字に切り詰めたうえで `Sentry said: ...` として付加します。
  これがないと、エージェントは検索構文のエラーを推測するしかありません。本文が HTML、解析不能、
  あるいはフィルタで落とされた場合は静的なメッセージに戻ります。したがって `INVALID_QUERY` の
  メッセージには 2 つの形があります。
- v0.1 では TLS 検証の無効化や自己署名証明書のバイパスには対応しません。

## 制限事項（v0.1）

- 書き込み操作は一切ありません。resolve、unresolve、アーカイブ、担当者割り当て、マージ、削除、
  リリース作成、イベント送信のいずれも行いません。
- プラグインインスタンスごとに組織は 1 つです。ツールは組織パラメータを受け付けません。
- Seer AI、Performance、Discover、Metrics、Dashboards、Replay、Trace、Span の各エンドポイントには
  対応しません。
- リリース、デプロイ、issue のタグ分布の照会には対応しません。
- `stats_period` は `24h` と `14d` のみで、任意の `start`/`end` 範囲には対応しません。
- 自動ページングは行いません。`sentry_search_issues` は 1 ページと `meta.nextCursor` を返し、
  `sentry_list_projects` はカーソルを受け取らず代わりに `meta.truncated` を報告します。
- ローカルキャッシュ、添付ファイルや source map のダウンロード、未削減のパススルーモードはありません。

## 開発

本プロジェクトは Bun のみを使用します:

```sh
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test --coverage
bun run build
bun pm pack
```

テストは Vitest とモックした `fetch` を使い、稼働中の Sentry インスタンスを必要としません。
lines、statements、functions、branches のカバレッジ基準はいずれも 80% 以上に設定されています。

本リリースでは Sentry SaaS およびセルフホストインスタンスに対する実機互換性検証をまだ記録して
いません。CI で本プラグインに依存する前に、ご自身のインスタンスで検証してください。

## ライセンス

MIT
