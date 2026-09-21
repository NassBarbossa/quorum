// tests/snapshot/index.test.ts
import { describe, it, expect, vi } from 'vitest'
import { takeSnapshot } from '../../src/snapshot/index.js'
import { Registry } from '../../src/registry/store.js'

const MINT = 'AMD8XwJXgQ9WV45Wyj9yFLejxzf2J6VM1PJY8bJEjeES'
const registry = new Registry([{
  mint: MINT, symbol: 'AMD', name: 'AMD', decimals: 6,
  assetClass: 'stock', issuer: 'backpack_securities',
  tokenProgram: 'token-2022', linkedStock: { ticker: 'AMD', currency: 'USD', mic: 'XNAS' },
}])

describe('takeSnapshot', () => {
  it('refuses a mint that is not in the canonical registry', async () => {
    await expect(takeSnapshot({
      rpc: {} as never, archiveRpc: {} as never, registry,
      mint: 'FAKEmint1111111111111111111111111111111111', recordDate: '2026-01-06',
    })).rejects.toThrow(/not in the canonical registry/i)
  })
})

/** Standard client: chain tip, block times, and one holder (alice, 1000 raw) at slot 900. */
function standardMock() {
  return {
    call: vi.fn(async (method: string, params: unknown[]) => {
      if (method === 'getSlot') return 1_000
      if (method === 'getBlocks') {
        const [start, end] = params as [number, number]
        const out: number[] = []
        for (let s = start; s <= end; s++) out.push(s)
        return out
      }
      // 17:00 America/New_York on the record date. January is EST (UTC-5), so 22:00Z.
      // This must equal recordDateToInstant('2026-01-06'), or pinSlot finds no candidate
      // at or before the target and throws instead of returning a slot.
      if (method === 'getBlockTime') return 1_767_736_800
      if (method === 'getSignaturesForAddress') {
        return (params[1] as { before?: string }).before ? [] : [{ signature: 'sig1', slot: 900 }]
      }
      if (method === 'getTransaction') {
        return { slot: 900, meta: { postTokenBalances: [{ mint: MINT, owner: 'alice', uiTokenAmount: { amount: '1000' } }] } }
      }
      throw new Error(`unexpected ${method}`)
    }),
  }
}

/** Archive client: answers every historical read. `balance` is what it reports for
 *  alice, `supply` is the mint's total supply at the slot. */
function archiveMock(opts: { balance: string; supply: string }) {
  return {
    callHistorical: vi.fn(async (method: string) => {
      if (method === 'getAccountInfo') {
        return { value: { data: { parsed: { info: { decimals: 6, extensions: [] } } } } }
      }
      if (method === 'getMultipleAccounts') {
        return { value: [{ owner: '11111111111111111111111111111111', executable: false }] }
      }
      if (method === 'getTokenSupply') return { value: { amount: opts.supply } }
      if (method === 'getTokenAccountsByOwner') {
        return { value: [{ account: { data: { parsed: { info: { tokenAmount: { amount: opts.balance } } } } } }] }
      }
      throw new Error(`unexpected ${method}`)
    }),
  }
}

describe('takeSnapshot detectors', () => {
  it('returns sourcesAgree=false and a null root when the sources disagree', async () => {
    const rpc = standardMock()
    // 999 against the replay's 1000 — the sources must refuse to agree. Supply is
    // set to 1000 so this test isolates the reconcile failure from the supply check.
    const archiveRpc = archiveMock({ balance: '999', supply: '1000' })
    const snap = await takeSnapshot({ rpc: rpc as never, archiveRpc: archiveRpc as never, registry, mint: MINT, recordDate: '2026-01-06' })
    expect(snap.sourcesAgree).toBe(false)
    expect(snap.supply.matches).toBe(true)
    expect(snap.merkleRoot).toBeNull()
  })

  it('withholds the root when the replayed balances do not sum to total supply', async () => {
    // Both sources agree on alice's 1000, but the mint says 5000 exist. Some holder
    // was never enumerated, so the holder set is not the truth and no root is published.
    // This is the only detector for a plain `transfer` the mint's signature list missed.
    const rpc = standardMock()
    const archiveRpc = archiveMock({ balance: '1000', supply: '5000' })
    const snap = await takeSnapshot({ rpc: rpc as never, archiveRpc: archiveRpc as never, registry, mint: MINT, recordDate: '2026-01-06' })
    expect(snap.sourcesAgree).toBe(true)
    expect(snap.supply).toEqual({ expected: '5000', replayed: '1000', matches: false })
    expect(snap.merkleRoot).toBeNull()
  })

  it('publishes a root when both sources agree and supply reconciles', async () => {
    const rpc = standardMock()
    const archiveRpc = archiveMock({ balance: '1000', supply: '1000' })
    const snap = await takeSnapshot({ rpc: rpc as never, archiveRpc: archiveRpc as never, registry, mint: MINT, recordDate: '2026-01-06' })
    expect(snap.sourcesAgree).toBe(true)
    expect(snap.supply.matches).toBe(true)
    expect(snap.merkleRoot).toMatch(/^[0-9a-f]{64}$/)
    expect(snap.holders).toEqual([{ owner: 'alice', rawAmount: '1000', shares: '0.001000' }])
  })
})
