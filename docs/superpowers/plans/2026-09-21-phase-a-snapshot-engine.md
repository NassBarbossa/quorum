# Quorum Phase A — Asset Registry & Snapshot Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Given a canonical tokenized-equity mint and a record date, produce a holder list with share weights that two independent sources agree on, committed to a Merkle root, and recomputable by a third party using code that shares nothing with ours.

**Architecture:** A TypeScript library plus CLI. The asset registry syncs canonical mints from Sunrise. The snapshot engine reconstructs the holder set at a past slot by replaying token-balance deltas from transaction metadata (primary source), verifies individual balances against an archive RPC (check source), converts raw amounts to share counts using the Token-2022 `scaledUiAmount` multiplier in force at that slot, excludes program-owned and burn addresses, and commits the result to a canonical Merkle tree. A standalone verifier script in plain JavaScript recomputes the root independently.

**Tech Stack:** TypeScript 5.x · Node 20+ · `@solana/web3.js` v1 · Vitest · `zod` for boundary validation · Helius RPC (replay) · Alchemy Account Archive (historical `getAccountInfo`)

**Spec:** `docs/superpowers/specs/2026-09-21-quorum-design.md`

## Global Constraints

- **Three construction rules apply to every task.** (1) Every number is read from a source, never stated. (2) The verifier shares no code with the thing it verifies. (3) Refuse to publish a zero you could not read — surface `unreadable`, never `0`.
- **Node 20+**, ESM only (`"type": "module"` in package.json).
- **No secrets in the repo.** RPC keys come from `.env`, which is gitignored. `.env.example` lists variable names only.
- **All external JSON is validated with zod at the boundary.** A malformed RPC or API response must throw, never silently produce a default.
- **Weight is shares, never raw token amounts.** `shares = raw × multiplier ÷ 10^decimals`, multiplier read at the snapshot slot.
- **Fixtures are real.** Golden fixtures use real mints at real slots with values committed to the repo. No synthetic chain data.
- **Commit after every task.** Conventional commits (`feat:`, `test:`, `chore:`).

## Reference values (verified on-chain 2026-09-21)

Use these exact values in tests. They were read from mainnet and are stable history.

| Thing | Value |
|---|---|
| Backpack AMD mint | `AMD8XwJXgQ9WV45Wyj9yFLejxzf2J6VM1PJY8bJEjeES` |
| Backpack DELL mint (small, good fixture) | `DELLPTjEX4hnfkjFKffMp2Vd8AFRpRSVAX9zS3qKrLu` |
| Backpack PTN mint | `PTNzAfFAB4LvoUQEUUGrFMyUoRLExMYjH6CcfyQfsVP` |
| Token-2022 program | `TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb` |
| SPL Token program | `TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA` |
| Sunrise registry | `https://api.sunrise.xyz/v1/tokens` |
| AMD mint decimals | `6` |
| AMD `scaledUiAmountConfig.multiplier` | `1` |

> **Note on DELL:** the mint address above is a placeholder pattern — Task 2 writes the registry, and Task 11 selects the smallest-supply mint from the synced registry as the golden fixture. Do not hardcode DELL before the registry exists.

---

## File Structure

```
src/
  lib/
    rpc.ts              RPC client: batching-free sequential calls, retry on 429, zod-validated
    env.ts              Typed env loading, fails loudly on missing keys
  registry/
    types.ts            Asset, Issuer, LinkedStock
    sunrise.ts          Fetch + normalise https://api.sunrise.xyz/v1/tokens
    store.ts            Read/write registry.json, canonical-mint lookup
  snapshot/
    types.ts            Snapshot, HolderBalance, Exclusion, Unreadable
    multiplier.ts       scaledUiAmount multiplier in force at a slot
    shares.ts           raw + multiplier + decimals -> share count (integer math)
    exclusions.ts       Classify program-owned / burn addresses
    sources/
      replay.ts         Primary: rebuild holder set from token-balance deltas
      archive.ts        Check: single balance at a slot from archive RPC
    reconcile.ts        Compare sources; agree or refuse
    merkle.ts           Canonical Merkle tree (domain-separated, sorted)
  slot/
    pin.ts              Record date + America/New_York 17:00 -> slot
scripts/
  verify-snapshot.mjs   Standalone. Plain JS. Imports nothing from src/.
tests/
  ...mirrors src/
fixtures/
  registry.sample.json
  snapshot.golden.json
```

---

### Task 1: Project scaffold and resilient RPC client

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.env.example`
- Create: `src/lib/env.ts`, `src/lib/rpc.ts`
- Test: `tests/lib/rpc.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `loadEnv(): Env` with `{ rpcUrl: string; archiveRpcUrl: string }`; `class RpcClient` with `call<T>(method: string, params: unknown[], schema: ZodType<T>): Promise<T>` and `callHistorical<T>(method: string, params: unknown[], slot: number, schema: ZodType<T>): Promise<T>`. Every later task uses `RpcClient`.

**On `callHistorical`:** `minContextSlot` is a *freshness guard* — "fail unless this node has reached slot N" — not a time machine. Reading historical state needs the archive provider's own parameter, whose exact shape is confirmed in Task 7 against the real API. So `callHistorical` takes the shape as a constructor option (`historicalParam`) with a documented default, and every caller stays unchanged when Task 7 pins it down. **Tasks 4, 5 and 7 all route through the archive client**, never the standard one: the multiplier and account ownership must be read as they stood at the snapshot slot, and a standard RPC would silently answer with head state.

**Why this is Task 1:** public Solana RPC returns HTTP 429 on batched requests. This was hit during research: a 10-call JSON-RPC batch failed immediately, sequential calls with a 700ms gap succeeded for all 55 mints. The client must be sequential-with-backoff by default or every later task fails intermittently.

- [ ] **Step 1: Write the failing test**

```ts
// tests/lib/rpc.test.ts
import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { RpcClient } from '../../src/lib/rpc.js'

describe('RpcClient', () => {
  it('retries on 429 and eventually succeeds', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => 'rate limited' })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: async () => ({ jsonrpc: '2.0', id: 1, result: { value: 42 } }),
      })
    const client = new RpcClient('https://rpc.example', { fetchImpl: fetchMock as never, baseDelayMs: 1 })
    const schema = z.object({ value: z.number() })
    const out = await client.call('getThing', [], schema)
    expect(out).toEqual({ value: 42 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('throws when the response fails schema validation instead of returning a default', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: { value: 'not a number' } }),
    })
    const client = new RpcClient('https://rpc.example', { fetchImpl: fetchMock as never, baseDelayMs: 1 })
    await expect(client.call('getThing', [], z.object({ value: z.number() }))).rejects.toThrow(/schema/i)
  })

  it('surfaces a JSON-RPC error rather than swallowing it', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'bad params' } }),
    })
    const client = new RpcClient('https://rpc.example', { fetchImpl: fetchMock as never, baseDelayMs: 1 })
    await expect(client.call('getThing', [], z.unknown())).rejects.toThrow(/bad params/)
  })

  it('callHistorical appends the configured historical parameter, not minContextSlot', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: { ok: true } }),
    })
    const client = new RpcClient('https://rpc.example', { fetchImpl: fetchMock as never, baseDelayMs: 1 })
    await client.callHistorical('getAccountInfo', ['MINT'], 12345, z.object({ ok: z.boolean() }))
    const sent = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body)
    expect(sent.params).toEqual(['MINT', { encoding: 'jsonParsed', slot: 12345 }])
    expect(JSON.stringify(sent)).not.toMatch(/minContextSlot/)
  })

  it('callHistorical honours a provider-specific parameter shape', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: { ok: true } }),
    })
    const client = new RpcClient('https://rpc.example', {
      fetchImpl: fetchMock as never, baseDelayMs: 1,
      historicalParam: slot => ({ encoding: 'jsonParsed', blockNumber: slot }),
    })
    await client.callHistorical('getAccountInfo', ['MINT'], 777, z.object({ ok: z.boolean() }))
    const sent = JSON.parse((fetchMock.mock.calls[0]![1] as { body: string }).body)
    expect(sent.params[1]).toEqual({ encoding: 'jsonParsed', blockNumber: 777 })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/lib/rpc.test.ts`
Expected: FAIL — `Cannot find module '../../src/lib/rpc.js'`

- [ ] **Step 3: Create the scaffold files**

```json
// package.json
{
  "name": "quorum",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@solana/web3.js": "^1.98.0",
    "dotenv": "^16.4.5",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

```json
// tsconfig.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "."
  },
  "include": ["src/**/*", "tests/**/*"]
}
```

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { environment: 'node', testTimeout: 30_000 } })
```

```sh
# .env.example
# Standard Solana RPC. Public endpoint works but rate-limits hard.
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
# Archive RPC that answers getAccountInfo at a historical slot.
SOLANA_ARCHIVE_RPC_URL=
```

- [ ] **Step 4: Write the implementation**

```ts
// src/lib/env.ts
import 'dotenv/config'
import { z } from 'zod'

const EnvSchema = z.object({
  SOLANA_RPC_URL: z.string().url(),
  SOLANA_ARCHIVE_RPC_URL: z.string().url(),
})

export type Env = { rpcUrl: string; archiveRpcUrl: string }

export function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env)
  if (!parsed.success) {
    throw new Error(
      `Missing or invalid environment: ${parsed.error.issues.map(i => i.path.join('.')).join(', ')}. ` +
      `Copy .env.example to .env and fill it in.`
    )
  }
  return { rpcUrl: parsed.data.SOLANA_RPC_URL, archiveRpcUrl: parsed.data.SOLANA_ARCHIVE_RPC_URL }
}
```

