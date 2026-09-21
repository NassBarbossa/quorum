import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { recordDateToInstant, pinSlot } from '../../src/slot/pin.js'

describe('recordDateToInstant', () => {
  it('resolves 17:00 New York in daylight saving time to 21:00 UTC', () => {
    // 2026-06-15 is EDT (UTC-4)
    expect(recordDateToInstant('2026-06-15').toISOString()).toBe('2026-06-15T21:00:00.000Z')
  })

  it('resolves 17:00 New York in standard time to 22:00 UTC', () => {
    // 2026-01-06 is EST (UTC-5)
    expect(recordDateToInstant('2026-01-06').toISOString()).toBe('2026-01-06T22:00:00.000Z')
  })

  it('rejects a malformed date', () => {
    expect(() => recordDateToInstant('06/15/2026')).toThrow(/YYYY-MM-DD/)
  })

  it('rejects a well-formed but impossible calendar date instead of rolling it over', () => {
    // Date.UTC would turn these into 2027-02-14 and 2027-03-01 respectively,
    // pinning a slot weeks away from the date the filing actually named.
    expect(() => recordDateToInstant('2026-13-45')).toThrow(/not a real calendar date/)
    expect(() => recordDateToInstant('2027-02-29')).toThrow(/not a real calendar date/)
  })
})

/**
 * Synthetic chain: slot N has block_time = 1_700_000_000 + N, except inside
 * `gaps`, which are ranges of skipped slots that produced no block at all.
 * Solana skips slots routinely and can skip hundreds consecutively during
 * congestion, so gaps are the normal case, not an exotic one.
 */
function chainMock(opts: { tip: number; gaps?: [number, number][] }) {
  const skipped = (s: number) => (opts.gaps ?? []).some(([a, b]) => s >= a && s <= b)
  return {
    call: vi.fn(async (method: string, params: unknown[]) => {
      if (method === 'getSlot') return opts.tip
      if (method === 'getBlocks') {
        const [start, end] = params as [number, number]
        const out: number[] = []
        for (let s = start; s <= end; s++) if (!skipped(s)) out.push(s)
        return out
      }
      if (method === 'getBlockTime') {
        const s = params[0] as number
        return skipped(s) ? null : 1_700_000_000 + s
      }
      throw new Error(`unexpected ${method}`)
    }),
  }
}

describe('pinSlot', () => {
  it('returns the last slot at or before the target instant', async () => {
    const rpc = chainMock({ tip: 1_000 })
    const target = new Date(1_700_000_500 * 1000)
    expect(await pinSlot(rpc as never, target, { lowerBound: 0 })).toBe(500)
  })

  it('skips back past a long run of skipped slots instead of discarding the answer', async () => {
    // Slots 301-700 produced no block. The true answer is 300: it is the highest
    // slot that both has a block and whose time is at or before the target.
    const rpc = chainMock({ tip: 1_000, gaps: [[301, 700]] })
    const target = new Date(1_700_000_500 * 1000)
    expect(await pinSlot(rpc as never, target, { lowerBound: 0 })).toBe(300)
  })

  it('throws when the target instant is in the future rather than guessing', async () => {
    const rpc = chainMock({ tip: 1_000 })
    const future = new Date(1_700_002_000 * 1000)
    await expect(pinSlot(rpc as never, future, { lowerBound: 0 })).rejects.toThrow(/future|not yet/i)
  })

  it('never asks getBlocks for more than 500,000 slots at a time', async () => {
    // getBlocks rejects a range wider than 500,000 slots, so a search that only ever
    // widened would start failing outright on a long gap. It slides instead: disjoint
    // ranges, scanned downward, so the first block found is still the highest one.
    // Only slots 0 and 3,000,000 produced a block, and the target sits just after 0.
    const ranges: [number, number][] = []
    const blocks = [0, 3_000_000]
    const rpc = {
      call: vi.fn(async (method: string, params: unknown[]) => {
        if (method === 'getSlot') return 3_000_000
        if (method === 'getBlocks') {
          const [start, end] = params as [number, number]
          ranges.push([start, end])
          return blocks.filter(b => b >= start && b <= end)
        }
        if (method === 'getBlockTime') return 1_700_000_000 + (params[0] as number)
        throw new Error(`unexpected ${method}`)
      }),
    }
    const target = new Date((1_700_000_000 + 1) * 1000)
    expect(await pinSlot(rpc as never, target, { lowerBound: 0 })).toBe(0)
    expect(ranges.length).toBeGreaterThan(5)   // it really did have to slide
    for (const [start, end] of ranges) expect(end - start + 1).toBeLessThanOrEqual(500_000)
  })

  it('throws rather than returning slot 0 when no block sits at or before the target', async () => {
    // Every slot in range is skipped except the tip, whose time is after the target.
    const rpc = chainMock({ tip: 1_000, gaps: [[0, 999]] })
    const target = new Date(1_700_000_500 * 1000)
    await expect(pinSlot(rpc as never, target, { lowerBound: 0 })).rejects.toThrow(/never confirmed|no solana block/i)
  })
})
