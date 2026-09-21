# Quorum — Design Spec

**Date:** 2026-09-21
**Status:** Approved design, pending implementation plan
**Author:** Nass, with Claude

---

## 1. What Quorum is

Quorum collects **signed, weighted, verifiable voting instructions** from holders of tokenized equities on Solana, publishes them as a public record, attests the tally on-chain, and hands the result to whichever rail can carry it to the company's meeting.

One line: *a quorum is the number of shares needed for a vote to count. Quorum is how retail holders of tokenized equities reach one.*

## 2. The problem

Tokenized equities pass through the economics of ownership. They do not pass through the vote.

- **Robinhood Chain (RHJ)** tokens are tokenised debt securities that explicitly grant *"no legal or beneficial rights in, or against the issuer of, those underlying securities."*
- **xStocks (Backed Assets JE Ltd)** are bearer tracker certificates; redemption is qualified-investors-only.
- **Backpack Securities** tokens are a *"claim on SPV holding the underlying assets"*; the brokerage-account form is a UCC Art. 8 security entitlement, but the on-chain token is not.

Meanwhile the holder base is real and large (measured 2026-09-21, see §3).

## 3. Market state as measured

Measured directly from `api.sunrise.xyz/v1/tokens`, Solana RPC (`getTokenSupply`, `getAccountInfo`), and Jupiter price/search APIs.

### Backpack Securities — complete universe

| Metric | Value |
|---|---|
| Stock tokens | 55 (+1 commodity) |
| On-chain value | **$30.5M** |
| DEX liquidity (pool TVL) | $12.7M |
| Token program | Token-2022, all |

Top: SPCX $6.56M · MU $6.14M · SKHY $2.36M · SNDK $2.12M · BOT $1.74M.

### xStocks — top 20 by market cap (search API caps at 20; 130+ exist)

| Metric | Value |
|---|---|
| On-chain value (top 20) | **$1.065B** (floor, not total) |
| DEX liquidity (top 20) | $28.2M |

Top: SPCXx $86.4M · TSLAx $84.8M · MSTRx $79.2M · CRCLx $78.8M · HOODx $74.2M · SPYx $73.5M · NVDAx $72.1M.

### Holder counts (positions, not unique wallets)

NVDAx 95,587 · SPYx 72,611 · TSLAx 38,956 · QQQx 38,352 · Backpack SPCX 34,306 · AAPLx 33,374.
~535,000 positions across top-20 xStocks; ~151,000 across top-20 Backpack.

Ecosystem context: 850,000 unique on-chain tokenized-equity holders on Solana (ATH); Solana = 95% of global on-chain equity volume; $5.8B tokenized asset volume in Q2 2026 (+114% QoQ).

## 4. Competitive state — why Quorum is not a rail

The gap is closing, from the top:

| Date | Event |
|---|---|
| 2026-04-28 | **Ondo + Broadridge** launch wallet-native proxy voting: 250+ tokenized stocks/ETFs, ~$700M AUM, Solana/Ethereum/BNB. Ondo ≈70% market share. |
| 2026-05-05 | **Broadridge** extends proxy voting to *third-party custodied* tokenized securities — now covering all three SEC-outlined tokenization models. No public integration criteria. |
| 2026-08 | **Kraken/Payward + Backed** add proxy voting for eligible xStocks holders via Broadridge, using contractual beneficiary instruction rights under Jersey law (Companies (Jersey) Law 1991, Trusts (Jersey) Law 1984) — no US securities registration triggered. |
| 2026-09-14 | **Robinhood** states 1:1 in-kind redemption is in progress and voting is on the roadmap, via *Say by Robinhood*. |
| 2026-09-17 | **SEC Innovation Exemption**: two five-year conditional exemptions for tokenized NMS stock trading (expires 2031-09-17). To qualify, a tokenized stock must carry the *same rights as the traditional share class, including voting*. |

**Conclusion.** Broadridge is commoditizing the rail across every tokenization model. Building a competing rail is building a bridge beside a bridge. Voting rights are becoming a compliance checkbox, not a differentiator.

**What remains open:** every issuer is a silo. Ondo serves Ondo, Kraken serves xStocks, Robinhood will serve RHJ, Backpack will serve Backpack. A holder with Apple exposure across two issuers has two portals and one split voice. And retail votes only ~30% of its shares vs 80%+ for institutions.

