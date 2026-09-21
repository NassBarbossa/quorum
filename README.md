# Quorum

The coordination layer for on-chain shareholders.

Quorum collects signed, weighted, verifiable voting instructions from holders of
tokenized equities on Solana, publishes them as a public record, attests the tally
on-chain, and hands the result to whichever rail can carry it to the company's meeting.

A quorum is the number of shares needed for a vote to count.
Quorum is how retail holders of tokenized equities reach one.

## Status

Design approved, implementation not started.

- [Design spec](docs/superpowers/specs/2026-09-21-quorum-design.md)

## What it is not

- Not a proxy solicitation, and it carries no proxy authority.
- Not affiliated with any issuer, chain operator, or token issuer.
- Not custodial. It never holds a token or a key.
