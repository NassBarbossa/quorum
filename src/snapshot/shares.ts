/**
 * shares = raw * multiplier / 10^decimals, rendered with exactly `decimals` places.
 * All arithmetic in bigint: a JS number loses precision above 2^53 and these
 * values feed a Merkle leaf, so a rounding difference is a verification failure.
 */
export function rawToShares(raw: bigint, multiplier: number, decimals: number): string {
  if (!Number.isInteger(multiplier)) {
    throw new Error(`Multiplier must be an integer to keep share maths exact, got ${multiplier}`)
  }
  if (multiplier < 1) throw new Error(`Multiplier must be at least 1, got ${multiplier}`)
  const scaled = raw * BigInt(multiplier)
  const divisor = 10n ** BigInt(decimals)
  const whole = scaled / divisor
  const frac = scaled % divisor
  return `${whole}.${frac.toString().padStart(decimals, '0')}`
}
