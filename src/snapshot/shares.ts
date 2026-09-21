/**
 * shares = raw * multiplier / 10^decimals, rendered with exactly `decimals` places.
 * All arithmetic in bigint: a JS number loses precision above 2^53 and these
 * values feed a Merkle leaf, so a rounding difference is a verification failure.
 */
export function rawToShares(raw: bigint, multiplier: number, decimals: number): string {
  if (!Number.isInteger(multiplier) || multiplier < 1) {
    // A fractional or sub-1 multiplier means a reverse split (1-for-10 gives 0.1).
    // Phase A has no exact-rational path for that, and the chain stores the
    // multiplier as an f64, so 0.1 is not even exactly representable at the source.
    // Refusing is the honest answer: a wrong share count here becomes a wrong
    // Merkle leaf, which fails verification rather than merely looking odd.
    throw new Error(
      `Multiplier must be an integer of at least 1 to keep share maths exact, got ${multiplier}. ` +
      `A fractional multiplier means this mint has had a reverse split, which Phase A does not support.`
    )
  }
  const scaled = raw * BigInt(multiplier)
  const divisor = 10n ** BigInt(decimals)
  const whole = scaled / divisor
  const frac = scaled % divisor
  return `${whole}.${frac.toString().padStart(decimals, '0')}`
}
