import { z } from 'zod'
import type { Env } from '@/lib/db'
import type { JsonSchema } from '@/lib/novel/outline'
import type { Prompt } from '@/lib/novel/prompts'
import { openaiCompleteJsonText, openaiStreamTarget } from '@/lib/openai/client'
import {
  type ParsedChunk,
  type StreamTarget,
  timeoutMessage,
  timeoutSignal,
  type UsageCounts
} from '@/lib/openai/protocol'
import { MODEL_PRICING_USD_PER_M_TOKENS, type ModelPricing, type ModelRef, parseModelRef } from '@/schemas/novel.dto'

// LLM の呼び出し口 (Gemini と OpenAI 互換の振り分け、要求の組み立て、応答と usage の解釈)。
// プロンプトの文面と小説に固有の流れは持たない (src/lib/novel/prompts.ts と assist.ts にある)。

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

// generateContent / streamGenerateContent 共通レスポンス。任意フィールドが多いので
// すべて optional で受けて safeParse する (壊れたチャンクは無視 = 既存挙動)。
const GeminiCandidateSchema = z.object({
  content: z
    .object({
      parts: z.array(z.object({ text: z.string().optional(), thought: z.boolean().default(false) })).optional()
    })
    .optional(),
  finishReason: z.string().optional(),
  safetyRatings: z
    .array(
      z.object({
        category: z.string(),
        probability: z.string(),
        blocked: z.boolean().optional()
      })
    )
    .optional()
})

// thoughtsTokenCount は思考が有効なモデルだけが返す。思考トークンは出力として課金されるので、
// 出力トークンは candidatesTokenCount との合計で数える。
const GeminiUsageMetadataSchema = z.object({
  promptTokenCount: z.number().optional(),
  candidatesTokenCount: z.number().optional(),
  thoughtsTokenCount: z.number().optional(),
  totalTokenCount: z.number().optional()
})
type GeminiUsageMetadata = z.infer<typeof GeminiUsageMetadataSchema>

const GeminiResponseSchema = z.object({
  candidates: z.array(GeminiCandidateSchema).optional(),
  promptFeedback: z
    .object({
      blockReason: z.string().optional(),
      safetyRatings: z.unknown().optional()
    })
    .optional(),
  usageMetadata: GeminiUsageMetadataSchema.optional()
})
type GeminiResponse = z.infer<typeof GeminiResponseSchema>

type StreamChapterParams = {
  prompt: Prompt
  model?: ModelRef
  // 上流から任意のチャンク (thinking 含む) を受け取るたびに呼ばれるコールバック。
  // DO 側が lastProgressAt を更新して stale 誤検知を防ぐために使う。
  onChunk?: () => void
}

// Gemini 直のコスト。単価表は画面表示と共有するため novel.dto.ts にある。
// OpenAI 互換のモデルは単価が /models から来るので、こちらではなく openai/models.ts の computeCostUsd を使う。
export function computeCostUsd(model: string, promptTokens: number, outputTokens: number): number {
  const pricingByModel: Record<string, ModelPricing | undefined> = MODEL_PRICING_USD_PER_M_TOKENS
  const pricing = pricingByModel[model]
  if (!pricing) {
    console.warn(`computeCostUsd: unknown model "${model}", returning 0`)
    return 0
  }
  return (promptTokens * pricing.input + outputTokens * pricing.output) / 1_000_000
}

// maxOutputTokens は意図的に指定しない: prompt 側で「約 N 文字」と指示しているし、模型自体は
// 自然完了するので人工的な cap を被せると却って MAX_TOKENS の原因になる。
// thinking もデフォルト動作に任せる (品質を取る) — 出力 cap を外したので thinking がトークン枠を
// 食い潰す問題は起きない。

// 小説生成では Gemini の安全フィルタを無効化する (Gemini 2.0+ は threshold='OFF' に対応)。
// 旧 API の BLOCK_NONE と違い、フィルタ評価自体を行わないため安全ブロックで途切れない。
const SAFETY_SETTINGS_OFF = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' }
] as const

