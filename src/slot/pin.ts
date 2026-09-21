import { z } from 'zod'
import type { RpcClient } from '../lib/rpc.js'

const RECORD_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const CLOSE_OF_BUSINESS_HOUR = 17
const ZONE = 'America/New_York'

/**
 * Resolve a record date to the exact instant that fixes eligibility:
 * 17:00:00 America/New_York on that calendar day.
 */
export function recordDateToInstant(date: string): Date {
  if (!RECORD_DATE_RE.test(date)) throw new Error(`Record date must be YYYY-MM-DD, got "${date}"`)

  const year = Number(date.slice(0, 4))
  const month = Number(date.slice(5, 7))
  const day = Number(date.slice(8, 10))

  // The regex only checks shape. Date.UTC silently rolls an impossible date over —
  // "2026-13-45" becomes 2027-02-14 — which would pin a slot weeks from the one the
  // filing named, with no error. Reject anything that does not round-trip.
  const roundTrip = new Date(Date.UTC(year, month - 1, day))
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== day
  ) {
    throw new Error(`Record date "${date}" is not a real calendar date`)
  }

  // Find the UTC offset New York had on that day by formatting a probe instant in that zone.
  const probe = new Date(`${date}T12:00:00Z`)
  const offsetMinutes = zoneOffsetMinutes(probe, ZONE)
  const utcMillis = Date.UTC(year, month - 1, day, CLOSE_OF_BUSINESS_HOUR, 0, 0, 0)
    - offsetMinutes * 60_000
  return new Date(utcMillis)
}

function zoneOffsetMinutes(at: Date, timeZone: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
  const parts = Object.fromEntries(fmt.formatToParts(at).map(p => [p.type, p.value]))
  const asUtc = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour) % 24, Number(parts.minute), Number(parts.second),
  )
  return (asUtc - at.getTime()) / 60_000
}

const SlotSchema = z.number().int().nonnegative()
const BlockTimeSchema = z.number().int().nullable()
const BlocksSchema = z.array(z.number().int())

export type PinOptions = { lowerBound?: number }

/**
 * Highest slot at or below `slot` that actually produced a block.
 *
 * Uses getBlocks rather than probing getBlockTime one slot at a time. Solana
 * skips slots routinely and can skip hundreds consecutively under congestion or
 * an outage; a fixed probe window that gave up after N slots would make the
 * caller discard a range that still held the answer, returning a wrong slot with
 * no error. Every weight in the snapshot hangs off this number, so the window
 * widens until a block is found or `floor` is reached. A null return therefore
 * means there is genuinely no block in [floor, slot].
 */
async function highestBlockAtOrBelow(
  rpc: RpcClient, slot: number, floor: number,
): Promise<{ slot: number; time: number } | null> {
  if (slot < floor) return null
  let window = 1_000
  for (;;) {
    const start = Math.max(floor, slot - window)
    const blocks = await rpc.call('getBlocks', [start, slot], BlocksSchema)
    const found = blocks.at(-1)
    if (found !== undefined) {
      const time = await rpc.call('getBlockTime', [found], BlockTimeSchema)
      if (time === null) {
        throw new Error(`Slot ${found} was listed as a confirmed block but has no block time`)
      }
      return { slot: found, time }
    }
    if (start === floor) return null
    window *= 8
  }
}

/** Binary search for the highest slot whose block_time is at or before `instant`. */
export async function pinSlot(rpc: RpcClient, instant: Date, opts: PinOptions = {}): Promise<number> {
  const targetSeconds = Math.floor(instant.getTime() / 1000)
  const floor = opts.lowerBound ?? 0
  let low = floor
  let high = await rpc.call('getSlot', [], SlotSchema)

  const tip = await highestBlockAtOrBelow(rpc, high, floor)
  if (tip === null) throw new Error(`Could not read any confirmed block between slots ${floor} and ${high}`)
  if (tip.time < targetSeconds) {
    throw new Error(
      `Record date instant ${instant.toISOString()} is in the future relative to the chain tip ` +
      `(latest block time ${new Date(tip.time * 1000).toISOString()}). Not yet snapshottable.`
    )
  }

  // `best` starts null, never at the lower bound: an unresolved search must throw
  // rather than hand back slot 0, which would read as a real answer.
  let best: number | null = null
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const found = await highestBlockAtOrBelow(rpc, mid, low)
    if (found === null) { low = mid + 1; continue }
    if (found.time <= targetSeconds) { best = found.slot; low = found.slot + 1 }
    else { high = found.slot - 1 }
  }

  if (best === null) {
    throw new Error(
      `No Solana block at or before ${instant.toISOString()} exists at or above slot ${floor}. ` +
      `Refusing to return a slot that was never confirmed.`
    )
  }
  return best
}
