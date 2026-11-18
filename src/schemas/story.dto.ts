import { z } from 'zod'

// 物語の整合性を保つためのデータ (docs/plans/2026-11-18-novel-consistency.md)。
// DB では JSON 文字列で保存し、API では検証済みのオブジェクトで返す。
// 文字列の上限は「保存してよい大きさ」の目安。モデルの出力はコード側で切り詰めてから検証する。

// ---------------------- 生成コストの種別 (Phase 0) ----------------------
// chapter = 本文、outline = 章立て、bible = 作品設計、record = 章の記録の抽出、review = 検査。
// 本文以外で作品単位の呼び出しは chapter_number = 0 で記録する。
export const COST_KINDS = ['chapter', 'outline', 'bible', 'record', 'review'] as const
export const CostKindSchema = z.enum(COST_KINDS)
export type CostKind = z.infer<typeof CostKindSchema>

// ---------------------- 伏線 ----------------------
// 章立ての「張る伏線」と、章の記録の「実際に張られた伏線」で同じ形を使う。
// 章立てで計画した伏線の id は章立てが決める。本文で新しく生まれた伏線の id はコードが振る。
export const StoryThreadSchema = z.object({
  id: z.string().nonempty().max(40),
  description: z.string().nonempty().max(400)
})
export type StoryThread = z.infer<typeof StoryThreadSchema>

// ---------------------- 章の記録 (Phase 2) ----------------------
// 本文を書いた結果として決まったこと。Chapter.record に version ごとに 1:1 で保存する。

export const CharacterStateSchema = z.object({
  name: z.string().nonempty().max(100),
  // 章末の状態 (居場所、知っていること、関係の変化)
  state: z.string().nonempty().max(600)
})
export type CharacterState = z.infer<typeof CharacterStateSchema>

export const EndStateSchema = z.object({
  time: z.string().max(200).default(''),
  place: z.string().max(200).default(''),
  // 章末にその場にいる人物
  present: z.array(z.string().nonempty().max(100)).max(50).default([])
})
export type EndState = z.infer<typeof EndStateSchema>

export const EMPTY_END_STATE: EndState = { time: '', place: '', present: [] }

export const ChapterRecordSchema = z.object({
  // 実際に起きたこと (300 字程度、三人称の常体)
  summary: z.string().nonempty().max(4000),
  // 新しく確定した事実 (外見、持ち物、約束、場所、日付)
  facts: z.array(z.string().nonempty().max(400)).max(60).default([]),
  character_states: z.array(CharacterStateSchema).max(50).default([]),
  // この章で張られた伏線
  threads_opened: z.array(StoryThreadSchema).max(30).default([]),
  // この章で回収された伏線の id
  threads_resolved: z.array(z.string().nonempty().max(40)).max(60).default([]),
  end_state: EndStateSchema.default(EMPTY_END_STATE)
})
export type ChapterRecord = z.infer<typeof ChapterRecordSchema>

// モデルに返させる形。伏線の id はモデルに作らせない:
//   new_threads          計画に無く、この章で新しく生まれた伏線 (説明文だけ。id はコードが振る)
//   resolved_thread_ids  渡した「未回収の伏線」のうち、この章で回収されたものの id
//   written_setup_ids    渡した「この章で張る予定の伏線」のうち、実際に書かれたものの id
// 長さの上限は付けない (超えた分はコードが切り詰める)。
export const ChapterRecordDraftSchema = z.object({
  summary: z.string().nonempty(),
  facts: z.array(z.string().nonempty()).default([]),
  character_states: z.array(z.object({ name: z.string().nonempty(), state: z.string().nonempty() })).default([]),
  new_threads: z.array(z.string().nonempty()).default([]),
  resolved_thread_ids: z.array(z.string().nonempty()).default([]),
  written_setup_ids: z.array(z.string().nonempty()).default([]),
  end_state: z
    .object({
      time: z.string().max(2000).default(''),
      place: z.string().max(2000).default(''),
      present: z.array(z.string().nonempty()).default([])
    })
    .default(EMPTY_END_STATE)
})
export type ChapterRecordDraft = z.infer<typeof ChapterRecordDraftSchema>

// ---------------------- 作品設計 (Phase 3) ----------------------
// 作品につき 1 回作り、章立てと全章の本文に同じものを渡す。Novel.bible に保存する。

export const StoryArcSchema = z.object({
  name: z.string().nonempty().max(100),
  // 物語の始まりの状態と、終わりの状態
  start: z.string().max(800).default(''),
  end: z.string().max(800).default('')
})
export type StoryArc = z.infer<typeof StoryArcSchema>

export const StoryTermSchema = z.object({
  // 表記を固定する固有名詞・用語
  term: z.string().nonempty().max(100),
  note: z.string().max(600).default('')
})
export type StoryTerm = z.infer<typeof StoryTermSchema>

export const StoryWorldSchema = z.object({
  rules: z.array(z.string().nonempty().max(600)).max(40).default([]),
  terms: z.array(StoryTermSchema).max(80).default([])
})
export type StoryWorld = z.infer<typeof StoryWorldSchema>

// 呼称表の 1 行。from が to を call と呼ぶ (call は本文にそのまま書ける具体的な文字列)。
export const AddressEntrySchema = z.object({
  from: z.string().nonempty().max(100),
  to: z.string().nonempty().max(100),
  call: z.string().nonempty().max(60)
})
export type AddressEntry = z.infer<typeof AddressEntrySchema>

