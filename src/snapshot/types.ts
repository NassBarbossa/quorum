export type HolderBalance = {
  owner: string
  rawAmount: string   // decimal string of a bigint; never a JS number
  shares: string      // fixed-point string with exactly `decimals` places
}

export type Exclusion = {
  address: string
  reason: 'program-owned' | 'burn' | 'mint-authority'
}

export type Snapshot = {
  mint: string
  slot: number
  blockTime: number
  decimals: number
  multiplier: number
  holders: HolderBalance[]
  excluded: Exclusion[]
  sourcesAgree: boolean
  merkleRoot: string | null   // null while sourcesAgree is false
}

/** Returned instead of a number when a value could not be read. Construction rule 3. */
export type Unreadable = { unreadable: true; reason: string }
