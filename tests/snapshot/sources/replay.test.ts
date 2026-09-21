import { describe, it, expect, vi } from 'vitest'
import {
  applyTransactionBalances, totalsByOwner, replayHolders,
  type TokenAccountState,
} from '../../../src/snapshot/sources/replay.js'

const MINT = 'AMD8XwJXgQ9WV45Wyj9yFLejxzf2J6VM1PJY8bJEjeES'
const OTHER = 'So11111111111111111111111111111111111111112'

// Token accounts, not wallets: the replay keys state by the account that holds the
// tokens, because a wallet can hold several and a transaction names only the ones
// it touched.
const ALICE_ATA = 'A1iceAta111111111111111111111111111111111111'
const ALICE_AUX = 'A1iceAux111111111111111111111111111111111111'
const BOB_ATA = 'B0bAta11111111111111111111111111111111111111'

/** accountKeys in the order a transaction would list them. */
const KEYS = [ALICE_ATA, ALICE_AUX, BOB_ATA]

describe('applyTransactionBalances', () => {
  it('records a balance against the token account that holds it', () => {
    const state = new Map<string, TokenAccountState>()
    applyTransactionBalances(state, MINT, [
      { mint: MINT, owner: 'alice', accountIndex: 0, uiTokenAmount: { amount: '1000000' } },
    ], KEYS)
    expect(state.get(ALICE_ATA)).toEqual({ owner: 'alice', amount: 1_000_000n })
  })

  it('ignores balances for other mints', () => {
    const state = new Map<string, TokenAccountState>()
    applyTransactionBalances(state, MINT, [
      { mint: OTHER, owner: 'bob', accountIndex: 2, uiTokenAmount: { amount: '5000' } },
    ], KEYS)
    expect(state.size).toBe(0)
  })

  it('removes a token account whose balance went to zero', () => {
    const state = new Map<string, TokenAccountState>([[ALICE_ATA, { owner: 'alice', amount: 1_000_000n }]])
    applyTransactionBalances(state, MINT, [
      { mint: MINT, owner: 'alice', accountIndex: 0, uiTokenAmount: { amount: '0' } },
    ], KEYS)
    expect(state.has(ALICE_ATA)).toBe(false)
  })

  it('sums multiple token accounts owned by the same wallet', () => {
    const state = new Map<string, TokenAccountState>()
    applyTransactionBalances(state, MINT, [
      { mint: MINT, owner: 'alice', accountIndex: 0, uiTokenAmount: { amount: '400' } },
      { mint: MINT, owner: 'alice', accountIndex: 1, uiTokenAmount: { amount: '600' } },
    ], KEYS)
    expect(totalsByOwner(state).get('alice')).toBe(1_000n)
  })

  it('keeps the accounts a later transaction did not name', () => {
    // The corruption this keying exists to prevent. alice holds 400 in her ATA and
    // 600 in an auxiliary account. A later transaction touches only the ATA and
    // reports its post-balance of 450. Recomputing her total from that transaction
    // alone and writing it absolutely gave 450; the truth is 450 + 600 = 1050.
    // The supply check would then refuse the whole snapshot, reporting "replayed
    // != expected" with no hint that a two-account holder is the cause.
    const state = new Map<string, TokenAccountState>()
    applyTransactionBalances(state, MINT, [
      { mint: MINT, owner: 'alice', accountIndex: 0, uiTokenAmount: { amount: '400' } },
      { mint: MINT, owner: 'alice', accountIndex: 1, uiTokenAmount: { amount: '600' } },
    ], KEYS)
    applyTransactionBalances(state, MINT, [
      { mint: MINT, owner: 'alice', accountIndex: 0, uiTokenAmount: { amount: '450' } },
    ], KEYS)
    expect(totalsByOwner(state).get('alice')).toBe(1_050n)
  })

  it('follows a token account whose authority changed', () => {
    const state = new Map<string, TokenAccountState>()
    applyTransactionBalances(state, MINT, [
      { mint: MINT, owner: 'alice', accountIndex: 0, uiTokenAmount: { amount: '400' } },
    ], KEYS)
    applyTransactionBalances(state, MINT, [
      { mint: MINT, owner: 'bob', accountIndex: 0, uiTokenAmount: { amount: '400' } },
    ], KEYS)
    const totals = totalsByOwner(state)
    expect(totals.get('bob')).toBe(400n)
    expect(totals.has('alice')).toBe(false)
  })

  it('refuses an entry whose accountIndex names no account', () => {
    const state = new Map<string, TokenAccountState>()
    expect(() => applyTransactionBalances(state, MINT, [
      { mint: MINT, owner: 'alice', accountIndex: 9, uiTokenAmount: { amount: '400' } },
    ], KEYS, 'sigX')).toThrow(/cannot be resolved/i)
  })

  it('refuses an entry with no accountIndex rather than guessing the account', () => {
    const state = new Map<string, TokenAccountState>()
    expect(() => applyTransactionBalances(state, MINT, [
      { mint: MINT, owner: 'alice', uiTokenAmount: { amount: '400' } },
    ], KEYS, 'sigX')).toThrow(/no accountIndex/i)
  })
})