```ts
// src/lib/rpc.ts
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
    // 700ms is the measured-safe pacing for public Solana RPC: a 10-call JSON-RPC
    // batch returned 429 immediately, while sequential calls at this spacing
    // succeeded across all 55 mints. Reactive backoff alone is not enough — the
    // replay in Task 6 makes thousands of calls and would eat a 429 on every run.
    // Callers on a paid endpoint pass a lower value explicitly.
    this.minIntervalMs = opts.minIntervalMs ?? 700
    this.historicalParam = opts.historicalParam ?? (slot => ({ encoding: 'jsonParsed', slot }))
  }

  async call<T>(method: string, params: unknown[], schema: ZodType<T>): Promise<T> {
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
```

- [ ] **Step 5: Install and run tests**

Run: `npm install && npx vitest run tests/lib/rpc.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .env.example src/lib tests/lib
git commit -m "feat: project scaffold and retrying RPC client"
```

---

### Task 2: Asset registry from Sunrise

**Files:**
- Create: `src/registry/types.ts`, `src/registry/sunrise.ts`, `src/registry/store.ts`
- Create: `fixtures/registry.sample.json`
- Test: `tests/registry/sunrise.test.ts`, `tests/registry/store.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1 (pure HTTP)
- Produces: `type Asset` (see below); `fetchSunriseAssets(fetchImpl?): Promise<Asset[]>`; `class Registry` with `static fromFile(path): Registry`, `lookup(mint: string): Asset | undefined`, `isCanonical(mint: string): boolean`, `stocks(): Asset[]`. Tasks 6, 7 and 11 use `Registry.isCanonical` to reject spoofed mints.

**Why this matters:** 35 of 55 results matching "xStock" on a public token search are spoofed mints with 1–28 holders and zero market cap. A snapshot built on the wrong mint is worthless. `isCanonical` is the single gate.

- [ ] **Step 1: Write the failing test**

```ts
// tests/registry/sunrise.test.ts
import { describe, it, expect, vi } from 'vitest'
import { fetchSunriseAssets } from '../../src/registry/sunrise.js'

const SAMPLE = {
  success: true,
  data: {
    count: 2,
    tokens: [
      {
        chain: 'solana',
        address: 'AMD8XwJXgQ9WV45Wyj9yFLejxzf2J6VM1PJY8bJEjeES',
        symbol: 'AMD',
        name: 'Advanced Micro Devices - Backpack Securities',
        decimals: 6,
        platform: 'svm',
        assetClass: 'stock',
        issuer: 'backpack_securities',
        tokenProgram: 'token-2022',
        stock: { ticker: 'AMD', currency: 'USD', exchange: { marketIdentifierCode: 'XNAS', name: 'Nasdaq' } },
      },
      {
        chain: 'solana',
        address: 'So11111111111111111111111111111111111111112',
        symbol: 'SOL',
        name: 'Wrapped SOL',
        decimals: 9,
        platform: 'svm',
        assetClass: 'crypto',
        issuer: null,
        tokenProgram: 'spl-token',
        stock: null,
      },
    ],
  },
}

describe('fetchSunriseAssets', () => {
  it('normalises stock tokens and keeps the linked ticker', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => SAMPLE })
    const assets = await fetchSunriseAssets(fetchMock as never)
    const amd = assets.find(a => a.symbol === 'AMD')!
    expect(amd.mint).toBe('AMD8XwJXgQ9WV45Wyj9yFLejxzf2J6VM1PJY8bJEjeES')
    expect(amd.assetClass).toBe('stock')
    expect(amd.tokenProgram).toBe('token-2022')
    expect(amd.decimals).toBe(6)
    expect(amd.linkedStock?.ticker).toBe('AMD')
  })

  it('keeps non-stock assets but marks them so stocks() can filter', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => SAMPLE })
    const assets = await fetchSunriseAssets(fetchMock as never)
    expect(assets).toHaveLength(2)
    expect(assets.filter(a => a.assetClass === 'stock')).toHaveLength(1)
  })

  it('throws on a malformed payload instead of returning an empty list', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ success: true, data: { tokens: 'nope' } }),
    })
    await expect(fetchSunriseAssets(fetchMock as never)).rejects.toThrow(/schema/i)
  })
})
```

```ts
// tests/registry/store.test.ts
import { describe, it, expect } from 'vitest'
import { Registry } from '../../src/registry/store.js'

const ASSETS = [
  {
    mint: 'AMD8XwJXgQ9WV45Wyj9yFLejxzf2J6VM1PJY8bJEjeES',
    symbol: 'AMD', name: 'AMD', decimals: 6,
    assetClass: 'stock' as const, issuer: 'backpack_securities',
    tokenProgram: 'token-2022' as const,
    linkedStock: { ticker: 'AMD', currency: 'USD', mic: 'XNAS' },
  },
]