// 実際に使うモデルの参照 (保存値の形)。指定が無ければ Gemini の既定にする。
function resolveModel(env: Env, model?: ModelRef): ModelRef {
  return model ?? env.GEMINI_MODEL ?? 'gemini-2.5-flash'
}

// ---------------------- 要求の body ----------------------

// stream = 本文のストリーム生成。json = JSON を 1 回で受け取る呼び出し (schema があれば構造化出力)。
export type GeminiRequest = { kind: 'stream'; prompt: Prompt } | { kind: 'json'; prompt: Prompt; schema?: JsonSchema }

function generationConfig(request: GeminiRequest): Record<string, unknown> {
  if (request.kind === 'stream') return { temperature: 0.9 }
  // 構造化出力は responseFormat で指定する (responseSchema は非推奨)。schema の型名は小文字の JSON Schema。
  if (request.schema !== undefined) {
    return { responseFormat: { text: { mimeType: 'APPLICATION_JSON', schema: request.schema } } }
  }
  return { responseMimeType: 'application/json' }
}

// Gemini の generateContent / streamGenerateContent に送る body。API キーや env には触れない (bun test で検証する)。
// system は systemInstruction、user は contents に入れる。system が空なら systemInstruction を付けない。
export function buildGeminiBody(request: GeminiRequest): Record<string, unknown> {
  const { system, user } = request.prompt
  return {
    ...(system.length > 0 ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    contents: [{ role: 'user', parts: [{ text: user }] }],
    safetySettings: SAFETY_SETTINGS_OFF,
    generationConfig: generationConfig(request)
  }
}

// ---------------------- 非ストリーム (JSON) ----------------------

// 非ストリーム呼び出し 1 回分の結果。usage はコストの記録に使う (上流が返さなければ undefined)。
export type JsonTextResult = { text: string; usage: UsageCounts | undefined }

export type GenerateJsonOptions = {
  // エラー文とログに出す呼び出しの名前。
  op: string
  // 構造化出力の JSON Schema。Gemini だけが使う (OpenAI 互換は json_object のまま)。
  schema?: JsonSchema
  // 応答を待つ上限 (ミリ秒)。超えたら中断して throw する。無ければ打ち切らない。
  timeoutMs?: number
}

function postGemini(url: string, body: Record<string, unknown>, signal: AbortSignal | undefined): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal
  })
}

// 構造化出力の新しい形式 (responseFormat) を受け付けない古いモデルは 400 を返す。
// schema を外して JSON の MIME 指定だけで 1 回だけやり直す (形の検証は呼び出し側のコードで行う)。
async function retryWithoutSchema(
  rejected: Response,
  url: string,
  prompt: Prompt,
  signal: AbortSignal | undefined,
  op: string
): Promise<Response> {
  const reason = await rejected.text().catch(() => '')
  console.warn(`Gemini ${op}: structured output was rejected (400), retrying without schema: ${reason}`)
  return postGemini(url, buildGeminiBody({ kind: 'json', prompt }), signal)
}

