import { z } from 'zod'
import type { RpcClient } from '../lib/rpc.js'

export type ScaledUiAmountState = {
  multiplier: number
  newMultiplier: number
  newMultiplierEffectiveTimestamp: number
}

const MintAccountSchema = z.object({
  value: z.object({
    data: z.object({
      parsed: z.object({
        info: z.object({
          decimals: z.number().int(),
          extensions: z
            .array(z.object({ extension: z.string(), state: z.unknown().optional() }))
            .optional(),
        }),
      }),
    }),
  }),
})

const ScaledStateSchema = z.object({
  multiplier: z.coerce.number(),
  newMultiplier: z.coerce.number(),
  newMultiplierEffectiveTimestamp: z.coerce.number(),
})

/** The new multiplier applies once block time reaches its effective timestamp. */
export function pickMultiplier(state: ScaledUiAmountState, blockTimeSeconds: number): number {
  return blockTimeSeconds >= state.newMultiplierEffectiveTimestamp ? state.newMultiplier : state.multiplier
}

export async function readMultiplierAtSlot(
  rpc: RpcClient, mint: string, slot: number, blockTimeSeconds: number,
): Promise<number> {
  const acct = await rpc.callHistorical('getAccountInfo', [mint], slot, MintAccountSchema)
  const ext = acct.value.data.parsed.info.extensions?.find(e => e.extension === 'scaledUiAmountConfig')
  if (!ext) return 1
  const parsed = ScaledStateSchema.safeParse(ext.state)
  if (!parsed.success) {
    throw new Error(`Mint ${mint} has a scaledUiAmountConfig that could not be decoded; refusing to assume 1`)
  }
  return pickMultiplier(parsed.data, blockTimeSeconds)
}
