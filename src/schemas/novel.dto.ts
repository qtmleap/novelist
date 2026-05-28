import { z } from 'zod'

// 1 章あたりの目標文字数 (新規作成フォームのプリセット)。Novel ごとに保持し、
// 本文生成時にサーバーがプロンプトと maxOutputTokens に反映する。
export const CHAPTER_LENGTH_OPTIONS = [2000, 3000, 4000, 6000, 8000] as const
export const DEFAULT_TARGET_CHARS = 4000

// 文体: 視点(POV) と 文体トーン。生成プロンプトに反映する。
export const POV_OPTIONS = ['一人称', '三人称一元視点', '三人称多元視点', '三人称神視点'] as const
export const TONE_OPTIONS = ['ライトノベル調', '一般文芸', '文学的', 'やさしい文体'] as const
export const DEFAULT_POV = '一人称'
export const DEFAULT_TONE = '一般文芸'
// 語り手(視点キャラ)を指定できる POV。一人称 / 三人称一元視点 のとき pov_character_id が有効。
export const FOCAL_POVS: readonly string[] = ['一人称', '三人称一元視点']

// エンディングの方向性。プロンプトに反映し、章立て生成・本文生成のトーンに影響する。
export const ENDING_OPTIONS = [
  '未指定',
  'ハッピーエンド',
  'バッドエンド',
  'ビターエンド',
  'メリーバッドエンド',
  'オープンエンド'
] as const
export const DEFAULT_ENDING = '未指定'

// 小説内のキャラ間関係の種別 (NovelCharacterRelation.relation のプリセット)
export const RELATION_TYPES = ['家族', '恋愛', '友人', '幼馴染', '仲間', 'ライバル', '敵対', '師弟', 'その他'] as const

// 小説に登場するキャラ (辞典のキャラ + その小説での役割)
export const NovelCharacterLinkSchema = z.object({
  character_id: z.string().min(1),
  role: z.string().max(50).default('')
})
export type NovelCharacterLink = z.infer<typeof NovelCharacterLinkSchema>

// 小説内の キャラ A → キャラ B の関係 (有向)
export const NovelCharacterRelationInputSchema = z.object({
  source_character_id: z.string().min(1),
  target_character_id: z.string().min(1),
  relation: z.string().min(1, '関係を入力してください').max(50),
  description: z.string().max(500).default(''),
  // source が target を呼ぶときの呼び方の上書き (ADDRESS_STYLES, 空=本人の既定)
  address_override: z.string().max(20).default('')
})
export type NovelCharacterRelationInput = z.infer<typeof NovelCharacterRelationInputSchema>

// ---------------------- あらすじ入力 ----------------------

export const CreateNovelSchema = z.object({
  title: z.string().min(1, 'タイトルを入力してください').max(100),
  genre: z.string().min(1, 'ジャンルを入力してください').max(50),
  characters: z.string().max(2000),
  setting: z.string().max(4000),
  num_chapters: z.number().int().min(1).max(30),
  target_chars: z.number().int().min(500).max(20000).default(DEFAULT_TARGET_CHARS),
  pov: z.string().max(30).default(DEFAULT_POV),
  tone: z.string().max(30).default(DEFAULT_TONE),
  pov_character_id: z.string().max(50).default(''),
  ending: z.string().max(30).default(DEFAULT_ENDING),
  character_links: z.array(NovelCharacterLinkSchema).max(50).default([]),
  relations: z.array(NovelCharacterRelationInputSchema).max(100).default([])
})
export type CreateNovelInput = z.infer<typeof CreateNovelSchema>

// ---------------------- 章立て (outline) ----------------------

export const OutlineChapterSchema = z.object({
  chapter_number: z.number().int().min(1),
  title: z.string(),
  summary: z.string()
})
export type OutlineChapter = z.infer<typeof OutlineChapterSchema>

export const OutlineSchema = z.object({
  chapters: z.array(OutlineChapterSchema)
})
export type Outline = z.infer<typeof OutlineSchema>

// ---------------------- 永続化された Novel / Chapter ----------------------
// 日付は Response.json 経由で ISO 文字列になるため string で受ける。
// Novel.outline は OutlineSchema を JSON.stringify した文字列 (未生成時は null)。

export const ChapterSchema = z.object({
  id: z.string(),
  novel_id: z.string(),
  chapter_number: z.number().int().min(1),
  title: z.string().nullable(),
  content: z.string(),
  created_at: z.string()
})
export type Chapter = z.infer<typeof ChapterSchema>

export const NovelSchema = z.object({
  id: z.string(),
  title: z.string(),
  genre: z.string(),
  characters: z.string(),
  setting: z.string(),
  num_chapters: z.number().int(),
  target_chars: z.number().int(),
  pov: z.string(),
  tone: z.string(),
  pov_character_id: z.string(),
  ending: z.string(),
  outline: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string()
})
export type Novel = z.infer<typeof NovelSchema>

