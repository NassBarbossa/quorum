import { describe, it, expect } from 'vitest'
import { Registry } from '../../src/registry/store.js'

const ASSETS = [
  {
    mint: 'AMD8XwJXgQ9WV45Wyj9yFLejxzf2J6VM1PJY8bJEjeES',
    symbol: 'AMD', name: 'AMD', decimals: 6,
    assetClass: 'stock' as const, issuer: 'backpack_securities',
    tokenProgram: 'token-2022' as const,
    linkedStock: { ticker: 'AMD', currency: 'USD', mic: 'XNAS' },
  },
]

describe('Registry', () => {
  it('accepts a mint that is in the registry', () => {
    const r = new Registry(ASSETS)
    expect(r.isCanonical('AMD8XwJXgQ9WV45Wyj9yFLejxzf2J6VM1PJY8bJEjeES')).toBe(true)
  })

  it('rejects a mint that is not in the registry', () => {
    const r = new Registry(ASSETS)
    expect(r.isCanonical('FAKEmintAddressThatIsNotCanonical11111111111')).toBe(false)
  })

  it('returns only stock assets from stocks()', () => {
    const r = new Registry([...ASSETS, { ...ASSETS[0]!, mint: 'X', symbol: 'SOL', assetClass: 'crypto' as const }])
    expect(r.stocks().map(a => a.symbol)).toEqual(['AMD'])
  })
})
