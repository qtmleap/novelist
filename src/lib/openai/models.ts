import type { Env } from '@/lib/db'
import { GEMINI_CATALOG, openaiModelRef, parseModelRef } from '@/schemas/novel.dto'
import {
  type AvailableModel,
  type ModelCatalog,
  type ModelPrice,
  UpstreamModelListSchema,
  UpstreamModelSchema
} from '@/schemas/provider.dto'
import { type OpenAIFormat, resolveFormat } from './protocol'

export type OpenAIConfig = { baseUrl: string; apiKey: string; format: OpenAIFormat }

// URL と API キーの両方があるときだけ「設定済み」。値は画面にも API にも出さない。
export function openaiConfig(env: Env): OpenAIConfig | null {
  const baseUrl = env.OPENAI_BASE_URL
  const apiKey = env.OPENAI_API_KEY
  if (baseUrl === undefined || apiKey === undefined) return null
  const trimmedUrl = baseUrl.trim().replace(/\/+$/, '')
  const trimmedKey = apiKey.trim()
  if (trimmedUrl.length === 0 || trimmedKey.length === 0) return null
  return { baseUrl: trimmedUrl, apiKey: trimmedKey, format: resolveFormat(env.OPENAI_API_FORMAT) }
}

const CACHE_TTL_MS = 5 * 60 * 1000
const FETCH_TIMEOUT_MS = 10_000

// Worker のインスタンス内だけの短い共有キャッシュ。/models は画面表示のたびに呼ばれ、
// コスト記録でも使うので、毎回上流に聞かない。失敗は覚えない (次の呼び出しで再試行する)。
const cache: { key: string; at: number; models: AvailableModel[] } = { key: '', at: 0, models: [] }

export type UpstreamResult = { models: AvailableModel[]; error: string | null }

// キーは返さず、理由はステータスと例外名だけにする (応答本文にも秘密が混ざりうるため)。
export async function fetchOpenAIModels(env: Env): Promise<UpstreamResult> {
  const config = openaiConfig(env)
  if (config === null) return { models: [], error: null }

  const cacheKey = config.baseUrl
  if (cache.key === cacheKey && Date.now() - cache.at < CACHE_TTL_MS) {
    return { models: cache.models, error: null }
  }

  try {
    const res = await fetch(`${config.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    if (!res.ok) return { models: [], error: `/models が HTTP ${res.status} を返しました` }

    const list = UpstreamModelListSchema.safeParse(await res.json())
    if (!list.success) return { models: [], error: '/models の応答の形式が OpenAI 互換ではありません' }

    const models = list.data.data.flatMap((item): AvailableModel[] => {
      const parsed = UpstreamModelSchema.safeParse(item)
      if (!parsed.success) return []
      const m = parsed.data
      return [
        {
          ref: openaiModelRef(m.id),
          name: m.id,
          provider: 'openai',
          owner: m.owned_by === undefined ? null : m.owned_by,
          contextWindow: m.context_window === undefined ? null : m.context_window,
          price:
            m.pricing === undefined
              ? null
              : { input: m.pricing.input, output: m.pricing.output, longPromptSurcharge: false }
        }
      ]
    })
    cache.key = cacheKey
    cache.at = Date.now()
    cache.models = models
    return { models, error: null }
  } catch (e) {
    const name = e instanceof Error ? e.name : 'Error'
    return { models: [], error: `/models を取得できませんでした (${name})` }
  }
}

// 画面のモデル選択に出す一覧。Gemini は常に出し、OpenAI 互換は設定済みのときだけ足す。
export async function buildModelCatalog(env: Env): Promise<ModelCatalog> {
  const config = openaiConfig(env)
  const upstream = await fetchOpenAIModels(env)
  return {
    openaiConfigured: config !== null,
    openaiFormat: config === null ? resolveFormat(env.OPENAI_API_FORMAT) : config.format,
    openaiError: upstream.error,
    models: [...GEMINI_CATALOG, ...upstream.models]
  }
}

// コスト記録用。Gemini は固定表、OpenAI 互換は /models の pricing を引く。単価が分からなければ null。
export async function findPrice(env: Env, ref: string): Promise<ModelPrice | null> {
  const parsed = parseModelRef(ref)
  if (parsed.provider === 'gemini') {
    const entry = GEMINI_CATALOG.find((m) => m.ref === parsed.id)
    return entry === undefined ? null : entry.price
  }
  const upstream = await fetchOpenAIModels(env)
  const entry = upstream.models.find((m) => m.ref === ref)
  return entry === undefined ? null : entry.price
}

// モデルの入力の上限 (トークン)。既出の章を本文プロンプトに入れる予算に使う。
// OpenAI 互換は /models の context_window、Gemini は持たない (null = 既定の予算)。分からなければ null。
export async function findContextWindow(env: Env, ref: string): Promise<number | null> {
  const parsed = parseModelRef(ref)
  if (parsed.provider === 'gemini') return null
  const upstream = await fetchOpenAIModels(env)
  const entry = upstream.models.find((m) => m.ref === ref)
  return entry === undefined ? null : entry.contextWindow
}

// 1 回分のコスト (USD)。単価が分からないモデルは 0 を記録し、警告を残す。
export function computeCostUsd(
  price: ModelPrice | null,
  model: string,
  promptTokens: number,
  outputTokens: number
): number {
  if (price === null) {
    console.warn(`computeCostUsd: no price for model "${model}", returning 0`)
    return 0
  }
  return (promptTokens * price.input + outputTokens * price.output) / 1_000_000
}
