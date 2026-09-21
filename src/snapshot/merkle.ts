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
