import { describe, it, expect, vi } from 'vitest'
import { fetchSunriseAssets } from '../../src/registry/sunrise.js'

const SAMPLE = {
  success: true,
  data: {
    count: 2,
    tokens: [
      {
        chain: 'solana',
        address: 'AMD8XwJXgQ9WV45Wyj9yFLejxzf2J6VM1PJY8bJEjeES',
        symbol: 'AMD',
        name: 'Advanced Micro Devices - Backpack Securities',
        decimals: 6,
        platform: 'svm',
        assetClass: 'stock',
        issuer: 'backpack_securities',
        tokenProgram: 'token-2022',
        stock: { ticker: 'AMD', currency: 'USD', exchange: { marketIdentifierCode: 'XNAS', name: 'Nasdaq' } },
      },
      {
        chain: 'solana',
        address: 'So11111111111111111111111111111111111111112',
        symbol: 'SOL',
        name: 'Wrapped SOL',
        decimals: 9,
        platform: 'svm',
        assetClass: 'crypto',
        issuer: null,
        tokenProgram: 'spl-token',
        stock: null,
      },
    ],
  },
}

describe('fetchSunriseAssets', () => {
  it('normalises stock tokens and keeps the linked ticker', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => SAMPLE })
    const assets = await fetchSunriseAssets(fetchMock as never)
    const amd = assets.find(a => a.symbol === 'AMD')!
    expect(amd.mint).toBe('AMD8XwJXgQ9WV45Wyj9yFLejxzf2J6VM1PJY8bJEjeES')
    expect(amd.assetClass).toBe('stock')
    expect(amd.tokenProgram).toBe('token-2022')
    expect(amd.decimals).toBe(6)
    expect(amd.linkedStock?.ticker).toBe('AMD')
  })

  it('keeps non-stock assets but marks them so stocks() can filter', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => SAMPLE })
    const assets = await fetchSunriseAssets(fetchMock as never)
    expect(assets).toHaveLength(2)
    expect(assets.filter(a => a.assetClass === 'stock')).toHaveLength(1)
  })

  it('throws on a malformed payload instead of returning an empty list', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ success: true, data: { tokens: 'nope' } }),
    })
    await expect(fetchSunriseAssets(fetchMock as never)).rejects.toThrow(/schema/i)
  })
})
