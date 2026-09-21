import { readFileSync, writeFileSync } from 'node:fs'
import type { Asset } from './types.js'

export class Registry {
  private readonly byMint: Map<string, Asset>

  constructor(private readonly assets: Asset[]) {
    this.byMint = new Map(assets.map(a => [a.mint, a]))
  }

  static fromFile(path: string): Registry {
    return new Registry(JSON.parse(readFileSync(path, 'utf8')) as Asset[])
  }

  save(path: string): void {
    writeFileSync(path, JSON.stringify(this.assets, null, 2) + '\n', 'utf8')
  }

  lookup(mint: string): Asset | undefined {
    return this.byMint.get(mint)
  }

  /** The single gate against spoofed mints. */
  isCanonical(mint: string): boolean {
    return this.byMint.has(mint)
  }

  stocks(): Asset[] {
    return this.assets.filter(a => a.assetClass === 'stock')
  }

  all(): Asset[] {
    return [...this.assets]
  }
}