**Quorum's position:** not the rail — the **coordination layer above every rail**. The only place where Apple is one ballot regardless of who issued the token.

## 5. Scope — v1

**In:**
- All tokenized equities on Solana, listed via the Sunrise canonical registry (all issuers).
- Instruction collection, weighting, publication, on-chain attestation, per-holder receipts.
- Per-ticker execution-eligibility labelling (executable vs record-only).

**Out (explicitly):**
- **No custody.** Quorum never holds a token or a key.
- **No proxy authority.** Quorum never accepts delegation of the right to vote. See §10.
- **No DeFi position attribution.** Tokens held by a pool or lending protocol are not attributed back to depositors. The wallet holding at the snapshot is the holder — which matches the TradFi convention that a lender of shares loses the vote. Attribution would risk double-counting the same shares (depositor + borrower).
- **No rail.** We submit to existing rails; we do not build custody or tabulation.

## 6. Three construction rules

These are load-bearing and apply everywhere:

1. **Every number is read from a source, never stated.**
2. **The verifier shares no code with the thing it verifies.**
3. **We refuse to publish a zero we could not read.** Display "unreadable", never `0`.

## 7. Architecture

### Components

1. **Asset registry** — canonical mints, issuer, token program, decimals, linked stock (ticker/MIC/currency), execution status. Synced from Sunrise `GET /v1/tokens`. *The mint is the only key of trust:* 35 of 55 "xStock" search results on Jupiter are spoofed mints with 1–28 holders and zero market cap. Anything not in the canonical registry is rejected.
2. **EDGAR pipeline** — DEF 14A → structured ballot. See §9.
3. **Snapshot engine** — holder set and weights at a pinned slot. Two independent sources.
4. **Instruction collection** — canonical message, wallet signature, gasless.
5. **Tally + attestation** — Merkle roots written to an Anchor program.
6. **Submission** — handoff to the applicable rail. Out of code scope for v1; the data model carries execution status from day one.
7. **Public site** — ballots, receipts, verification tools, transparency.

### Flow

```
EDGAR DEF 14A ──> extraction ──> human review ──> Ballot
                                                    │
Sunrise registry ──> Asset registry ────────────────┤
                                                    ▼
                                            slot pinned
                                                    │
      indexer (transfer replay) ──> holders + balances
                                                    │
                               corporate-action multiplier
                                                    ▼
                                           weights published
                                                    │
       wallet signMessage (ed25519, free) ──> instructions
                                                    ▼
                                    close ──> tally + Merkle roots
                                                    │
                                    Anchor attestation program
                                                    │
                            [if eligible] ──> rail submission
```

### Snapshot sourcing

Standard Solana RPC has no historical state. Two independent paths, required to agree:

- **Primary:** in-house indexer replaying all transfers for the mint from creation, reconstructing state at any slot.
- **Check:** archive RPC (`getAccountInfo` at slot) for individual balances. Alchemy Account Archive answers any slot since July 2025 with parsed token accounts; Helius `getTransactionsForAddress` with `tokenAccounts` filter for replay.

If they disagree, `sources_agree = false` and nothing is published.

**Exclusions:** pool PDAs, program-owned accounts, burn addresses — excluded from the holder set with the reason displayed, so the participation denominator is honest.

### Slot pinning convention

> The last Solana slot whose `block_time` is at or before **17:00:00 `America/New_York`** on the record date.

17:00 local is the convention, fixed and published, because "close of business" is stated in filings without a time and transfer agents treat it as end of business day rather than market close. Resolved per-ballot in local time rather than fixed in UTC, because US daylight saving shifts it by an hour twice a year — a fixed UTC convention would pin the wrong slot for half the year. The resolved instant and the slot are both printed on every ballot.

### Voting window

The record date is set by the company, typically 30–60 days before the meeting (Delaware DGCL §213: no more than 60, no fewer than 10 days). The voting window is ours to choose inside that gap.

**Default: 10 days, closing at least 5 days before the meeting.**

```
Jan 6    RECORD DATE            (company sets this; balances frozen here)
Feb 10   voting opens
Feb 20   voting closes          → tally, attestation, submission
Feb 25   MEETING
```

The closing margin is not cosmetic: the tally has to be computed, written on-chain, and delivered before the carrying rail's submission cutoff. A window that closes on the meeting date misses that cutoff, and the ballot silently degrades from executable to record-only.

## 8. Data model and signature format

### Canonical message

