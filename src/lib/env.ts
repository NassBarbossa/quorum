import 'dotenv/config'
import { z } from 'zod'

const EnvSchema = z.object({
  SOLANA_RPC_URL: z.string().url(),
  SOLANA_ARCHIVE_RPC_URL: z.string().url(),
})

export type Env = { rpcUrl: string; archiveRpcUrl: string }

export function loadEnv(): Env {
  const parsed = EnvSchema.safeParse(process.env)
  if (!parsed.success) {
    throw new Error(
      `Missing or invalid environment: ${parsed.error.issues.map(i => i.path.join('.')).join(', ')}. ` +
      `Copy .env.example to .env and fill it in.`
    )
  }
  return { rpcUrl: parsed.data.SOLANA_RPC_URL, archiveRpcUrl: parsed.data.SOLANA_ARCHIVE_RPC_URL }
}