// Gemini の非ストリーム呼び出し。本文テキストを返し、空なら理由つきで throw する。
// ref は保存値の形のモデル参照 (usage.model に入れる)、id は URL に入れる上流のモデル名。
async function geminiGenerateJson(
  env: Env,
  id: string,
  ref: ModelRef,
  prompt: Prompt,
  options: GenerateJsonOptions
): Promise<JsonTextResult> {
  const { op, schema, timeoutMs } = options
  const url = `${GEMINI_BASE}/${id}:generateContent?key=${env.GEMINI_API_KEY}`
  // やり直しも含めて 1 つの上限で打ち切る。
  const signal = timeoutSignal(timeoutMs)
  try {
    const first = await postGemini(url, buildGeminiBody({ kind: 'json', prompt, schema }), signal)
    const res =
      first.status === 400 && schema !== undefined ? await retryWithoutSchema(first, url, prompt, signal, op) : first
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`Gemini ${op} failed: ${res.status} ${err}`)
    }

    const data: GeminiResponse = GeminiResponseSchema.parse(await res.json())
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text
    if (!text) {
      const finishReason = data.candidates?.[0]?.finishReason ?? 'unknown'
      const promptBlock = data.promptFeedback?.blockReason
      const blockedSafety = data.candidates?.[0]?.safetyRatings?.filter((r) => r.blocked) ?? []
      const detail = [
        `finishReason=${finishReason}`,
        promptBlock ? `promptBlockReason=${promptBlock}` : '',
        blockedSafety.length > 0 ? `blockedCategories=${blockedSafety.map((r) => r.category).join(',')}` : ''
      ]
        .filter((x) => x.length > 0)
        .join(' / ')
      throw new Error(`Gemini returned empty ${op} response (${detail})`)
    }
    return { text, usage: usageFromMetadata(data.usageMetadata, ref) }
  } catch (e) {
    if (signal?.aborted === true && timeoutMs !== undefined) throw new Error(timeoutMessage(`Gemini ${op}`, timeoutMs))
    throw e
  }
}

// JSON を 1 回で受け取る呼び出し (章立てなど)。モデルの接頭辞で Gemini / OpenAI 互換を切り替える。
// ref が undefined なら既定のモデル。通信エラー、空の応答、ブロックは throw する。
export async function generateJson(
  env: Env,
  ref: ModelRef | undefined,
  prompt: Prompt,
  options: GenerateJsonOptions
): Promise<JsonTextResult> {
  const model = resolveModel(env, ref)
  const target = parseModelRef(model)
  if (target.provider === 'openai') {
    return openaiCompleteJsonText(env, model, target.id, prompt, { op: options.op, timeoutMs: options.timeoutMs })
  }
  return geminiGenerateJson(env, target.id, model, prompt, options)
}

// ---------------------- ストリーム (本文) ----------------------

export type StreamChapterUsage = UsageCounts & {
  // Gemini が報告する finishReason。'STOP' = 自然完了、それ以外 (MAX_TOKENS/SAFETY/RECITATION/OTHER) は
  // 途中で打ち切られたサインなので DO 側で警告として通知する。chunk が finishReason を送ってこなかった
  // 場合は 'STOP' として扱う (= 正常終了とみなす)。
  finishReason: string
}

// 送ったプロンプトは呼び出し側が持っている (保存用の文字列は renderPromptForStorage で作る) ので、ここでは返さない。
export type StreamChapterResult = {
  stream: ReadableStream<Uint8Array>
  usage: Promise<StreamChapterUsage>
  // Gemini がプロンプト自体を拒否した場合の理由 (PROHIBITED_CONTENT 等)。
  // stream 終了時に resolve される。拒否がなければ undefined。
  // 空出力時に DO 側がユーザーへ原因を提示するために使う。
  blockReason: Promise<string | undefined>
}

// Gemini のストリーム呼び出しの宛先と読み方。受信ループは OpenAI 互換と共通。
function geminiStreamTarget(env: Env, id: string, ref: ModelRef, prompt: Prompt): StreamTarget {
  return {
    url: `${GEMINI_BASE}/${id}:streamGenerateContent?alt=sse&key=${env.GEMINI_API_KEY}`,
    headers: { 'Content-Type': 'application/json' },
    body: buildGeminiBody({ kind: 'stream', prompt }),
    label: 'Gemini',
    parse: (chunk): ParsedChunk => ({
      text: extractText(chunk),
      usage: extractUsage(chunk, ref),
      finishReason: extractFinishReason(chunk),
      blockReason: extractBlockReason(chunk)
    })
  }
}

