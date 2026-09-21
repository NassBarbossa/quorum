export type Disagreement = { owner: string; replay: string; archive: string }

export type ReconcileResult =
  | { agree: true; holders: Map<string, bigint> }
  | { agree: false; disagreements: Disagreement[] }

/**
 * Confirm every balance the replay produced against an independent read.
 * On any mismatch the result is a refusal with the specific owners named:
 * we do not pick a winner, and we do not publish a number we cannot stand behind.
 */
export async function reconcile(
  replay: Map<string, bigint>,
  lookup: (owner: string) => Promise<bigint | null>,
): Promise<ReconcileResult> {
  const disagreements: Disagreement[] = []
  for (const [owner, replayAmount] of replay) {
    const archiveAmount = await lookup(owner)
    if (archiveAmount === null) {
      disagreements.push({ owner, replay: replayAmount.toString(), archive: 'absent' })
      continue
    }
    if (archiveAmount !== replayAmount) {
      disagreements.push({ owner, replay: replayAmount.toString(), archive: archiveAmount.toString() })
    }
  }
  return disagreements.length === 0 ? { agree: true, holders: replay } : { agree: false, disagreements }
}