Solana has no EIP-712. Borsh+hash is deterministic but shows the user an opaque blob — disqualifying for a voting product. SIWS is an authentication primitive, not typed data. **We use a canonical human-readable text message:** the user reads exactly what they sign.

```
Quorum Voting Instruction

I instruct that my position be voted as set out below.

Ballot: aapl-2027-01-14-agm
Company: Apple Inc. (AAPL)
Meeting: 2027-01-14
Record date: 2026-11-20
Snapshot: Solana slot 451203887

Proposals:
1. Election of Director: Arthur D. Levinson — FOR
2. Election of Director: Tim Cook — WITHHOLD
3. Ratification of Ernst & Young LLP — FOR
4. Advisory vote on executive compensation — AGAINST

Wallet: 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU
Weight: 12.480000 shares
Document: sha256:9f2a...6210
Domain: quorum.vote
Nonce: 0194a3f2-7c11-7b3e-9d44-1f8e2a5c9013
Issued at: 2026-11-22T14:03:11Z

This is a voting instruction, not a legal proxy.
```

**Canonicality rules** (published as spec — this is what makes third-party verification possible):

- fixed field order; `Key: value` with exactly one space; no alignment padding
- `\n` line endings only, never `\r\n`; no trailing whitespace
- UTF-8, NFC-normalised
- weight rendered with exactly the token's decimals, no thousands separators
- dates ISO 8601 UTC with `Z`
- choices uppercase
- `Document` is the SHA-256 of the canonical ballot document — **this binds the short message to the long content**; changing a proposal's text invalidates every signature

Signature: ed25519 over the UTF-8 bytes. Verification is three lines and needs nothing from us:

```js
nacl.sign.detached.verify(new TextEncoder().encode(message), sig, pubkey)
```

### Entities

**Asset** — `mint` · `symbol` · `issuer` · `token_program` · `decimals` · `linked_stock {ticker, mic, currency}` · `execution_status`

**Ballot** — `ballot_id` · `company {name, cik, ticker}` · `asset_refs[]` · `meeting_date` · `record_date` · `snapshot_slot` · `source {edgar_accession, filing_url, doc_sha256, retrieved_at}` · `review {reviewer, reviewed_at}` · `opens_at` · `closes_at` · `execution_status` · `proposals[]`

**Proposal** — `index` · `reference` (as printed) · `text` (verbatim) · `choices[]` · `board_recommendation`

**Snapshot** — `slot` · `block_time` · per mint `{multiplier_at_slot, holders[{owner, raw_amount, shares}]}` · `excluded[{address, reason}]` · `merkle_root` · `sources_agree`

**Instruction** — `ballot_id` · `wallet` · `choices[]` · `weight_shares` · `message` · `signature` · `received_at` · `status`

**Tally** — per proposal `{for, against, abstain}` in shares · `eligible_supply` · `participating_shares` · `participation_rate`

**Attestation** — on-chain PDA, write-once

**Receipt** — message · signature · leaf index · Merkle path · PDA address

### Five modelling decisions

1. **A company is not a mint.** Apple exists as AAPLx (Backed) *and* as a Backpack token. A ballot aggregates **all mints representing the same underlying company** — hence `asset_refs[]`. This is what makes the cross-issuer position operational rather than rhetorical.
2. **Choices are per proposal, never global.** See §9 for the four distinct choice sets that occur in real filings.
3. **Human review is in the schema.** A ballot without `review.reviewed_at` cannot open.
4. **Weight is shares, not tokens.** `raw × multiplier ÷ 10^decimals`, with the Token-2022 `scaledUiAmountConfig` multiplier **read at the snapshot slot**. Backpack handles stock splits by changing this multiplier, not by rebasing balances — reading today's multiplier would produce wrong weights after any split.
5. **Two sources must agree** before publication; `sources_agree` is a visible field.

## 9. EDGAR pipeline

### Reuse decisions

**Use:** EDGAR Full-Text Search (`efts.sec.gov`) — free, no API key, filterable by form type and CIK; requires a `User-Agent` with a contact name and email (address TBD). `data.sec.gov` + `company_tickers.json` for ticker→CIK. **EdgarTools** (`dgunning/edgartools`) for access and filing navigation.

**Build:** proposal extraction. EdgarTools states plainly that *"board composition, director details, and shareholder proposals live in the HTML body of the filing and are not yet extracted into structured properties."* ISS, Glass Lewis and Broadridge do this in-house and do not publish it. This is the moat.