// 組み立て済みのプロンプトで本文をストリーム生成する。
export function streamChapter(env: Env, params: StreamChapterParams): StreamChapterResult {
  const model = resolveModel(env, params.model)
  const modelTarget = parseModelRef(model)
  const target =
    modelTarget.provider === 'openai'
      ? openaiStreamTarget(env, model, modelTarget.id, params.prompt)
      : geminiStreamTarget(env, modelTarget.id, model, params.prompt)

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const writer = writable.getWriter()
  const encoder = new TextEncoder()

  let resolveUsage!: (value: StreamChapterUsage) => void
  let rejectUsage!: (reason: unknown) => void
  const usage = new Promise<StreamChapterUsage>((res, rej) => {
    resolveUsage = res
    rejectUsage = rej
  })

  let resolveBlockReason!: (value: string | undefined) => void
  const blockReason = new Promise<string | undefined>((res) => {
    resolveBlockReason = res
  })

  // 上流が無応答でハングすると DO が永久に「生成中」のままになるので、接続〜チャンク間の
  // 無応答に上限を設ける。チャンク受信ごとにタイマーを張り直し、超過したら fetch を abort する。
  const STALL_TIMEOUT_MS = 90_000
  // 一時的な過負荷 (429/5xx) や接続失敗は数回までバックオフして再接続を試みる (本文受信前のみ)。
  const MAX_CONNECT_ATTEMPTS = 3
  const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504])
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

  const doStream = async () => {
    const controller = new AbortController()
    let stalled: Error | undefined
    let stallTimer: ReturnType<typeof setTimeout> | undefined
    const armStall = () => {
      if (stallTimer !== undefined) clearTimeout(stallTimer)
      stallTimer = setTimeout(() => {
        stalled = new Error(`${target.label} 応答が ${Math.round(STALL_TIMEOUT_MS / 1000)} 秒途絶えたため中断しました`)
        controller.abort(stalled)
      }, STALL_TIMEOUT_MS)
    }
    const clearStall = () => {
      if (stallTimer !== undefined) {
        clearTimeout(stallTimer)
        stallTimer = undefined
      }
    }

    // ── 接続フェーズ (本文をまだ 1 文字も受け取っていないのでリトライ可能) ──
    let res: Response | undefined
    for (let attempt = 1; ; attempt++) {
      armStall()
      try {
        res = await fetch(target.url, {
          method: 'POST',
          headers: target.headers,
          body: JSON.stringify(target.body),
          signal: controller.signal
        })
      } catch (e) {
        clearStall()
        if (stalled === undefined && attempt < MAX_CONNECT_ATTEMPTS) {
          await sleep(500 * 2 ** (attempt - 1))
          continue
        }
        const err = stalled !== undefined ? stalled : e
        rejectUsage(err)
        await writer.abort(err)
        return
      }
      if (res.ok && res.body) {
        clearStall()
        break
      }
      const status = res.status
      if (RETRYABLE_STATUS.has(status) && attempt < MAX_CONNECT_ATTEMPTS) {
        const retryAfter = Number(res.headers.get('retry-after'))
        await res.body?.cancel().catch(() => {})
        clearStall()
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** (attempt - 1))
        continue
      }
      const errText = await res.text().catch(() => String(status))
      clearStall()
      const err = new Error(`${target.label} streamChapter failed: ${status} ${errText}`)
      rejectUsage(err)
      await writer.abort(err)
      return
    }

    const responseBody = res.body
    if (responseBody === null) {
      const err = new Error(`${target.label} streamChapter failed: empty response body`)
      rejectUsage(err)
      await writer.abort(err)
      return
    }

    const decoder = new TextDecoder()
    let buffer = ''
    let lastUsage: Omit<StreamChapterUsage, 'finishReason'> | undefined
    // finishReason は最終 chunk にのみ乗ることが多いので、流れる度に上書き。
    // 終了時にこれを見て途中打ち切り (MAX_TOKENS/SAFETY/RECITATION) を検出する。
    let lastFinishReason: string | undefined
    let lastBlockReason: string | undefined

    try {
      for await (const value of responseBody) {
        armStall()
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const jsonStr = trimmed.slice(5).trim()
          if (!jsonStr || jsonStr === '[DONE]') continue
          let chunk: unknown
          try {
            chunk = JSON.parse(jsonStr)
          } catch {
            continue
          }
          // thinking 含む全チャンク受信時に通知 (DO 側の lastProgressAt 更新用)
          params.onChunk?.()
          const parsedChunk = target.parse(chunk)
          if (parsedChunk.error !== undefined) {
            // 上流がストリームの途中でエラーを返した。部分本文を「完了」にしないよう、受信エラーとして扱う。
            throw new Error(`${target.label} stream error: ${parsedChunk.error}`)
          }
          if (parsedChunk.text) {
            await writer.write(encoder.encode(parsedChunk.text))
          }
          if (parsedChunk.usage) lastUsage = parsedChunk.usage
          if (parsedChunk.finishReason) lastFinishReason = parsedChunk.finishReason
          if (parsedChunk.blockReason) lastBlockReason = parsedChunk.blockReason
        }
      }
      // 正常終了: stream を閉じ、finishReason / usage を確定する。
      clearStall()
      await writer.close()
      resolveBlockReason(lastBlockReason)
      if (lastUsage) {
        const finishReason = lastFinishReason === undefined ? 'STOP' : lastFinishReason
        resolveUsage({ ...lastUsage, finishReason })
      } else {
        rejectUsage(new Error(`${target.label} stream ended without usage`))
      }
    } catch (e) {
      // 受信途中での中断 (ストール abort / ネットワーク切断)。graceful close せず error として
      // 伝播させ、DO 側で「途中で止まった部分本文を done 扱い」しないようにする。
      clearStall()
      const err = stalled !== undefined ? stalled : e
      resolveBlockReason(lastBlockReason)
      rejectUsage(err)
      await writer.abort(err).catch(() => {})
    }
  }

  doStream().catch(async (e) => {
    rejectUsage(e)
    resolveBlockReason(undefined)
    try {
      await writer.abort(e)
    } catch {
      // already closed
    }
  })

  return { stream: readable, usage, blockReason }
}

