import { describe, it, expect, vi } from 'vitest'
import { applyTransactionBalances, replayHolders } from '../../../src/snapshot/sources/replay.js'

const MINT = 'AMD8XwJXgQ9WV45Wyj9yFLejxzf2J6VM1PJY8bJEjeES'
const OTHER = 'So11111111111111111111111111111111111111112'

describe('applyTransactionBalances', () => {
  it('sets a holder balance from postTokenBalances', () => {
    const state = new Map<string, bigint>()
    applyTransactionBalances(state, MINT, [
      { mint: MINT, owner: 'alice', uiTokenAmount: { amount: '1000000' } },
    ])
    expect(state.get('alice')).toBe(1_000_000n)
  })

  it('ignores balances for other mints', () => {
    const state = new Map<string, bigint>()
    applyTransactionBalances(state, MINT, [
      { mint: OTHER, owner: 'bob', uiTokenAmount: { amount: '5000' } },
    ])
    expect(state.has('bob')).toBe(false)
  })

  it('removes a holder whose balance went to zero', () => {
    const state = new Map<string, bigint>([['alice', 1_000_000n]])
    applyTransactionBalances(state, MINT, [
      { mint: MINT, owner: 'alice', uiTokenAmount: { amount: '0' } },
    ])
    expect(state.has('alice')).toBe(false)
  })

  it('sums multiple token accounts owned by the same wallet', () => {
    const state = new Map<string, bigint>()
    applyTransactionBalances(state, MINT, [
      { mint: MINT, owner: 'alice', uiTokenAmount: { amount: '400' }, accountIndex: 1 },
      { mint: MINT, owner: 'alice', uiTokenAmount: { amount: '600' }, accountIndex: 2 },
    ])
    expect(state.get('alice')).toBe(1_000n)
  })
})

describe('replayHolders', () => {
  it('walks signatures oldest-first and stops at the target slot', async () => {
    const signatures = [
      { signature: 'sig3', slot: 300 },
      { signature: 'sig2', slot: 200 },
      { signature: 'sig1', slot: 100 },
    ]
    const txs: Record<string, unknown> = {
      sig1: { slot: 100, meta: { postTokenBalances: [{ mint: MINT, owner: 'alice', uiTokenAmount: { amount: '1000' } }] } },
      sig2: { slot: 200, meta: { postTokenBalances: [{ mint: MINT, owner: 'bob', uiTokenAmount: { amount: '500' } }] } },
      sig3: { slot: 300, meta: { postTokenBalances: [{ mint: MINT, owner: 'alice', uiTokenAmount: { amount: '0' } }] } },
    }
    const rpc = {
      call: vi.fn(async (method: string, params: unknown[]) => {
        if (method === 'getSignaturesForAddress') {
          const before = (params[1] as { before?: string } | undefined)?.before
          if (before) return []
          return signatures
        }
        if (method === 'getTransaction') return txs[params[0] as string]
        throw new Error(`unexpected ${method}`)
      }),
    }
    const holders = await replayHolders(rpc as never, MINT, 250)
    expect(holders.get('alice')).toBe(1_000n)  // sig3 is past the target slot
    expect(holders.get('bob')).toBe(500n)
  })

  it('applies same-slot transactions oldest-first, not in RPC order', async () => {
    // getSignaturesForAddress returns newest first, including within one slot, and
    // a slot holds many transactions. Post-balances are absolute, so the newest
    // transaction in a slot must be applied LAST or an older one overwrites it.
    const signatures = [
      { signature: 'newer', slot: 100 },
      { signature: 'older', slot: 100 },
    ]
    const txs: Record<string, unknown> = {
      older: { slot: 100, meta: { postTokenBalances: [{ mint: MINT, owner: 'alice', uiTokenAmount: { amount: '111' } }] } },
      newer: { slot: 100, meta: { postTokenBalances: [{ mint: MINT, owner: 'alice', uiTokenAmount: { amount: '999' } }] } },
    }
    const rpc = {
      call: vi.fn(async (method: string, params: unknown[]) => {
        if (method === 'getSignaturesForAddress') {
          return (params[1] as { before?: string }).before ? [] : signatures
        }
        if (method === 'getTransaction') return txs[params[0] as string]
        throw new Error(`unexpected ${method}`)
      }),
    }
    const holders = await replayHolders(rpc as never, MINT, 200)
    expect(holders.get('alice')).toBe(999n)
  })

  it('throws rather than looping when the endpoint ignores the before cursor', async () => {
    const rpc = {
      call: vi.fn(async (method: string) => {
        if (method === 'getSignaturesForAddress') return [{ signature: 'same', slot: 10 }]
        throw new Error(`unexpected ${method}`)
      }),
    }
    await expect(replayHolders(rpc as never, MINT, 100)).rejects.toThrow(/ignoring "before"|same page twice/i)
  })
})
