import { describe, it, expect, vi } from 'vitest'
import { pickMultiplier, readMultiplierAtSlot } from '../../src/snapshot/multiplier.js'

describe('pickMultiplier', () => {
  it('uses the current multiplier before the effective timestamp', () => {
    expect(pickMultiplier({ multiplier: 1, newMultiplier: 4, newMultiplierEffectiveTimestamp: 2000 }, 1999)).toBe(1)
  })

  it('uses the new multiplier at the effective timestamp', () => {
    expect(pickMultiplier({ multiplier: 1, newMultiplier: 4, newMultiplierEffectiveTimestamp: 2000 }, 2000)).toBe(4)
  })

  it('treats a zero effective timestamp as already in force', () => {
    expect(pickMultiplier({ multiplier: 1, newMultiplier: 1, newMultiplierEffectiveTimestamp: 0 }, 1)).toBe(1)
  })
})

describe('readMultiplierAtSlot', () => {
  it('returns 1 for a mint with no scaledUiAmount extension', async () => {
    const rpc = {
      callHistorical: vi.fn(async () => ({
        value: { data: { parsed: { info: { decimals: 6, extensions: [{ extension: 'transferHook', state: {} }] } } } },
      })),
    }
    const m = await readMultiplierAtSlot(rpc as never, 'MINT', 123, 1000)
    expect(m).toBe(1)
  })

  it('reads the multiplier from the extension', async () => {
    const rpc = {
      callHistorical: vi.fn(async () => ({
        value: {
          data: {
            parsed: {
              info: {
                decimals: 6,
                extensions: [
                  { extension: 'scaledUiAmountConfig', state: { multiplier: 1, newMultiplier: 4, newMultiplierEffectiveTimestamp: 500 } },
                ],
              },
            },
          },
        },
      })),
    }
    expect(await readMultiplierAtSlot(rpc as never, 'MINT', 123, 499)).toBe(1)
    expect(await readMultiplierAtSlot(rpc as never, 'MINT', 123, 500)).toBe(4)
  })
})
