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
  const slot = await pinSlot(rpc, instant)
  const blockTime = await rpc.call('getBlockTime', [slot], BlockTimeSchema)
  if (blockTime === null) throw new Error(`Slot ${slot} has no block time; cannot anchor the multiplier`)

  // Multiplier and account ownership are historical reads: they must reflect the
  // snapshot slot, so they go through the archive client. Signature and transaction
  // history is not state, so the replay uses the standard client.
  const multiplier = await readMultiplierAtSlot(archiveRpc, mint, slot, blockTime)
  const replayed = await replayHolders(rpc, mint, slot)

  // The strongest correctness check available, and the ONLY detector for the known
  // enumeration gap: signatures are enumerated from the mint's address, which catches
  // `transferChecked` (the mint is in its account list) but can miss a plain `transfer`.
  // If any holder was missed, the replayed balances will not sum to total supply.
  // Computed BEFORE exclusions, because pools and burn addresses hold real supply.
  const replayedTotal = [...replayed.values()].reduce((sum, amount) => sum + amount, 0n)
  const supply = await archiveRpc.callHistorical('getTokenSupply', [mint], slot, TokenSupplySchema)
  const expectedTotal = BigInt(supply.value.amount)
  const supplyMatches = replayedTotal === expectedTotal

  const { eligible, excluded } = await classifyOwners(archiveRpc, [...replayed.keys()], slot)
  const eligibleSet = new Set(eligible)
  const filtered = new Map([...replayed].filter(([owner]) => eligibleSet.has(owner)))

  const result = await reconcile(filtered, owner => archiveBalanceAtSlot(archiveRpc, mint, owner, slot))

  const supplyReport = {
    expected: expectedTotal.toString(),
    replayed: replayedTotal.toString(),
    matches: supplyMatches,
  }

  // A root is published only when BOTH detectors pass. They catch different things:
  // reconcile catches a WRONG balance (per owner), the supply check catches a MISSING
  // holder (set level). Either failure means the holder set is not the truth.
  if (!result.agree || !supplyMatches) {
    return {
      mint, slot, blockTime, decimals: asset.decimals, multiplier,
      holders: [], excluded, sourcesAgree: result.agree, supply: supplyReport, merkleRoot: null,
    }
  }

  const rows = sortLeaves(
    [...result.holders].map(([owner, raw]) => ({ owner, rawAmount: raw.toString() })),
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
