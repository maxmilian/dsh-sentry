import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'

import { apply, Config, inject, name, resolveConfig } from '../src/index.js'

const BASE = { token: 't', org: 'acme' } as const

function registerWith(config: Record<string, unknown>): Map<string, ToolDefinition> {
  const tools = new Map<string, ToolDefinition>()
  const ctx = {
    tools: { register: (tool: ToolDefinition) => tools.set(tool.name, tool) },
  } as unknown as Context
  apply(ctx, config as never)
  return tools
}

describe('DSH plugin entry', () => {
  it('exports the required identity and tools injection', () => {
    expect(name).toBe('dsh-sentry')
    expect(inject).toEqual(['tools'])
    expect(Config).toBeDefined()
  })

  it('exposes localized plugin configuration descriptions', () => {
    expect(Config.meta.description).toMatchObject({
      en: 'Read-only Sentry integration settings.',
      'zh-TW': 'Sentry 唯讀整合設定。',
      'zh-CN': 'Sentry 只读集成设置。',
      'ja-JP': 'Sentry の読み取り専用連携設定。',
    })
    expect(Config.dict?.token?.meta.role).toBe('secret')
  })

  it('registers five tools without presentCall', () => {
    const tools = registerWith({ ...BASE })

    expect(tools.size).toBe(5)
    for (const tool of tools.values()) {
      expect(tool.presentCall).toBeUndefined()
      expect(tool.output?.schema).toMatchObject({ type: 'object', additionalProperties: false })
    }
  })

  it('keeps tool names in English while switching descriptions by locale', () => {
    const english = registerWith({ ...BASE })
    const traditional = registerWith({ ...BASE, locale: 'zh-TW' })
    const japanese = registerWith({ ...BASE, locale: 'ja' })

    expect([...traditional.keys()].sort()).toEqual([...english.keys()].sort())

    const key = 'sentry_search_issues'
    const englishText = english.get(key)?.description ?? ''
    expect(englishText.startsWith('Search Sentry issues')).toBe(true)
    expect(traditional.get(key)?.description).not.toBe(englishText)
    expect(japanese.get(key)?.description).not.toBe(englishText)
    expect(japanese.get(key)?.description).not.toBe(traditional.get(key)?.description)
  })

  it('rejects an unusable configuration at apply time', () => {
    expect(() => registerWith({ org: 'acme' })).toThrow(/token/)
  })

  it('preserves environment fallbacks after Schemastery parses config defaults', () => {
    const parsed = Config({ token: 'cfg-token', org: 'cfg-org' })
    const resolved = resolveConfig(parsed, {
      SENTRY_URL: 'https://self-hosted.example/sentry/',
      SENTRY_INCLUDE_FRAME_VARS: 'true',
    })

    expect(resolved.baseUrl).toBe('https://self-hosted.example/sentry/')
    expect(resolved.includeFrameVars).toBe(true)
  })

  it('renders output as a single text block', () => {
    const tool = registerWith({ ...BASE }).get('sentry_get_issue')
    const rendered = tool?.output?.render?.({}, { data: { id: '1' }, meta: {} } as never)

    expect(rendered).toEqual([{ type: 'text', text: '{"data":{"id":"1"},"meta":{}}' }])
  })
})
