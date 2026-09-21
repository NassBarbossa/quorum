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
  // Find the UTC offset New York had on that day by formatting a probe instant in that zone.
  const probe = new Date(`${date}T12:00:00Z`)
  const offsetMinutes = zoneOffsetMinutes(probe, ZONE)
  const utcMillis = Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)),
    CLOSE_OF_BUSINESS_HOUR,
    0, 0, 0,
  ) - offsetMinutes * 60_000
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

export type PinOptions = { lowerBound?: number }

/**
 * Binary search for the highest slot whose block_time is at or before `instant`.
 * Skipped slots return a null block_time; we walk down until we find a real block.
 */
export async function pinSlot(rpc: RpcClient, instant: Date, opts: PinOptions = {}): Promise<number> {
  const targetSeconds = Math.floor(instant.getTime() / 1000)
  let low = opts.lowerBound ?? 0
  let high = await rpc.call('getSlot', [], SlotSchema)

  const highTime = await blockTimeAtOrBelow(rpc, high, low)
  if (highTime === null) throw new Error(`Could not read a block time near the chain tip (slot ${high})`)
  if (highTime.time < targetSeconds) {
    throw new Error(
      `Record date instant ${instant.toISOString()} is in the future relative to the chain tip ` +
      `(latest block time ${new Date(highTime.time * 1000).toISOString()}). Not yet snapshottable.`
    )
  }

  let best = low
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const found = await blockTimeAtOrBelow(rpc, mid, low)
    if (found === null) { low = mid + 1; continue }
    if (found.time <= targetSeconds) { best = found.slot; low = found.slot + 1 }
    else { high = found.slot - 1 }
  }
  return best
}

async function blockTimeAtOrBelow(
  rpc: RpcClient, slot: number, floor: number,
): Promise<{ slot: number; time: number } | null> {
  for (let s = slot; s >= floor && s > slot - 200; s--) {
    const t = await rpc.call('getBlockTime', [s], BlockTimeSchema)
    if (t !== null) return { slot: s, time: t }
  }
  return null
}
