# Phase A — decisions taken on the user's behalf

Recorded 2026-09-21, during the subagent-driven execution of
`docs/superpowers/plans/2026-09-21-phase-a-snapshot-engine.md`.

Every entry below is a call the controlling session made without stopping to ask, each
with what it costs if it turns out wrong. They are listed in the order they were made.
Anything here can be reopened; that is the point of writing them down.

Context worth keeping beside this list: **eleven per-task reviews all passed, and the
whole-branch review then found two reproducible silent corruptions** — a forged snapshot
the verifier accepted, and a published root missing a real holder. Both lived at the join
between modules that were individually correct. Most of the rulings below are me fixing my
own plan, not anyone's implementation.

1. Ruling: isolation by feature branch rather than a git worktree — fresh single-developer

2. Task 1: Ruling: minIntervalMs default 0 -> 700. The finding is real and load-bearing: Task 6 replays thousands of transactions and Task 5 loops owners in chunks, so relying on reactive backoff means eating a 429 on every run. 700ms is the value measured during design (batch failed, 700ms sequential succeeded across 55 mints). Paid endpoints pass a lower value explicitly, as Task 11's fixture script already does. Cost if wrong: slower runs against a fast endpoint, fixed by one constructor option.

3. Task 1: Ruling: retry must also cover a rejected fetch. Real fetch rejects on connection reset, DNS failure and timeout; as written those abort immediately with no retry, which would kill a multi-thousand-call replay on one blip. Treat a thrown fetch as retryable like a 429. Cost if wrong: an unreachable endpoint takes maxAttempts x backoff before failing instead of failing fast — the error still surfaces.

4. Task 1: Ruling: folding the Minor test-strengthening (JSON-RPC error test uses mockResolvedValue with no call-count assertion, so it cannot prove non-retry) into this same fix dispatch. It is one assertion in a file already being touched — this does not extend the loop, and leaving a test that cannot fail is worse than the process purity.

5. Task 3: Ruling: pinSlot had a silent-wrong-answer bug in my plan's reference code. blockTimeAtOrBelow walked only 200 slots below a probe before returning null, and a null made the binary search do low = mid + 1, discarding a whole region. Solana skips slots routinely and can skip hundreds consecutively during congestion or an outage, so a real answer sitting below a >200-slot gap was discarded and pinSlot returned a wrong but plausible slot with no error. Every weight in the snapshot hangs off this number, and the project's own rule is to refuse rather than guess. Fix: replace the fixed probe window with getBlocks over a window that widens until a block is found or the floor is reached, so null now genuinely means "no block in range". Cost if wrong: a few extra RPC calls per search on a chain with no gaps.

6. Task 3: Ruling: `best` initialised to `low` meant an unresolved search returned slot 0 as though it were an answer. Now starts null and throws. Cost if wrong: none — it only converts a silent wrong answer into a loud failure.

7. Task 3: Ruling: promoting the reviewer's Minor on RECORD_DATE_RE to a fix. The regex checks shape only, so "2026-13-45" passes and Date.UTC silently rolls it to 2027-02-14 — a slot pinned weeks from the date the filing named, wrong without being loud. That is the same failure class as the Critical just fixed in this very task, the fix is three lines, and Task 3 is the last cheap moment before the EDGAR pipeline starts feeding it dates it did not author. Cost if wrong: a valid date is rejected, which fails loudly and is trivially diagnosed. Deferring it would have been process purity over the project's own rule.

8. Task 4: Ruling: the vacuous test is a real Important and enters the loop. A test whose expected value holds under both branches is not a regression guard, and this one sits on the split-boundary logic — the exact thing that silently corrupts every weight after a split. Fix: make the two multipliers differ. Cost if wrong: none.

9. Task 4: Ruling: keeping the integer-multiplier restriction, but naming the cause in the error. A reverse split gives a fractional multiplier, the chain stores it as an f64 so 0.1 is not exactly representable at source, and Phase A has no exact-rational path. A wrong share count becomes a wrong Merkle leaf, so refusing beats approximating. Recorded as a known Phase A limitation: a mint that reverse-splits becomes unsnapshottable until a rational-arithmetic path exists. Cost if wrong: that mint blocks loudly rather than producing quiet nonsense, and the message now says why.

