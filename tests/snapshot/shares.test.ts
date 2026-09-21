import { describe, it, expect } from 'vitest'
import { rawToShares } from '../../src/snapshot/shares.js'

describe('rawToShares', () => {
  it('converts raw to shares with no multiplier', () => {
    expect(rawToShares(12_480_000n, 1, 6)).toBe('12.480000')
  })

  it('applies a 4-for-1 split multiplier', () => {
    expect(rawToShares(12_480_000n, 4, 6)).toBe('49.920000')
  })

  it('renders exactly `decimals` places, always', () => {
    expect(rawToShares(1n, 1, 6)).toBe('0.000001')
    expect(rawToShares(1_000_000n, 1, 6)).toBe('1.000000')
  })

  it('never loses precision to floating point on large balances', () => {
    // 95,587,000.123456 shares would round badly through Number
    expect(rawToShares(95_587_000_123_456n, 1, 6)).toBe('95587000.123456')
  })

  it('rejects a non-integer multiplier that would introduce rounding', () => {
    expect(() => rawToShares(1_000_000n, 1.5, 6)).toThrow(/integer/i)
  })
})
