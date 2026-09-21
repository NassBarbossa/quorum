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

  it('exits non-zero when the published root is wrong', () => {
    const path = writeSnapshot('0'.repeat(64))
    expect(() => execFileSync('node', ['scripts/verify-snapshot.mjs', path], { encoding: 'utf8' }))
      .toThrow()
  })
})