// 応答 (ストリームの 1 チャンク、または非ストリームの応答全体) から usage を取り出す。
// 出力トークンは本文と思考の合計 (どちらも出力単価で課金される)。
export function extractUsage(chunk: unknown, model: ModelRef): UsageCounts | undefined {
  const parsed = GeminiResponseSchema.safeParse(chunk)
  if (!parsed.success) return undefined
  return usageFromMetadata(parsed.data.usageMetadata, model)
}

function tokenCount(value: number | undefined): number {
  return value === undefined ? 0 : value
}

function usageFromMetadata(meta: GeminiUsageMetadata | undefined, model: ModelRef): UsageCounts | undefined {
  if (meta === undefined) return undefined
  const promptTokens = tokenCount(meta.promptTokenCount)
  const outputTokens = tokenCount(meta.candidatesTokenCount) + tokenCount(meta.thoughtsTokenCount)
  const totalTokens = meta.totalTokenCount === undefined ? promptTokens + outputTokens : meta.totalTokenCount
  return { model, promptTokens, outputTokens, totalTokens }
}

function extractText(chunk: unknown): string {
  const parsed = GeminiResponseSchema.safeParse(chunk)
  if (!parsed.success) return ''
  const parts = parsed.data.candidates?.[0]?.content?.parts
  if (!parts || parts.length === 0) return ''
  return parts
    .filter((p) => p.thought !== true)
    .map((p) => (p.text !== undefined ? p.text : ''))
    .join('')
}

// chunk に乗っていれば finishReason を取り出す。最終 chunk にだけ含まれることが多い。
function extractFinishReason(chunk: unknown): string | undefined {
  const parsed = GeminiResponseSchema.safeParse(chunk)
  if (!parsed.success) return undefined
  return parsed.data.candidates?.[0]?.finishReason
}

// chunk に乗っていれば promptFeedback.blockReason を取り出す。
// プロンプトが拒否されると候補なしでこのフィールドだけ送られてくる (= 空出力の原因)。
function extractBlockReason(chunk: unknown): string | undefined {
  const parsed = GeminiResponseSchema.safeParse(chunk)
  if (!parsed.success) return undefined
  return parsed.data.promptFeedback?.blockReason
}
