import type { ZodType } from 'zod'

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
    this.minIntervalMs = opts.minIntervalMs ?? 0
    this.historicalParam = opts.historicalParam ?? (slot => ({ encoding: 'jsonParsed', slot }))
  }

  async call<T>(method: string, params: unknown[], schema: ZodType<T>): Promise<T> {
    await this.throttle()
    let lastErr: unknown
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      if (attempt > 0) await sleep(this.baseDelayMs * 2 ** (attempt - 1))
      const res = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method, params }),
      })
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
      return parsed.data
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
   */
  async callHistorical<T>(method: string, params: unknown[], slot: number, schema: ZodType<T>): Promise<T> {
    return this.call(method, [...params, this.historicalParam(slot)], schema)
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
