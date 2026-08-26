import { describe, expect, it } from 'vitest'

import type { JsonObject, TransportMeta, TrimResult } from '../src/types.js'

describe('scaffold', () => {
  it('exposes the shared JSON and layering types', () => {
    const data: JsonObject = { ok: true }
    const meta: TransportMeta = { nextCursor: '0:100:0', matchingCount: 7, hasMore: true }
    const trimmed: TrimResult = { data, trimmed: { omittedFrames: 3 }, truncated: true }

    expect(meta.matchingCount).toBe(7)
    expect(trimmed.trimmed?.omittedFrames).toBe(3)
  })
})
