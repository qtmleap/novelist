import type { Env } from '@/lib/db'
import { FIRST_PERSON_AS_NAME } from '@/schemas/character.dto'
import { type GeminiModel, type Outline, type OutlineChapter, OutlineSchema } from '@/schemas/novel.dto'

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

type GeminiNovelParams = {
  title: string
  genre: string
  characters: string
  setting: string
  num_chapters: number
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

type StyleParams = {
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
}

const OUTPUT_TOKEN_CAP: Record<string, number> = {
  'gemini-3.5-flash': 65536,
  'gemini-3.1-pro-preview': 65536,
  'gemini-3-flash-preview': 65536,
  'gemini-3.1-flash-lite': 65536,
  'gemini-2.5-pro': 65536,
  'gemini-2.5-flash': 65536,
  'gemini-2.5-flash-lite': 65536
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

function maxOutputTokens(model: string, targetChars: number): number {
  const cap = OUTPUT_TOKEN_CAP[model] ?? 8192
  return Math.min(targetChars * 2 + 1024, cap)
}

// 小説生成では Gemini の安全フィルタを無効化する (Gemini 2.0+ は threshold='OFF' に対応)。
// 旧 API の BLOCK_NONE と違い、フィルタ評価自体を行わないため安全ブロックで途切れない。
const SAFETY_SETTINGS_OFF = [
  { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'OFF' },
  { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'OFF' }
] as const

function resolveModel(env: Env, model?: GeminiModel): string {
  return model ?? env.GEMINI_MODEL ?? 'gemini-2.5-flash'
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

function buildStyleInstruction(style: StyleParams): string {
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
    R15: '性器を指す放送禁止用語 (露骨な俗語) の使用は禁止。それ以外の性的な描写や行為自体は許容する',
    R18: '成人向け。性的描写・暴力描写・直接的な語彙を含め、必要に応じて踏み込んだ表現を制限なく用いてよい'
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
  if (endingLine) lines.push(`結末: ${endingLine}`)
  return lines.join('\n')
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
  const url = `${GEMINI_BASE}/${model}:generateContent?key=${env.GEMINI_API_KEY}`

  const styleInstruction = buildStyleInstruction(style)
  const castSection = buildCastSection(cast)
  const relationsSection = buildRelationsSection(relations)
  const notesSection = buildNotesSection(novel.notes)
  const extraSections = [castSection, relationsSection, notesSection].filter((s) => s.length > 0).join('\n\n')

  const prompt = `あなたはプロの小説家です。以下のあらすじに基づいて、小説の章立てを作成してください。

タイトル: ${novel.title}
ジャンル: ${novel.genre}
登場人物: ${novel.characters}
世界観・設定: ${novel.setting}
章数: ${novel.num_chapters}
${styleInstruction}
${extraSections ? `\n${extraSections}\n` : ''}
必ず ${novel.num_chapters} 章分の章立てを JSON 形式で出力してください。
各章には chapter_number（1 から始まる整数）、title（章のタイトル）、summary（章の概要。200字程度）を含めてください。
登場キャラクター詳細を与えた場合は、各キャラの性格・背景・関係を踏まえた章立てにしてください。

出力形式:
{
  "chapters": [
    { "chapter_number": 1, "title": "章のタイトル", "summary": "章の概要" },
    ...
  ]
}`

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    safetySettings: SAFETY_SETTINGS_OFF,
    generationConfig: {
      responseMimeType: 'application/json'
    }
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })

  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Gemini generateOutline failed: ${res.status} ${err}`)
  }

  const data = (await res.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> }
      finishReason?: string
      safetyRatings?: Array<{ category: string; probability: string; blocked?: boolean }>
    }>
    promptFeedback?: { blockReason?: string; safetyRatings?: unknown }
  }

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
      .filter((s) => s.length > 0)
      .join(' / ')
    throw new Error(`Gemini returned empty outline response (${detail})`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`Gemini outline response is not valid JSON: ${text}`)
  }

  const validated = OutlineSchema.safeParse(parsed)
  if (!validated.success) {
    throw new Error(`Gemini outline response failed validation: ${JSON.stringify(validated.error.issues)}`)
  }

  return validated.data
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
    summary: ''
  }

  const model = resolveModel(env, modelOverride)
  const url = `${GEMINI_BASE}/${model}:generateContent?key=${env.GEMINI_API_KEY}`

  const styleInstruction = buildStyleInstruction(style)
  const castSection = buildCastSection(cast)
  const relationsSection = buildRelationsSection(relations)
  const notesSection = buildNotesSection(novel.notes)
  const extra = [castSection, relationsSection, notesSection].filter((s) => s.length > 0).join('\n\n')

  const otherChapters = existing.chapters
    .filter((c) => c.chapter_number !== chapterNumber)
    .map((c) => `第${c.chapter_number}章「${c.title}」: ${c.summary}`)
    .join('\n')

  const prompt = `あなたはプロの小説家です。既存の章立てのうち、指定された 1 章だけを書き直してください。

【作品情報】
タイトル: ${novel.title}
ジャンル: ${novel.genre}
登場人物: ${novel.characters}
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
- summary は 200 字程度。

出力は以下の JSON 形式 (chapter_number, title, summary のみ) のみ:
{ "chapter_number": ${chapterNumber}, "title": "...", "summary": "..." }`

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
    throw new Error(`Gemini regenerateOutlineChapter failed: ${res.status} ${err}`)
  }

  const data = (await res.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string }> }
      finishReason?: string
      safetyRatings?: Array<{ category: string; probability: string; blocked?: boolean }>
    }>
    promptFeedback?: { blockReason?: string; safetyRatings?: unknown }
  }
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
      .filter((s) => s.length > 0)
      .join(' / ')
    throw new Error(`Gemini returned empty regenerateOutlineChapter response (${detail})`)
  }

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
  return { ...validated.data, chapter_number: chapterNumber }
}

export type StreamChapterUsage = {
  model: string
  promptTokens: number
  outputTokens: number
  totalTokens: number
}

export type StreamChapterResult = {
  stream: ReadableStream<Uint8Array>
  usage: Promise<StreamChapterUsage>
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

  const styleInstruction = buildStyleInstruction(style)
  const castSection = buildCastSection(cast)
  const relationsSection = buildRelationsSection(relations)
  const writingRules = buildWritingRules(cast)
  // notes は章立て生成時にのみ使う (outline.summary に既に振り分けが乗っているため、
  // 本文生成では全体リストを再注入しない)。

  const sections: string[] = [
    `【作品情報】\nタイトル: ${novel.title}\nジャンル: ${novel.genre}\n登場人物: ${novel.characters}\n世界観・設定: ${novel.setting}`,
    `【文体・視点】\n${styleInstruction}`,
    castSection,
    relationsSection,
    writingRules,
    `【全体の章立て（概要）】\n${allChapterSummaries}`,
    prevChaptersText ? `【直前の章の本文（参考）】\n${prevChaptersText}` : '',
    `【執筆対象】\n第${chapterNumber}章「${targetEntry.title}」\n概要: ${targetEntry.summary}`
  ].filter((s) => s.length > 0)

  const prompt = `あなたはプロの小説家です。以下の設定と章立てに基づいて、指定された章の本文を執筆してください。

${sections.join('\n\n')}

上記の概要に沿って、第${chapterNumber}章の本文を執筆してください。
本文は日本語で約${targetChars}文字を目安に執筆してください。
登場キャラクター詳細を与えた場合は、各キャラの「口調の例」と「他者の呼び方」「関係」を必ずセリフに反映してください。
文章は読者を引き込む描写を心がけ、登場人物の心情や情景を丁寧に描いてください。
本文のみを出力し、章番号やタイトルは含めないでください。`

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    safetySettings: SAFETY_SETTINGS_OFF,
    generationConfig: {
      temperature: 0.9,
      maxOutputTokens: maxOutputTokens(model, targetChars)
    }
  }

  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>()
  const writer = writable.getWriter()
  const encoder = new TextEncoder()

  let resolveUsage!: (value: StreamChapterUsage) => void
  let rejectUsage!: (reason: unknown) => void
  const usage = new Promise<StreamChapterUsage>((res, rej) => {
    resolveUsage = res
    rejectUsage = rej
  })

  const doStream = async () => {
    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      })
    } catch (e) {
      rejectUsage(e)
      await writer.abort(e)
      return
    }

    if (!res.ok || !res.body) {
      const errText = await res.text().catch(() => String(res.status))
      const err = new Error(`Gemini streamChapter failed: ${res.status} ${errText}`)
      rejectUsage(err)
      await writer.abort(err)
      return
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let lastUsage: StreamChapterUsage | undefined

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
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
          const text = extractText(chunk)
          if (text) {
            await writer.write(encoder.encode(text))
          }
          const meta = extractUsage(chunk, model)
          if (meta) lastUsage = meta
        }
      }
    } finally {
      reader.releaseLock()
      await writer.close()
      if (lastUsage) {
        resolveUsage(lastUsage)
      } else {
        rejectUsage(new Error('Gemini stream ended without usageMetadata'))
      }
    }
  }

  doStream().catch(async (e) => {
    rejectUsage(e)
    try {
      await writer.abort(e)
    } catch {
      // already closed
    }
  })

  return { stream: readable, usage }
}

function extractUsage(chunk: unknown, model: string): StreamChapterUsage | undefined {
  if (typeof chunk !== 'object' || chunk === null) return undefined
  const c = chunk as Record<string, unknown>
  const meta = c.usageMetadata
  if (typeof meta !== 'object' || meta === null) return undefined
  const m = meta as Record<string, unknown>
  const promptTokens = typeof m.promptTokenCount === 'number' ? m.promptTokenCount : 0
  const outputTokens = typeof m.candidatesTokenCount === 'number' ? m.candidatesTokenCount : 0
  const totalTokens = typeof m.totalTokenCount === 'number' ? m.totalTokenCount : promptTokens + outputTokens
  return { model, promptTokens, outputTokens, totalTokens }
}

function extractText(chunk: unknown): string {
  if (typeof chunk !== 'object' || chunk === null) return ''
  const c = chunk as Record<string, unknown>
  const candidates = c.candidates
  if (!Array.isArray(candidates) || candidates.length === 0) return ''
  const first = candidates[0] as Record<string, unknown>
  const content = first.content as Record<string, unknown> | undefined
  if (!content) return ''
  const parts = content.parts
  if (!Array.isArray(parts) || parts.length === 0) return ''
  const part = parts[0] as Record<string, unknown>
  return typeof part.text === 'string' ? part.text : ''
}