/** A jsonParsed transaction as the RPC returns it. */
function tx(slot: number, balances: [number, string, string][], keys: string[] = KEYS) {
  return {
    slot,
    transaction: { message: { accountKeys: keys.map(pubkey => ({ pubkey })) } },
    meta: {
      postTokenBalances: balances.map(([accountIndex, owner, amount]) => ({
        mint: MINT, owner, accountIndex, uiTokenAmount: { amount },
      })),
    },
  }
}

describe('replayHolders', () => {
  it('walks signatures oldest-first and stops at the target slot', async () => {
    const signatures = [
      { signature: 'sig3', slot: 300 },
      { signature: 'sig2', slot: 200 },
      { signature: 'sig1', slot: 100 },
    ]
    const txs: Record<string, unknown> = {
      sig1: tx(100, [[0, 'alice', '1000']]),
      sig2: tx(200, [[2, 'bob', '500']]),
      sig3: tx(300, [[0, 'alice', '0']]),
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

  it('totals a holder across two token accounts touched in different transactions', async () => {
    // Exactly the case that used to collapse to 450: the second transaction names
    // only the ATA, so a per-owner absolute write would forget the 600 in the aux.
    const signatures = [
      { signature: 'sig2', slot: 200 },
      { signature: 'sig1', slot: 100 },
    ]
    const txs: Record<string, unknown> = {
      sig1: tx(100, [[0, 'alice', '400'], [1, 'alice', '600']]),
      sig2: tx(200, [[0, 'alice', '450']]),
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
    const holders = await replayHolders(rpc as never, MINT, 300)
    expect(holders.get('alice')).toBe(1_050n)
  })

  it('resolves accounts a v0 transaction loaded from an address lookup table', async () => {
    // Lookup-table accounts are not in accountKeys; they extend the index space
    // after it, writable first. Index 1 here is BOB_ATA, loaded from a table.
    const loaded = {
      slot: 100,
      transaction: { message: { accountKeys: [{ pubkey: ALICE_ATA }] } },
      meta: {
        postTokenBalances: [{ mint: MINT, owner: 'bob', accountIndex: 1, uiTokenAmount: { amount: '700' } }],
        loadedAddresses: { writable: [BOB_ATA], readonly: [] },
      },
    }
    const rpc = {
      call: vi.fn(async (method: string, params: unknown[]) => {
        if (method === 'getSignaturesForAddress') {
          return (params[1] as { before?: string }).before ? [] : [{ signature: 'sig1', slot: 100 }]
        }
        if (method === 'getTransaction') return loaded
        throw new Error(`unexpected ${method}`)
      }),
    }
    const holders = await replayHolders(rpc as never, MINT, 200)
    expect(holders.get('bob')).toBe(700n)
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
      older: tx(100, [[0, 'alice', '111']]),
      newer: tx(100, [[0, 'alice', '999']]),
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