// 詳細レスポンス用: 役割・関係を名前付きで解決した形
export const NovelCastMemberSchema = z.object({
  character_id: z.string(),
  name: z.string(),
  role: z.string()
})
export type NovelCastMember = z.infer<typeof NovelCastMemberSchema>

export const NovelRelationSchema = z.object({
  source_character_id: z.string(),
  source_name: z.string(),
  target_character_id: z.string(),
  target_name: z.string(),
  relation: z.string(),
  description: z.string(),
  address_override: z.string()
})
export type NovelRelation = z.infer<typeof NovelRelationSchema>

// 章ごとの生成コスト (別テーブル ChapterGenerationCost を集計)
export const ChapterCostSchema = z.object({
  chapter_number: z.number().int(),
  model: z.string(),
  prompt_tokens: z.number().int(),
  output_tokens: z.number().int(),
  cost_usd: z.number()
})
export type ChapterCost = z.infer<typeof ChapterCostSchema>

export const NovelWithChaptersSchema = NovelSchema.extend({
  chapters: z.array(ChapterSchema),
  cast: z.array(NovelCastMemberSchema).default([]),
  relations: z.array(NovelRelationSchema).default([]),
  generation_costs: z.array(ChapterCostSchema).default([]),
  total_cost_usd: z.number().default(0)
})
export type NovelWithChapters = z.infer<typeof NovelWithChaptersSchema>

// 一覧用 (chapters は含めない)
export type NovelSummary = Novel

// ---------------------- 章生成 SSE ストリーミング契約 ----------------------
// POST /api/novels/[id]/chapters/[number]/generate は Content-Type: text/event-stream で
// 以下のいずれかの JSON を `data: ` 行として逐次送出する。
//   { delta: string }                                  生成テキストの増分
//   { done: true, chapterId: string, title: string }   完了 (この時点で D1 保存済み)
//   { error: string }                                  生成失敗
// フロントの src/lib/stream.ts がこれをパースする。

export const ChapterStreamEventSchema = z.union([
  z.object({ delta: z.string() }),
  z.object({ done: z.literal(true), chapterId: z.string(), title: z.string() }),
  z.object({ error: z.string() })
])
export type ChapterStreamEvent = z.infer<typeof ChapterStreamEventSchema>

// ---------------------- AI モデル設定 ----------------------
// Editor = 章立て(outline)生成, Writer = 本文生成。
// 設定は端末の localStorage に保存し、生成リクエストの body でサーバーへ渡す。
// model はサーバー側で Gemini の URL パスに入るため、必ず enum で検証する。

// 公式 (ai.google.dev/gemini-api/docs/models) 準拠。2.0 系は 2026-06-01 停止のため除外。
export const GEMINI_MODELS = [
  'gemini-3.5-flash',
  'gemini-3.1-pro-preview',
  'gemini-3-flash-preview',
  'gemini-3.1-flash-lite',
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite'
] as const
export const GeminiModelSchema = z.enum(GEMINI_MODELS)
export type GeminiModel = z.infer<typeof GeminiModelSchema>

export const DEFAULT_EDITOR_MODEL: GeminiModel = 'gemini-2.5-flash'
export const DEFAULT_WRITER_MODEL: GeminiModel = 'gemini-2.5-flash'

// 設定画面の ☆ 表示用。各 1〜5 (多いほど良い)。price は「安さ」(多いほど安価)。
export const MODEL_META: Record<GeminiModel, { quality: number; speed: number; price: number }> = {
  'gemini-3.5-flash': { quality: 4, speed: 4, price: 2 },
  'gemini-3.1-pro-preview': { quality: 5, speed: 2, price: 1 },
  'gemini-3-flash-preview': { quality: 4, speed: 4, price: 3 },
  'gemini-3.1-flash-lite': { quality: 3, speed: 5, price: 4 },
  'gemini-2.5-pro': { quality: 5, speed: 2, price: 2 },
  'gemini-2.5-flash': { quality: 3, speed: 4, price: 4 },
  'gemini-2.5-flash-lite': { quality: 2, speed: 5, price: 5 }
}

// outline / chapter 生成エンドポイント共通の body (model 上書き; 省略時はサーバー既定)
export const GenerateOptionsSchema = z.object({
  model: GeminiModelSchema.optional()
})
export type GenerateOptions = z.infer<typeof GenerateOptionsSchema>

// outline 生成時のみ使える追加オプション: 章の指定セットだけ (既存 outline ありの場合のみ意味を持つ)。
export const GenerateOutlineOptionsSchema = GenerateOptionsSchema.extend({
  chapters: z.array(z.number().int().min(1)).optional()
})
export type GenerateOutlineOptions = z.infer<typeof GenerateOutlineOptionsSchema>
