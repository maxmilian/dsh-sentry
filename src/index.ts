/**
 * dsh-sentry — read-only Sentry issue and event tools for DeepSeek Harness.
 * @module dsh-sentry
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

import { SentryClient } from './client.js'
import type { SentryConfig } from './config.js'
import {
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  LOCALES,
  MAX_REQUEST_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  resolveConfig,
} from './config.js'
import { CONFIG_I18N } from './locales.js'
import { registerSentryTools } from './tools.js'

export type { SearchIssuesParams } from './client.js'
export {
  CURSOR_PATTERN,
  createSentryClient,
  ERROR_BODY_MAX_BYTES,
  EVENT_ID_PATTERN,
  NUMERIC_ID_PATTERN,
  resolveConfig,
  SentryClient,
  SHORT_ID_PATTERN,
} from './client.js'
export type { Locale, ResolvedSentryConfig, SentryConfig } from './config.js'
export type { SentryErrorCode } from './errors.js'
export { createHttpError, SentryApiError, sanitizeUpstreamDetail } from './errors.js'
export { OUTPUT_SCHEMA, registerSentryTools } from './tools.js'
export type { TrimEventOptions } from './trim.js'
export {
  MAX_TOOL_RESULT_BYTES,
  trimEvent,
  trimIssue,
  trimIssueList,
  trimProjectList,
} from './trim.js'
export type * from './types.js'

/** Stable Cordis plugin name. */
export const name = 'dsh-sentry'

/** DSH services required by this plugin. */
export const inject = ['tools']

/** Plugin configuration supplied through Cordis. */
export type Config = SentryConfig

/** Schemastery configuration exposed by the plugin. */
export const Config: Schema<Config> = Schema.object({
  baseUrl: Schema.string(),
  token: Schema.string().role('secret'),
  org: Schema.string(),
  locale: Schema.union(LOCALES.map((locale) => Schema.const(locale))).default('en'),
  includeFrameVars: Schema.boolean(),
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

/** Resolves configuration once, then creates the client and registers all read-only tools. */
export function apply(ctx: Context, config: Config): void {
  const resolved = resolveConfig(config)
  const client = new SentryClient(resolved)
  registerSentryTools(ctx, client, resolved.locale, resolved.includeFrameVars)
}
