import { describe, it, expect, vi } from 'vitest'
import { archiveBalanceAtSlot } from '../../../src/snapshot/sources/archive.js'

const MINT = 'AMD8XwJXgQ9WV45Wyj9yFLejxzf2J6VM1PJY8bJEjeES'

describe('archiveBalanceAtSlot', () => {
  it('sums all token accounts an owner held for the mint at that slot', async () => {
    const rpc = {
      callHistorical: vi.fn(async () => ({
        value: [
          { account: { data: { parsed: { info: { tokenAmount: { amount: '400' } } } } } },
          { account: { data: { parsed: { info: { tokenAmount: { amount: '600' } } } } } },
        ],
      })),
    }
    expect(await archiveBalanceAtSlot(rpc as never, MINT, 'alice', 100)).toBe(1_000n)
  })

  it('returns null when the owner held nothing', async () => {
    const rpc = { callHistorical: vi.fn(async () => ({ value: [] })) }
    expect(await archiveBalanceAtSlot(rpc as never, MINT, 'bob', 100)).toBeNull()
  })

  it('propagates an archive error instead of returning zero', async () => {
    const rpc = { callHistorical: vi.fn(async () => { throw new Error('slot not in archive coverage') }) }
    await expect(archiveBalanceAtSlot(rpc as never, MINT, 'alice', 100)).rejects.toThrow(/archive coverage/)
  })
})
