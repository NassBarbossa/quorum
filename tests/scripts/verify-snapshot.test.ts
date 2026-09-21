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

/** Write an arbitrary snapshot object and run the verifier over it. */
function runOn(snapshot: unknown): { status: number | undefined; stderr: string } {
  const dir = mkdtempSync(join(tmpdir(), 'quorum-'))
  const path = join(dir, 'snapshot.json')
  writeFileSync(path, JSON.stringify(snapshot, null, 2))
  try {
    execFileSync('node', ['scripts/verify-snapshot.mjs', path], { encoding: 'utf8', stdio: 'pipe' })
    return { status: 0, stderr: '' }
  } catch (err) {
    const e = err as { status?: number; stderr?: string }
    return { status: e.status, stderr: e.stderr ?? '' }
  }
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

  it('refuses a holder set that names the same owner twice', () => {
    // The duplication attack: bob is the lexicographically-last holder, so appending
    // a copy of his row doubles his weight. The verifier must refuse before hashing,
    // naming him — and the count-bound root would catch it even if it did not.
    const { status, stderr } = runOn({
      mint: MINT, slot: 100, blockTime: 1_700_000_000, decimals: 6, multiplier: 1,
      holders: [
        { owner: 'alice', rawAmount: '1000', shares: '0.001000' },
        { owner: 'bob', rawAmount: '500', shares: '0.000500' },
        { owner: 'bob', rawAmount: '500', shares: '0.000500' },
      ],
      excluded: [], sourcesAgree: true, merkleRoot: realRoot(),
    })
    expect(status).toBe(1)
    expect(stderr).toMatch(/more than once/i)
    expect(stderr).toMatch(/bob/)
  })

  it('refuses a snapshot whose replayed balances do not sum to total supply', () => {
    // The arithmetic over the published rows is sound, so the root recomputes fine
    // and the verifier used to print OK. A holder is missing from the set: the rows
    // are not wrong, they are incomplete, and that is still not verified.
    const { status, stderr } = runOn({
      mint: MINT, slot: 100, blockTime: 1_700_000_000, decimals: 6, multiplier: 1,
      holders: [
        { owner: 'alice', rawAmount: '1000', shares: '0.001000' },
        { owner: 'bob', rawAmount: '500', shares: '0.000500' },
      ],
      excluded: [], sourcesAgree: true,
      supply: { expected: '5000', replayed: '1500', matches: false },
      merkleRoot: realRoot(),
    })
    expect(status).toBe(1)
    expect(stderr).toMatch(/REFUSED/)
    expect(stderr).toMatch(/1500.*5000|5000.*1500/s)
  })

  it('refuses a snapshot with no merkleRoot rather than comparing against null', () => {
    const { status, stderr } = runOn({
      mint: MINT, slot: 100, blockTime: 1_700_000_000, decimals: 6, multiplier: 1,
      holders: [{ owner: 'alice', rawAmount: '1000', shares: '0.001000' }],
      excluded: [], sourcesAgree: true, merkleRoot: null,
    })
    expect(status).toBe(1)
    expect(stderr).toMatch(/no merkleRoot/i)
  })

  it('refuses a fractional multiplier with a sentence, not a RangeError', () => {
    const { status, stderr } = runOn({
      mint: MINT, slot: 100, blockTime: 1_700_000_000, decimals: 6, multiplier: 0.1,
      holders: [{ owner: 'alice', rawAmount: '1000', shares: '0.000100' }],
      excluded: [], sourcesAgree: true, merkleRoot: '0'.repeat(64),
    })
    expect(status).toBe(1)
    expect(stderr).toMatch(/integer of at least 1/i)
    expect(stderr).toMatch(/reverse split/i)
    expect(stderr).not.toMatch(/RangeError|at Object|at Module/)
  })
})
