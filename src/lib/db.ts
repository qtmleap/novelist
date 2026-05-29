import { env } from 'cloudflare:workers'
import { PrismaD1 } from '@prisma/adapter-d1'
import { PrismaClient } from '@/generated/prisma/client'

export type Env = {
  DB: D1Database
  GEMINI_API_KEY: string
  GEMINI_MODEL?: string
  CHAPTER_GEN: DurableObjectNamespace<import('./chapter-gen-do').ChapterGenerationDO>
}

export function getPrisma(): PrismaClient {
  const adapter = new PrismaD1((env as Env).DB)
  return new PrismaClient({ adapter })
}

export function getEnv(): Env {
  return env as Env
}
