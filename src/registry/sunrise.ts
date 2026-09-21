import { z } from 'zod'
import type { Asset } from './types.js'

const SUNRISE_URL = 'https://api.sunrise.xyz/v1/tokens'

const TokenSchema = z.object({
  address: z.string(),
  symbol: z.string(),
  name: z.string(),
  decimals: z.number().int().min(0).max(18),
  assetClass: z.enum(['stock', 'crypto', 'commodity']),
  issuer: z.string().nullable().optional(),
  tokenProgram: z.enum(['spl-token', 'token-2022']),
  stock: z
    .object({
      ticker: z.string(),
      currency: z.string(),
      exchange: z.object({ marketIdentifierCode: z.string() }).nullable().optional(),
    })
    .nullable()
    .optional(),
})

const ResponseSchema = z.object({
  data: z.object({ tokens: z.array(TokenSchema) }),
})

export async function fetchSunriseAssets(fetchImpl: typeof fetch = fetch): Promise<Asset[]> {
  const res = await fetchImpl(SUNRISE_URL)
  if (!res.ok) throw new Error(`Sunrise registry HTTP ${res.status}`)
  const parsed = ResponseSchema.safeParse(await res.json())
  if (!parsed.success) {
    throw new Error(`Sunrise registry schema mismatch: ${parsed.error.issues.map(i => i.path.join('.')).join(', ')}`)
  }
  return parsed.data.data.tokens.map(t => ({
    mint: t.address,
    symbol: t.symbol,
    name: t.name,
    decimals: t.decimals,
    assetClass: t.assetClass,
    issuer: t.issuer ?? null,
    tokenProgram: t.tokenProgram,
    linkedStock: t.stock
      ? { ticker: t.stock.ticker, currency: t.stock.currency, mic: t.stock.exchange?.marketIdentifierCode ?? null }
      : null,
  }))
}
