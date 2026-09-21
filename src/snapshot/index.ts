// src/snapshot/index.ts
import type { RpcClient } from '../lib/rpc.js'
import type { Registry } from '../registry/store.js'
import type { Snapshot, HolderBalance } from './types.js'
import { recordDateToInstant, pinSlot } from '../slot/pin.js'
import { readMultiplierAtSlot } from './multiplier.js'
import { rawToShares } from './shares.js'
import { classifyOwners } from './exclusions.js'
import { replayHolders } from './sources/replay.js'
import { archiveBalanceAtSlot } from './sources/archive.js'
import { reconcile } from './reconcile.js'
import { leafHash, buildTree, sortLeaves } from './merkle.js'
import { z } from 'zod'

export type TakeSnapshotOptions = {
  rpc: RpcClient
  archiveRpc: RpcClient
  registry: Registry
  mint: string
  recordDate: string
}

const BlockTimeSchema = z.number().int().nullable()
const TokenSupplySchema = z.object({ value: z.object({ amount: z.string() }) })

export async function takeSnapshot(opts: TakeSnapshotOptions): Promise<Snapshot> {
  const { rpc, archiveRpc, registry, mint, recordDate } = opts

  const asset = registry.lookup(mint)
  if (!asset) {
    throw new Error(
      `Mint ${mint} is not in the canonical registry. Spoofed mints impersonating real ` +
      `tokenized equities are common; refusing to snapshot an unverified mint.`
    )
  }

  const instant = recordDateToInstant(recordDate)
  const slot = await pinSlot(archiveRpc, instant)
  const blockTime = await rpc.call('getBlockTime', [slot], BlockTimeSchema)
  if (blockTime === null) throw new Error(`Slot ${slot} has no block time; cannot anchor the multiplier`)

  // Everything the snapshot is built from goes through the archive client. State at a
  // past slot needs an archive by definition — and so does past *history*: a standard
  // node keeps only a rolling ledger window, so it retains neither the old signature
  // list nor the old blocks that pinSlot and the replay walk. Saying that transaction
  // history is not state was beside the point; a non-archival node has neither.
  const multiplier = await readMultiplierAtSlot(archiveRpc, mint, slot, blockTime)
  const replayed = await replayHolders(archiveRpc, mint, slot)

  // Signatures are enumerated from the mint's address, which catches `transferChecked`
  // (the mint is in its account list) but can miss a plain `transfer`. The supply sum
  // catches what MOVES the total: a mint or a burn the walk never saw. It does NOT
  // catch a missed transfer — a transfer misattributes supply between two owners and
  // leaves the sum unchanged — so it is not, on its own, a detector for a missing
  // holder. That case is caught by reconcile below, through the SENDER's balance.
  // Computed BEFORE exclusions, because pools and burn addresses hold real supply.
  const replayedTotal = [...replayed.values()].reduce((sum, amount) => sum + amount, 0n)
  const supply = await archiveRpc.callHistorical('getTokenSupply', [mint], slot, TokenSupplySchema)
  const expectedTotal = BigInt(supply.value.amount)
  const supplyMatches = replayedTotal === expectedTotal

  const { eligible, excluded } = await classifyOwners(archiveRpc, [...replayed.keys()], slot)

  // Reconcile the WHOLE replay, excluded owners included. Narrowing to the eligible
  // set first would leave pool PDAs unchecked, and a missed plain `transfer` out of a
  // pool is exactly the case that survives the supply check: the pool's balance is
  // then too high and the wallet that received the tokens is absent from the holder
  // set entirely. Checking the sender is the only way that shows up at all.
  const result = await reconcile(replayed, owner => archiveBalanceAtSlot(archiveRpc, mint, owner, slot))

  const supplyReport = {
    expected: expectedTotal.toString(),
    replayed: replayedTotal.toString(),
    matches: supplyMatches,
  }

  // A root is published only when BOTH detectors pass. They catch different things:
  // reconcile catches a WRONG balance for any owner the replay saw — which is how a
  // missed transfer surfaces, at the sender — and the supply check catches a mint or
  // burn that moved the total without appearing in the replay. Either failure means
  // the holder set is not the truth.
  if (!result.agree || !supplyMatches) {
    return {
      mint, slot, blockTime, decimals: asset.decimals, multiplier,
      holders: [], excluded, sourcesAgree: result.agree, supply: supplyReport, merkleRoot: null,
    }
  }

  // Exclusions decide only who is PUBLISHED; they never narrow what was checked.
  const eligibleSet = new Set(eligible)
  const rows = sortLeaves(
    [...result.holders]
      .filter(([owner]) => eligibleSet.has(owner))
      .map(([owner, raw]) => ({ owner, rawAmount: raw.toString() })),
  )
  const holders: HolderBalance[] = rows.map(r => ({
    owner: r.owner,
    rawAmount: r.rawAmount,
    shares: rawToShares(BigInt(r.rawAmount), multiplier, asset.decimals),
  }))
  const { root } = buildTree(rows.map(r => leafHash(mint, r.owner, r.rawAmount, multiplier)))

  return {
    mint, slot, blockTime, decimals: asset.decimals, multiplier,
    holders, excluded, sourcesAgree: true, supply: supplyReport, merkleRoot: root,
  }
}
