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
