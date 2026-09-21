import { describe, it, expect, vi } from 'vitest'
import { classifyOwners, BURN_ADDRESSES } from '../../src/snapshot/exclusions.js'

const SYSTEM_PROGRAM = '11111111111111111111111111111111'

describe('classifyOwners', () => {
  it('keeps wallet accounts owned by the system program', async () => {
    const rpc = {
      callHistorical: vi.fn(async () => ({ value: [{ owner: SYSTEM_PROGRAM, executable: false }] })),
    }
    const out = await classifyOwners(rpc as never, ['WalletAddress1111111111111111111111111111111'], 100)
    expect(out.eligible).toEqual(['WalletAddress1111111111111111111111111111111'])
    expect(out.excluded).toEqual([])
  })

  it('excludes an account owned by a non-system program', async () => {
    const rpc = {
      callHistorical: vi.fn(async () => ({
        value: [{ owner: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', executable: false }],
      })),
    }
    const out = await classifyOwners(rpc as never, ['PoolPda11111111111111111111111111111111111'], 100)
    expect(out.eligible).toEqual([])
    expect(out.excluded[0]).toEqual({ address: 'PoolPda11111111111111111111111111111111111', reason: 'program-owned' })
  })

  it('excludes known burn addresses without an RPC call', async () => {
    const rpc = { callHistorical: vi.fn() }
    const out = await classifyOwners(rpc as never, [BURN_ADDRESSES[0]!], 100)
    expect(out.excluded[0]!.reason).toBe('burn')
    expect(rpc.callHistorical).not.toHaveBeenCalled()
  })

  it('treats an account that does not exist at the slot as eligible, not excluded', async () => {
    // A wallet can hold tokens through an ATA while its own account has never been funded.
    const rpc = { callHistorical: vi.fn(async () => ({ value: [null] })) }
    const out = await classifyOwners(rpc as never, ['UnfundedWallet11111111111111111111111111111'], 100)
    expect(out.eligible).toEqual(['UnfundedWallet11111111111111111111111111111'])
  })

  it('throws rather than defaulting when the response is shorter than the request', async () => {
    // A truncated reply must not let the missing tail pass as eligible — that is
    // how a pool PDA would end up counted as a voter.
    const rpc = { callHistorical: vi.fn(async () => ({ value: [] })) }
    await expect(
      classifyOwners(rpc as never, ['Wallet1111111111111111111111111111111111111'], 100),
    ).rejects.toThrow(/partial response/i)
  })
})
