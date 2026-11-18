import type { PrismaClient } from '@/generated/prisma/client'
import type { Env } from '@/lib/db'
// 同名の computeCostUsd が 2 つあるので名前空間で区別する (import の別名は Lint が型アサーションと誤検出する)。
import * as gemini from '@/lib/gemini/client'
import * as openaiModels from '@/lib/openai/models'
import type { UsageCounts } from '@/lib/openai/protocol'
import { parseModelRef } from '@/schemas/novel.dto'
import type { CostKind } from '@/schemas/story.dto'

// LLM 呼び出し 1 回分のコスト (USD)。Gemini は固定の単価表、OpenAI 互換はサーバーの /models の単価を使う。
// 単価が分からないモデルは 0 (警告はそれぞれの computeCostUsd が出す)。
export async function usageCostUsd(env: Env, usage: UsageCounts): Promise<number> {
  const parsed = parseModelRef(usage.model)
  if (parsed.provider === 'gemini') {
    return gemini.computeCostUsd(parsed.id, usage.promptTokens, usage.outputTokens)
  }
  const price = await openaiModels.findPrice(env, usage.model)
  return openaiModels.computeCostUsd(price, usage.model, usage.promptTokens, usage.outputTokens)
}

export type GenerationCostInput = {
  novelId: string
  // 本文以外で作品単位の呼び出し (章立ての一括生成など) は 0。
  chapterNumber: number
  kind: CostKind
  usage: UsageCounts
}

// ChapterGenerationCost に 1 行足す。失敗は呼び出し側で握る (コストの記録で生成結果を失わないため)。
// usage は本文のストリームから来ると finishReason などを余分に持つので、列ごとに取り出して書く。
export async function recordGenerationCost(prisma: PrismaClient, env: Env, input: GenerationCostInput): Promise<void> {
  const { usage } = input
  const costUsd = await usageCostUsd(env, usage)
  await prisma.chapterGenerationCost.create({
    data: {
      novel_id: input.novelId,
      chapter_number: input.chapterNumber,
      kind: input.kind,
      model: usage.model,
      prompt_tokens: usage.promptTokens,
      output_tokens: usage.outputTokens,
      cost_usd: costUsd
    }
  })
}
