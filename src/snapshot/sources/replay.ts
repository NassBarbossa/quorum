import { z } from 'zod'
import type { RpcClient } from '../../lib/rpc.js'

export type TokenBalanceEntry = {
  mint: string
  owner?: string
  accountIndex?: number
  uiTokenAmount: { amount: string }
}

/** What the replay tracks per token account: who owns it and what it holds. */
export type TokenAccountState = { owner: string; amount: bigint }

const SignatureSchema = z.array(z.object({ signature: z.string(), slot: z.number().int() }))

// jsonParsed renders account keys as objects; other encodings as bare strings.
const AccountKeySchema = z.union([z.string(), z.object({ pubkey: z.string() })])

const TransactionSchema = z
  .object({
    slot: z.number().int(),
    transaction: z.object({
      message: z.object({ accountKeys: z.array(AccountKeySchema) }),
    }),
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
        // A v0 transaction's address-lookup-table accounts are not in accountKeys.
        // They extend the index space: static keys, then writable, then readonly.
        loadedAddresses: z
          .object({ writable: z.array(z.string()), readonly: z.array(z.string()) })
          .nullable()
          .optional(),
      })
      .nullable(),
  })
  .nullable()

type Transaction = NonNullable<z.infer<typeof TransactionSchema>>

/** The full account index space a postTokenBalances entry's accountIndex points into. */
export function accountKeysOf(tx: Transaction): string[] {
  const keys = tx.transaction.message.accountKeys.map(k => (typeof k === 'string' ? k : k.pubkey))
  const loaded = tx.meta?.loadedAddresses
  return loaded ? [...keys, ...loaded.writable, ...loaded.readonly] : keys
}

/**
 * Apply one transaction's post-balances, keyed by TOKEN ACCOUNT.
 *
 * Post-balances are absolute, and a transaction reports only the accounts it
 * touched. Keying by owner and writing that owner's total absolutely would erase
 * their other token accounts: alice holding 400 in one and 600 in another, then
 * sending from the first, would drop from 1050 to the 450 the transaction named.
 * An ATA plus an auxiliary account is ordinary, so this is not a corner case.
 * Per-account state survives; owners are totalled only at the end.
 */
export function applyTransactionBalances(
  state: Map<string, TokenAccountState>,
  mint: string,
  entries: TokenBalanceEntry[],
  accountKeys: string[],
  signature = 'transaction',
): void {
  for (const e of entries) {
    if (e.mint !== mint) continue
    if (!e.owner) continue
    if (e.accountIndex === undefined) {
      throw new Error(
        `${signature}: a postTokenBalances entry for ${mint} has no accountIndex, so the ` +
        `token account it describes cannot be identified. Refusing to guess which ` +
        `account of ${e.owner} this balance belongs to.`
      )
    }
    const tokenAccount = accountKeys[e.accountIndex]
    if (tokenAccount === undefined) {
      throw new Error(
        `${signature}: postTokenBalances names account index ${e.accountIndex} but the ` +
        `transaction lists only ${accountKeys.length} accounts. Refusing to replay a ` +
        `balance whose token account cannot be resolved.`
      )
    }
    const amount = BigInt(e.uiTokenAmount.amount)
    // A zero balance empties THAT account. The owner keeps whatever else they hold.
    if (amount === 0n) state.delete(tokenAccount)
    else state.set(tokenAccount, { owner: e.owner, amount })
  }
}

/** Sum per-account state into one balance per owner. */
export function totalsByOwner(state: Map<string, TokenAccountState>): Map<string, bigint> {
  const totals = new Map<string, bigint>()
  for (const { owner, amount } of state.values()) {
    totals.set(owner, (totals.get(owner) ?? 0n) + amount)
  }
  return totals
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
    const nextBefore = page[page.length - 1]!.signature
    if (nextBefore === before) {
      // The endpoint returned the same page again, so it is ignoring the cursor.
      // Without this guard the loop runs forever and the snapshot never completes.
      throw new Error(
        `getSignaturesForAddress returned the same page twice at cursor ${before}; ` +
        `the endpoint is ignoring "before". Refusing to loop.`
      )
    }
    before = nextBefore
  }

  // getSignaturesForAddress returns newest first — including *within* a single slot,
  // which holds many transactions. Array.sort is stable, so sorting by slot alone
  // would preserve that newest-first order inside each slot and, because
  // post-balances are absolute, let an older transaction overwrite a newer one.
  // Reverse first, then the stable sort keeps each slot's transactions oldest-first.
  const ordered = signatures
    .filter(s => s.slot <= slot)
    .reverse()
    .sort((a, b) => a.slot - b.slot)

  const state = new Map<string, TokenAccountState>()
  for (const sig of ordered) {
    const tx = await rpc.call(
      'getTransaction',
      [sig.signature, { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' }],
      TransactionSchema,
    )
    if (!tx || !tx.meta) continue
    if (tx.slot > slot) continue
    applyTransactionBalances(state, mint, tx.meta.postTokenBalances ?? [], accountKeysOf(tx), sig.signature)
  }
  return totalsByOwner(state)
}