describe('Registry', () => {
  it('accepts a mint that is in the registry', () => {
    const r = new Registry(ASSETS)
    expect(r.isCanonical('AMD8XwJXgQ9WV45Wyj9yFLejxzf2J6VM1PJY8bJEjeES')).toBe(true)
  })

  it('rejects a mint that is not in the registry', () => {
    const r = new Registry(ASSETS)
    expect(r.isCanonical('FAKEmintAddressThatIsNotCanonical11111111111')).toBe(false)
  })

  it('returns only stock assets from stocks()', () => {
    const r = new Registry([...ASSETS, { ...ASSETS[0]!, mint: 'X', symbol: 'SOL', assetClass: 'crypto' as const }])
    expect(r.stocks().map(a => a.symbol)).toEqual(['AMD'])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/registry`
Expected: FAIL — modules not found

- [ ] **Step 3: Write the implementation**

```ts
// src/registry/types.ts
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
```

```ts
// src/registry/sunrise.ts
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
```

```ts
// src/registry/store.ts
import { readFileSync, writeFileSync } from 'node:fs'
import type { Asset } from './types.js'

export class Registry {
  private readonly byMint: Map<string, Asset>

  constructor(private readonly assets: Asset[]) {
    this.byMint = new Map(assets.map(a => [a.mint, a]))
  }

  static fromFile(path: string): Registry {
    return new Registry(JSON.parse(readFileSync(path, 'utf8')) as Asset[])
  }

  save(path: string): void {
    writeFileSync(path, JSON.stringify(this.assets, null, 2) + '\n', 'utf8')
  }

  lookup(mint: string): Asset | undefined {
    return this.byMint.get(mint)
  }

  /** The single gate against spoofed mints. */
  isCanonical(mint: string): boolean {
    return this.byMint.has(mint)
  }

  stocks(): Asset[] {
    return this.assets.filter(a => a.assetClass === 'stock')
  }

  all(): Asset[] {
    return [...this.assets]
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/registry`
Expected: PASS, 6 tests

- [ ] **Step 5: Sync the real registry and commit it as a fixture**

```bash
node --input-type=module -e "
import { fetchSunriseAssets } from './src/registry/sunrise.js'
import { Registry } from './src/registry/store.js'
const assets = await fetchSunriseAssets()
new Registry(assets).save('fixtures/registry.sample.json')
console.log('assets:', assets.length, 'stocks:', assets.filter(a => a.assetClass === 'stock').length)
"
```
Expected output: roughly `assets: 88 stocks: 55` (the registry grows over time; the count is informational, not asserted).

- [ ] **Step 6: Commit**

```bash
git add src/registry tests/registry fixtures/registry.sample.json
git commit -m "feat: canonical asset registry synced from Sunrise"
```

---

### Task 3: Record date to slot pinning

**Files:**
- Create: `src/slot/pin.ts`
- Test: `tests/slot/pin.test.ts`

**Interfaces:**
- Consumes: `RpcClient` from Task 1
- Produces: `recordDateToInstant(date: string): Date` and `pinSlot(rpc: RpcClient, instant: Date): Promise<number>`. Task 6, 7 and 11 consume `pinSlot`'s return value.

**Convention (from spec §7):** the last slot whose `block_time` is at or before **17:00:00 `America/New_York`** on the record date. Resolved in local time because US daylight saving shifts it by an hour twice a year.

- [ ] **Step 1: Write the failing test**

```ts
// tests/slot/pin.test.ts
import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { recordDateToInstant, pinSlot } from '../../src/slot/pin.js'

describe('recordDateToInstant', () => {
  it('resolves 17:00 New York in daylight saving time to 21:00 UTC', () => {
    // 2026-06-15 is EDT (UTC-4)
    expect(recordDateToInstant('2026-06-15').toISOString()).toBe('2026-06-15T21:00:00.000Z')
  })

  it('resolves 17:00 New York in standard time to 22:00 UTC', () => {
    // 2026-01-06 is EST (UTC-5)
    expect(recordDateToInstant('2026-01-06').toISOString()).toBe('2026-01-06T22:00:00.000Z')
  })

  it('rejects a malformed date', () => {
    expect(() => recordDateToInstant('06/15/2026')).toThrow(/YYYY-MM-DD/)
  })

  it('rejects a well-formed but impossible calendar date instead of rolling it over', () => {
    // Date.UTC would turn these into 2027-02-14 and 2027-03-01 respectively,
    // pinning a slot weeks away from the date the filing actually named.
    expect(() => recordDateToInstant('2026-13-45')).toThrow(/not a real calendar date/)
    expect(() => recordDateToInstant('2027-02-29')).toThrow(/not a real calendar date/)
  })
})

/**
 * Synthetic chain: slot N has block_time = 1_700_000_000 + N, except inside
 * `gaps`, which are ranges of skipped slots that produced no block at all.
 * Solana skips slots routinely and can skip hundreds consecutively during
 * congestion, so gaps are the normal case, not an exotic one.
 */
function chainMock(opts: { tip: number; gaps?: [number, number][] }) {
  const skipped = (s: number) => (opts.gaps ?? []).some(([a, b]) => s >= a && s <= b)
  return {
    call: vi.fn(async (method: string, params: unknown[]) => {
      if (method === 'getSlot') return opts.tip
      if (method === 'getBlocks') {
        const [start, end] = params as [number, number]
        const out: number[] = []
        for (let s = start; s <= end; s++) if (!skipped(s)) out.push(s)
        return out
      }
      if (method === 'getBlockTime') {
        const s = params[0] as number
        return skipped(s) ? null : 1_700_000_000 + s
      }
      throw new Error(`unexpected ${method}`)
    }),
  }
}

describe('pinSlot', () => {
  it('returns the last slot at or before the target instant', async () => {
    const rpc = chainMock({ tip: 1_000 })
    const target = new Date(1_700_000_500 * 1000)
    expect(await pinSlot(rpc as never, target, { lowerBound: 0 })).toBe(500)
  })

  it('skips back past a long run of skipped slots instead of discarding the answer', async () => {
    // Slots 301-700 produced no block. The true answer is 300: it is the highest
    // slot that both has a block and whose time is at or before the target.
    const rpc = chainMock({ tip: 1_000, gaps: [[301, 700]] })
    const target = new Date(1_700_000_500 * 1000)
    expect(await pinSlot(rpc as never, target, { lowerBound: 0 })).toBe(300)
  })

  it('throws when the target instant is in the future rather than guessing', async () => {
    const rpc = chainMock({ tip: 1_000 })
    const future = new Date(1_700_002_000 * 1000)
    await expect(pinSlot(rpc as never, future, { lowerBound: 0 })).rejects.toThrow(/future|not yet/i)
  })

  it('throws rather than returning slot 0 when no block sits at or before the target', async () => {
    // Every slot in range is skipped except the tip, whose time is after the target.
    const rpc = chainMock({ tip: 1_000, gaps: [[0, 999]] })
    const target = new Date(1_700_000_500 * 1000)
    await expect(pinSlot(rpc as never, target, { lowerBound: 0 })).rejects.toThrow(/never confirmed|no solana block/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/slot/pin.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```ts
// src/slot/pin.ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/slot/pin.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 5: Commit**

```bash
git add src/slot tests/slot
git commit -m "feat: pin a record date to a Solana slot at 17:00 America/New_York"
```

---

### Task 4: Share weight from the scaledUiAmount multiplier

**Files:**
- Create: `src/snapshot/types.ts`, `src/snapshot/multiplier.ts`, `src/snapshot/shares.ts`
- Test: `tests/snapshot/multiplier.test.ts`, `tests/snapshot/shares.test.ts`

**Interfaces:**
- Consumes: `RpcClient` (Task 1)
- Produces: `readMultiplierAtSlot(rpc, mint, slot, blockTimeSeconds): Promise<number>`; `rawToShares(raw: bigint, multiplier: number, decimals: number): string`. Tasks 6, 7, 9 and 11 use both.

**Why:** Backpack handles stock splits by changing the Token-2022 `scaledUiAmount` multiplier, not by rebasing balances. Reading today's multiplier for a past snapshot produces wrong share counts after any split. The extension carries `multiplier`, `newMultiplier` and `newMultiplierEffectiveTimestamp`: the new value applies once the block time reaches the effective timestamp.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/snapshot/multiplier.test.ts
import { describe, it, expect, vi } from 'vitest'
import { pickMultiplier, readMultiplierAtSlot } from '../../src/snapshot/multiplier.js'

describe('pickMultiplier', () => {
  it('uses the current multiplier before the effective timestamp', () => {
    expect(pickMultiplier({ multiplier: 1, newMultiplier: 4, newMultiplierEffectiveTimestamp: 2000 }, 1999)).toBe(1)
  })

  it('uses the new multiplier at the effective timestamp', () => {
    expect(pickMultiplier({ multiplier: 1, newMultiplier: 4, newMultiplierEffectiveTimestamp: 2000 }, 2000)).toBe(4)
  })

  it('treats a zero effective timestamp as already in force', () => {
    // The two multipliers must differ, or this test passes under either branch
    // and guards nothing.
    expect(pickMultiplier({ multiplier: 1, newMultiplier: 4, newMultiplierEffectiveTimestamp: 0 }, 1)).toBe(4)
  })
})

describe('readMultiplierAtSlot', () => {
  it('returns 1 for a mint with no scaledUiAmount extension', async () => {
    const rpc = {
      callHistorical: vi.fn(async () => ({
        value: { data: { parsed: { info: { decimals: 6, extensions: [{ extension: 'transferHook', state: {} }] } } } },
      })),
    }
    const m = await readMultiplierAtSlot(rpc as never, 'MINT', 123, 1000)
    expect(m).toBe(1)
  })

  it('reads the multiplier from the extension', async () => {
    const rpc = {
      callHistorical: vi.fn(async () => ({
        value: {
          data: {
            parsed: {
              info: {
                decimals: 6,
                extensions: [
                  { extension: 'scaledUiAmountConfig', state: { multiplier: 1, newMultiplier: 4, newMultiplierEffectiveTimestamp: 500 } },
                ],
              },
            },
          },
        },
      })),
    }
    expect(await readMultiplierAtSlot(rpc as never, 'MINT', 123, 499)).toBe(1)
    expect(await readMultiplierAtSlot(rpc as never, 'MINT', 123, 500)).toBe(4)
  })
})
```

```ts
// tests/snapshot/shares.test.ts
import { describe, it, expect } from 'vitest'
import { rawToShares } from '../../src/snapshot/shares.js'

describe('rawToShares', () => {
  it('converts raw to shares with no multiplier', () => {
    expect(rawToShares(12_480_000n, 1, 6)).toBe('12.480000')
  })

  it('applies a 4-for-1 split multiplier', () => {
    expect(rawToShares(12_480_000n, 4, 6)).toBe('49.920000')
  })

  it('renders exactly `decimals` places, always', () => {
    expect(rawToShares(1n, 1, 6)).toBe('0.000001')
    expect(rawToShares(1_000_000n, 1, 6)).toBe('1.000000')
  })

  it('never loses precision to floating point on large balances', () => {
    // 95,587,000.123456 shares would round badly through Number
    expect(rawToShares(95_587_000_123_456n, 1, 6)).toBe('95587000.123456')
  })

  it('rejects a non-integer multiplier that would introduce rounding', () => {
    expect(() => rawToShares(1_000_000n, 1.5, 6)).toThrow(/integer/i)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/snapshot`
Expected: FAIL — modules not found

- [ ] **Step 3: Write the implementation**

```ts
// src/snapshot/types.ts
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
  /** Replayed balances vs the mint's total supply at the slot. Detects a MISSING holder. */
  supply: { expected: string; replayed: string; matches: boolean }
  merkleRoot: string | null   // null unless sourcesAgree AND supply.matches
}

/** Returned instead of a number when a value could not be read. Construction rule 3. */
export type Unreadable = { unreadable: true; reason: string }
```

```ts
// src/snapshot/multiplier.ts
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
```

```ts
// src/snapshot/shares.ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/snapshot`
Expected: PASS, 10 tests

- [ ] **Step 5: Commit**

```bash
git add src/snapshot tests/snapshot
git commit -m "feat: share weights from the scaledUiAmount multiplier at a slot"
```

---

### Task 5: Address exclusions

**Files:**
- Create: `src/snapshot/exclusions.ts`
- Test: `tests/snapshot/exclusions.test.ts`

**Interfaces:**
- Consumes: `RpcClient` (Task 1), `Exclusion` (Task 4)
- Produces: `classifyOwners(rpc, owners: string[], slot: number): Promise<{ eligible: string[]; excluded: Exclusion[] }>`. Tasks 6 and 9 consume it.

**Why:** a liquidity-pool PDA appears as a large holder that will never vote. Counting it turns a 40% participation rate into 4%. Program-owned accounts cannot sign, so they cannot produce an instruction. The test is ownership by a program, not a hand-maintained list of pool addresses.

- [ ] **Step 1: Write the failing test**

```ts
// tests/snapshot/exclusions.test.ts
import { describe, it, expect, vi } from 'vitest'
import { classifyOwners, BURN_ADDRESSES } from '../../src/snapshot/exclusions.js'

const SYSTEM_PROGRAM = '11111111111111111111111111111111'

describe('classifyOwners', () => {
  it('keeps wallet accounts owned by the system program', async () => {
    const rpc = {
      callHistorical: vi.fn(async () => ({ value: [{ owner: SYSTEM_PROGRAM, executable: false }] })),
    }
    const out = await classifyOwners(rpc as never, ['WalletAddress1111111111111111111111111111111'], 100)
    expect(out.eligible).toEqual(['WalletAddress1111111111111111111111111111111'])
    expect(out.excluded).toEqual([])
  })

  it('excludes an account owned by a non-system program', async () => {
    const rpc = {
      callHistorical: vi.fn(async () => ({
        value: [{ owner: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', executable: false }],
      })),
    }
    const out = await classifyOwners(rpc as never, ['PoolPda11111111111111111111111111111111111'], 100)
    expect(out.eligible).toEqual([])
    expect(out.excluded[0]).toEqual({ address: 'PoolPda11111111111111111111111111111111111', reason: 'program-owned' })
  })

  it('excludes known burn addresses without an RPC call', async () => {
    const rpc = { callHistorical: vi.fn() }
    const out = await classifyOwners(rpc as never, [BURN_ADDRESSES[0]!], 100)
    expect(out.excluded[0]!.reason).toBe('burn')
    expect(rpc.callHistorical).not.toHaveBeenCalled()
  })

  it('treats an account that does not exist at the slot as eligible, not excluded', async () => {
    // A wallet can hold tokens through an ATA while its own account has never been funded.
    const rpc = { callHistorical: vi.fn(async () => ({ value: [null] })) }
    const out = await classifyOwners(rpc as never, ['UnfundedWallet11111111111111111111111111111'], 100)
    expect(out.eligible).toEqual(['UnfundedWallet11111111111111111111111111111'])
  })

  it('throws rather than defaulting when the response is shorter than the request', async () => {
    // A truncated reply must not let the missing tail pass as eligible — that is
    // how a pool PDA would end up counted as a voter.
    const rpc = { callHistorical: vi.fn(async () => ({ value: [] })) }
    await expect(
      classifyOwners(rpc as never, ['Wallet1111111111111111111111111111111111111'], 100),
    ).rejects.toThrow(/partial response/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/snapshot/exclusions.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```ts
// src/snapshot/exclusions.ts
import { z } from 'zod'
import type { RpcClient } from '../lib/rpc.js'
import type { Exclusion } from './types.js'

const SYSTEM_PROGRAM = '11111111111111111111111111111111'

/** Addresses whose tokens are provably out of circulation. */
export const BURN_ADDRESSES: readonly string[] = [
  '1nc1nerator11111111111111111111111111111111',
]

const MultipleAccountsSchema = z.object({
  value: z.array(z.object({ owner: z.string(), executable: z.boolean() }).nullable()),
})

const CHUNK = 100

/**
 * An owner is eligible if it can sign. Program-owned accounts (pool PDAs, vaults)
 * cannot, so they can never produce a voting instruction and must not sit in the
 * participation denominator.
 */
export async function classifyOwners(
  rpc: RpcClient, owners: string[], slot: number,
): Promise<{ eligible: string[]; excluded: Exclusion[] }> {
  const eligible: string[] = []
  const excluded: Exclusion[] = []
  const toProbe: string[] = []

  for (const owner of owners) {
    if (BURN_ADDRESSES.includes(owner)) excluded.push({ address: owner, reason: 'burn' })
    else toProbe.push(owner)
  }

  for (let i = 0; i < toProbe.length; i += CHUNK) {
    const chunk = toProbe.slice(i, i + CHUNK)
    const res = await rpc.callHistorical('getMultipleAccounts', [chunk], slot, MultipleAccountsSchema)
    chunk.forEach((address, idx) => {
      const info = res.value[idx]
      if (info === undefined) {
        // The response is shorter than the request. Treating the missing tail as
        // eligible would silently admit pool PDAs into the holder set — the exact
        // error this function exists to prevent — so refuse rather than default.
        throw new Error(
          `getMultipleAccounts returned ${res.value.length} entries for ${chunk.length} addresses ` +
          `at slot ${slot}; nothing for ${address}. Refusing to classify a partial response.`
        )
      }
      // A never-funded wallet has no account but can still own an ATA and can still sign.
      if (info === null) { eligible.push(address); return }
      if (info.owner === SYSTEM_PROGRAM) eligible.push(address)
      else excluded.push({ address, reason: 'program-owned' })
    })
  }

  return { eligible, excluded }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/snapshot/exclusions.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add src/snapshot/exclusions.ts tests/snapshot/exclusions.test.ts
git commit -m "feat: exclude program-owned and burn addresses from the holder set"
```

---

### Task 6: Replay source — rebuild the holder set at a slot

**Files:**
- Create: `src/snapshot/sources/replay.ts`
- Test: `tests/snapshot/sources/replay.test.ts`

**Interfaces:**
- Consumes: `RpcClient` (Task 1)
- Produces: `replayHolders(rpc, mint: string, slot: number): Promise<Map<string, bigint>>` — owner address to raw amount, including only non-zero balances. Tasks 8 and 9 consume it.

**Approach:** every transaction that changes a token balance carries `meta.preTokenBalances` and `meta.postTokenBalances`, and each entry names the `mint`, the `owner` and the `uiTokenAmount.amount`. Replaying those post-balances in slot order rebuilds the state at any slot without needing historical `getProgramAccounts`. Entries for other mints are ignored.

- [ ] **Step 1: Write the failing test**

```ts
// tests/snapshot/sources/replay.test.ts
import { describe, it, expect, vi } from 'vitest'
import { applyTransactionBalances, replayHolders } from '../../../src/snapshot/sources/replay.js'

const MINT = 'AMD8XwJXgQ9WV45Wyj9yFLejxzf2J6VM1PJY8bJEjeES'
const OTHER = 'So11111111111111111111111111111111111111112'

describe('applyTransactionBalances', () => {
  it('sets a holder balance from postTokenBalances', () => {
    const state = new Map<string, bigint>()
    applyTransactionBalances(state, MINT, [
      { mint: MINT, owner: 'alice', uiTokenAmount: { amount: '1000000' } },
    ])
    expect(state.get('alice')).toBe(1_000_000n)
  })

  it('ignores balances for other mints', () => {
    const state = new Map<string, bigint>()
    applyTransactionBalances(state, MINT, [
      { mint: OTHER, owner: 'bob', uiTokenAmount: { amount: '5000' } },
    ])
    expect(state.has('bob')).toBe(false)
  })

  it('removes a holder whose balance went to zero', () => {
    const state = new Map<string, bigint>([['alice', 1_000_000n]])
    applyTransactionBalances(state, MINT, [
      { mint: MINT, owner: 'alice', uiTokenAmount: { amount: '0' } },
    ])
    expect(state.has('alice')).toBe(false)
  })

  it('sums multiple token accounts owned by the same wallet', () => {
    const state = new Map<string, bigint>()
    applyTransactionBalances(state, MINT, [
      { mint: MINT, owner: 'alice', uiTokenAmount: { amount: '400' }, accountIndex: 1 },
      { mint: MINT, owner: 'alice', uiTokenAmount: { amount: '600' }, accountIndex: 2 },
    ])
    expect(state.get('alice')).toBe(1_000n)
  })
})

describe('replayHolders', () => {
  it('walks signatures oldest-first and stops at the target slot', async () => {
    const signatures = [
      { signature: 'sig3', slot: 300 },
      { signature: 'sig2', slot: 200 },
      { signature: 'sig1', slot: 100 },
    ]
    const txs: Record<string, unknown> = {
      sig1: { slot: 100, meta: { postTokenBalances: [{ mint: MINT, owner: 'alice', uiTokenAmount: { amount: '1000' } }] } },
      sig2: { slot: 200, meta: { postTokenBalances: [{ mint: MINT, owner: 'bob', uiTokenAmount: { amount: '500' } }] } },
      sig3: { slot: 300, meta: { postTokenBalances: [{ mint: MINT, owner: 'alice', uiTokenAmount: { amount: '0' } }] } },
    }
    const rpc = {
      call: vi.fn(async (method: string, params: unknown[]) => {
        if (method === 'getSignaturesForAddress') {
          const before = (params[1] as { before?: string } | undefined)?.before
          if (before) return []
          return signatures
        }
        if (method === 'getTransaction') return txs[params[0] as string]
        throw new Error(`unexpected ${method}`)
      }),
    }
    const holders = await replayHolders(rpc as never, MINT, 250)
    expect(holders.get('alice')).toBe(1_000n)  // sig3 is past the target slot
    expect(holders.get('bob')).toBe(500n)
  })

  it('applies same-slot transactions oldest-first, not in RPC order', async () => {
    // getSignaturesForAddress returns newest first, including within one slot, and
    // a slot holds many transactions. Post-balances are absolute, so the newest
    // transaction in a slot must be applied LAST or an older one overwrites it.
    const signatures = [
      { signature: 'newer', slot: 100 },
      { signature: 'older', slot: 100 },
    ]
    const txs: Record<string, unknown> = {
      older: { slot: 100, meta: { postTokenBalances: [{ mint: MINT, owner: 'alice', uiTokenAmount: { amount: '111' } }] } },
      newer: { slot: 100, meta: { postTokenBalances: [{ mint: MINT, owner: 'alice', uiTokenAmount: { amount: '999' } }] } },
    }
    const rpc = {
      call: vi.fn(async (method: string, params: unknown[]) => {
        if (method === 'getSignaturesForAddress') {
          return (params[1] as { before?: string }).before ? [] : signatures
        }
        if (method === 'getTransaction') return txs[params[0] as string]
        throw new Error(`unexpected ${method}`)
      }),
    }
    const holders = await replayHolders(rpc as never, MINT, 200)
    expect(holders.get('alice')).toBe(999n)
  })

  it('throws rather than looping when the endpoint ignores the before cursor', async () => {
    const rpc = {
      call: vi.fn(async (method: string) => {
        if (method === 'getSignaturesForAddress') return [{ signature: 'same', slot: 10 }]
        throw new Error(`unexpected ${method}`)
      }),
    }
    await expect(replayHolders(rpc as never, MINT, 100)).rejects.toThrow(/ignoring "before"|same page twice/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/snapshot/sources/replay.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```ts
// src/snapshot/sources/replay.ts
import { z } from 'zod'
import type { RpcClient } from '../../lib/rpc.js'

export type TokenBalanceEntry = {
  mint: string
  owner?: string
  accountIndex?: number
  uiTokenAmount: { amount: string }
}

const SignatureSchema = z.array(z.object({ signature: z.string(), slot: z.number().int() }))

const TransactionSchema = z
  .object({
    slot: z.number().int(),
    meta: z
      .object({
        postTokenBalances: z
          .array(
            z.object({
              mint: z.string(),
              owner: z.string().optional(),
              accountIndex: z.number().int().optional(),
              uiTokenAmount: z.object({ amount: z.string() }),
            }),
          )
          .nullable()
          .optional(),
      })
      .nullable(),
  })
  .nullable()

/**
 * Apply one transaction's post-balances. Post-balances are absolute, not deltas,
 * so the last write for an owner at or before the target slot is their balance.
 * Multiple token accounts for the same owner are summed.
 */
export function applyTransactionBalances(
  state: Map<string, bigint>, mint: string, entries: TokenBalanceEntry[],
): void {
  const perOwner = new Map<string, bigint>()
  for (const e of entries) {
    if (e.mint !== mint) continue
    if (!e.owner) continue
    perOwner.set(e.owner, (perOwner.get(e.owner) ?? 0n) + BigInt(e.uiTokenAmount.amount))
  }
  for (const [owner, amount] of perOwner) {
    if (amount === 0n) state.delete(owner)
    else state.set(owner, amount)
  }
}

const PAGE = 1000

/**
 * Rebuild the holder set at `slot` by walking every signature that touched the
 * mint, oldest first, applying post-balances up to and including the target slot.
 */
export async function replayHolders(
  rpc: RpcClient, mint: string, slot: number,
): Promise<Map<string, bigint>> {
  const signatures: { signature: string; slot: number }[] = []
  let before: string | undefined
  for (;;) {
    const page = await rpc.call(
      'getSignaturesForAddress',
      [mint, before ? { limit: PAGE, before } : { limit: PAGE }],
      SignatureSchema,
    )
    if (page.length === 0) break
    signatures.push(...page)
    const nextBefore = page[page.length - 1]!.signature
    if (nextBefore === before) {
      // The endpoint returned the same page again, so it is ignoring the cursor.
      // Without this guard the loop runs forever and the snapshot never completes.
      throw new Error(
        `getSignaturesForAddress returned the same page twice at cursor ${before}; ` +
        `the endpoint is ignoring "before". Refusing to loop.`
      )
    }
    before = nextBefore
  }

  // getSignaturesForAddress returns newest first — including *within* a single slot,
  // which holds many transactions. Array.sort is stable, so sorting by slot alone
  // would preserve that newest-first order inside each slot and, because
  // post-balances are absolute, let an older transaction overwrite a newer one.
  // Reverse first, then the stable sort keeps each slot's transactions oldest-first.
  const ordered = signatures
    .filter(s => s.slot <= slot)
    .reverse()
    .sort((a, b) => a.slot - b.slot)

  const state = new Map<string, bigint>()
  for (const sig of ordered) {
    const tx = await rpc.call(
      'getTransaction',
      [sig.signature, { maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' }],
      TransactionSchema,
    )
    if (!tx || !tx.meta) continue
    if (tx.slot > slot) continue
    applyTransactionBalances(state, mint, tx.meta.postTokenBalances ?? [])
  }
  return state
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/snapshot/sources/replay.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/snapshot/sources/replay.ts tests/snapshot/sources/replay.test.ts
git commit -m "feat: rebuild the holder set at a slot by replaying token balances"
```

---

### Task 7: Archive source — a single balance at a slot

**Files:**
- Create: `src/snapshot/sources/archive.ts`
- Test: `tests/snapshot/sources/archive.test.ts`

**Interfaces:**
- Consumes: `RpcClient` (Task 1) pointed at `archiveRpcUrl`
- Produces: `archiveBalanceAtSlot(rpc, mint: string, owner: string, slot: number): Promise<bigint | null>` — `null` when the owner held no token account at that slot. Task 8 consumes it.

**Why separate from replay:** a standard RPC cannot enumerate holders historically, but an archive RPC can read one account at a historical slot. The two sources answer different shapes of question, which is exactly what makes their agreement meaningful: replay produces the set, archive independently confirms each balance.

- [ ] **Step 1: Write the failing test**

```ts
// tests/snapshot/sources/archive.test.ts
import { describe, it, expect, vi } from 'vitest'
import { archiveBalanceAtSlot } from '../../../src/snapshot/sources/archive.js'

const MINT = 'AMD8XwJXgQ9WV45Wyj9yFLejxzf2J6VM1PJY8bJEjeES'

describe('archiveBalanceAtSlot', () => {
  it('sums all token accounts an owner held for the mint at that slot', async () => {
    const rpc = {
      callHistorical: vi.fn(async () => ({
        value: [
          { account: { data: { parsed: { info: { tokenAmount: { amount: '400' } } } } } },
          { account: { data: { parsed: { info: { tokenAmount: { amount: '600' } } } } } },
        ],
      })),
    }
    expect(await archiveBalanceAtSlot(rpc as never, MINT, 'alice', 100)).toBe(1_000n)
  })

  it('returns null when the owner held nothing', async () => {
    const rpc = { callHistorical: vi.fn(async () => ({ value: [] })) }
    expect(await archiveBalanceAtSlot(rpc as never, MINT, 'bob', 100)).toBeNull()
  })

  it('propagates an archive error instead of returning zero', async () => {
    const rpc = { callHistorical: vi.fn(async () => { throw new Error('slot not in archive coverage') }) }
    await expect(archiveBalanceAtSlot(rpc as never, MINT, 'alice', 100)).rejects.toThrow(/archive coverage/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/snapshot/sources/archive.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```ts
// src/snapshot/sources/archive.ts
import { z } from 'zod'
import type { RpcClient } from '../../lib/rpc.js'

const TokenAccountsSchema = z.object({
  value: z.array(
    z.object({
      account: z.object({
        data: z.object({
          parsed: z.object({
            info: z.object({ tokenAmount: z.object({ amount: z.string() }) }),
          }),
        }),
      }),
    }),
  ),
})

/**
 * Read an owner's total balance for a mint at a historical slot.
 * Returns null when the owner held no token account for that mint — distinct
 * from a zero balance, and distinct from a read failure, which throws.
 */
export async function archiveBalanceAtSlot(
  rpc: RpcClient, mint: string, owner: string, slot: number,
): Promise<bigint | null> {
  const res = await rpc.callHistorical('getTokenAccountsByOwner', [owner, { mint }], slot, TokenAccountsSchema)
  if (res.value.length === 0) return null
  return res.value.reduce(
    (sum, entry) => sum + BigInt(entry.account.data.parsed.info.tokenAmount.amount),
    0n,
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/snapshot/sources/archive.test.ts`
Expected: PASS, 3 tests

- [ ] **Step 5: Commit**

```bash
git add src/snapshot/sources/archive.ts tests/snapshot/sources/archive.test.ts
git commit -m "feat: read a historical balance from an archive RPC"
```

---

### Task 8: Reconciliation — agree or refuse

**Files:**
- Create: `src/snapshot/reconcile.ts`
- Test: `tests/snapshot/reconcile.test.ts`

**Interfaces:**
- Consumes: `replayHolders` (Task 6), `archiveBalanceAtSlot` (Task 7)
- Produces: `reconcile(replay: Map<string, bigint>, lookup: (owner: string) => Promise<bigint | null>): Promise<ReconcileResult>` where `ReconcileResult = { agree: true; holders: Map<string, bigint> } | { agree: false; disagreements: Disagreement[] }`. Task 11 consumes it.

**Construction rule 3 in force:** when the sources disagree, the function returns `agree: false` with the specific mismatches. It never picks a winner and never returns a number.

- [ ] **Step 1: Write the failing test**

```ts
// tests/snapshot/reconcile.test.ts
import { describe, it, expect } from 'vitest'
import { reconcile } from '../../src/snapshot/reconcile.js'

describe('reconcile', () => {
  it('agrees when every replayed balance matches the archive', async () => {
    const replay = new Map([['alice', 1_000n], ['bob', 500n]])
    const archive = new Map([['alice', 1_000n], ['bob', 500n]])
    const out = await reconcile(replay, async o => archive.get(o) ?? null)
    expect(out.agree).toBe(true)
    if (out.agree) expect(out.holders.get('alice')).toBe(1_000n)
  })

  it('refuses when a balance differs, naming the owner and both values', async () => {
    const replay = new Map([['alice', 1_000n]])
    const archive = new Map([['alice', 999n]])
    const out = await reconcile(replay, async o => archive.get(o) ?? null)
    expect(out.agree).toBe(false)
    if (!out.agree) {
      expect(out.disagreements).toEqual([{ owner: 'alice', replay: '1000', archive: '999' }])
    }
  })

  it('refuses when the archive has no account for a replayed holder', async () => {
    const replay = new Map([['alice', 1_000n]])
    const out = await reconcile(replay, async () => null)
    expect(out.agree).toBe(false)
    if (!out.agree) expect(out.disagreements[0]!.archive).toBe('absent')
  })

  it('agrees on an empty holder set rather than throwing', async () => {
    const out = await reconcile(new Map(), async () => null)
    expect(out.agree).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/snapshot/reconcile.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```ts
// src/snapshot/reconcile.ts
export type Disagreement = { owner: string; replay: string; archive: string }

export type ReconcileResult =
  | { agree: true; holders: Map<string, bigint> }
  | { agree: false; disagreements: Disagreement[] }

/**
 * Confirm every balance the replay produced against an independent read.
 * On any mismatch the result is a refusal with the specific owners named:
 * we do not pick a winner, and we do not publish a number we cannot stand behind.
 */
export async function reconcile(
  replay: Map<string, bigint>,
  lookup: (owner: string) => Promise<bigint | null>,
): Promise<ReconcileResult> {
  const disagreements: Disagreement[] = []
  for (const [owner, replayAmount] of replay) {
    const archiveAmount = await lookup(owner)
    if (archiveAmount === null) {
      disagreements.push({ owner, replay: replayAmount.toString(), archive: 'absent' })
      continue
    }
    if (archiveAmount !== replayAmount) {
      disagreements.push({ owner, replay: replayAmount.toString(), archive: archiveAmount.toString() })
    }
  }
  return disagreements.length === 0 ? { agree: true, holders: replay } : { agree: false, disagreements }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/snapshot/reconcile.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Commit**

```bash
git add src/snapshot/reconcile.ts tests/snapshot/reconcile.test.ts
git commit -m "feat: reconcile replay against archive, refusing on disagreement"
```

---

### Task 9: Canonical Merkle tree

**Files:**
- Create: `src/snapshot/merkle.ts`
- Test: `tests/snapshot/merkle.test.ts`

**Interfaces:**
- Consumes: `HolderBalance` (Task 4)
- Produces: `leafHash(mint, owner, rawAmount, multiplier): Buffer`; `buildTree(leaves: Buffer[]): { root: string; layers: Buffer[][] }`; `proofFor(layers, index): string[]`; `verifyProof(leaf, proof, root): boolean`. Task 10's standalone verifier reimplements these independently; Task 11 consumes them.

**Canonical construction:** domain-separated prefixes (`0x00` leaf, `0x01` internal node) so a leaf can never be replayed as an internal node; leaves sorted by owner so the tree is deterministic; SHA-256 because it is syscall-available on Solana, which matters when the attestation program verifies proofs in Phase D.

- [ ] **Step 1: Write the failing test**

```ts
// tests/snapshot/merkle.test.ts
import { describe, it, expect } from 'vitest'
import { leafHash, buildTree, proofFor, verifyProof, sortLeaves } from '../../src/snapshot/merkle.js'

const MINT = 'AMD8XwJXgQ9WV45Wyj9yFLejxzf2J6VM1PJY8bJEjeES'

describe('merkle', () => {
  it('produces a stable root for the same input', () => {
    const leaves = [leafHash(MINT, 'alice', '1000', 1), leafHash(MINT, 'bob', '500', 1)]
    expect(buildTree(leaves).root).toBe(buildTree(leaves).root)
  })

  it('produces a different root when a balance changes', () => {
    const a = buildTree([leafHash(MINT, 'alice', '1000', 1)]).root
    const b = buildTree([leafHash(MINT, 'alice', '1001', 1)]).root
    expect(a).not.toBe(b)
  })

  it('produces a different root when leaves are reordered without sorting', () => {
    // Three leaves, not two: each pair is sorted by byte value before hashing
    // (so on-chain proof verification in Phase D needs no position flags), which
    // makes a two-leaf tree order-independent. Three leaves still differ.
    const a = leafHash(MINT, 'alice', '1000', 1)
    const b = leafHash(MINT, 'bob', '500', 1)
    const c = leafHash(MINT, 'carol', '250', 1)
    expect(buildTree([a, b, c]).root).not.toBe(buildTree([c, b, a]).root)
  })

  it('sortLeaves makes order irrelevant', () => {
    const rows = [
      { owner: 'bob', rawAmount: '500' },
      { owner: 'alice', rawAmount: '1000' },
    ]
    const sortedA = sortLeaves(rows).map(r => leafHash(MINT, r.owner, r.rawAmount, 1))
    const sortedB = sortLeaves([...rows].reverse()).map(r => leafHash(MINT, r.owner, r.rawAmount, 1))
    expect(buildTree(sortedA).root).toBe(buildTree(sortedB).root)
  })

  it('verifies a proof for every leaf in an odd-sized tree', () => {
    const rows = ['alice', 'bob', 'carol'].map((owner, i) => leafHash(MINT, owner, String((i + 1) * 100), 1))
    const tree = buildTree(rows)
    rows.forEach((leaf, i) => {
      expect(verifyProof(leaf, proofFor(tree.layers, i), tree.root)).toBe(true)
    })
  })

  it('rejects a proof for a tampered leaf', () => {
    const rows = ['alice', 'bob'].map((owner, i) => leafHash(MINT, owner, String((i + 1) * 100), 1))
    const tree = buildTree(rows)
    const tampered = leafHash(MINT, 'alice', '999999', 1)
    expect(verifyProof(tampered, proofFor(tree.layers, 0), tree.root)).toBe(false)
  })

  it('throws on an empty leaf set rather than inventing a root', () => {
    expect(() => buildTree([])).toThrow(/empty/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/snapshot/merkle.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```ts
// src/snapshot/merkle.ts
import { createHash } from 'node:crypto'

const LEAF_PREFIX = Buffer.from([0x00])
const NODE_PREFIX = Buffer.from([0x01])

function sha256(...parts: Buffer[]): Buffer {
  const h = createHash('sha256')
  for (const p of parts) h.update(p)
  return h.digest()
}

/**
 * Leaf = SHA256(0x00 || mint || 0x1f || owner || 0x1f || rawAmount || 0x1f || multiplier)
 * The 0x1f unit separator prevents field-boundary ambiguity: without it,
 * ("ab","c") and ("a","bc") would hash identically.
 */
export function leafHash(mint: string, owner: string, rawAmount: string, multiplier: number): Buffer {
  const sep = Buffer.from([0x1f])
  return sha256(
    LEAF_PREFIX,
    Buffer.from(mint, 'utf8'), sep,
    Buffer.from(owner, 'utf8'), sep,
    Buffer.from(rawAmount, 'utf8'), sep,
    Buffer.from(String(multiplier), 'utf8'),
  )
}

/** Deterministic leaf order: lexicographic by owner address. */
export function sortLeaves<T extends { owner: string }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0))
}

export function buildTree(leaves: Buffer[]): { root: string; layers: Buffer[][] } {
  if (leaves.length === 0) throw new Error('Cannot build a Merkle tree over an empty leaf set')
  const layers: Buffer[][] = [leaves]
  while (layers[layers.length - 1]!.length > 1) {
    const prev = layers[layers.length - 1]!
    const next: Buffer[] = []
    for (let i = 0; i < prev.length; i += 2) {
      const left = prev[i]!
      const right = prev[i + 1] ?? left // odd node is paired with itself
      // Each pair is hashed in byte order, so a proof needs no left/right flags.
      // verifyProof() below does the same, and so does scripts/verify-snapshot.mjs.
      next.push(
        Buffer.compare(left, right) <= 0
          ? sha256(NODE_PREFIX, left, right)
          : sha256(NODE_PREFIX, right, left),
      )
    }
    layers.push(next)
  }
  return { root: layers[layers.length - 1]![0]!.toString('hex'), layers }
}

export function proofFor(layers: Buffer[][], index: number): string[] {
  const proof: string[] = []
  let idx = index
  for (let level = 0; level < layers.length - 1; level++) {
    const layer = layers[level]!
    const pairIdx = idx % 2 === 0 ? idx + 1 : idx - 1
    proof.push((layer[pairIdx] ?? layer[idx]!).toString('hex'))
    idx = Math.floor(idx / 2)
  }
  return proof
}

export function verifyProof(leaf: Buffer, proof: string[], root: string): boolean {
  let node = leaf
  for (const sibling of proof) {
    const sib = Buffer.from(sibling, 'hex')
    node = Buffer.compare(node, sib) <= 0
      ? sha256(NODE_PREFIX, node, sib)
      : sha256(NODE_PREFIX, sib, node)
  }
  return node.toString('hex') === root
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/snapshot/merkle.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add src/snapshot/merkle.ts tests/snapshot/merkle.test.ts
git commit -m "feat: canonical domain-separated Merkle tree over the holder set"
```

---

### Task 10: Standalone independent verifier

**Files:**
- Create: `scripts/verify-snapshot.mjs`
- Test: `tests/scripts/verify-snapshot.test.ts`

**Interfaces:**
- Consumes: **nothing from `src/`.** This is construction rule 2 and it is the point of the task.
- Produces: a CLI — `node scripts/verify-snapshot.mjs <snapshot.json>` — exiting 0 when the published root matches its own recomputation and 1 when it does not.

**Why it must share no code:** if the verifier imports `merkle.ts`, a bug in `merkle.ts` verifies itself. The verifier reimplements leaf hashing and tree building from the published spec, in plain JavaScript, so a disagreement between the two implementations is a real signal.

- [ ] **Step 1: Write the failing test**

```ts
// tests/scripts/verify-snapshot.test.ts
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { leafHash, buildTree, sortLeaves } from '../../src/snapshot/merkle.js'

const MINT = 'AMD8XwJXgQ9WV45Wyj9yFLejxzf2J6VM1PJY8bJEjeES'

function writeSnapshot(root: string) {
  const dir = mkdtempSync(join(tmpdir(), 'quorum-'))
  const path = join(dir, 'snapshot.json')
  writeFileSync(path, JSON.stringify({
    mint: MINT, slot: 100, blockTime: 1_700_000_000, decimals: 6, multiplier: 1,
    holders: [
      { owner: 'alice', rawAmount: '1000', shares: '0.001000' },
      { owner: 'bob', rawAmount: '500', shares: '0.000500' },
    ],
    excluded: [], sourcesAgree: true, merkleRoot: root,
  }, null, 2))
  return path
}

function realRoot() {
  const rows = sortLeaves([
    { owner: 'alice', rawAmount: '1000' },
    { owner: 'bob', rawAmount: '500' },
  ])
  return buildTree(rows.map(r => leafHash(MINT, r.owner, r.rawAmount, 1))).root
}

describe('verify-snapshot.mjs', () => {
  it('exits 0 when the published root matches its own recomputation', () => {
    const path = writeSnapshot(realRoot())
    const out = execFileSync('node', ['scripts/verify-snapshot.mjs', path], { encoding: 'utf8' })
    expect(out).toMatch(/OK/)
  })

  it('exits 1 and says FAIL when the published root is wrong', () => {
    // Asserting only .toThrow() would pass for any crash at all — including the
    // script not existing. Pin the exit code and the message so this test can only
    // pass for the right reason.
    const path = writeSnapshot('0'.repeat(64))
    let status: number | undefined
    let stderr = ''
    try {
      execFileSync('node', ['scripts/verify-snapshot.mjs', path], { encoding: 'utf8', stdio: 'pipe' })
    } catch (err) {
      const e = err as { status?: number; stderr?: string }
      status = e.status
      stderr = e.stderr ?? ''
    }
    expect(status).toBe(1)
    expect(stderr).toMatch(/FAIL/)
  })

  it('refuses an empty holder set with a message rather than a stack trace', () => {
    const dir = mkdtempSync(join(tmpdir(), 'quorum-'))
    const path = join(dir, 'snapshot.json')
    writeFileSync(path, JSON.stringify({
      mint: MINT, slot: 100, blockTime: 1_700_000_000, decimals: 6, multiplier: 1,
      holders: [], excluded: [], sourcesAgree: true, merkleRoot: '0'.repeat(64),
    }))
    let status: number | undefined
    let stderr = ''
    try {
      execFileSync('node', ['scripts/verify-snapshot.mjs', path], { encoding: 'utf8', stdio: 'pipe' })
    } catch (err) {
      const e = err as { status?: number; stderr?: string }
      status = e.status
      stderr = e.stderr ?? ''
    }
    expect(status).toBe(1)
    expect(stderr).toMatch(/no holders/i)
    expect(stderr).not.toMatch(/at Object|at Module/)  // no stack trace
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/scripts/verify-snapshot.test.ts`
Expected: FAIL — `scripts/verify-snapshot.mjs` does not exist

- [ ] **Step 3: Write the standalone verifier**

```js
#!/usr/bin/env node
// scripts/verify-snapshot.mjs
//
// Independent recomputation of a Quorum snapshot's Merkle root.
// This file deliberately imports NOTHING from src/. It reimplements the
// published leaf and tree construction so that a bug in the main
// implementation cannot verify itself. If the two disagree, that is signal.
//
// Spec: docs/superpowers/specs/2026-09-21-quorum-design.md, section 11.
//
// Usage: node scripts/verify-snapshot.mjs <snapshot.json>

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const LEAF = Buffer.from([0x00])
const NODE = Buffer.from([0x01])
const SEP = Buffer.from([0x1f])

function h(...parts) {
  const d = createHash('sha256')
  for (const p of parts) d.update(p)
  return d.digest()
}

function leaf(mint, owner, rawAmount, multiplier) {
  return h(
    LEAF,
    Buffer.from(mint, 'utf8'), SEP,
    Buffer.from(owner, 'utf8'), SEP,
    Buffer.from(rawAmount, 'utf8'), SEP,
    Buffer.from(String(multiplier), 'utf8'),
  )
}

function root(leaves) {
  if (leaves.length === 0) throw new Error('empty leaf set')
  let level = leaves
  while (level.length > 1) {
    const next = []
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i]
      const b = level[i + 1] ?? a
      next.push(Buffer.compare(a, b) <= 0 ? h(NODE, a, b) : h(NODE, b, a))
    }
    level = next
  }
  return level[0].toString('hex')
}

function sharesOf(rawAmount, multiplier, decimals) {
  const scaled = BigInt(rawAmount) * BigInt(multiplier)
  const div = 10n ** BigInt(decimals)
  return `${scaled / div}.${(scaled % div).toString().padStart(decimals, '0')}`
}

const path = process.argv[2]
if (!path) {
  console.error('usage: node scripts/verify-snapshot.mjs <snapshot.json>')
  process.exit(2)
}

const snap = JSON.parse(readFileSync(path, 'utf8'))

if (snap.sourcesAgree !== true) {
  console.error(`REFUSED: this snapshot is marked sourcesAgree=false and has no valid root.`)
  process.exit(1)
}

if (!Array.isArray(snap.holders) || snap.holders.length === 0) {
  // root() would throw 'empty leaf set' here and print a stack trace. A verifier
  // that crashes reads as broken tooling rather than as a verdict on the file,
  // and someone checking our work deserves a sentence, not a trace.
  console.error(`REFUSED: this snapshot has no holders; there is nothing to verify.`)
  process.exit(1)
}

let shareErrors = 0
for (const holder of snap.holders) {
  const expected = sharesOf(holder.rawAmount, snap.multiplier, snap.decimals)
  if (expected !== holder.shares) {
    console.error(`SHARE MISMATCH ${holder.owner}: published ${holder.shares}, recomputed ${expected}`)
    shareErrors++
  }
}

const sorted = [...snap.holders].sort((a, b) => (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0))
const recomputed = root(sorted.map(x => leaf(snap.mint, x.owner, x.rawAmount, snap.multiplier)))

if (recomputed !== snap.merkleRoot || shareErrors > 0) {
  console.error(`FAIL  published root ${snap.merkleRoot}`)
  console.error(`      recomputed     ${recomputed}`)
  console.error(`      share mismatches: ${shareErrors}`)
  process.exit(1)
}

console.log(`OK  ${snap.holders.length} holders, root ${recomputed}`)
console.log(`    mint ${snap.mint} at slot ${snap.slot}, multiplier ${snap.multiplier}`)
process.exit(0)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/scripts/verify-snapshot.test.ts`
Expected: PASS, 3 tests

- [ ] **Step 5: Commit**

```bash
git add scripts/verify-snapshot.mjs tests/scripts
git commit -m "feat: standalone snapshot verifier sharing no code with the tallier"
```

---

### Task 11: End-to-end snapshot against a real mint

**Files:**
- Create: `src/snapshot/index.ts`
- Create: `fixtures/snapshot.golden.json`
- Test: `tests/snapshot/index.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–10
- Produces: `takeSnapshot(opts): Promise<Snapshot>` where `opts = { rpc: RpcClient; archiveRpc: RpcClient; registry: Registry; mint: string; recordDate: string }`. Phase C consumes this.

**Fixture choice:** pick the smallest-supply stock mint in `fixtures/registry.sample.json` so the replay is short enough to run in CI and small enough to check by hand. At the time of writing DELL had a supply of 120 tokens.

- [ ] **Step 1: Write the failing test**

```ts
// tests/snapshot/index.test.ts
import { describe, it, expect, vi } from 'vitest'
import { takeSnapshot } from '../../src/snapshot/index.js'
import { Registry } from '../../src/registry/store.js'

const MINT = 'AMD8XwJXgQ9WV45Wyj9yFLejxzf2J6VM1PJY8bJEjeES'
const registry = new Registry([{
  mint: MINT, symbol: 'AMD', name: 'AMD', decimals: 6,
  assetClass: 'stock', issuer: 'backpack_securities',
  tokenProgram: 'token-2022', linkedStock: { ticker: 'AMD', currency: 'USD', mic: 'XNAS' },
}])

describe('takeSnapshot', () => {
  it('refuses a mint that is not in the canonical registry', async () => {
    await expect(takeSnapshot({
      rpc: {} as never, archiveRpc: {} as never, registry,
      mint: 'FAKEmint1111111111111111111111111111111111', recordDate: '2026-01-06',
    })).rejects.toThrow(/not in the canonical registry/i)
  })
})

/** Standard client: chain tip, block times, and one holder (alice, 1000 raw) at slot 900. */
function standardMock() {
  return {
    call: vi.fn(async (method: string, params: unknown[]) => {
      if (method === 'getSlot') return 1_000
      if (method === 'getBlocks') {
        const [start, end] = params as [number, number]
        const out: number[] = []
        for (let s = start; s <= end; s++) out.push(s)
        return out
      }
      if (method === 'getBlockTime') return 1_767_740_400 // 2026-01-06T22:00:00Z
      if (method === 'getSignaturesForAddress') {
        return (params[1] as { before?: string }).before ? [] : [{ signature: 'sig1', slot: 900 }]
      }
      if (method === 'getTransaction') {
        return { slot: 900, meta: { postTokenBalances: [{ mint: MINT, owner: 'alice', uiTokenAmount: { amount: '1000' } }] } }
      }
      throw new Error(`unexpected ${method}`)
    }),
  }
}

/** Archive client: answers every historical read. `balance` is what it reports for
 *  alice, `supply` is the mint's total supply at the slot. */
function archiveMock(opts: { balance: string; supply: string }) {
  return {
    callHistorical: vi.fn(async (method: string) => {
      if (method === 'getAccountInfo') {
        return { value: { data: { parsed: { info: { decimals: 6, extensions: [] } } } } }
      }
      if (method === 'getMultipleAccounts') {
        return { value: [{ owner: '11111111111111111111111111111111', executable: false }] }
      }
      if (method === 'getTokenSupply') return { value: { amount: opts.supply } }
      if (method === 'getTokenAccountsByOwner') {
        return { value: [{ account: { data: { parsed: { info: { tokenAmount: { amount: opts.balance } } } } } }] }
      }
      throw new Error(`unexpected ${method}`)
    }),
  }
}

describe('takeSnapshot detectors', () => {
  it('returns sourcesAgree=false and a null root when the sources disagree', async () => {
    const rpc = standardMock()
    }
    // 999 against the replay's 1000 — the sources must refuse to agree. Supply is
    // set to 1000 so this test isolates the reconcile failure from the supply check.
    const archiveRpc = archiveMock({ balance: '999', supply: '1000' })
    const snap = await takeSnapshot({ rpc: rpc as never, archiveRpc: archiveRpc as never, registry, mint: MINT, recordDate: '2026-01-06' })
    expect(snap.sourcesAgree).toBe(false)
    expect(snap.supply.matches).toBe(true)
    expect(snap.merkleRoot).toBeNull()
  })

  it('withholds the root when the replayed balances do not sum to total supply', async () => {
    // Both sources agree on alice's 1000, but the mint says 5000 exist. Some holder
    // was never enumerated, so the holder set is not the truth and no root is published.
    // This is the only detector for a plain `transfer` the mint's signature list missed.
    const rpc = standardMock()
    const archiveRpc = archiveMock({ balance: '1000', supply: '5000' })
    const snap = await takeSnapshot({ rpc: rpc as never, archiveRpc: archiveRpc as never, registry, mint: MINT, recordDate: '2026-01-06' })
    expect(snap.sourcesAgree).toBe(true)
    expect(snap.supply).toEqual({ expected: '5000', replayed: '1000', matches: false })
    expect(snap.merkleRoot).toBeNull()
  })

  it('publishes a root when both sources agree and supply reconciles', async () => {
    const rpc = standardMock()
    const archiveRpc = archiveMock({ balance: '1000', supply: '1000' })
    const snap = await takeSnapshot({ rpc: rpc as never, archiveRpc: archiveRpc as never, registry, mint: MINT, recordDate: '2026-01-06' })
    expect(snap.sourcesAgree).toBe(true)
    expect(snap.supply.matches).toBe(true)
    expect(snap.merkleRoot).toMatch(/^[0-9a-f]{64}$/)
    expect(snap.holders).toEqual([{ owner: 'alice', rawAmount: '1000', shares: '0.001000' }])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/snapshot/index.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```ts
// src/snapshot/index.ts
import type { RpcClient } from '../lib/rpc.js'
import type { Registry } from '../registry/store.js'
import type { Snapshot, HolderBalance } from './types.js'
import { recordDateToInstant, pinSlot } from '../slot/pin.js'
import { readMultiplierAtSlot } from './multiplier.js'
import { rawToShares } from './shares.js'
import { classifyOwners } from './exclusions.js'
import { replayHolders } from './sources/replay.js'
import { archiveBalanceAtSlot } from './sources/archive.js'
import { reconcile } from './reconcile.js'
import { leafHash, buildTree, sortLeaves } from './merkle.js'
import { z } from 'zod'

export type TakeSnapshotOptions = {
  rpc: RpcClient
  archiveRpc: RpcClient
  registry: Registry
  mint: string
  recordDate: string
}

const BlockTimeSchema = z.number().int().nullable()
const TokenSupplySchema = z.object({ value: z.object({ amount: z.string() }) })

export async function takeSnapshot(opts: TakeSnapshotOptions): Promise<Snapshot> {
  const { rpc, archiveRpc, registry, mint, recordDate } = opts

  const asset = registry.lookup(mint)
  if (!asset) {
    throw new Error(
      `Mint ${mint} is not in the canonical registry. Spoofed mints impersonating real ` +
      `tokenized equities are common; refusing to snapshot an unverified mint.`
    )
  }

  const instant = recordDateToInstant(recordDate)
  const slot = await pinSlot(rpc, instant)
  const blockTime = await rpc.call('getBlockTime', [slot], BlockTimeSchema)
  if (blockTime === null) throw new Error(`Slot ${slot} has no block time; cannot anchor the multiplier`)

  // Multiplier and account ownership are historical reads: they must reflect the
  // snapshot slot, so they go through the archive client. Signature and transaction
  // history is not state, so the replay uses the standard client.
  const multiplier = await readMultiplierAtSlot(archiveRpc, mint, slot, blockTime)
  const replayed = await replayHolders(rpc, mint, slot)

  // The strongest correctness check available, and the ONLY detector for the known
  // enumeration gap: signatures are enumerated from the mint's address, which catches
  // `transferChecked` (the mint is in its account list) but can miss a plain `transfer`.
  // If any holder was missed, the replayed balances will not sum to total supply.
  // Computed BEFORE exclusions, because pools and burn addresses hold real supply.
  const replayedTotal = [...replayed.values()].reduce((sum, amount) => sum + amount, 0n)
  const supply = await archiveRpc.callHistorical('getTokenSupply', [mint], slot, TokenSupplySchema)
  const expectedTotal = BigInt(supply.value.amount)
  const supplyMatches = replayedTotal === expectedTotal

  const { eligible, excluded } = await classifyOwners(archiveRpc, [...replayed.keys()], slot)
  const eligibleSet = new Set(eligible)
  const filtered = new Map([...replayed].filter(([owner]) => eligibleSet.has(owner)))

  const result = await reconcile(filtered, owner => archiveBalanceAtSlot(archiveRpc, mint, owner, slot))

  const supplyReport = {
    expected: expectedTotal.toString(),
    replayed: replayedTotal.toString(),
    matches: supplyMatches,
  }

  // A root is published only when BOTH detectors pass. They catch different things:
  // reconcile catches a WRONG balance (per owner), the supply check catches a MISSING
  // holder (set level). Either failure means the holder set is not the truth.
  if (!result.agree || !supplyMatches) {
    return {
      mint, slot, blockTime, decimals: asset.decimals, multiplier,
      holders: [], excluded, sourcesAgree: result.agree, supply: supplyReport, merkleRoot: null,
    }
  }

  const rows = sortLeaves(
    [...result.holders].map(([owner, raw]) => ({ owner, rawAmount: raw.toString() })),
  )
  const holders: HolderBalance[] = rows.map(r => ({
    owner: r.owner,
    rawAmount: r.rawAmount,
    shares: rawToShares(BigInt(r.rawAmount), multiplier, asset.decimals),
  }))
  const { root } = buildTree(rows.map(r => leafHash(mint, r.owner, r.rawAmount, multiplier)))

  return {
    mint, slot, blockTime, decimals: asset.decimals, multiplier,
    holders, excluded, sourcesAgree: true, supply: supplyReport, merkleRoot: root,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run`
Expected: PASS, all suites (4 tests in this file: the registry gate plus the three detector cases)

- [ ] **Step 5: Produce the golden fixture from a real mint**

Choose the smallest-supply stock mint, snapshot it at a real past record date, and verify it with the independent script.

```bash
node --input-type=module -e "
import { loadEnv } from './src/lib/env.js'
import { RpcClient } from './src/lib/rpc.js'
import { Registry } from './src/registry/store.js'
import { takeSnapshot } from './src/snapshot/index.js'
import { writeFileSync } from 'node:fs'

const env = loadEnv()
const rpc = new RpcClient(env.rpcUrl, { minIntervalMs: 700 })
const archiveRpc = new RpcClient(env.archiveRpcUrl, { minIntervalMs: 200 })
const registry = Registry.fromFile('fixtures/registry.sample.json')

// Pick the stock mint with the fewest transactions to keep the replay short.
const mint = process.env.FIXTURE_MINT ?? registry.stocks()[0].mint
const snap = await takeSnapshot({ rpc, archiveRpc, registry, mint, recordDate: '2026-09-01' })
writeFileSync('fixtures/snapshot.golden.json', JSON.stringify(snap, null, 2) + '\n')
console.log('holders:', snap.holders.length, 'agree:', snap.sourcesAgree, 'root:', snap.merkleRoot)
"
node scripts/verify-snapshot.mjs fixtures/snapshot.golden.json
```

Expected: the verifier prints `OK <n> holders, root <hex>` and exits 0.

If `sourcesAgree` is `false`, that is a real finding, not a test failure: inspect the named disagreements before proceeding. A likely cause is an archive RPC whose coverage does not reach the chosen slot.

- [ ] **Step 6: Commit**

```bash
git add src/snapshot/index.ts tests/snapshot/index.test.ts fixtures/snapshot.golden.json
git commit -m "feat: end-to-end snapshot with golden fixture from a real mint"
```

---

## Self-Review

**Spec coverage:**

| Spec requirement | Task |
|---|---|
| Canonical registry from Sunrise; reject spoofed mints | 2, 11 |
| Slot pinning at 17:00 America/New_York | 3 |
| `scaledUiAmount` multiplier read at the snapshot slot | 4 |
| Shares, not raw tokens | 4 |
| Exclude program-owned, pool, burn addresses | 5 |
| Two independent sources | 6, 7 |
| Refuse rather than publish when sources disagree | 8, 11 |
| Canonical domain-separated Merkle tree | 9 |
| Verifier sharing no code with the tallier | 10 |
| Real fixtures, no synthetic chain data | 2, 11 |
| Every number read from a source | 1 (zod at every boundary), 4, 6, 7 |

**Not in this plan, by design:** the EDGAR pipeline (Phase B), instruction collection and the canonical message format (Phase C), the Anchor attestation program (Phase D), the public site (Phase E). Phase A stops at a verified holder list.

**Known gaps to resolve during execution:**

1. **Archive RPC coverage is unverified.** Alchemy Account Archive is documented as answering any slot since July 2025, but this was not tested with a key during design. Task 7's first real run is the moment of truth. If coverage fails, the fallback is a second independent replay from a different provider's transaction history, which preserves rule 2 at higher cost.
2. **`getSignaturesForAddress` on a mint may miss plain `transfer` instructions** that do not name the mint in their account list. Task 6's golden fixture run will expose this: if the replayed total supply does not match `getTokenSupply` at that slot, enumeration is incomplete. The fix is to enumerate via the token accounts themselves or a provider's token-account-aware history endpoint.
3. **Test that the replayed set sums to total supply.** Add this assertion during Task 11 — it is the single strongest correctness check available and it catches gap 2 immediately.
