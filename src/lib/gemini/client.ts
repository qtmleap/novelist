import { z } from 'zod'
import type { Env } from '@/lib/db'
import { FIRST_PERSON_AS_NAME } from '@/schemas/character.dto'
import {
  DEFAULT_GENERATION_MODEL,
  type GeminiModel,
  type Outline,
  type OutlineChapter,
  OutlineSchema
} from '@/schemas/novel.dto'

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

const GeminiUsageMetadataSchema = z.object({
  promptTokenCount: z.number().optional(),
  candidatesTokenCount: z.number().optional(),
  totalTokenCount: z.number().optional()
})

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

export type GeminiNovelParams = {
  title: string
  genre: string
  setting: string
  num_chapters: number
  // 章立ての各章 summary の概算文字数 (章立て生成プロンプトに反映)。
  outline_summary_chars: number
  // ユーザーが PremiseForm の備考欄に書いた追加指示 (任意)。
  notes?: string
}

// 章立て生成時にのみ参照する「物語に取り込みたい要素」セクション。
// 箇条書きで何個でも記述された自由テキストを、AI が物語の自然な箇所に振り分けて
// outline の構成 (各章の summary) に反映することを期待する。
function buildNotesSection(notes: string | undefined): string {
  if (!notes || notes.trim().length === 0) return ''
  return `【物語に取り込みたい要素】\n${notes.trim()}\n上記の各項目を、物語のどこかに自然に組み込むよう章立て (各章の概要) に反映してください。配置や順序は AI 側で判断して構いません。`
}

type ViewpointChar = {
  name: string
  first_person: string
}

// 小説に登場するキャラの詳細 (Gemini プロンプト向け)。
// 辞典 (Character) + その小説での役割 (NovelCharacter.role) をマージしたもの。
export type CastMember = {
  name: string
  role: string
  gender: string
  age: string
  occupation: string
  appearance: string
  first_person: string
  address_others: string
  speech_examples: string[]
  description: string
}

// キャラ A → キャラ B の関係 (呼び方上書きを含む)。
export type CastRelation = {
  source_name: string
  target_name: string
  relation: string
  description: string
  address_override: string
}

export type StyleParams = {
  pov: string
  tone: string
  ending?: string
  age_rating?: string
  viewpointChar?: ViewpointChar
}

type StreamChapterParams = {
  novel: GeminiNovelParams
  outline: Outline
  chapterNumber: number
  previousChapters: Array<{ chapter_number: number; content: string }>
  targetChars: number
  style: StyleParams
  cast?: CastMember[]
  relations?: CastRelation[]
  model?: GeminiModel
  // Gemini から任意のチャンク (thinking 含む) を受け取るたびに呼ばれるコールバック。
  // DO 側が lastProgressAt を更新して stale 誤検知を防ぐために使う。
  onChunk?: () => void
}

type ModelPricing = { input: number; output: number }
const MODEL_PRICING_USD_PER_M_TOKENS: Record<string, ModelPricing> = {
  'gemini-3.5-flash': { input: 1.5, output: 9.0 },
  'gemini-3.1-pro-preview': { input: 2.0, output: 12.0 },
  'gemini-3-flash-preview': { input: 0.5, output: 3.0 },
  'gemini-3.1-flash-lite': { input: 0.25, output: 1.5 },
  'gemini-2.5-pro': { input: 1.25, output: 10.0 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4 }
}

export function computeCostUsd(model: string, promptTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING_USD_PER_M_TOKENS[model]
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

function resolveModel(env: Env, model?: GeminiModel): string {
  if (model !== undefined) return model
  if (env.GEMINI_MODEL !== undefined && env.GEMINI_MODEL.length > 0) return env.GEMINI_MODEL
  return DEFAULT_GENERATION_MODEL
}

// Promise + resolvers を 1 つのオブジェクトで返す小さなヘルパ。
// `let resolveXxx!` + `new Promise((r) => { resolveXxx = r })` パターンを避けるために使う。
function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (reason: unknown) => void
} {
  const handlers: { resolve?: (value: T) => void; reject?: (reason: unknown) => void } = {}
  const promise = new Promise<T>((res, rej) => {
    handlers.resolve = res
    handlers.reject = rej
  })
  return {
    promise,
    resolve: (value: T) => handlers.resolve?.(value),
    reject: (reason: unknown) => handlers.reject?.(reason)
  }
}

