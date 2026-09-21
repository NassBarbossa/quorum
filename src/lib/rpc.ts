import { z, type ZodType } from 'zod'

/**
 * Every Solana RPC that can be pinned to a slot answers with a context block naming
 * the slot it actually read at. Validated on its own, against the raw result, so a
 * caller's schema never has to carry it.
 */
const ContextSchema = z.object({ context: z.object({ slot: z.number().int() }) })

export type RpcOptions = {
  fetchImpl?: typeof fetch
  baseDelayMs?: number
  maxAttempts?: number
  minIntervalMs?: number
  /**
   * Builds the provider-specific config object that pins a read to a past slot.
   * Default matches Alchemy Account Archive's documented shape; Task 7 confirms
   * it against the live API and changes only this default if it differs.
   */
  historicalParam?: (slot: number) => Record<string, unknown>
}

export class RpcClient {
  private readonly url: string
  private readonly fetchImpl: typeof fetch
  private readonly baseDelayMs: number
  private readonly maxAttempts: number
  private readonly minIntervalMs: number
  private readonly historicalParam: (slot: number) => Record<string, unknown>
  private lastCallAt = 0
  private nextId = 1

  constructor(url: string, opts: RpcOptions = {}) {
    this.url = url
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.baseDelayMs = opts.baseDelayMs ?? 700
    this.maxAttempts = opts.maxAttempts ?? 5
    // 700ms is the measured-safe pacing for public Solana RPC: a 10-call JSON-RPC
    // batch returned 429 immediately, while sequential calls at this spacing
    // succeeded across all 55 mints. Reactive backoff alone is not enough — the
    // replay in Task 6 makes thousands of calls and would eat a 429 on every run.
    // Callers on a paid endpoint pass a lower value explicitly.
    this.minIntervalMs = opts.minIntervalMs ?? 700
    this.historicalParam = opts.historicalParam ?? (slot => ({ encoding: 'jsonParsed', slot }))
  }

  async call<T>(method: string, params: unknown[], schema: ZodType<T>): Promise<T> {
    return (await this.execute(method, params, schema)).data
  }

  /** One validated call, returning the raw result alongside so callHistorical can
   *  check the provider's context block without every caller's schema changing. */
  private async execute<T>(
    method: string, params: unknown[], schema: ZodType<T>,
  ): Promise<{ data: T; raw: unknown }> {
    await this.throttle()
    let lastErr: unknown
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      if (attempt > 0) await sleep(this.baseDelayMs * 2 ** (attempt - 1))
      let res: Response
      try {
        res = await this.fetchImpl(this.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
        })
      } catch (err) {
        // Real fetch rejects on network faults — connection reset, DNS failure,
        // timeout. A replay makes thousands of calls, so one transient blip must
        // not abort the run. Treat it as retryable, exactly like a 429.
        lastErr = err
        continue
      }
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`RPC ${method} HTTP ${res.status}`)
        continue
      }
      if (!res.ok) throw new Error(`RPC ${method} HTTP ${res.status}`)
      const body = (await res.json()) as { result?: unknown; error?: { message?: string } }
      if (body.error) throw new Error(`RPC ${method} error: ${body.error.message ?? 'unknown'}`)
      const parsed = schema.safeParse(body.result)
      if (!parsed.success) {
        throw new Error(`RPC ${method} schema mismatch: ${parsed.error.issues.map(i => i.path.join('.')).join(', ')}`)
      }
      return { data: parsed.data, raw: body.result }
    }
    throw lastErr instanceof Error ? lastErr : new Error(`RPC ${method} failed after ${this.maxAttempts} attempts`)
  }

  /**
   * Read state as it stood at `slot`, using the archive provider's historical parameter.
   *
   * Deliberately NOT minContextSlot: that is a freshness guard ("fail unless this node
   * has reached slot N"), and using it here would return head state wearing a snapshot
   * label — wrong without being loud, which is the worst failure this project has.
   * The parameter shape is a constructor option because providers differ; Task 7 pins
   * it against the real archive API without touching a single caller.
   *
   * Asking is not enough: a Solana RPC silently ignores config fields it does not
   * recognise, so an endpoint that is not an archive — or one whose historical
   * parameter has another name — answers from head and admits it only in its context
   * block. On a quiet mint every check downstream would still agree and we would
   * publish today's state as the record date's. So the answer's own slot is verified
   * against the one we asked for, and a mismatch is a refusal.
   */
  async callHistorical<T>(method: string, params: unknown[], slot: number, schema: ZodType<T>): Promise<T> {
    const { data, raw } = await this.execute(method, [...params, this.historicalParam(slot)], schema)
    const ctx = ContextSchema.safeParse(raw)
    if (ctx.success && ctx.data.context.slot !== slot) {
      throw new Error(
        `RPC ${method} was pinned to slot ${slot} but the provider answered from slot ` +
        `${ctx.data.context.slot}. The endpoint is ignoring the historical parameter; ` +
        `refusing to read head state as history.`
      )
    }
    return data
  }

  private async throttle(): Promise<void> {
    if (this.minIntervalMs === 0) return
    const wait = this.lastCallAt + this.minIntervalMs - Date.now()
    if (wait > 0) await sleep(wait)
    this.lastCallAt = Date.now()
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
