# CLAUDE.md — Quorum

Guidance for Claude working in this repository.

## What this is

Quorum answers one question in a way a sceptic can recheck: **given a tokenized-equity mint
and a company's record date, who held how many shares at that exact moment?**

Everything downstream — voting weights, tallies, an on-chain attestation — rests on that
answer. A wrong-but-plausible snapshot is the one failure this project cannot have. Read
that sentence again before changing anything in `src/snapshot/`.

## Commands

```bash
npm install
npx vitest run          # full suite
npx vitest run <path>   # one file
npx tsc --noEmit        # typecheck
node scripts/verify-snapshot.mjs <snapshot.json>
```

Node 20+, ESM only, TypeScript with `.js` extensions on relative imports (NodeNext).

## The three construction rules

These are quoted in code comments throughout and are not negotiable:

1. **Every number is read from a source, never stated.**
2. **The verifier shares no code with the thing it verifies.**
3. **Refuse to publish a zero you could not read.** Surface an error or `null`, never `0`
   and never `[]`.

## Hard invariants

- **`scripts/verify-snapshot.mjs` imports NOTHING from `src/`.** Not a helper, not a type,
  not a constant. If it imported the Merkle code, a bug there would verify itself and the
  output would be a tautology. The duplication is the point. Its test file may import from
  `src/` — it only builds fixtures and shells out to the script.
- **Weight is shares, never raw token amounts.** `shares = raw × multiplier ÷ 10^decimals`,
  all in `bigint`. A JS `number` loses precision above 2^53 and these values feed a Merkle
  leaf, where a one-digit difference is a verification failure.
- **Historical reads go through the archive client**, head reads through the standard one.
  Transaction and signature history counts as historical: a non-archival node does not
  retain it.
- **The canonical construction is specified in `docs/canonical-snapshot-construction.md`.**
  It is normative. If an implementation disagrees with it, the implementation is wrong.
  Change the document first, then both implementations, then the tests.

## Traps that have already bitten

Three silent corruptions reached `main` review and were caught only by an adversarial pass
that *executed* attacks rather than reasoning about code. Do not reintroduce them.

- **Leaf duplication.** A Merkle tree that pairs a lone odd node with itself gives
  `[a,b,c]` and `[a,b,c,c]` the same root. Leaves are sorted by owner, so duplicating the
  last holder's row doubled their weight invisibly. Defended two ways now: duplicate owners
  are rejected outright, and the published root binds the leaf count
  (`SHA256(0x02 ‖ count(8,BE) ‖ innerTreeRoot)`). Both implementations must match byte for
  byte, including that the inner root is fed as **raw bytes, not hex**.
- **The supply check does NOT detect a missing holder via a transfer.** An earlier comment
  in `index.ts` claimed it did. That is false: a missed transfer misattributes the sum, it
  does not change it. The supply check catches a missed **mint or burn**. The detector for
  a missing holder is the *sender's* wrong balance — which is `reconcile`. So `reconcile`
  must receive the **unfiltered** replay map; exclusions apply only when choosing what gets
  published.
- **A pinned read must prove its own slot.** Solana RPCs silently ignore unknown config
  fields, so an endpoint that does not support historical reads answers from head and says
  so only in its `context` block. `callHistorical` refuses on a slot mismatch *and* on a
  response carrying no readable context at all.

More generally: most defects in this codebase came from a plan that stated a premise
instead of testing it. Prefer a reproduced failure over an argued one.

## Layout

```
src/lib/          RPC client (retry, pacing, slot assertion), env loading
src/registry/     Canonical mints, synced from Sunrise. The gate against spoofed mints.
src/slot/         Record date -> pinned slot (17:00 America/New_York)
src/snapshot/     multiplier, shares, exclusions, merkle, reconcile, index (takeSnapshot)
src/snapshot/sources/   replay (primary, rebuilds the set) + archive (check, per balance)
scripts/          The standalone verifier
docs/             Spec, canonical construction, plans, decisions
```

## State

**Phase A is built and reviewed** — 83 tests, typecheck clean, on
`feat/phase-a-snapshot-engine`. It has never run against a real mint.

**Blocked on an archive RPC key.** `SOLANA_ARCHIVE_RPC_URL` is unset, so the golden fixture
was never produced, the slot assertion has never met a real provider, and
`historicalParam`'s shape is unconfirmed. Expect the first real run to surface something —
the enumeration gap below is the likeliest candidate.

**Known limitations, all loud rather than silent:**
- Signature enumeration from the mint address catches `transferChecked` but can miss a
  plain `transfer`. The supply check is the detector; it aborts rather than publishing.
- A reverse split gives a fractional multiplier, which is refused. That mint is
  unsnapshottable until an exact-rational path exists.
- The verifier recomputes published rows; it does not read the chain. It cannot detect a
  wrong balance, a wrong multiplier, a wrong slot, or a missing holder. **The honest claim
  is "recompute our published rows with code that shares nothing with ours", never
  "independently verifiable".** Do not widen it in any copy you write.

**Not built:** the EDGAR ballot pipeline, instruction collection, the Anchor attestation
program, the public site. Phases B through E in the spec.

## Reading order for a new session

1. `docs/superpowers/specs/2026-09-21-quorum-design.md` — the binding authority
2. `docs/canonical-snapshot-construction.md` — normative, for anything touching Merkle
3. `docs/decisions/2026-09-21-phase-a-rulings.md` — twenty calls made without asking, each
   with what it costs if wrong. Any of them can be reopened.