// レスポンスに text が無かったときの原因説明を組み立てる。
// finishReason / promptFeedback.blockReason / blocked safety category を合成する。
function emptyResponseDetail(data: GeminiResponse): string {
  const finishReason = data.candidates?.[0]?.finishReason ?? 'unknown'
  const promptBlock = data.promptFeedback?.blockReason
  const blockedSafety = data.candidates?.[0]?.safetyRatings?.filter((r) => r.blocked) ?? []
  return [
    `finishReason=${finishReason}`,
    promptBlock ? `promptBlockReason=${promptBlock}` : '',
    blockedSafety.length > 0 ? `blockedCategories=${blockedSafety.map((r) => r.category).join(',')}` : ''
  ]
    .filter((s) => s.length > 0)
    .join(' / ')
}

// Gemini の JSON レスポンス生成エンドポイントを呼び出し、text (JSON 文字列) を返す。
// 失敗パス (HTTP エラー・空レスポンス) は label 付きで例外化して呼び出し側の catch を簡潔にする。
async function callGeminiJson(env: Env, model: string, prompt: string, label: string): Promise<string> {
  const url = `${GEMINI_BASE}/${model}:generateContent?key=${env.GEMINI_API_KEY}`
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    safetySettings: SAFETY_SETTINGS_OFF,
    generationConfig: { responseMimeType: 'application/json' }
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Gemini ${label} failed: ${res.status} ${err}`)
  }
  const data: GeminiResponse = GeminiResponseSchema.parse(await res.json())
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text
  if (!text) {
    throw new Error(`Gemini returned empty ${label} response (${emptyResponseDetail(data)})`)
  }
  return text
}

// プロンプト用のキャラクター詳細セクションを組み立てる。speech_examples・address_others・
// description を含めて Gemini が口調・呼び方を踏襲できるようにする。
function buildCastSection(cast: CastMember[] | undefined): string {
  if (!cast || cast.length === 0) return ''
  const blocks = cast.map((c) => {
    const meta = [c.age, c.gender, c.occupation].filter((v) => v && v.length > 0).join('・')
    const lines: string[] = []
    const header = meta ? `■ ${c.name} (${meta})` : `■ ${c.name}`
    lines.push(c.role ? `${header} - ${c.role}` : header)
    const fpDisplay = c.first_person === FIRST_PERSON_AS_NAME ? `自分自身を「${c.name}」と名前で呼ぶ` : c.first_person
    const idLine = [
      fpDisplay ? `一人称: ${fpDisplay}` : '',
      c.address_others ? `他者の呼び方: ${c.address_others}` : ''
    ]
      .filter((s) => s.length > 0)
      .join(' / ')
    if (idLine) lines.push(`  ${idLine}`)
    if (c.appearance) lines.push(`  外見: ${c.appearance}`)
    if (c.speech_examples.length > 0) {
      lines.push('  口調の例:')
      for (const ex of c.speech_examples) lines.push(`    「${ex}」`)
    }
    if (c.description) lines.push(`  背景: ${c.description}`)
    return lines.join('\n')
  })
  return `【登場キャラクター詳細】\n${blocks.join('\n\n')}`
}

function buildRelationsSection(relations: CastRelation[] | undefined): string {
  if (!relations || relations.length === 0) return ''
  const lines = relations.map((r) => {
    const addr = r.address_override
      ? `（${r.source_name} が ${r.target_name} を呼ぶときは「${r.address_override}」）`
      : ''
    const desc = r.description ? ` — ${r.description}` : ''
    return `- ${r.source_name} → ${r.target_name}: ${r.relation}${addr}${desc}`
  })
  return `【キャラクター間の関係】\n${lines.join('\n')}`
}

function buildWritingRules(cast: CastMember[] | undefined): string {
  if (!cast || cast.length === 0) return ''
  return [
    '【執筆ルール】',
    '- 各キャラクターのセリフは「口調の例」の語尾・一人称・口癖・性格を必ず踏襲すること。',
    '- 一人称代名詞は各キャラの設定値を厳守する (例えば「僕」キャラに「俺」と言わせない)。',
    '- 他キャラへの呼びかけは「他者の呼び方」と関係ごとの上書きを優先すること。',
    '- 各キャラの背景・性格に反する行動や発言を避け、辞典の人物像に沿って描写すること。'
  ].join('\n')
}

function buildStyleInstruction(style: StyleParams, includeEnding = true): string {
  const { pov, tone, ending, age_rating, viewpointChar: vc } = style

  let povLine: string
  if (pov === '一人称') {
    if (vc && vc.first_person === FIRST_PERSON_AS_NAME) {
      povLine = `『${vc.name}』の一人称視点で、地の文の主語は『${vc.name}』を用いる(一人称代名詞は使わず、自分自身を「${vc.name}」と名前で呼ぶ独特な語り口)`
    } else if (vc) {
      povLine = `『${vc.name}』(一人称「${vc.first_person}」)の一人称視点で、地の文は語り手の主観で執筆`
    } else {
      povLine = '主人公の一人称視点で執筆'
    }
  } else if (pov === '三人称一元視点') {
    povLine = vc ? `『${vc.name}』に寄り添う三人称一元視点で執筆` : '三人称一元視点で執筆'
  } else if (pov === '三人称多元視点') {
    povLine = '複数キャラの視点を切り替える三人称多元視点'
  } else {
    povLine = '全知の三人称(神視点)'
  }

  const toneMap: Record<string, string> = {
    ライトノベル調: '口語的で軽快なライトノベル調の文体',
    一般文芸: '標準的な一般文芸の文体',
    文学的: '硬質で描写を重視した文学的な文体',
    やさしい文体: '平易でやさしい童話風の文体'
  }
  const toneLine = toneMap[tone] ?? '標準的な一般文芸の文体'

  // age_rating で描写の踏み込み度合いを制御する (tone とは独立)。
  const ratingMap: Record<string, string> = {
    全年齢: '性的描写・過度な暴力描写を含めず、誰でも読める内容に留めること',
    R15: '物語の登場人物はすべて 18 歳以上の成人とする。たとえ後述の登場人物詳細に「高校生」「17歳」「女子高生」「十代」「美少女」等、未成年を連想させる記述が含まれていても、本作品においては大学生または社会人として読み替えて描写すること。学校設定が必要な場合は大学とする。性器を指す放送禁止用語 (露骨な俗語) の使用は禁止。それ以外の性的な描写や行為自体は許容する',
    R18: '成人向け。物語の登場人物はすべて 18 歳以上の成人とする。たとえ後述の登場人物詳細に「高校生」「17歳」「女子高生」「十代」「美少女」等、未成年を連想させる記述が含まれていても、本作品においては大学生または社会人として読み替えて描写すること。学校設定が必要な場合は大学とする。性的描写・暴力描写・直接的な語彙を含め、必要に応じて踏み込んだ表現を制限なく用いてよい'
  }
  const ratingLine = age_rating ? ratingMap[age_rating] : undefined

  const endingMap: Record<string, string> = {
    ハッピーエンド: '主要な葛藤が解決し、登場人物が報われる前向きな結末へ向けて構成すること',
    バッドエンド: '救いの少ない悲劇的な結末へ向けて構成し、終章で喪失や敗北を直視すること',
    ビターエンド: '喜びと喪失が混在する苦味のある結末。完全な勝利でも敗北でもなく、余韻を残すこと',
    メリーバッドエンド:
      '表面的にはハッピーエンドに見えるが、実際には何かが歪んでいる/失われていることが読み取れる結末にすること',
    オープンエンド: '物語の結末を断定せず、複数の解釈の余地を残して幕を引くこと'
  }
  const endingLine = ending && ending !== '未指定' ? endingMap[ending] : undefined

  const lines = [`視点: ${povLine}`, `文体: ${toneLine}`]
  if (ratingLine) lines.push(`年齢指定: ${ratingLine}`)
  // 結末は章立て時にだけ渡す。本文は章立て(概要)経由で結末に沿うので再注入しない。
  if (includeEnding && endingLine) lines.push(`結末: ${endingLine}`)
  return lines.join('\n')
}

// 章立て (bulk) 生成プロンプトの本文だけ組み立てる。プレビュー用にも使う。
export function buildOutlinePrompt(
  novel: GeminiNovelParams,
  style: StyleParams,
  cast?: CastMember[],
  relations?: CastRelation[]
): string {
  const styleInstruction = buildStyleInstruction(style)
  const castSection = buildCastSection(cast)
  const relationsSection = buildRelationsSection(relations)
  const notesSection = buildNotesSection(novel.notes)
  const extraSections = [castSection, relationsSection, notesSection].filter((s) => s.length > 0).join('\n\n')

  const castNames = cast && cast.length > 0 ? cast.map((c) => c.name) : []
  const charactersInstruction =
    castNames.length > 0
      ? `各章には、その章に実際に登場するキャラクターを characters 配列で指定してください。名前は次の表記と完全に一致させること: ${castNames.join('、')}。関係性に記載があるだけで、その章に登場しないキャラクターは含めないでください。`
      : ''
  const exampleEntry =
    castNames.length > 0
      ? '{ "chapter_number": 1, "title": "章のタイトル", "summary": "章の概要", "characters": ["登場キャラ名"] }'
      : '{ "chapter_number": 1, "title": "章のタイトル", "summary": "章の概要" }'

  return `あなたはプロの小説家です。以下のあらすじに基づいて、小説の章立てを作成してください。

ジャンル: ${novel.genre}
世界観・設定: ${novel.setting}
章数: ${novel.num_chapters}
${styleInstruction}
${extraSections ? `\n${extraSections}\n` : ''}
必ず ${novel.num_chapters} 章分の章立てを JSON 形式で出力してください。
各章には chapter_number（1 から始まる整数）、title（章のタイトル）、summary（章の概要。${novel.outline_summary_chars}字程度）を含めてください。
登場キャラクター詳細を与えた場合は、各キャラの性格・背景・関係を踏まえた章立てにしてください。
${charactersInstruction ? `${charactersInstruction}\n` : ''}
出力形式:
{
  "chapters": [
    ${exampleEntry},
    ...
  ]
}`
}

// モデルが返した各章の characters を、実在するキャスト名だけに絞り込む。
// 名前ドリフトや幻覚 (関係性にしか居ないキャラ・架空名) を除去し、重複も排除する。
// キャスト未指定なら characters は意味を持たないので空にする。
function normalizeChapterCharacters(characters: string[], cast: CastMember[] | undefined): string[] {
  if (!cast || cast.length === 0) return []
  const known = new Set(cast.map((c) => c.name))
  return [...new Set(characters.filter((name) => known.has(name)))]
}

export async function generateOutline(
  env: Env,
  novel: GeminiNovelParams,
  style: StyleParams,
  modelOverride?: GeminiModel,
  cast?: CastMember[],
  relations?: CastRelation[]
): Promise<Outline> {
  const model = resolveModel(env, modelOverride)
  const prompt = buildOutlinePrompt(novel, style, cast, relations)
  const text = await callGeminiJson(env, model, prompt, 'outline')

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`Gemini outline response is not valid JSON: ${text}`)
  }

  // モデルがトップレベルに { chapters: [...] } ではなく配列を直接返すことがあるので吸収する。
  const candidate = Array.isArray(parsed) ? { chapters: parsed } : parsed
  const validated = OutlineSchema.safeParse(candidate)
  if (!validated.success) {
    throw new Error(`Gemini outline response failed validation: ${JSON.stringify(validated.error.issues)}`)
  }

  return {
    chapters: validated.data.chapters.map((c) => ({
      ...c,
      characters: normalizeChapterCharacters(c.characters, cast)
    }))
  }
}

// 既存 outline の中の特定章だけを書き直す。他の章 (title/summary) はそのまま維持。
// 既存章本文との整合 (タイトル変更で本文が浮く) を避けたい場合は呼び出し側で UI 確認する。
export async function regenerateOutlineChapter(
  env: Env,
  novel: GeminiNovelParams,
  style: StyleParams,
  existing: Outline,
  chapterNumber: number,
  modelOverride?: GeminiModel,
  cast?: CastMember[],
  relations?: CastRelation[]
): Promise<OutlineChapter> {
  // 既存に当該章が無い場合 (= 後から num_chapters を増やした) も生成できるよう、無ければ空のテンプレを充てる。
  const target = existing.chapters.find((c) => c.chapter_number === chapterNumber) ?? {
    chapter_number: chapterNumber,
    title: '',
    summary: '',
    characters: []
  }

  const model = resolveModel(env, modelOverride)
  const styleInstruction = buildStyleInstruction(style)
  const castSection = buildCastSection(cast)
  const relationsSection = buildRelationsSection(relations)
  const notesSection = buildNotesSection(novel.notes)
  const extra = [castSection, relationsSection, notesSection].filter((s) => s.length > 0).join('\n\n')

  const castNames = cast && cast.length > 0 ? cast.map((c) => c.name) : []
  const charactersInstruction =
    castNames.length > 0
      ? `\n- characters には、この章に実際に登場するキャラクターを次の表記と完全一致で指定する: ${castNames.join('、')}。関係性に記載があるだけで登場しないキャラクターは含めない。`
      : ''
  const exampleEntry =
    castNames.length > 0
      ? `{ "chapter_number": ${chapterNumber}, "title": "...", "summary": "...", "characters": ["登場キャラ名"] }`
      : `{ "chapter_number": ${chapterNumber}, "title": "...", "summary": "..." }`

  const otherChapters = existing.chapters
    .filter((c) => c.chapter_number !== chapterNumber)
    .map((c) => `第${c.chapter_number}章「${c.title}」: ${c.summary}`)
    .join('\n')

  const prompt = `あなたはプロの小説家です。既存の章立てのうち、指定された 1 章だけを書き直してください。

【作品情報】
ジャンル: ${novel.genre}
世界観・設定: ${novel.setting}
章数: ${novel.num_chapters}

【文体・視点】
${styleInstruction}
${extra ? `\n${extra}\n` : ''}
【他の章 (固定。これらと整合する内容にする)】
${otherChapters || '(なし — 全体が 1 章のみ)'}

【書き直す章】
第${chapterNumber}章「${target.title}」: ${target.summary}

書き直し方針:
- 章番号は ${chapterNumber} のまま。
- 物語全体の流れを壊さないように、前後の章と矛盾しない内容にする。
- 元のタイトルや要約に固執せず、異なる切り口・展開を提案して構わない。
- summary は ${novel.outline_summary_chars} 字程度。${charactersInstruction}

出力は以下の JSON 形式のみ:
${exampleEntry}`

  const text = await callGeminiJson(env, model, prompt, 'regenerateOutlineChapter')

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`Gemini regenerateOutlineChapter response is not valid JSON: ${text}`)
  }
  const validated = OutlineSchema.shape.chapters.element.safeParse(parsed)
  if (!validated.success) {
    throw new Error(`Gemini outline-chapter response failed validation: ${JSON.stringify(validated.error.issues)}`)
  }
  // chapter_number はモデルが取り違える可能性があるので強制的に target に揃える。
  // characters は実在キャスト名のみに正規化する。
  return {
    ...validated.data,
    chapter_number: chapterNumber,
    characters: normalizeChapterCharacters(validated.data.characters, cast)
  }
}

export type StreamChapterUsage = {
  model: string
  promptTokens: number
  outputTokens: number
  totalTokens: number
  // Gemini が報告する finishReason。'STOP' = 自然完了、それ以外 (MAX_TOKENS/SAFETY/RECITATION/OTHER) は
  // 途中で打ち切られたサインなので DO 側で警告として通知する。chunk が finishReason を送ってこなかった
  // 場合は 'STOP' として扱う (= 正常終了とみなす)。
  finishReason: string
}

export type StreamChapterResult = {
  stream: ReadableStream<Uint8Array>
  usage: Promise<StreamChapterUsage>
  // Gemini がプロンプト自体を拒否した場合の理由 (PROHIBITED_CONTENT 等)。
  // stream 終了時に resolve される。拒否がなければ undefined。
  // 空出力時に DO 側がユーザーへ原因を提示するために使う。
  blockReason: Promise<string | undefined>
  // Gemini に実際に送ったプロンプト全文 (同期的に確定済み)。
  // DO が章本文と一緒に D1 へ保存し、フロントで確認できるようにする。
  prompt: string
}

export function streamChapter(env: Env, params: StreamChapterParams): StreamChapterResult {
  const model = resolveModel(env, params.model)
  const url = `${GEMINI_BASE}/${model}:streamGenerateContent?alt=sse&key=${env.GEMINI_API_KEY}`

  const { novel, outline, chapterNumber, previousChapters, targetChars, style, cast, relations } = params

  const targetEntry: OutlineChapter | undefined = outline.chapters.find((c) => c.chapter_number === chapterNumber)
  if (!targetEntry) {
    throw new Error(`Chapter ${chapterNumber} not found in outline`)
  }

  const allChapterSummaries = outline.chapters
    .map((c) => `第${c.chapter_number}章「${c.title}」: ${c.summary}`)
    .join('\n')

  const prevChaptersText =
    previousChapters.length === 0
      ? ''
      : previousChapters
          .slice(-2)
          .map((c) => `【第${c.chapter_number}章 本文】\n${c.content}`)
          .join('\n\n')

  // 本文では結末指示を渡さない (章立て側に結末が織り込まれているため)。
  const styleInstruction = buildStyleInstruction(style, false)

  // 章立てに characters があれば、その章のキャストだけにキャスト詳細・関係を絞り込む。
  // 関係は両端ともこの章に登場するペアだけ残す。characters が空 (旧 outline) なら全キャストを使う。
  const allowed = targetEntry.characters.length > 0 ? new Set(targetEntry.characters) : undefined
  const scopedCast = allowed && cast ? cast.filter((c) => allowed.has(c.name)) : cast
  const scopedRelations =
    allowed && relations ? relations.filter((r) => allowed.has(r.source_name) && allowed.has(r.target_name)) : relations

  const castSection = buildCastSection(scopedCast)
  const relationsSection = buildRelationsSection(scopedRelations)
  const writingRules = buildWritingRules(scopedCast)
  // notes は章立て生成時にのみ使う (outline.summary に既に振り分けが乗っているため、
  // 本文生成では全体リストを再注入しない)。

  // 結末への寄せ方は章の現在位置から自然に決まるはず (序盤=展開、終盤=収束、最終章=結末到達)。
  // 過剰に「結末を温存せよ/直接示せ」と指示せず、進行度だけ渡してモデルに任せる。
  const totalChapters = Math.max(...outline.chapters.map((c) => c.chapter_number))
  const positionLine = `現在執筆中: 第${chapterNumber}章 / 全${totalChapters}章`

  const sections: string[] = [
    `【作品情報】\nジャンル: ${novel.genre}\n世界観・設定: ${novel.setting}`,
    `【文体・視点】\n${styleInstruction}`,
    castSection,
    relationsSection,
    writingRules,
    `【全体の章立て（概要）】\n${allChapterSummaries}`,
    prevChaptersText ? `【直前の章の本文（参考）】\n${prevChaptersText}` : '',
    `【執筆位置】\n${positionLine}`,
    `【執筆対象】\n第${chapterNumber}章「${targetEntry.title}」\n概要: ${targetEntry.summary}`
  ].filter((s) => s.length > 0)

  const prompt = `あなたはプロの小説家です。以下の設定と章立てに基づいて、指定された章の本文を執筆してください。

${sections.join('\n\n')}

上記の概要に沿って、第${chapterNumber}章の本文を執筆してください。
本文は日本語で約${targetChars}文字を目安に執筆してください。
登場キャラクター詳細を与えた場合は、各キャラの「口調の例」と「他者の呼び方」「関係」を必ずセリフに反映してください。
ただし、キャラクター間の関係に記載があっても、章立て（全体の章立て・本章の概要）に登場しないキャラクターは本章に登場させないでください。
文章は読者を引き込む描写を心がけ、登場人物の心情や情景を丁寧に描いてください。
本文のみを出力し、章番号やタイトルは含めないでください。`

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    safetySettings: SAFETY_SETTINGS_OFF,
    generationConfig: {
      temperature: 0.9
    }
  }

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const writer = writable.getWriter()
  const encoder = new TextEncoder()

  const usageDefer = deferred<StreamChapterUsage>()
  const usage = usageDefer.promise
  const resolveUsage = usageDefer.resolve
  const rejectUsage = usageDefer.reject

  const blockReasonDefer = deferred<string | undefined>()
  const blockReason = blockReasonDefer.promise
  const resolveBlockReason = blockReasonDefer.resolve

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
        stalled = new Error(`Gemini 応答が ${Math.round(STALL_TIMEOUT_MS / 1000)} 秒途絶えたため中断しました`)
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
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
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
      const err = new Error(`Gemini streamChapter failed: ${status} ${errText}`)
      rejectUsage(err)
      await writer.abort(err)
      return
    }

    const responseBody = res.body
    if (responseBody === null) {
      const err = new Error('Gemini streamChapter failed: empty response body')
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
          const text = extractText(chunk)
          if (text) {
            await writer.write(encoder.encode(text))
          }
          const meta = extractUsage(chunk, model)
          if (meta) lastUsage = meta
          const fr = extractFinishReason(chunk)
          if (fr) lastFinishReason = fr
          const br = extractBlockReason(chunk)
          if (br) lastBlockReason = br
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
        rejectUsage(new Error('Gemini stream ended without usageMetadata'))
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

  return { stream: readable, usage, blockReason, prompt }
}

function extractUsage(chunk: unknown, model: string): Omit<StreamChapterUsage, 'finishReason'> | undefined {
  const parsed = GeminiResponseSchema.safeParse(chunk)
  if (!parsed.success) return undefined
  const meta = parsed.data.usageMetadata
  if (!meta) return undefined
  const promptTokens = meta.promptTokenCount ?? 0
  const outputTokens = meta.candidatesTokenCount ?? 0
  const totalTokens = meta.totalTokenCount ?? promptTokens + outputTokens
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
