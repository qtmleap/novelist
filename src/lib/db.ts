import { env } from 'cloudflare:workers'
import { PrismaD1 } from '@prisma/adapter-d1'
import { PrismaClient } from '@/generated/prisma/client'

export type Env = {
  DB: D1Database
  GEMINI_API_KEY: string
  GEMINI_MODEL?: string
  // OpenAI 互換 API。URL とキーはサーバー側だけが持つ (WebUI には「設定済みか」しか返さない)。
  OPENAI_BASE_URL?: string
  OPENAI_API_KEY?: string
  // 'chat' (/chat/completions、既定) か 'responses' (/responses)。
  OPENAI_API_FORMAT?: string
  CHAPTER_GEN: DurableObjectNamespace<import('./chapter-gen-do').ChapterGenerationDO>
}

export function getPrisma(): PrismaClient {
  const adapter = new PrismaD1((env as Env).DB)
  return new PrismaClient({ adapter })
}

export function getEnv(): Env {
  return env as Env
}
