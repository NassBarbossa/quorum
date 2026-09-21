import { z } from 'zod'
import type { RpcClient } from '../../lib/rpc.js'

export type TokenBalanceEntry = {
  mint: string
  owner?: string
  accountIndex?: number
  uiTokenAmount: { amount: string }
}

const SignatureSchema = z.array(z.object({ signature: z.string(), slot: z.number().int() }))

const TransactionSchema = z
  .object({
    slot: z.number().int(),
    meta: z
      .object({
        postTokenBalances: z
          .array(
            z.object({
              mint: z.string(),
              owner: z.string().optional(),
              accountIndex: z.number().int().optional(),
              uiTokenAmount: z.object({ amount: z.string() }),
            }),
          )
          .nullable()
          .optional(),
      })
      .nullable(),
  })
  .nullable()

/**
 * Apply one transaction's post-balances. Post-balances are absolute, not deltas,
 * so the last write for an owner at or before the target slot is their balance.
 * Multiple token accounts for the same owner are summed.
 */
export function applyTransactionBalances(
  state: Map<string, bigint>, mint: string, entries: TokenBalanceEntry[],
): void {
  const perOwner = new Map<string, bigint>()
  for (const e of entries) {
    if (e.mint !== mint) continue
    if (!e.owner) continue
    perOwner.set(e.owner, (perOwner.get(e.owner) ?? 0n) + BigInt(e.uiTokenAmount.amount))
  }
  for (const [owner, amount] of perOwner) {
    if (amount === 0n) state.delete(owner)
    else state.set(owner, amount)
  }
}

const PAGE = 1000

/**
 * Rebuild the holder set at `slot` by walking every signature that touched the
 * mint, oldest first, applying post-balances up to and including the target slot.
 */
export async function replayHolders(
  rpc: RpcClient, mint: string, slot: number,
): Promise<Map<string, bigint>> {
  const signatures: { signature: string; slot: number }[] = []
  let before: string | undefined
  for (;;) {
    const page = await rpc.call(
      'getSignaturesForAddress',
      [mint, before ? { limit: PAGE, before } : { limit: PAGE }],
      SignatureSchema,
    )
    if (page.length === 0) break
    signatures.push(...page)
    before = page[page.length - 1]!.signature
  }

  // getSignaturesForAddress returns newest first; replay needs oldest first.
  const ordered = signatures
    .filter(s => s.slot <= slot)
    .sort((a, b) => a.slot - b.slot)

  const state = new Map<string, bigint>()
  for (const sig of ordered) {
    const tx = await rpc.call(
      'getTransaction',
      [sig.signature, { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' }],
      TransactionSchema,
    )
    if (!tx || !tx.meta) continue
    if (tx.slot > slot) continue
    applyTransactionBalances(state, mint, tx.meta.postTokenBalances ?? [])
  }
  return state
}
