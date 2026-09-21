export type TokenProgram = 'spl-token' | 'token-2022'
export type AssetClass = 'stock' | 'crypto' | 'commodity'

export type LinkedStock = {
  ticker: string
  currency: string
  mic: string | null
}

export type Asset = {
  mint: string
  symbol: string
  name: string
  decimals: number
  assetClass: AssetClass
  issuer: string | null
  tokenProgram: TokenProgram
  linkedStock: LinkedStock | null
}
