import { z } from 'zod'
import type { RpcClient } from '../lib/rpc.js'
import type { Exclusion } from './types.js'

const SYSTEM_PROGRAM = '11111111111111111111111111111111'

/** Addresses whose tokens are provably out of circulation. */
export const BURN_ADDRESSES: readonly string[] = [
  '1nc1nerator11111111111111111111111111111111',
]

const MultipleAccountsSchema = z.object({
  value: z.array(z.object({ owner: z.string(), executable: z.boolean() }).nullable()),
})

const CHUNK = 100

/**
 * An owner is eligible if it can sign. Program-owned accounts (pool PDAs, vaults)
 * cannot, so they can never produce a voting instruction and must not sit in the
 * participation denominator.
 */
export async function classifyOwners(
  rpc: RpcClient, owners: string[], slot: number,
): Promise<{ eligible: string[]; excluded: Exclusion[] }> {
  const eligible: string[] = []
  const excluded: Exclusion[] = []
  const toProbe: string[] = []

  for (const owner of owners) {
    if (BURN_ADDRESSES.includes(owner)) excluded.push({ address: owner, reason: 'burn' })
    else toProbe.push(owner)
  }

  for (let i = 0; i < toProbe.length; i += CHUNK) {
    const chunk = toProbe.slice(i, i + CHUNK)
    const res = await rpc.callHistorical('getMultipleAccounts', [chunk], slot, MultipleAccountsSchema)
    chunk.forEach((address, idx) => {
      const info = res.value[idx]
      if (info === undefined) {
        // The response is shorter than the request. Treating the missing tail as
        // eligible would silently admit pool PDAs into the holder set — the exact
        // error this function exists to prevent — so refuse rather than default.
        throw new Error(
          `getMultipleAccounts returned ${res.value.length} entries for ${chunk.length} addresses ` +
          `at slot ${slot}; nothing for ${address}. Refusing to classify a partial response.`
        )
      }
      // A never-funded wallet has no account but can still own an ATA and can still sign.
      if (info === null) { eligible.push(address); return }
      if (info.owner === SYSTEM_PROGRAM) eligible.push(address)
      else excluded.push({ address, reason: 'program-owned' })
    })
  }

  return { eligible, excluded }
}
