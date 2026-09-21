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
})

describe('pinSlot', () => {
  it('returns the last slot at or before the target instant', async () => {
    // Synthetic chain: slot N has block_time = 1_700_000_000 + N
    const target = new Date((1_700_000_500) * 1000)
    const rpc = {
      call: vi.fn(async (method: string, params: unknown[]) => {
        if (method === 'getSlot') return 1_000
        if (method === 'getBlockTime') {
          const slot = params[0] as number
          return 1_700_000_000 + slot
        }
        throw new Error(`unexpected ${method}`)
      }),
    }
    const slot = await pinSlot(rpc as never, target, { lowerBound: 0 })
    expect(slot).toBe(500)
  })

  it('throws when the target instant is in the future rather than guessing', async () => {
    const rpc = {
      call: vi.fn(async (method: string, params: unknown[]) => {
        if (method === 'getSlot') return 1_000
        if (method === 'getBlockTime') return 1_700_000_000 + (params[0] as number)
        throw new Error(`unexpected ${method}`)
      }),
    }
    const future = new Date((1_700_002_000) * 1000)
    await expect(pinSlot(rpc as never, future, { lowerBound: 0 })).rejects.toThrow(/future|not yet/i)
  })
})
