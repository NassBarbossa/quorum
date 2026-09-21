import { z } from 'zod'
import type { RpcClient } from '../../lib/rpc.js'

const TokenAccountsSchema = z.object({
  value: z.array(
    z.object({
      account: z.object({
        data: z.object({
          parsed: z.object({
            info: z.object({ tokenAmount: z.object({ amount: z.string() }) }),
          }),
        }),
      }),
    }),
  ),
})

/**
 * Read an owner's total balance for a mint at a historical slot.
 * Returns null when the owner held no token account for that mint — distinct
 * from a zero balance, and distinct from a read failure, which throws.
 */
export async function archiveBalanceAtSlot(
  rpc: RpcClient, mint: string, owner: string, slot: number,
): Promise<bigint | null> {
  const res = await rpc.callHistorical('getTokenAccountsByOwner', [owner, { mint }], slot, TokenAccountsSchema)
  if (res.value.length === 0) return null
  return res.value.reduce(
    (sum, entry) => sum + BigInt(entry.account.data.parsed.info.tokenAmount.amount),
    0n,
  )
}
