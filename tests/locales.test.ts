import { describe, expect, it } from 'vitest'

import { LOCALES } from '../src/config.js'
import { CONFIG_I18N, TOOL_I18N } from '../src/locales.js'

const TOOL_NAMES = [
  'sentry_list_projects',
  'sentry_search_issues',
  'sentry_get_issue',
  'sentry_get_latest_event',
  'sentry_get_event',
] as const

describe('TOOL_I18N', () => {
  it('has exactly the four supported locales and no aliases', () => {
    expect(Object.keys(TOOL_I18N).sort()).toEqual(['en', 'ja', 'zh-CN', 'zh-TW'])
    expect([...LOCALES].sort()).toEqual(['en', 'ja', 'zh-CN', 'zh-TW'])
  })

  it('describes every tool and every parameter in every locale', () => {
    for (const locale of LOCALES) {
      for (const tool of TOOL_NAMES) {
        const entry = TOOL_I18N[locale][tool]
        expect(entry.description.trim().length).toBeGreaterThan(0)
        for (const [param, text] of Object.entries(entry.params)) {
          expect(text.trim().length, `${locale}/${tool}/${param}`).toBeGreaterThan(0)
        }
      }
    }
  })

  it('uses identical parameter key sets across locales', () => {
    for (const tool of TOOL_NAMES) {
      const reference = Object.keys(TOOL_I18N.en[tool].params).sort()
      for (const locale of LOCALES) {
        expect(Object.keys(TOOL_I18N[locale][tool].params).sort(), `${locale}/${tool}`).toEqual(
          reference,
        )
      }
    }
  })

  it('actually translates rather than copying English', () => {
    for (const tool of TOOL_NAMES) {
      const texts = LOCALES.map((locale) => TOOL_I18N[locale][tool].description)
      expect(new Set(texts).size, tool).toBe(LOCALES.length)
    }
  })

  it('states that frame variables can be retained by administrator configuration', () => {
    for (const locale of LOCALES) {
      expect(TOOL_I18N[locale].sentry_get_latest_event.description).toMatch(
        /includeFrameVars|管理者|管理员/,
      )
    }
  })
})

describe('CONFIG_I18N', () => {
  it('exposes the seven Schemastery locale keys', () => {
    expect(Object.keys(CONFIG_I18N).sort()).toEqual([
      'en',
      'en-US',
      'ja',
      'ja-JP',
      'zh',
      'zh-CN',
      'zh-TW',
    ])
  })

  it('aliases share the same object reference as their canonical locale', () => {
    expect(CONFIG_I18N['en-US']).toBe(CONFIG_I18N.en)
    expect(CONFIG_I18N.zh).toBe(CONFIG_I18N['zh-CN'])
    expect(CONFIG_I18N['ja-JP']).toBe(CONFIG_I18N.ja)
  })

  it('documents every configuration field in every locale', () => {
    const fields = [
      '$description',
      'baseUrl',
      'token',
      'org',
      'locale',
      'includeFrameVars',
      'requestTimeoutMs',
      'maxResponseBytes',
    ] as const
    for (const [key, messages] of Object.entries(CONFIG_I18N)) {
      for (const field of fields) {
        expect(messages[field].trim().length, `${key}/${field}`).toBeGreaterThan(0)
      }
    }
  })
})
