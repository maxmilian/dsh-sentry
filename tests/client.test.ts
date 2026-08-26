import { describe, expect, it } from 'vitest'

import { resolveConfig } from '../src/config.js'
import { SentryApiError } from '../src/errors.js'

const ENV = { SENTRY_AUTH_TOKEN: 'env-token', SENTRY_ORG: 'env-org' }

describe('configuration', () => {
  it('prefers plugin config over environment variables', () => {
    const resolved = resolveConfig(
      { baseUrl: 'https://self.example.com/sentry/', token: 'cfg-token', org: 'cfg-org' },
      { ...ENV, SENTRY_URL: 'https://env.example.com' },
    )

    expect(resolved.baseUrl).toBe('https://self.example.com/sentry/')
    expect(resolved.token).toBe('cfg-token')
    expect(resolved.org).toBe('cfg-org')
  })

  it('falls back to environment variables and defaults', () => {
    const resolved = resolveConfig({}, ENV)

    expect(resolved.baseUrl).toBe('https://sentry.io/')
    expect(resolved.token).toBe('env-token')
    expect(resolved.org).toBe('env-org')
    expect(resolved.locale).toBe('en')
    expect(resolved.includeFrameVars).toBe(false)
    expect(resolved.requestTimeoutMs).toBe(30_000)
    expect(resolved.maxResponseBytes).toBe(5 * 1024 * 1024)
  })

  it('strips a trailing api/0 segment and adds a trailing slash', () => {
    expect(resolveConfig({ baseUrl: 'https://sentry.io/api/0/' }, ENV).baseUrl).toBe(
      'https://sentry.io/',
    )
    expect(resolveConfig({ baseUrl: 'https://x.com/sentry' }, ENV).baseUrl).toBe(
      'https://x.com/sentry/',
    )
  })

  it.each([
    ['ftp://sentry.io/', 'protocol'],
    ['https://user:pw@sentry.io/', 'credentials'],
    ['https://sentry.io/?a=1', 'query'],
    ['https://sentry.io/#frag', 'fragment'],
    ['not a url', 'invalid'],
  ])('rejects unsafe baseUrl %s', (baseUrl) => {
    expect(() => resolveConfig({ baseUrl }, ENV)).toThrow(SentryApiError)
  })

  it('requires a token and an org', () => {
    expect(() => resolveConfig({}, { SENTRY_ORG: 'o' })).toThrow(/token/)
    expect(() => resolveConfig({}, { SENTRY_AUTH_TOKEN: 't' })).toThrow(/org/)
  })

  it.each(['Bad-Org', 'org/slash', '../escape', '-leading', 'x'.repeat(65)])(
    'rejects org slug %s',
    (org) => {
      expect(() => resolveConfig({ org }, ENV)).toThrow(SentryApiError)
    },
  )

  it('rejects an unknown locale', () => {
    // @ts-expect-error deliberately invalid locale
    expect(() => resolveConfig({ locale: 'fr' }, ENV)).toThrow(/locale/)
  })

  it('treats only the literal string true as includeFrameVars', () => {
    expect(resolveConfig({}, { ...ENV, SENTRY_INCLUDE_FRAME_VARS: 'TRUE' }).includeFrameVars).toBe(
      true,
    )
    expect(
      resolveConfig({}, { ...ENV, SENTRY_INCLUDE_FRAME_VARS: ' true ' }).includeFrameVars,
    ).toBe(true)
    for (const value of ['1', 'yes', '', 'false']) {
      expect(resolveConfig({}, { ...ENV, SENTRY_INCLUDE_FRAME_VARS: value }).includeFrameVars).toBe(
        false,
      )
    }
  })

  it.each([
    ['requestTimeoutMs', 0],
    ['requestTimeoutMs', 300_001],
    ['requestTimeoutMs', 1.5],
    ['maxResponseBytes', 0],
    ['maxResponseBytes', 50 * 1024 * 1024 + 1],
  ])('rejects out-of-bounds %s = %s', (field, value) => {
    expect(() => resolveConfig({ [field]: value }, ENV)).toThrow(SentryApiError)
  })

  it('reports configuration failures with the INVALID_CONFIG code', () => {
    try {
      resolveConfig({}, {})
      expect.unreachable('resolveConfig should have thrown')
    } catch (error) {
      expect((error as SentryApiError).code).toBe('INVALID_CONFIG')
    }
  })
})