// 年齢指定 (R15 / R18) に合わせて確定した人物設定。全年齢では空配列。
// 口調の例と一人称は辞典 (Character) のものを使うので、ここには持たない。
export const BibleCastSchema = z.object({
  name: z.string().nonempty().max(100),
  age: z.string().max(50).default(''),
  occupation: z.string().max(100).default(''),
  appearance: z.string().max(2000).default(''),
  background: z.string().max(4000).default('')
})
export type BibleCast = z.infer<typeof BibleCastSchema>

export const EMPTY_WORLD: StoryWorld = { rules: [], terms: [] }

export const StoryBibleSchema = z.object({
  // 物語の核 (誰が何を求め、何が妨げるか)
  premise: z.string().max(3000).default(''),
  // 結末の具体像 (最終章で何が起きるか)
  ending: z.string().max(3000).default(''),
  arcs: z.array(StoryArcSchema).max(50).default([]),
  world: StoryWorldSchema.default(EMPTY_WORLD),
  // 物語内の時系列 (期間、季節、章と日付の対応)。1 行 1 項目。
  timeline: z.array(z.string().nonempty().max(600)).max(80).default([]),
  addresses: z.array(AddressEntrySchema).max(600).default([]),
  cast: z.array(BibleCastSchema).max(50).default([])
})
export type StoryBible = z.infer<typeof StoryBibleSchema>

// ---------------------- 章立ての警告 (Phase 1 / 3) ----------------------
// 章立ての生成結果と一緒に返す。chapter_number = 0 は章立て全体への警告。
//   dropped_character  名簿と照合できず捨てた登場人物名
//   unresolved_setup   どの章でも回収されない伏線
export const OUTLINE_WARNING_KINDS = ['dropped_character', 'unresolved_setup'] as const
export const OutlineWarningSchema = z.object({
  chapter_number: z.number().int().min(0),
  kind: z.enum(OUTLINE_WARNING_KINDS),
  message: z.string().nonempty().max(600)
})
export type OutlineWarning = z.infer<typeof OutlineWarningSchema>

// ---------------------- 鮮度 (Phase 4) ----------------------
// 上流 (章立て、前の章) が変わって、この章の本文が古い前提のまま残っていること。
//   outline_changed       生成後に、この章の章立てが変わった
//   previous_regenerated  生成後に、直前の章が作り直された (または消えた)
//   previous_stale        直前の章が「要再生成」
export const STALE_REASONS = ['outline_changed', 'previous_regenerated', 'previous_stale'] as const
export const StaleReasonSchema = z.enum(STALE_REASONS)
export type StaleReason = z.infer<typeof StaleReasonSchema>

export const ChapterStalenessSchema = z.object({
  stale: z.boolean(),
  reasons: z.array(StaleReasonSchema).default([])
})
export type ChapterStaleness = z.infer<typeof ChapterStalenessSchema>

// ---------------------- 検査 (Phase 0 / 5) ----------------------
// コードで機械的に検査した結果。
//   length                文字数が目標から外れている
//   missing_character     登場予定の人物が本文に出てこない
//   unexpected_character  登場予定でない名簿の人物が本文に出ている
//   ending_overlap        章末の言い回しが他の章と重なっている
//   speech_copy           口調の例が本文にそのまま使われている
//   indent                段落頭の字下げが揃っていない
export const CHECK_KINDS = [
  'length',
  'missing_character',
  'unexpected_character',
  'ending_overlap',
  'speech_copy',
  'indent'
] as const
export const CheckKindSchema = z.enum(CHECK_KINDS)
export type CheckKind = z.infer<typeof CheckKindSchema>

export const CheckWarningSchema = z.object({
  kind: CheckKindSchema,
  message: z.string().nonempty().max(600)
})
export type CheckWarning = z.infer<typeof CheckWarningSchema>

// モデルに検査させた矛盾の指摘。quote は本文からの引用 (本文に実在しない指摘はコードが捨てる)。
//   setting  設定 (作品設計・人物設定) との矛盾     fact      既出の事実との矛盾
//   address  呼称・一人称の誤り                     timeline  時系列の矛盾
//   thread   伏線の扱いの誤り                       presence  その場に居ない人物の言動
export const REVIEW_ISSUE_KINDS = ['setting', 'fact', 'address', 'timeline', 'thread', 'presence', 'other'] as const
export const ReviewIssueKindSchema = z.enum(REVIEW_ISSUE_KINDS)
export type ReviewIssueKind = z.infer<typeof ReviewIssueKindSchema>

export const ReviewIssueSchema = z.object({
  kind: ReviewIssueKindSchema,
  quote: z.string().nonempty().max(600),
  reason: z.string().nonempty().max(800)
})
export type ReviewIssue = z.infer<typeof ReviewIssueSchema>

// Chapter.review に保存する形。
export const ChapterReviewSchema = z.object({
  checks: z.array(CheckWarningSchema).max(100).default([]),
  issues: z.array(ReviewIssueSchema).max(100).default([]),
  // モデルの検査まで済んだか。false = コードの検査だけ (モデルの検査が未実行か失敗)
  reviewed: z.boolean().default(false)
})
export type ChapterReview = z.infer<typeof ChapterReviewSchema>
