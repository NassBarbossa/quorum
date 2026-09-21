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