10. Task 5: Ruling: the Important is correct and enters the loop. The brief conflated two cases behind one branch — `null` means "no account at this slot", which is legitimately eligible, while `undefined` means the RPC returned fewer entries than were asked for. Treating the second as eligible would silently admit the untested tail, pool PDAs included, into the holder set. That is precisely the error classifyOwners exists to prevent, and it violates construction rule 3. Fix: separate the branches and throw on a short response. Cost if wrong: a malformed reply aborts the snapshot instead of quietly corrupting it.

11. Task 6: Ruling: same-slot ordering was inverted. getSignaturesForAddress returns newest first INCLUDING within a single slot, and Array.sort is stable, so sorting by slot alone preserved newest-first inside each slot. Because post-balances are absolute, the oldest transaction in a slot won and overwrote the newest — a wrong balance for any owner touched twice in the same slot. A Solana slot is ~400ms and holds many transactions, so this is ordinary traffic, not a corner case. The implementer confirmed it with a node repro. Fix: reverse before the stable sort. Cost if wrong: none — the reverse only affects ties, and the new test pins the behaviour.

12. Task 6: Ruling: added a pagination progress guard. The loop only terminated on an empty page, so an endpoint that ignored the "before" cursor would spin forever and the snapshot would never complete. Now it throws when a page repeats. Cost if wrong: a pathological endpoint fails loudly instead of hanging.

13. Task 8: Ruling: NOT promoting either minor. The two I promoted earlier (Task 3's calendar date, Task 4's vacuous test) were silent-wrong-answer risks in the same class as the Criticals beside them. These two are not: the aliasing is inert today and the coverage gap sits on behaviour the reviewer verified by reading. Promoting every minor would be me failing to run the process I am running. Both go to the final review's triage.

14. Task 10: Ruling: the mismatch test asserted only .toThrow(), so it passed for ANY crash, including the script not existing — the implementer's own report notes it passed that way before the script was written. Same vice as Task 4's vacuous test, on the one test that is supposed to prove the verifier detects tampering. Fix: assert exit status 1 and a FAIL message. Cost if wrong: none.

15. Task 10: Ruling: an empty holders array crashed with an uncaught 'empty leaf set' and a stack trace. It never printed a false OK, so it was not a correctness hole — but a verifier is the artefact a sceptic runs, and one that crashes reads as broken tooling rather than as a verdict on the file. Fix: a controlled refusal with a sentence. Cost if wrong: none.

16. Task 11: Ruling: correct the constant to 1_767_736_800 and keep the comment, which was right about the intent all along. Unlike the earlier plan defects this one fails loudly rather than silently — the tests throw instead of passing wrongly — so it was going to be found either way. It is still mine, and the implementer handled it exactly right by reproducing it with a scratch test and asking instead of patching around it. Cost if wrong: none; the value is now pinned to the same function the production path uses.

17. Ruling: the public claim is now "recomputes our published rows with code that shares nothing with ours", NOT "independently verifiable", until spec §11's weight check exists. C1 is direct evidence for this: both implementations shared the odd-node duplication behaviour, so their agreement caught nothing. Cost if wrong: we under-claim, which is the safe direction for a product whose entire pitch is not trusting us.

18. Ruling: getBlockTime at index.ts:39 moves to archiveRpc. Reading a PAST slot's block time is a historical read and a non-archival node does not retain it; leaving it would pass every mocked test and fail on the first real run. Cost if wrong: one extra archive call.

19. Ruling: npm audit 9 -> 5 residual is carried, not chased. The five are dev-only, in the vitest/vite/esbuild chain — they never ship and never touch a snapshot. A major vitest bump at the end of a fix wave would churn the very harness holding the correctness evidence. Cost if wrong: dev-chain advisories persist in a private repo.

20. Ruling: NOT carrying the C3 residual to the user as a leftover. The assertion reads `if (ctx.success && …)`, so a response with no context block passes silently — head state included. All four pinned methods always return a context, so its absence is a signal, not a normal case, and letting it through reopens the exact failure C3 closes by another door. The skill says residual load-bearing findings surface rather than triggering a second wave; this one is load-bearing AND a one-line fix I already hold, so ruling on it is the honest reading of "rule on the load-bearing ones". Dispatched, and I verify it myself rather than spending another review round. Cost if wrong: one extra commit.
