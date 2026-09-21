import { createHash } from 'node:crypto'

const LEAF_PREFIX = Buffer.from([0x00])
const NODE_PREFIX = Buffer.from([0x01])
const COUNT_PREFIX = Buffer.from([0x02])

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

/**
 * Deterministic leaf order: lexicographic by owner address.
 *
 * Throws on a repeated owner. One wallet cannot hold two rows in a holder set —
 * such a set is malformed whatever it hashes to, and a duplicate row is exactly
 * how an attacker doubles a holder's weight. Refuse rather than sort it happily.
 */
export function sortLeaves<T extends { owner: string }>(rows: T[]): T[] {
  const seen = new Set<string>()
  for (const row of rows) {
    if (seen.has(row.owner)) {
      throw new Error(
        `Holder set contains ${row.owner} more than once. A holder appears exactly once ` +
        `in a snapshot; refusing to build a tree over a duplicated row.`
      )
    }
    seen.add(row.owner)
  }
  return [...rows].sort((a, b) => (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0))
}

/** Leaf count as 8 bytes big-endian, bound into the published root. */
function countBytes(leafCount: number): Buffer {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(BigInt(leafCount))
  return buf
}

export type Tree = {
  /**
   * The PUBLISHED root: SHA256(0x02 || leafCount(8, big-endian) || treeRoot).
   * Binding the count defeats leaf duplication. A classic Merkle tree that pairs a
   * lone odd node with itself gives [a,b,c] and [a,b,c,c] the SAME inner root, so an
   * attacker could duplicate the lexicographically-last holder's row, double that
   * holder's weight, and leave the root untouched. The counts differ, so the
   * published roots differ. scripts/verify-snapshot.mjs recomputes this same value.
   */
  root: string
  /**
   * The INNER tree root, over the leaves alone. Proofs are checked against this one,
   * never against `root`: proofFor()/verifyProof() walk the leaf layers only.
   */
  treeRoot: string
  layers: Buffer[][]
}

export function buildTree(leaves: Buffer[]): Tree {
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
  const treeRoot = layers[layers.length - 1]![0]!
  return {
    root: sha256(COUNT_PREFIX, countBytes(leaves.length), treeRoot).toString('hex'),
    treeRoot: treeRoot.toString('hex'),
    layers,
  }
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

/**
 * Check a proof against the INNER tree root (`Tree.treeRoot`), not the published
 * root. The published root wraps the inner one with the leaf count, which no proof
 * path reconstructs; a caller holding only a published root must first confirm the
 * leaf count and unwrap it.
 */
export function verifyProof(leaf: Buffer, proof: string[], treeRoot: string): boolean {
  let node = leaf
  for (const sibling of proof) {
    const sib = Buffer.from(sibling, 'hex')
    node = Buffer.compare(node, sib) <= 0
      ? sha256(NODE_PREFIX, node, sib)
      : sha256(NODE_PREFIX, sib, node)
  }
  return node.toString('hex') === treeRoot
}
