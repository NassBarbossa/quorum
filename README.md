# Quorum

The coordination layer for on-chain shareholders.

A quorum is the number of shares needed for a vote to count. Quorum is how retail holders
of tokenized equities reach one.

---

## The problem

Tokenized equities pass through the economics of ownership. They do not pass through the
vote. Robinhood Chain tokens are debt securities granting *"no legal or beneficial rights
in, or against the issuer of, those underlying securities"*. xStocks are bearer tracker
certificates. Backpack's on-chain token is a claim on an SPV.

Meanwhile the holder base is real: **850,000 unique on-chain tokenized-equity holders on
Solana**, which carries 95% of global on-chain equity volume.

Every issuer is a silo. Ondo serves Ondo, Kraken serves xStocks, Robinhood will serve RHJ.
A holder with Apple exposure across two issuers has two portals and one split voice.

Quorum is not another rail — Broadridge is already commoditizing that across every
tokenization model. It is the layer above them: **the only place where Apple is one ballot
regardless of who issued the token.**

## Phase A — the snapshot engine

Built. Given a canonical mint and a company's record date, it produces the holder list with
share weights that the whole product rests on.

```
record date ──> pinned slot (17:00 America/New_York)
                     │
    replay all transfers ──> holder set ──┐
                                          ├──> reconcile ──> refuse on any mismatch
    archive RPC, per balance ─────────────┘
                     │
    sum vs total supply ──────────────────────> refuse on any shortfall
                     │
    split multiplier at that slot ──> shares ──> Merkle root
```

Two detectors, and a root is published only if **both** pass. They catch different things:
`reconcile` catches a **wrong balance** and names the owner; the supply check catches a
**missing holder** at set level.

### Verifying a snapshot

```bash
node scripts/verify-snapshot.mjs snapshot.json
```

The verifier imports nothing from `src/`. It reimplements leaf hashing, tree building and
the share calculation from the specification in
[`docs/canonical-snapshot-construction.md`](docs/canonical-snapshot-construction.md), so a
bug in the producer cannot verify itself.

What that proves: the published rows hash to the published root, each row's `shares`
follows from its `rawAmount`, and nothing was added, removed, reordered or duplicated after
the root was fixed.

What it does not prove: that any balance matches the chain, that the multiplier was the one
in force, that the slot matches the record date, or that no holder is missing. Those need a
chain read the verifier does not yet do.

**So the claim is "recompute our published rows with code that shares nothing with ours",
not "independently verifiable".** The narrower one is the true one, and for a product whose
premise is that you should not have to trust us, under-claiming is the only safe direction.

## Running it

```bash
npm install
npx vitest run       # 83 tests
npx tsc --noEmit
```

`cp .env.example .env` and fill in an archive RPC endpoint that answers `getAccountInfo` at
a historical slot.

## State

Phase A is built and reviewed but **has never run against a real mint** — it is blocked on
an archive RPC key. Everything is tested against mocks.

Not built: the EDGAR ballot pipeline, instruction collection, the on-chain attestation
program, the public site.

## What this is not

- Not a proxy solicitation, and it carries no proxy authority. Users sign their own
  instructions; Quorum never accepts delegation of the right to vote.
- Not affiliated with any issuer, chain operator, or token issuer.
- Not custodial. It never holds a token or a key.

## Documentation

| | |
|---|---|
| [Design spec](docs/superpowers/specs/2026-09-21-quorum-design.md) | The binding authority — market data, competitive state, architecture, legal constraints |
| [Canonical construction](docs/canonical-snapshot-construction.md) | Normative. How to reproduce a root from a snapshot file |
| [Phase A plan](docs/superpowers/plans/2026-09-21-phase-a-snapshot-engine.md) | The eleven implementation tasks |
| [Decisions](docs/decisions/2026-09-21-phase-a-rulings.md) | Twenty calls made without asking, each with what it costs if wrong |