### Stages

1. **Discovery** — daily EFTS poll on `DEF 14A`, filtered to CIKs present in the asset registry.
2. **Fetch & normalise** — primary document, flattened to text with structure preserved; raw file and its hash stored as the provenance anchor.
3. **Extraction (LLM-assisted)** — **every extracted field carries the verbatim span it came from and its character offset in the source. If the model cannot point at the text, the field is `null`, never guessed.**
4. **Deterministic validation (no LLM)** — `record_date < meeting_date`; ≥2 choices per proposal; contiguous numbering; board recommendation present; **cited spans exist at the stated offsets** (catches hallucinated citations).
5. **Human review gate** — extracted structure beside highlighted source spans; approve or correct; reviewer identity and timestamp recorded.
6. **Publication** — accession number, filing URL and document hash printed on the ballot page.
7. **Amendment watch** — see below.

### Real choice sets

| Proposal type | Choices | Trap |
|---|---|---|
| Director election | FOR / WITHHOLD (plurality) or FOR / AGAINST / ABSTAIN (majority) | **N directors = N separate votes.** One "Proposal 1" can contain 12 votes. The filing states the regime. |
| Auditor ratification | FOR / AGAINST / ABSTAIN | standard |
| Say-on-pay | FOR / AGAINST / ABSTAIN | standard |
| **Say-on-pay frequency** | **1 YEAR / 2 YEARS / 3 YEARS / ABSTAIN** | Four choices, none of them for/against. Breaks any ternary assumption. |
| Shareholder proposal | FOR / AGAINST / ABSTAIN | board usually recommends AGAINST — display it |

### Amendments

DEFA14A (additional materials) and DEFR14A (revised) can move a meeting, add or withdraw a proposal.

The signature binds `Document: sha256:…`, so a changed document **mechanically breaks the binding** — correct behaviour, but it must be handled explicitly:

- amendment watch runs until the meeting date
- on a material change after collection opens: the ballot is flagged; instructions already signed remain valid **for the version they signed**; signers are invited to re-sign the new version
- **a ballot that people have signed is never silently changed**

## 10. Legal constraints

### Rule 14a — the architectural constraint

Rule 14a-1(l) defines *solicit* as any communication reasonably calculated to result in the procurement of a proxy. Rule 14a-3 requires a publicly filed proxy statement, furnished concurrently, with Schedule 14A filed before solicitation and preliminary copies 10 days ahead.

**Therefore: Quorum never accepts delegation of voting authority.** Taking a proxy would forfeit the Rule 14a-2(b)(1) exemption (which is precisely for persons *not* seeking proxy authority) and make Quorum a full proxy solicitor filing per company, per meeting.

**Instead:** the user signs their own instruction. Quorum computes weight, publishes, attests, and hands off. It never votes on anyone's behalf; it makes their own vote possible. This is also the Flex Voting shape (a pool splits its vote to match what its depositors said) and it is why OnRecord insists on *"instruction, not proxy"* — that is a regulatory architecture, not modesty.

### Token separation

If a token is ever issued: the **entity operating the voting registry must be separate from the entity issuing the token**, and the token's value must track **volume of participation, never outcomes**. A financial interest in how a vote resolves is the fact pattern that turns a neutral utility into an interested solicitor.

Counsel review is required before any organised-bloc feature ships. Organising a voting bloc sits much closer to solicitation than passively publishing a record.

### Disclosure

Every ballot page states, in the body and not in small print:

- Quorum is not a proxy solicitation and carries no proxy authority
- Quorum is not affiliated with any issuer, chain operator or token issuer
- Quorum cannot compel any company to count anything
- Whether this ballot is *executable* or *record-only*

## 11. Attestation and verification

### Anchor program

One PDA per ballot, `seeds = ["ballot", ballot_id_hash]`:

```rust
pub struct BallotAttestation {
    pub ballot_id_hash:   [u8; 32],
    pub snapshot_slot:    u64,
    pub snapshot_root:    [u8; 32],
    pub instruction_root: [u8; 32],
    pub tally_digest:     [u8; 32],
    pub closed_at:        i64,
    pub authority:        Pubkey,
    pub version:          u8,
}
```

A single `attest` instruction that fails if the PDA is already initialised. **No update, no close, no admin function.** The authority can create, never rewrite.

### Two Merkle trees

