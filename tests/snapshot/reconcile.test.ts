import { describe, it, expect } from 'vitest'
import { reconcile } from '../../src/snapshot/reconcile.js'

describe('reconcile', () => {
  it('agrees when every replayed balance matches the archive', async () => {
    const replay = new Map([['alice', 1_000n], ['bob', 500n]])
    const archive = new Map([['alice', 1_000n], ['bob', 500n]])
    const out = await reconcile(replay, async o => archive.get(o) ?? null)
    expect(out.agree).toBe(true)
    if (out.agree) expect(out.holders.get('alice')).toBe(1_000n)
  })

  it('refuses when a balance differs, naming the owner and both values', async () => {
    const replay = new Map([['alice', 1_000n]])
    const archive = new Map([['alice', 999n]])
    const out = await reconcile(replay, async o => archive.get(o) ?? null)
    expect(out.agree).toBe(false)
    if (!out.agree) {
      expect(out.disagreements).toEqual([{ owner: 'alice', replay: '1000', archive: '999' }])
    }
  })

  it('refuses when the archive has no account for a replayed holder', async () => {
    const replay = new Map([['alice', 1_000n]])
    const out = await reconcile(replay, async () => null)
    expect(out.agree).toBe(false)
    if (!out.agree) expect(out.disagreements[0]!.archive).toBe('absent')
  })

  it('agrees on an empty holder set rather than throwing', async () => {
    const out = await reconcile(new Map(), async () => null)
    expect(out.agree).toBe(true)
  })
})
