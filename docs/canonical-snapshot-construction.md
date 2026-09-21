# Canonical Snapshot Construction

**Version 1 — 2026-09-21**

This document specifies exactly how a Quorum snapshot's Merkle root is computed, so that
anyone can reproduce it from the published snapshot file alone, using their own code.

It is normative. `src/snapshot/merkle.ts` and `scripts/verify-snapshot.mjs` are two
implementations of it; if either disagrees with this document, the implementation is wrong.

---

## 1. What a snapshot file contains

```json
{
  "mint": "<base58 mint address>",
  "slot": 449028273,
  "blockTime": 1700000000,
  "decimals": 6,
  "multiplier": 1,
  "holders": [
    { "owner": "<base58 address>", "rawAmount": "12480000", "shares": "12.480000" }
  ],
  "excluded": [ { "address": "<base58>", "reason": "program-owned" } ],
  "sourcesAgree": true,
  "supply": { "expected": "…", "replayed": "…", "matches": true },
  "merkleRoot": "<64 hex chars>"
}
```

A root is published **only** when `sourcesAgree` is `true` **and** `supply.matches` is
`true`. When either is false, `merkleRoot` is `null` and `holders` is `null`. A file with a
non-null root and either flag false is malformed; reject it.

## 2. Share counts

For each holder:

```
shares = rawAmount × multiplier ÷ 10^decimals
```

All arithmetic in arbitrary-precision integers. A 64-bit float loses precision above 2^53
and these values are published, so a rounding difference is a mismatch, not a nicety.

Rendered with **exactly `decimals` fractional digits**, zero-padded, no thousands
separators, always a leading integer digit (`0.001000`, never `.001000`).

`multiplier` must be an integer ≥ 1. A fractional multiplier means the mint has had a
reverse split, which this version does not support; refuse rather than approximate.

## 3. Leaf ordering

Holders are sorted by `owner`, ascending, comparing the base58 strings by Unicode code
point. Base58 is ASCII, so this equals byte order.

**Duplicate owners are forbidden.** A holder set containing the same owner twice is
malformed; refuse before hashing.

## 4. Leaf hash

```
leaf = SHA256( 0x00 ‖ mint ‖ 0x1f ‖ owner ‖ 0x1f ‖ rawAmount ‖ 0x1f ‖ multiplier )
```

- `0x00` is a one-byte domain prefix marking a leaf. It stops a leaf being replayed as an
  internal node, the classic second-preimage attack on a naive Merkle tree.
- `0x1f` is the ASCII unit separator, placed between each adjacent pair of fields — three
  separators for four fields. Without it, `("ab","c")` and `("a","bc")` hash identically
  and two different holder records could collide.
- `mint`, `owner` and `rawAmount` are their **UTF-8 bytes as they appear in the file**:
  base58 for addresses, a decimal string for the amount. No base58 decoding, no numeric
  conversion.
- `multiplier` is its **decimal representation in UTF-8** — the integer `1` contributes the
  single byte `0x31`, not a numeric encoding.

## 5. Internal nodes

Build upward from the sorted leaves. At each level, take nodes in pairs, left to right:

```
node = SHA256( 0x01 ‖ min(a,b) ‖ max(a,b) )
```

where `min`/`max` compare the two 32-byte digests as unsigned byte strings. Ordering each
pair by value means a proof carries no left/right position flags, which keeps on-chain
verification cheap.

If a level has an odd number of nodes, **the last node is paired with itself**.

Repeat until one node remains. Call it the **inner tree root**.

## 6. The published root

```
publishedRoot = SHA256( 0x02 ‖ leafCount ‖ innerTreeRoot )
```

- `0x02` is a one-byte domain prefix marking the count commitment.
- `leafCount` is the number of leaves as an **unsigned 64-bit big-endian integer**, eight
  bytes.
- `innerTreeRoot` is the **raw 32 bytes**, not its hex text.

The result is rendered as 64 lowercase hex characters. This is the value in `merkleRoot`.

**Why the count is bound in.** Pairing a lone odd node with itself gives `[a,b,c]` and
`[a,b,c,c]` the same inner tree root. Because leaves are sorted by owner, an attacker could
append a duplicate of the lexicographically-last holder's row, doubling that holder's
weight, and leave the root untouched. The counts differ, so the published roots differ.
This was a real defect in version 0 of this construction, found by adversarial review and
reproduced against the code; the rule in §3 forbidding duplicate owners is the direct
defence, and the count binding is the belt to its braces.

## 7. Proofs

`proofFor` / `verifyProof` operate on the **inner tree root**, never the published root.
A proof demonstrates membership in the tree; the published root additionally commits to
how many leaves that tree had.

## 8. What verifying this proves — and what it does not

Recomputing the published root from a snapshot file proves:

- the rows in the file hash to the root the file claims;
- each row's `shares` follows from its `rawAmount`, and the file's `multiplier` and
  `decimals`;
- no row was added, removed, reordered or duplicated after the root was fixed.

It does **not** prove:

- that any `rawAmount` matches what the wallet actually held on chain;
- that `multiplier` was the one in force at `slot`;
- that `slot` corresponds to the record date the ballot names;
- that no holder is missing from the set.

Those require reading the chain at `slot`, which the verifier script does not do in this
version. Until it does, the honest claim is **"you can recompute our published rows with
code that shares nothing with ours"** — not "independently verifiable". The narrower claim
is the true one, and for a product whose premise is that you should not have to trust us,
under-claiming is the only safe direction.

## 9. Reference implementations

- `src/snapshot/merkle.ts` — used to produce snapshots.
- `scripts/verify-snapshot.mjs` — used to check them. Imports nothing from `src/`, so a bug
  in the producer cannot verify itself.

Both are transcriptions of this document rather than independent derivations from it. A
shared misreading of this specification would therefore go undetected by their agreement —
which is precisely how the version 0 duplication flaw survived until adversarial review.
A third implementation written from this document alone, by someone who has not read ours,
is worth more than either of them.
