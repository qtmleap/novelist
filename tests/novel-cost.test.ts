import { describe, expect, test } from 'bun:test'
import type { PrismaClient } from '@/generated/prisma/client'
import type { Env } from '@/lib/db'
import { extractUsage } from '@/lib/gemini/client'
import { recordGenerationCost, usageCostUsd } from '@/lib/novel/cost'
import { getNovelWithChapters } from '@/lib/novel/repository'

// Gemini の経路は env を読まない (単価は固定表)。読んだら失敗する偽物を渡して、
// ネットワークにも /models にも行かないことを確かめる。
const untouchedEnv: Env = new Proxy(Object.create(null), {
  get(_target, key) {
    throw new Error(`env.${String(key)} should not be read`)
  }
})

describe('extractUsage (Gemini)', () => {
  test('thinking tokens are billed as output', () => {
    const chunk = {
      usageMetadata: {
        promptTokenCount: 1000,
        candidatesTokenCount: 1200,
        thoughtsTokenCount: 800,
        totalTokenCount: 3000
      }
    }
    expect(extractUsage(chunk, 'gemini-2.5-flash')).toEqual({
      model: 'gemini-2.5-flash',
      promptTokens: 1000,
      outputTokens: 2000,
      totalTokens: 3000
    })
  })

  test('total includes thinking tokens when the API omits it', () => {
    const chunk = { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, thoughtsTokenCount: 5 } }
    expect(extractUsage(chunk, 'gemini-2.5-flash')?.totalTokens).toBe(35)
  })

  test('models without thinking keep the old counts', () => {
    const chunk = { usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 40, totalTokenCount: 140 } }
    expect(extractUsage(chunk, 'gemini-2.5-flash-lite')).toEqual({
      model: 'gemini-2.5-flash-lite',
      promptTokens: 100,
      outputTokens: 40,
      totalTokens: 140
    })
  })

  test('a non-stream response with candidates is read the same way', () => {
    const body = {
      candidates: [{ content: { parts: [{ text: '{"chapters":[]}' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, thoughtsTokenCount: 4, totalTokenCount: 14 }
    }
    expect(extractUsage(body, 'gemini-2.5-flash')?.outputTokens).toBe(7)
  })

  test('chunks without usage give undefined', () => {
    expect(extractUsage({ candidates: [] }, 'gemini-2.5-flash')).toBeUndefined()
    expect(extractUsage('garbage', 'gemini-2.5-flash')).toBeUndefined()
  })
})

describe('usageCostUsd (Gemini fixed price table)', () => {
  test('gemini-2.5-flash: $0.30 in / $2.50 out per 1M tokens, thinking included', async () => {
    const usage = extractUsage(
      { usageMetadata: { promptTokenCount: 1000, candidatesTokenCount: 1200, thoughtsTokenCount: 800 } },
      'gemini-2.5-flash'
    )
    if (usage === undefined) throw new Error('usage expected')
    // (1000 * 0.3 + 2000 * 2.5) / 1e6
    expect(await usageCostUsd(untouchedEnv, usage)).toBeCloseTo(0.0053, 10)
  })

  test('gemini-2.5-flash-lite: $0.10 in / $0.40 out per 1M tokens', async () => {
    const usage = { model: 'gemini-2.5-flash-lite', promptTokens: 2_000_000, outputTokens: 500_000, totalTokens: 0 }
    expect(await usageCostUsd(untouchedEnv, usage)).toBeCloseTo(0.4, 10)
  })
})

describe('recordGenerationCost', () => {
  test('writes kind and token columns only', async () => {
    const calls: unknown[] = []
    const prisma: PrismaClient = Object.assign(Object.create(null), {
      chapterGenerationCost: {
        create: async (args: unknown) => {
          calls.push(args)
        }
      }
    })
    // 本文のストリームの usage は finishReason を持つ。列に無い値が混ざらないこと。
    const usage = { model: 'gemini-2.5-flash', promptTokens: 1000, outputTokens: 2000, totalTokens: 3000, finishReason: 'STOP' }
    await recordGenerationCost(prisma, untouchedEnv, { novelId: 'n1', chapterNumber: 0, kind: 'outline', usage })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({
      data: {
        novel_id: 'n1',
        chapter_number: 0,
        kind: 'outline',
        model: 'gemini-2.5-flash',
        prompt_tokens: 1000,
        output_tokens: 2000,
        cost_usd: expect.closeTo(0.0053, 10)
      }
    })
  })
})

describe('getNovelWithChapters cost totals', () => {
  type CostRow = { chapter_number: number; kind: string; model: string; cost_usd: number }

  // findUnique は created_at desc で並べた行を返す想定 (include の orderBy と同じ順)。
  function fakePrisma(costs: CostRow[]): PrismaClient {
    const novel = {
      id: 'n1',
      chapters: [],
      character_links: [],
      relations: [],
      generation_job: null,
      category: null,
      generation_costs: costs.map((c) => ({ ...c, prompt_tokens: 1, output_tokens: 1 }))
    }
    return Object.assign(Object.create(null), { novel: { findUnique: async () => novel } })
  }

  test('chapter costs keep the latest per chapter, other kinds are summed in aux', async () => {
    const prisma = fakePrisma([
      // chapter_number 昇順、同じ章の中は新しい順
      { chapter_number: 0, kind: 'outline', model: 'm', cost_usd: 0.01 },
      { chapter_number: 0, kind: 'outline', model: 'm', cost_usd: 0.02 },
      // 章 1 の章立ての部分再生成のほうが本文より新しくても、本文の最新を隠さない
      { chapter_number: 1, kind: 'outline', model: 'm', cost_usd: 0.004 },
      { chapter_number: 1, kind: 'chapter', model: 'm', cost_usd: 0.1 },
      { chapter_number: 1, kind: 'chapter', model: 'm', cost_usd: 0.3 },
      { chapter_number: 2, kind: 'chapter', model: 'm', cost_usd: 0.2 }
    ])
    const novel = await getNovelWithChapters(prisma, 'n1')
    if (novel === null) throw new Error('novel expected')
    expect(novel.generation_costs.map((c) => [c.chapter_number, c.cost_usd])).toEqual([
      [1, 0.1],
      [2, 0.2]
    ])
    expect(novel.total_cost_usd).toBeCloseTo(0.3, 10)
    expect(novel.aux_cost_usd).toBeCloseTo(0.034, 10)
  })

  test('no auxiliary rows give zero', async () => {
    const novel = await getNovelWithChapters(
      fakePrisma([{ chapter_number: 1, kind: 'chapter', model: 'm', cost_usd: 0.5 }]),
      'n1'
    )
    expect(novel?.aux_cost_usd).toBe(0)
    expect(novel?.total_cost_usd).toBeCloseTo(0.5, 10)
  })
})
