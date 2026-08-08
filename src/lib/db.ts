import { env } from 'cloudflare:workers'
import { PrismaD1 } from '@prisma/adapter-d1'
import { PrismaClient } from '@/generated/prisma/client'

// wrangler.toml で定義した bindings / vars を Cloudflare.Env に augment する。
// これで `env` (cloudflare:workers) の型が自動的に拡張され、getEnv()/withPrisma() 内で
// as キャストなしに DB / GEMINI_API_KEY / CHAPTER_GEN を触れる。
declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database
      GEMINI_API_KEY: string
      GEMINI_MODEL?: string
      CHAPTER_GEN: DurableObjectNamespace<import('./chapter-gen-do').ChapterGenerationDO>
    }
  }
}

export type Env = Cloudflare.Env

export function getPrisma(): PrismaClient {
  const adapter = new PrismaD1(env.DB)
  return new PrismaClient({ adapter })
}

export function getEnv(): Env {
  return env
}

// PrismaClient は 1 リクエストにつき new して使ったら $disconnect() する。
// try/finally を各ハンドラで書くとボイラープレートで潰れるので、
// 全ハンドラはこの withPrisma() 経由でクライアントを受け取る。
export async function withPrisma<T>(fn: (prisma: PrismaClient) => Promise<T>): Promise<T> {
  const prisma = getPrisma()
  try {
    return await fn(prisma)
  } finally {
    await prisma.$disconnect()
  }
}

// Prisma の "record not found" (P2025) を判定する型ガード。
// update/delete の catch で使う。想定外の例外はそのまま rethrow するのが呼び出し側の責務。
export function isPrismaNotFound(e: unknown): boolean {
  if (typeof e !== 'object' || e === null || !('code' in e)) return false
  return e.code === 'P2025'
}