- **Snapshot tree** — leaves `hash(mint, owner, raw_amount, multiplier)`. Proves eligibility.
- **Instruction tree** — leaves `hash(canonical_message, signature)`. Proves inclusion in the tally.

Separating them lets a holder prove eligibility without revealing their vote, and prove inclusion without re-deriving the snapshot.

**Canonical construction:** fully specified in [docs/canonical-snapshot-construction.md](../../canonical-snapshot-construction.md) — domain-separated prefixes (`0x00` leaf, `0x01` internal node, `0x02` count commitment), a `0x1f` unit separator between leaf fields, leaves sorted by owner with duplicates forbidden, each pair hashed in byte order, and the published root binding the leaf count as `SHA256(0x02 ‖ count(8, big-endian) ‖ innerTreeRoot)`. SHA-256 throughout, syscall-available on Solana.

The count binding is not decoration. Pairing a lone odd node with itself gives `[a,b,c]` and `[a,b,c,c]` the same inner root, so duplicating the lexicographically-last holder's row would double that holder's weight and leave the root untouched. Adversarial review found and reproduced this; §3 of that document forbids duplicate owners as the direct defence.

### Verification path

Three checks, all doable by a third party with no access to us:

| Check | How | Proves |
|---|---|---|
| Signature | ed25519 verify over UTF-8 message bytes | the wallet said this |
| Weight | balance at `snapshot_slot` from archive RPC × multiplier at that slot | the weight is right |
| Inclusion | recompute Merkle path, compare to on-chain root | it was counted |

Plus an independent recomputation script that rebuilds the whole tally from published data and **shares no code with the component that computed it**.

### What attestation does not prove

Stated on the page, not in small print:

> It proves a given tally existed at a given time and has not changed since. **It does not prove the issuer counted anything.**

And a second limit, narrower than the first and easier to overclaim. The verifier recomputes the published rows; it does not read the chain. So it cannot detect a wrong balance, a wrong multiplier, a wrong slot, or a missing holder. Until the weight check in the verification table is actually implemented, the claim we make in public is **"recompute our published rows with code that shares nothing with ours"**, never "independently verifiable". Both reference implementations are transcriptions of the same specification rather than independent derivations, so their agreement does not catch a shared misreading of it — which is exactly how the leaf-duplication flaw survived eleven reviews.

### Failure modes

- **Sources disagree** → no publication, status "unreadable", never a number.
- **Attestation transaction fails** → ballot stays `closing` and retries. Never marked closed without an on-chain root.
- **Confidential transfers enabled on a mint** → that mint becomes unsnapshotable; ballot marked record-only with the reason displayed.

### Tests

- **Property:** for any random holder set, recomputed root == published root.
- **Golden fixtures:** real mints, real slots, real values, committed.
- **Adversarial:** tampered message fails signature; reordered leaves produce a different root; duplicate wallet rejected.

## 12. Known Token-2022 surface (Backpack mints, verified on-chain)

Extensions active on Backpack Securities mints:

| Extension | Implication |
|---|---|
| `scaledUiAmountConfig` | **Corporate-action mechanism.** Splits change the multiplier, not balances. Must be read at the snapshot slot. |
| `permanentDelegate` | Issuer can move any token from any account unilaterally (clawback). |
| `pausableConfig` | Issuer can pause all transfers. |
| `freezeAuthority` | Issuer can freeze an individual account. |
| `transferHook` | Slot reserved, `programId = None` — inactive but activatable. |
| `confidentialTransferMint` | Present, auto-approve off. **If ever enabled, balances become unreadable and the snapshot model breaks for that mint.** |

## 13. Open questions

- Broadridge's integration criteria for the third-party-custodied model — not public; resolved by contact, not research.
- Backpack's voting timeline — docs say "not enabled yet", no date.
- Complete xStocks universe (130+ tokens); the Jupiter search API caps at 20.
- Contact email for the SEC `User-Agent` header.
- Whether a Solana equivalent of Flex Voting exists (none found — possible contribution).

## 14. Sequencing

1. Ship the permissionless record layer fast — weeks, not months — to be in market while the narrative is hot.
2. Run the Backpack and Broadridge conversations **in parallel**, not as phase 2. A rail conversation goes better with real signed instructions from real holders than with a deck.
3. Revenue follows the only model that has survived in this category: **the user never pays; issuers and companies pay.** Snapshot charges DAOs for Pro; Broadridge and Say charge issuers per event; Tally charged nothing and shut down in March 2026.
