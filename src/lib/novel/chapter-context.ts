import type { PrismaClient } from '@/generated/prisma/client'
import type { Env } from '@/lib/db'
import { generateJson } from '@/lib/gemini/client'
import {
  bibleBlocker,
  castForPrompt,
  extractRecordFlow,
  type JsonCaller,
  type RecordFlowInput,
  type RecordFlowResult,
  reviewChapterFlow,
  toStoryBible
} from '@/lib/novel/assist'
import type { ReviewPromptInput } from '@/lib/novel/assist-prompts'
import { addressesFor, callsByName } from '@/lib/novel/bible'
import { type ChapterCheckInput, checkChapter } from '@/lib/novel/checks'
import { type GenerationCostInput, recordGenerationCost } from '@/lib/novel/cost'
import { buildLedger, LEDGER_MAX_CHARS, type Ledger, renderLedger } from '@/lib/novel/ledger'
import { contextBudgetTokens, selectPriorChapters, TOKENS_PER_CHAR } from '@/lib/novel/memory'
import {
  buildChapterPrompt,
  buildChapterPromptForStorage,
  type CastMember,
  type CastRelation,
  type ChapterPromptInput,
  type NextChapterInput,
  type NovelParams,
  narratorName,
  type PriorChapterInput,
  type Prompt,
  type RevisionInput,
  type StyleParams,
  trimChapterText
} from '@/lib/novel/prompts'
import {
  type ChapterLineage,
  findChapterVersion,
  getNovelWithChapters,
  saveChapterRecord,
  saveChapterReview
} from '@/lib/novel/repository'
import { missingPredecessors, normalizeTargets, outlineEntryHash } from '@/lib/novel/staleness'
import { findContextWindow } from '@/lib/openai/models'
import type { UsageCounts } from '@/lib/openai/protocol'
import { type ModelRef, type Outline, OutlineSchema, parseModelRef } from '@/schemas/novel.dto'
import {
  type ChapterRecord,
  type ChapterReview,
  EMPTY_END_STATE,
  type StoryBible,
  type StoryThread
} from '@/schemas/story.dto'

// 本文 1 章の生成の文脈 (送るプロンプト、保存用のプロンプト、記録の抽出の材料) を D1 から組み立てる。
// 判断を含む部分 (既出の章の選び方、確定事項、記録の無い章の扱い、再開の段階) は純粋関数にして bun test で検証する。
// DB と LLM に触れるのは「D1 から読む」の節の関数だけ。

// 章の生成の Durable Object に渡す payload。文脈は DO の中で実行時に D1 から組み立てる。
// DO ストレージに残っている旧形式の payload (novel、outline などを含む) も、最初の 3 項目は同じ名前で持つ。
// instruction と baseVersionId は指示つきの書き直しのときだけ (旧形式には無い。無ければ空とみなす)。
// instruction は利用者の自由記述なので、プロンプトに入れる以外に使わない (ログやエラー文に出さない)。
export type ChapterGenPayload = {
  novelId: string
  chapterNumber: number
  model?: ModelRef
  instruction?: string
  baseVersionId?: string
}

// 書き直しの指示 (前後の空白を除いたもの)。空なら通常の生成。生成の開始 (API) と文脈の組み立てが同じ判定を使う。
// 空白だけの指示は、プロンプトの側 (prompts.ts) でも書き直しとして扱われないので、ここでも通常の生成にする。
export function revisionInstruction(instruction: string | undefined): string {
  return instruction === undefined ? '' : instruction.trim()
}

// バリエーション (variant) の生フィールド。name/gender は variant では不変なので持たない。
type VariantFields = {
  id: string
  age: string
  occupation: string
  appearance: string
  first_person: string
  address_others: string
  speech_examples: string
  description: string
}

// getNovelWithChapters が返す character_links の要素 (variant 込み)。
type CharacterLink = {
  character_id: string
  role: string
  variant_id: string | null
  character: {
    name: string
    gender: string
    age: string
    occupation: string
    appearance: string
    first_person: string
    address_others: string
    speech_examples: string
    description: string
    variants: VariantFields[]
  }
}

type EffectiveCharacter = {
  name: string
  gender: string
  age: string
  occupation: string
  appearance: string
  first_person: string
  address_others: string
  speech_examples: string
  description: string
}

// variant_id が指す variant の非空フィールドをベースに重ねる (name/gender は不変)。
// variant が見つからない (削除済み等) ときはベースのまま返す。
function effectiveCharacter(link: CharacterLink): EffectiveCharacter {
  const base = link.character
  if (link.variant_id === null) return base
  const v = base.variants.find((x) => x.id === link.variant_id)
  if (v === undefined) return base
  const pick = (variantValue: string, baseValue: string) => (variantValue !== '' ? variantValue : baseValue)
  // speech_examples は JSON 文字列。空配列 '[]' は未設定としてベース継承する。
  const speech = v.speech_examples !== '' && v.speech_examples !== '[]' ? v.speech_examples : base.speech_examples
  return {
    name: base.name,
    gender: base.gender,
    age: pick(v.age, base.age),
    occupation: pick(v.occupation, base.occupation),
    appearance: pick(v.appearance, base.appearance),
    first_person: pick(v.first_person, base.first_person),
    address_others: pick(v.address_others, base.address_others),
    speech_examples: speech,
    description: pick(v.description, base.description)
  }
}

// 視点キャラの表示用 (選択 variant をマージした名前・一人称)。未指定なら undefined。
export function viewpointCharFor(
  characterLinks: CharacterLink[],
  povCharacterId: string
): { name: string; first_person: string } | undefined {
  if (povCharacterId === '') return undefined
  const link = characterLinks.find((l) => l.character_id === povCharacterId)
  if (link === undefined) return undefined
  const eff = effectiveCharacter(link)
  return { name: eff.name, first_person: eff.first_person }
}

export function buildCastForGemini(characterLinks: CharacterLink[]): CastMember[] {
  return characterLinks.map((l) => {
    const eff = effectiveCharacter(l)
    let speech: string[] = []
    try {
      const parsed = JSON.parse(eff.speech_examples)
      if (Array.isArray(parsed)) speech = parsed.filter((s) => typeof s === 'string')
    } catch {
      // malformed stored value — skip
    }
    return {
      name: eff.name,
      role: l.role,
      gender: eff.gender,
      age: eff.age,
      occupation: eff.occupation,
      appearance: eff.appearance,
      first_person: eff.first_person,
      address_others: eff.address_others,
      speech_examples: speech,
      description: eff.description
    }
  })
}

export function buildRelationsForGemini(
  relations: Array<{
    source_name: string
    target_name: string
    relation: string
    description: string
    address_override: string
  }>
): CastRelation[] {
  return relations.map((r) => ({
    source_name: r.source_name,
    target_name: r.target_name,
    relation: r.relation,
    description: r.description,
    address_override: r.address_override
  }))
}

// ---------------------- 既出の章の選び方と確定事項 (純粋) ----------------------

// 各章の最新 version。
export type ContextChapter = {
  id: string
  number: number
  title: string | null
  content: string
  // 保存済みの記録 (検証済み)。未抽出・抽出の失敗・この機能より前の章は null
  record: ChapterRecord | null
  // 生成に使った章立ての項目のハッシュ。この機能より前の章は null
  outlineHash: string | null
}

// 文脈の組み立ての材料 (D1 から読んだもの)。
export type ContextSource = {
  novel: NovelParams
  outline: Outline
  chapterNumber: number
  targetChars: number
  style: StyleParams
  // 辞典の人物設定 (variant を反映したもの)。成人指定で作品設計があれば、プロンプトには作品設計の設定に差し替えて渡す
  cast: CastMember[]
  relations: CastRelation[]
  // 作品設計。無い旧データ、または保存値が読めないときは null
  bible: StoryBible | null
  // 作品設計の列に値があるのに読めない (壊れている) か
  bibleUnreadable: boolean
  // 指示つきの書き直しのとき、元の版の本文と指示。通常の生成では null
  revision: RevisionInput | null
  // 執筆上の指示 (Novel.writing_notes)。無ければ ''
  writingNotes: string
  // 各章の最新 version。今回の章以降を含んでいてもよい (組み立てで除く)
  chapters: ContextChapter[]
}

// 生成を始めてはいけない理由 (無ければ null)。判定は assist.ts の bibleBlocker (章立ての生成、プレビューと同じ)。
// 成人指定で、作品設計が条件を満たさないとき (手で直して壊れた、年齢指定を後から変えた、人物を足した) と、
// 作品設計の保存値が読めないとき。作品設計が無い旧データは止めない (辞典の原文と読み替えの指示で書く)。
export function contextBlocker(
  source: Pick<ContextSource, 'bible' | 'bibleUnreadable' | 'style' | 'cast'>
): string | null {
  return bibleBlocker(source)
}

// 章立てでその章に張る予定の伏線。章立てにその章が無ければ空。
export function setupsOf(outline: Outline, chapterNumber: number): StoryThread[] {
  const entry = outline.chapters.find((chapter) => chapter.chapter_number === chapterNumber)
  return entry === undefined ? [] : entry.setups.map((setup) => ({ id: setup.id, description: setup.description }))
}

export type ContextBudget = { budgetTokens: number; tokensPerChar: number }

// 既出の章に使う予算。換算係数は書き手のモデルの提供元で、予算はモデルの contextWindow で決める。
// model が無いときは Gemini の既定のモデルで書くので、Gemini の係数を使う。
export function contextBudget(model: ModelRef | undefined, contextWindow: number | null): ContextBudget {
  const provider = model === undefined ? 'gemini' : parseModelRef(model).provider
  return { budgetTokens: contextBudgetTokens(contextWindow), tokensPerChar: TOKENS_PER_CHAR[provider] }
}

// 【確定事項】に使ってよいのは、既出の章の予算のうちこの割合まで。
// 確定事項は予算に関係なく毎章入るので、入力の上限が小さいモデルでは、これが無いと確定事項だけで溢れる。
const LEDGER_BUDGET_SHARE = 0.25

// 【確定事項】の文字数の上限。既定の上限 (LEDGER_MAX_CHARS) と、予算の LEDGER_BUDGET_SHARE ぶんの小さい方。
// 既定の予算 (12 万トークン、Gemini の 0.65 トークン/字) では既定の上限のまま。
// 直近 2 章は予算を超えても全文で入れる (memory.ts) ので、それでも溢れるほど小さいモデルは対象外。
export function ledgerMaxChars(budget: ContextBudget): number {
  return Math.min(LEDGER_MAX_CHARS, Math.floor((budget.budgetTokens * LEDGER_BUDGET_SHARE) / budget.tokensPerChar))
}

export type ContextPlan = {
  // モデルに送るプロンプト
  prompt: Prompt
  // Chapter.prompt に保存する文字列 (既出の章の本文は字数の 1 行)
  storagePrompt: string
  // 全文で渡す章と、記録に置き換えた章の番号 (どちらも昇順)
  full: number[]
  recorded: number[]
  // 記録に置き換えた章のうち、使える記録が無い章 (その場で抽出する対象)
  missing: number[]
  // 今回より前の章の記録を累積したもの
  ledger: Ledger
  // 本文と一緒に保存する、どの章立てと前章の版から作ったか (鮮度の判定に使う)
  lineage: ChapterLineage
}

// 次の章の冒頭として渡す長さの上限 (字)。
export const NEXT_OPENING_CHARS = 500

// 次の章の冒頭。前後の空行を除いた本文の先頭から、上限を超えない範囲の最後の改行まで (行の途中で切らない)。
// 最初の行だけで上限を超えるとき (改行が無いとき) は、上限の字数で切る。字数はコードポイントで数える (サロゲートを割らない)。
export function nextOpening(content: string, maxChars: number = NEXT_OPENING_CHARS): string {
  const chars = [...trimChapterText(content)]
  if (chars.length <= maxChars) return chars.join('')
  const head = chars.slice(0, maxChars).join('')
  // 上限のちょうど次が改行なら、上限までが行の切れ目
  if (chars[maxChars] === '\n') return head
  const lastBreak = head.lastIndexOf('\n')
  return lastBreak > 0 ? head.slice(0, lastBreak).trimEnd() : head
}

// 途中の章を書き直すとき、次の章 (番号 + 1) に本文があれば、その冒頭と章立ての題と概要を渡す。
// 本文が無ければ渡さない。今回の章が最終章なら、プロンプトの側が無視する。
// 次の章が今の章立てと違う章立てから書かれていたら (章立てを作り直した後)、渡さない。その本文は作り直す対象で、
// 「書き換えない次の章」として繋げると、古い展開に今回の章を合わせてしまうため。
// 前の章の作り直し (previous_regenerated) で古くなっただけの次の章は渡す (途中の章の書き直しは、まさにこの場合)。
// この機能より前の章 (ハッシュが null) は判定できないので渡す。
export function nextChapterOf(source: ContextSource): NextChapterInput | null {
  const nextNumber = source.chapterNumber + 1
  const next = source.chapters.find((chapter) => chapter.number === nextNumber)
  if (next === undefined || trimChapterText(next.content).length === 0) return null
  const entry = source.outline.chapters.find((chapter) => chapter.chapter_number === nextNumber)
  const planChanged = next.outlineHash !== null && (entry === undefined || outlineEntryHash(entry) !== next.outlineHash)
  if (planChanged) return null
  return {
    opening: nextOpening(next.content),
    title: entry === undefined ? '' : entry.title,
    summary: entry === undefined ? '' : entry.summary
  }
}

// 今回の章をどの章立てと前章の版から作るか。前章は最新 version (本文があるもの) の id。第 1 章は null。
// 章立てに今回の章が無ければ null のハッシュ (その場合 buildChapterPrompt が throw する)。
export function lineageOf(source: ContextSource): ChapterLineage {
  const entry = source.outline.chapters.find((chapter) => chapter.chapter_number === source.chapterNumber)
  const previous = source.chapters.find((chapter) => chapter.number === source.chapterNumber - 1)
  return {
    outlineHash: entry === undefined ? null : outlineEntryHash(entry),
    prevChapterId: previous === undefined || trimChapterText(previous.content).length === 0 ? null : previous.id
  }
}

function priorChaptersOf(source: ContextSource): ContextChapter[] {
  return source.chapters.filter((chapter) => chapter.number < source.chapterNumber).sort((a, b) => a.number - b.number)
}

// 保存済みの記録が優先。無ければ、その場で抽出したものか仮の記録 (extra)。
function effectiveRecord(chapter: ContextChapter, extra: ReadonlyMap<number, ChapterRecord>): ChapterRecord | null {
  if (chapter.record !== null) return chapter.record
  const added = extra.get(chapter.number)
  return added === undefined ? null : added
}

// 記録のある章だけから確定事項を作る。全文で渡す章の記録も入れる (全体の流れと人物ごとの記録を毎回渡すため)。
export function ledgerOf(chapters: ContextChapter[], extra: ReadonlyMap<number, ChapterRecord>): Ledger {
  return buildLedger(
    chapters.flatMap((chapter) => {
      const record = effectiveRecord(chapter, extra)
      return record === null ? [] : [{ number: chapter.number, record }]
    })
  )
}

// 本文のプロンプトを組み立てる。既出の章 (今回より前の章の最新 version) は予算に収まる間は全文で、
// 超えたら古い章から記録に置き換える (memory.ts)。予算の見積もりに使う「本文以外の資料」の文字数は、
// 既出の章を 1 つも入れず、【確定事項】は入れて組み立てたプロンプトの長さ。
// 章立てに今回の章が無ければ throw する (buildChapterPrompt)。
export function planChapterContext(
  source: ContextSource,
  budget: ContextBudget,
  extra: ReadonlyMap<number, ChapterRecord> = new Map()
): ContextPlan {
  const prior = priorChaptersOf(source)
  const ledger = ledgerOf(prior, extra)
  const base: Omit<ChapterPromptInput, 'priorChapters'> = {
    novel: source.novel,
    outline: source.outline,
    chapterNumber: source.chapterNumber,
    targetChars: source.targetChars,
    style: source.style,
    cast: castForPrompt(source.cast, source.style, source.bible),
    relations: source.relations,
    // 直前の章の記録が無いとき、もっと前の章の章末を「直前の章の終わり」として出さない (previousChapter)。
    ledgerText: renderLedger(ledger, { maxChars: ledgerMaxChars(budget), previousChapter: source.chapterNumber - 1 }),
    bible: source.bible,
    writingNotes: source.writingNotes,
    nextChapter: nextChapterOf(source),
    revision: source.revision
  }
  const skeleton = buildChapterPrompt({ ...base, priorChapters: [] })
  const selection = selectPriorChapters(
    prior.map((chapter) => ({
      number: chapter.number,
      title: chapter.title === null ? '' : chapter.title,
      content: chapter.content
    })),
    { ...budget, reservedChars: skeleton.system.length + skeleton.user.length }
  )
  const recorded = new Set(selection.recorded)
  const priorChapters = prior.map(
    (chapter): PriorChapterInput =>
      recorded.has(chapter.number)
        ? { chapter_number: chapter.number, title: chapter.title, omitted: true }
        : { chapter_number: chapter.number, title: chapter.title, content: chapter.content }
  )
  const input: ChapterPromptInput = { ...base, priorChapters }
  return {
    prompt: buildChapterPrompt(input),
    storagePrompt: buildChapterPromptForStorage(input),
    full: selection.full,
    recorded: selection.recorded,
    missing: prior
      .filter((chapter) => recorded.has(chapter.number) && effectiveRecord(chapter, extra) === null)
      .map((chapter) => chapter.number),
    ledger,
    lineage: lineageOf(source)
  }
}

// 記録の抽出に失敗した章の代わり (保存しない)。要約は章立てのその章の概要そのもの。概要が無ければ null。
export function provisionalRecord(outline: Outline, chapterNumber: number): ChapterRecord | null {
  const entry = outline.chapters.find((chapter) => chapter.chapter_number === chapterNumber)
  const summary = entry === undefined ? '' : entry.summary.trim()
  if (summary.length === 0) return null
  return {
    summary,
    facts: [],
    characters: [],
    threads_opened: [],
    threads_resolved: [],
    end_state: { ...EMPTY_END_STATE, present: [] }
  }
}

// ---------------------- 記録の抽出の材料 (純粋) ----------------------

// 章の記録の抽出に、章ごとに変わらない材料 (本文と章番号以外)。
export type RecordMaterials = Pick<RecordFlowInput, 'castNames' | 'openThreads' | 'plannedSetups' | 'narrator'>

// 記録の抽出のプロンプトは語り手を「本文の一人称の人物」として書くので、一人称のときだけ渡す。
// 三人称一元視点の視点人物は「私」ではないので渡さない。
export function recordNarrator(style: StyleParams, cast: CastMember[]): string | undefined {
  return style.pov === '一人称' ? narratorName(style, cast) : undefined
}

// 確定事項の未回収の伏線を、記録の抽出に渡す形 (id と説明) にする。
export function openThreadsOf(ledger: Ledger): StoryThread[] {
  return ledger.openThreads.map((thread) => ({ id: thread.id, description: thread.description }))
}

// ledger は、記録を作る章より前の章の記録を累積したもの。未回収の伏線をそこから取る。
// plannedSetups は、章立てでその章に張る予定の伏線 (setupsOf)。実際に書かれたものを記録に答えさせる。
export function recordMaterials(
  cast: CastMember[],
  style: StyleParams,
  ledger: Ledger,
  plannedSetups: StoryThread[]
): RecordMaterials {
  return {
    castNames: cast.map((member) => member.name),
    narrator: recordNarrator(style, cast),
    openThreads: openThreadsOf(ledger),
    plannedSetups
  }
}

// ---------------------- 記録の無い章の補い ----------------------

// 章の記録をその場で作る。作れなければ null (呼び出し側が仮の記録で代用する)。
// openThreads は、その章より前の章までに未回収の伏線。plannedSetups は、章立てでその章に張る予定の伏線。
export type RecordExtractor = (
  chapter: ContextChapter,
  threads: { openThreads: StoryThread[]; plannedSetups: StoryThread[] }
) => Promise<ChapterRecord | null>

export type ResolvedContext = {
  plan: ContextPlan
  // 今回の章の記録の抽出の材料 (未回収の伏線は今回より前の章までの分、張る予定の伏線は今回の章の章立てから)
  record: RecordMaterials
  // その場で記録を作れた章と、仮の記録で代用した章
  extracted: number[]
  provisional: number[]
}

type Settling = {
  extra: Map<number, ChapterRecord>
  attempted: Set<number>
  extracted: number[]
  provisional: number[]
}

async function extractSafely(
  extract: RecordExtractor,
  chapter: ContextChapter,
  threads: { openThreads: StoryThread[]; plannedSetups: StoryThread[] }
): Promise<ChapterRecord | null> {
  try {
    return await extract(chapter, threads)
  } catch (e) {
    console.warn(`record extraction for chapter ${chapter.number} failed`, e)
    return null
  }
}

// 記録に置き換える章に記録が無ければ、古い章から 1 章ずつ作って組み立て直す。
// 記録が増えると【確定事項】が伸びて置き換える章が増えることがあるので、毎回選び直す。
// 試した章は覚えておき、同じ章を 2 度試さない (仮の記録も作れない章があっても必ず終わる)。
async function settleRecords(
  source: ContextSource,
  budget: ContextBudget,
  extract: RecordExtractor,
  onProgress: () => void,
  state: Settling
): Promise<ResolvedContext> {
  const plan = planChapterContext(source, budget, state.extra)
  const next = plan.missing.find((number) => !state.attempted.has(number))
  const chapter = next === undefined ? undefined : source.chapters.find((candidate) => candidate.number === next)
  if (next === undefined || chapter === undefined) {
    return {
      plan,
      record: recordMaterials(source.cast, source.style, plan.ledger, setupsOf(source.outline, source.chapterNumber)),
      extracted: state.extracted,
      provisional: state.provisional
    }
  }
  const earlier = priorChaptersOf(source).filter((candidate) => candidate.number < next)
  const threads = {
    openThreads: openThreadsOf(ledgerOf(earlier, state.extra)),
    plannedSetups: setupsOf(source.outline, next)
  }
  onProgress()
  const record = await extractSafely(extract, chapter, threads)
  onProgress()
  const fallback = record === null ? provisionalRecord(source.outline, next) : null
  const added = record !== null ? record : fallback
  const extra = new Map(state.extra)
  if (added !== null) extra.set(next, added)
  return settleRecords(source, budget, extract, onProgress, {
    extra,
    attempted: new Set([...state.attempted, next]),
    extracted: record !== null ? [...state.extracted, next] : state.extracted,
    provisional: fallback !== null ? [...state.provisional, next] : state.provisional
  })
}

// 既出の章を選び、記録に置き換える章で記録が無いものを補ってから、プロンプトを組み立てる。
// onProgress は、時間のかかる処理 (その場の記録の抽出) の前後に呼ぶ。
export function resolveChapterContext(
  source: ContextSource,
  budget: ContextBudget,
  extract: RecordExtractor,
  onProgress: () => void = () => {}
): Promise<ResolvedContext> {
  return settleRecords(source, budget, extract, onProgress, {
    extra: new Map(),
    attempted: new Set(),
    extracted: [],
    provisional: []
  })
}

// ---------------------- 再開 (純粋) ----------------------

// run() をどこから始めるか。本文を保存済み (chapterId あり) なら、その章を保存済みとして記録の抽出から続ける。
// 本文を作り直すと同じ章の version が二重にでき、費用も二重にかかるため。null なら文脈の組み立てから (本文を書く)。
export function resumePoint(state: {
  chapterId: string | null
  chapterTitle: string | null
}): { chapterId: string; title: string } | null {
  if (state.chapterId === null) return null
  return { chapterId: state.chapterId, title: state.chapterTitle === null ? '' : state.chapterTitle }
}

export type RestartableState = { buffer: string; chapterId: string | null; chapterTitle: string | null }

// 止まった run() を alarm や openStream が起動し直すときの状態。
// 本文を保存済みなら、本文と保存先をそのまま残す (再接続した画面に本文を見せ続け、記録の抽出から続ける)。
// 保存前なら、途中までの本文を捨てて最初からやり直す。
export function restartState(state: RestartableState): RestartableState {
  if (state.chapterId !== null) return { ...state }
  return { buffer: '', chapterId: null, chapterTitle: null }
}

// 記録の抽出の段階で、保存済みの行をどう扱うか。
//   missing  行が無い (章立ての作り直しや削除で消えた)。完了扱いにせず error にする
//   skip     検証できる記録が既にある (前の run() が抽出まで済ませていた)
//   extract  抽出する
export function recordStageAction(saved: { record: ChapterRecord | null } | null): 'missing' | 'skip' | 'extract' {
  if (saved === null) return 'missing'
  return saved.record === null ? 'extract' : 'skip'
}

function parseOutline(raw: string | null): Outline | null {
  if (raw === null || raw.length === 0) return null
  try {
    const result = OutlineSchema.safeParse(JSON.parse(raw))
    return result.success ? result.data : null
  } catch {
    return null
  }
}

// ---------------------- D1 から読む ----------------------

// 補助の呼び出しのコストを記録する。記録に失敗しても生成結果は返したいので、例外は警告に留める。
export async function recordCostsBestEffort(
  prisma: PrismaClient,
  env: Env,
  target: Omit<GenerationCostInput, 'usage'>,
  usages: UsageCounts[]
): Promise<void> {
  for (const usage of usages) {
    try {
      await recordGenerationCost(prisma, env, { ...target, usage })
    } catch (e) {
      console.warn(`${target.kind} cost record failed`, e)
    }
  }
}

// assist.ts の流れに渡す LLM の呼び出し。model が undefined なら既定のモデル。
export function jsonCaller(env: Env, model: ModelRef | undefined): JsonCaller {
  return (prompt, options) => generateJson(env, model, prompt, options)
}

export type RecordTarget = {
  novelId: string
  chapterId: string
  chapterNumber: number
  title: string | null
  content: string
}

// 1 章の記録を作って保存し、コストを kind: 'record'・その章番号で記録する (失敗した回の分も)。
// 保存に失敗しても、作れた記録は返す (呼び出し側はこの回の確定事項に使える)。
export async function extractAndSaveRecord(
  prisma: PrismaClient,
  env: Env,
  call: JsonCaller,
  target: RecordTarget,
  materials: RecordMaterials
): Promise<RecordFlowResult> {
  const result = await extractRecordFlow(call, {
    ...materials,
    chapterNumber: target.chapterNumber,
    title: target.title,
    content: target.content
  })
  await recordCostsBestEffort(
    prisma,
    env,
    { novelId: target.novelId, chapterNumber: target.chapterNumber, kind: 'record' },
    result.usages
  )
  if (!result.ok) {
    console.warn(`record extraction for chapter ${target.chapterNumber} failed: ${result.error}`)
    return result
  }
  try {
    await saveChapterRecord(prisma, target.chapterId, result.record)
  } catch (e) {
    console.warn(`record save for chapter ${target.chapterNumber} failed`, e)
  }
  return result
}

type LoadedNovel = NonNullable<Awaited<ReturnType<typeof getNovelWithChapters>>>

function novelParams(novel: LoadedNovel): NovelParams {
  return {
    title: novel.title,
    genre: novel.genre,
    setting: novel.setting,
    num_chapters: novel.num_chapters,
    outline_summary_chars: novel.outline_summary_chars,
    notes: novel.notes
  }
}

function styleOf(novel: LoadedNovel): StyleParams {
  return {
    pov: novel.pov,
    tone: novel.tone,
    age_rating: novel.age_rating,
    ending: novel.ending,
    viewpointChar: viewpointCharFor(novel.character_links, novel.pov_character_id)
  }
}

function contextChapters(novel: LoadedNovel): ContextChapter[] {
  return novel.chapters.map((chapter) => ({
    id: chapter.id,
    number: chapter.chapter_number,
    title: chapter.title,
    content: chapter.content,
    record: chapter.record,
    outlineHash: chapter.outline_hash
  }))
}

export type ChapterContext = {
  prompt: Prompt
  storagePrompt: string
  // 章の題 (章立ての題)。本文と一緒に保存する
  title: string
  // 記録の抽出に使うモデル
  editorModel: ModelRef
  // この章の記録の抽出の材料 (未回収の伏線は、今回より前の章までの分)
  record: RecordMaterials
  // 本文と一緒に保存する、どの章立てと前章の版から作ったか
  lineage: ChapterLineage
}

export type ChapterContextResult = { ok: true; context: ChapterContext } | { ok: false; error: string }

// 段階 1: 文脈の組み立て。小説、章立て、名簿、関係、各章の最新 version を D1 から読み、
// 記録に置き換える章で記録が無いものはその場で抽出して保存する。
export async function buildChapterContext(
  prisma: PrismaClient,
  env: Env,
  payload: ChapterGenPayload,
  hooks: { onProgress?: () => void } = {}
): Promise<ChapterContextResult> {
  const novel = await getNovelWithChapters(prisma, payload.novelId)
  if (novel === null) return { ok: false, error: '小説が見つかりません' }
  const outline = parseOutline(novel.outline)
  if (outline === null) return { ok: false, error: '章立てがまだ作られていないか、読み込めません' }
  const entry = outline.chapters.find((chapter) => chapter.chapter_number === payload.chapterNumber)
  if (entry === undefined) return { ok: false, error: `章立てに第 ${payload.chapterNumber} 章がありません` }

  const cast = buildCastForGemini(novel.character_links)
  const style = styleOf(novel)
  const chapters = contextChapters(novel)
  const revision = await loadRevision(prisma, payload, chapters)
  if (!revision.ok) return revision
  const source: ContextSource = {
    novel: novelParams(novel),
    outline,
    chapterNumber: payload.chapterNumber,
    targetChars: novel.target_chars,
    style,
    cast,
    relations: buildRelationsForGemini(novel.relations),
    bible: novel.bible === null ? null : toStoryBible(novel.bible),
    bibleUnreadable: novel.bible_unreadable,
    revision: revision.revision,
    writingNotes: novel.writing_notes,
    chapters
  }
  // 記録の抽出 (費用がかかる) より前に止める。
  const blocker = contextBlocker(source)
  if (blocker !== null) return { ok: false, error: blocker }
  const contextWindow = payload.model === undefined ? null : await findContextWindow(env, payload.model)
  const editorModel = novel.editor_model
  const call = jsonCaller(env, editorModel)
  const narrator = recordNarrator(style, cast)
  const extract: RecordExtractor = async (chapter, threads) => {
    const result = await extractAndSaveRecord(
      prisma,
      env,
      call,
      {
        novelId: payload.novelId,
        chapterId: chapter.id,
        chapterNumber: chapter.number,
        title: chapter.title,
        content: chapter.content
      },
      { castNames: cast.map((member) => member.name), narrator, ...threads }
    )
    return result.ok ? result.record : null
  }
  const resolved = await resolveChapterContext(
    source,
    contextBudget(payload.model, contextWindow),
    extract,
    hooks.onProgress === undefined ? () => {} : hooks.onProgress
  )
  return {
    ok: true,
    context: {
      prompt: resolved.plan.prompt,
      storagePrompt: resolved.plan.storagePrompt,
      title: entry.title,
      editorModel,
      record: resolved.record,
      lineage: resolved.plan.lineage
    }
  }
}

// 再開したとき (本文は保存済み) の記録の抽出の材料。文脈は組み立て直さず、保存済みの記録だけから未回収の伏線を取る
// (段階 1 でその場で作った記録は保存済み。仮の記録は伏線を持たないので、結果は最初の run() と同じになる)。
export async function loadRecordMaterials(
  prisma: PrismaClient,
  payload: ChapterGenPayload
): Promise<{ editorModel: ModelRef; materials: RecordMaterials } | null> {
  const novel = await getNovelWithChapters(prisma, payload.novelId)
  if (novel === null) return null
  const earlier = contextChapters(novel).filter((chapter) => chapter.number < payload.chapterNumber)
  const outline = parseOutline(novel.outline)
  return {
    editorModel: novel.editor_model,
    materials: recordMaterials(
      buildCastForGemini(novel.character_links),
      styleOf(novel),
      ledgerOf(earlier, new Map()),
      outline === null ? [] : setupsOf(outline, payload.chapterNumber)
    )
  }
}

// 生成の開始 (API) が DO に渡す payload。小説があり、章立てにその章があるときだけ作る (無ければ null)。
// 文脈は DO が組み立てるので、ここでは章立てだけを読む。
// ---------------------- 生成の開始の検証 ----------------------

export type GenerationTargets = { ok: true; targets: number[] } | { ok: false; missing: number[] }

// 生成する章 (重複を除いて昇順) と、本文がある章から、前の章が欠けていないかを確かめる。
// 対象より前の章は、本文があるか、同じ生成の対象 (先に書かれる) でなければならない。
export function checkGenerationTargets(targets: number[], written: Set<number>): GenerationTargets {
  const normalized = normalizeTargets(targets)
  const missing = missingPredecessors(normalized, written)
  return missing.length === 0 ? { ok: true, targets: normalized } : { ok: false, missing }
}

// 409 previous_chapters_missing の detail (「第 2、3 章」)。
export function missingChaptersDetail(missing: number[]): string {
  return `第 ${missing.join('、')} 章`
}

export type GenerationStart =
  | { ok: true; payload: ChapterGenPayload; targets: number[] }
  | { ok: false; status: 404; error: 'not_found' }
  | { ok: false; status: 400; error: 'invalid_bible'; detail: string }
  | { ok: false; status: 409; error: 'previous_chapters_missing'; detail: string }

// 生成の開始の判定の材料 (D1 から読んだもの)。
export type GenerationStartSource = {
  outline: Outline | null
  // 本文がある章の番号
  written: Set<number>
  // 作品設計で生成を止める理由 (contextBlocker と同じ判定)。止めなければ null
  blocker: string | null
}

// 生成を始めてよいか。順に、小説と章立ての最初の対象の章 (404)、成人指定の作品設計 (400 invalid_bible)、
// 前の章が欠けていないか (409)。ジョブを running にする前、DO を起動する前に判定する
// (DO の文脈の段階でも同じ判定をする。開始の時点で止めれば、利用者がストリームのエラーで初めて気付くことも、
// ジョブが一度 running になることも無い)。対象は重複を除いて昇順にする。
export function decideGenerationStart(
  source: GenerationStartSource | null,
  novelId: string,
  targets: number[],
  model: ModelRef
): GenerationStart {
  const normalized = normalizeTargets(targets)
  const first = normalized.length === 0 ? undefined : normalized[0]
  if (source === null || source.outline === null || first === undefined) {
    return { ok: false, status: 404, error: 'not_found' }
  }
  if (!source.outline.chapters.some((chapter) => chapter.chapter_number === first)) {
    return { ok: false, status: 404, error: 'not_found' }
  }
  if (source.blocker !== null) return { ok: false, status: 400, error: 'invalid_bible', detail: source.blocker }
  const checked = checkGenerationTargets(normalized, source.written)
  if (!checked.ok) {
    return {
      ok: false,
      status: 409,
      error: 'previous_chapters_missing',
      detail: missingChaptersDetail(checked.missing)
    }
  }
  return { ok: true, payload: { novelId, chapterNumber: first, model }, targets: checked.targets }
}

// 生成の開始の判定を D1 から行う (小説、章立て、名簿、作品設計、各章の最新 version を読む)。
export async function prepareGenerationStart(
  prisma: PrismaClient,
  novelId: string,
  targets: number[],
  model: ModelRef
): Promise<GenerationStart> {
  const novel = await getNovelWithChapters(prisma, novelId)
  if (novel === null) return decideGenerationStart(null, novelId, targets, model)
  const blocker = contextBlocker({
    style: styleOf(novel),
    cast: buildCastForGemini(novel.character_links),
    bible: novel.bible === null ? null : toStoryBible(novel.bible),
    bibleUnreadable: novel.bible_unreadable
  })
  const source = {
    outline: parseOutline(novel.outline),
    written: new Set(novel.chapters.map((chapter) => chapter.chapter_number)),
    blocker
  }
  return decideGenerationStart(source, novelId, targets, model)
}

// ---------------------- 指示つきの書き直し ----------------------

export type RevisionBaseRow = { novel_id: string; chapter_number: number; content: string }

export type RevisionBase = { ok: true; content: string } | { ok: false; error: string }

// 書き直しの元の版を選ぶ。baseVersionId が空ならその章の最新 version。指定があれば、その行がこの小説のこの章のものであること。
// 元の版が無い・本文が空・別の小説や別の章の版なら失敗。エラー文に指示の文面は入れない。
export function revisionBaseOf(input: {
  novelId: string
  chapterNumber: number
  baseVersionId: string
  latest: ContextChapter | undefined
  row: RevisionBaseRow | null
}): RevisionBase {
  const missing = `書き直す元の版がありません（第 ${input.chapterNumber} 章の本文を確かめてください）`
  if (input.baseVersionId.length === 0) {
    return input.latest === undefined || trimChapterText(input.latest.content).length === 0
      ? { ok: false, error: missing }
      : { ok: true, content: input.latest.content }
  }
  const row = input.row
  if (row === null || row.novel_id !== input.novelId || row.chapter_number !== input.chapterNumber) {
    return { ok: false, error: '書き直す元の版が見つかりません（この小説のこの章の版ではありません）' }
  }
  return trimChapterText(row.content).length === 0 ? { ok: false, error: missing } : { ok: true, content: row.content }
}

// 書き直しなら元の版を読んで revision を作る。通常の生成なら null。
async function loadRevision(
  prisma: PrismaClient,
  payload: ChapterGenPayload,
  chapters: ContextChapter[]
): Promise<{ ok: true; revision: RevisionInput | null } | { ok: false; error: string }> {
  const instruction = revisionInstruction(payload.instruction)
  if (instruction.length === 0) return { ok: true, revision: null }
  const baseVersionId = payload.baseVersionId === undefined ? '' : payload.baseVersionId.trim()
  const row = baseVersionId.length === 0 ? null : await findChapterVersion(prisma, baseVersionId)
  const base = revisionBaseOf({
    novelId: payload.novelId,
    chapterNumber: payload.chapterNumber,
    baseVersionId,
    latest: chapters.find((chapter) => chapter.number === payload.chapterNumber),
    row
  })
  return base.ok ? { ok: true, revision: { baseContent: base.content, instruction } } : base
}

// ---------------------- 検査 (Phase 5) ----------------------

// 検査の材料 (D1 から読んだもの)。
export type ReviewSource = {
  outline: Outline
  chapterNumber: number
  // 検査する版 (保存した chapterId の行。最新とは限らない)
  title: string | null
  content: string
  targetChars: number
  style: StyleParams
  // 辞典の人物設定 (variant を反映したもの)
  cast: CastMember[]
  bible: StoryBible | null
  bibleUnreadable: boolean
  // 各章の最新 version (今回の章より前の章を、確定事項と章末の比較に使う)
  chapters: ContextChapter[]
}

export type ReviewInputs = {
  check: ChapterCheckInput
  // モデルの検査の入力。作品設計で生成を止めるべき状態 (成人指定で検証に落ちる、読めない) なら null
  // (その人物設定をモデルに渡さない。機械的な検査だけを保存する)
  review: ReviewPromptInput | null
}

// その章に登場する人物。章立ての登場予定 (と語り手) で絞る。登場予定が名簿の誰とも一致しなければ全員
// (本文プロンプトの splitCast と同じ考え方)。
function presentCast(cast: CastMember[], characters: string[], style: StyleParams): CastMember[] {
  const listed = new Set(characters)
  if (!cast.some((member) => listed.has(member.name))) return cast
  const narrator = narratorName(style, cast)
  return cast.filter((member) => listed.has(member.name) || member.name === narrator)
}

// 機械的な検査とモデルの検査の材料を組み立てる。章立てにその章が無ければ null。
export function reviewInputsOf(source: ReviewSource): ReviewInputs | null {
  const entry = source.outline.chapters.find((chapter) => chapter.chapter_number === source.chapterNumber)
  if (entry === undefined) return null
  const prior = source.chapters
    .filter((chapter) => chapter.number < source.chapterNumber)
    .sort((a, b) => a.number - b.number)
  const present = presentCast(source.cast, entry.characters, source.style)
  const presentNames = present.map((member) => member.name)
  const table = source.bible === null ? [] : source.bible.addresses
  const check: ChapterCheckInput = {
    chapter: { number: source.chapterNumber, content: source.content },
    targetChars: source.targetChars,
    plannedCharacters: entry.characters,
    castNames: source.cast.map((member) => member.name),
    ...(table.length > 0 ? { callsByName: callsByName(table) } : {}),
    speechExamples: entry.characters.length === 0 ? [] : present.flatMap((member) => member.speech_examples),
    otherChapters: prior.map((chapter) => ({ number: chapter.number, content: chapter.content })),
    ageRating: source.style.age_rating
  }
  const blocked = bibleBlocker(source)
  const review: ReviewPromptInput | null =
    blocked !== null
      ? null
      : {
          chapterNumber: source.chapterNumber,
          title: source.title,
          content: source.content,
          entry,
          bible: source.bible,
          // 検査する章より前の章までの確定事項
          ledgerText: renderLedger(ledgerOf(prior, new Map()), { previousChapter: source.chapterNumber - 1 }),
          cast: castForPrompt(present, source.style, source.bible),
          addresses: addressesFor(table, presentNames),
          style: source.style
        }
  return { check, review }
}

// 検査を何回まで走らせるか (最初の 1 回と、DO が落ちて失われたときのやり直し 1 回)。
export const MAX_REVIEW_ATTEMPTS = 2

export type ReviewAlarmAction = 'none' | 'keep' | 'retry' | 'give_up'

// 生成が終わった後 (phase が streaming でない) の alarm で、検査をどうするか。
//   none     検査待ちが無い (alarm の連鎖を終える)
//   keep     検査がこの DO で走っている (alarm を連鎖させて DO を生かす)
//   retry    検査待ちなのに走っていない (DO が落ちて失われた)。回数が残っていれば検査だけやり直す
//   give_up  やり直しの回数が尽きた、または検査する版が分からない。検査待ちを消す
export function reviewAlarmAction(state: {
  reviewPending: boolean
  reviewRunning: boolean
  reviewAttempts: number
  hasTarget: boolean
}): ReviewAlarmAction {
  if (!state.reviewPending) return 'none'
  if (!state.hasTarget) return 'give_up'
  if (state.reviewRunning) return 'keep'
  return state.reviewAttempts < MAX_REVIEW_ATTEMPTS ? 'retry' : 'give_up'
}

// 検査がこの DO のメモリで、いまの世代のものとして走っているか。
// 走っている世代が記録されていない (evict でメモリが消えた) か、古い世代の検査なら false。
export function isReviewRunning(runningGeneration: number | null, generation: number): boolean {
  return runningGeneration !== null && runningGeneration === generation
}

// 終わった検査が DO の状態 (検査待ちの印) を書き換えてよいか。始めた後に start() で世代が進んでいたら、
// 新しい生成の状態なので書き換えない (検査の結果は、検査した版の行にだけ書いてある)。
export function reviewOwnsState(startedGeneration: number, currentGeneration: number): boolean {
  return startedGeneration === currentGeneration
}

// ChapterReviewSchema の上限 (検査の警告の数)。
const REVIEW_CHECKS_MAX = 100

// 1 章の版を検査して、その版の行に保存する。機械的な検査は必ず、モデルの検査は作品設計で止めるべきでなければ走らせる。
// モデルの検査が失敗したら、機械的な検査の結果だけを reviewed: false で保存する。コストは kind: 'review'・この章番号。
// 検査する版が見つからない (削除された)、章立てにその章が無いときは何も保存しない ('skipped')。
// makeCall は editor_model からモデルの呼び出しを作る (既定は generateJson。テストでは偽の呼び出しを渡す)。
export async function reviewAndSave(
  prisma: PrismaClient,
  env: Env,
  target: { novelId: string; chapterNumber: number; chapterId: string },
  makeCall: (model: ModelRef) => JsonCaller = (model) => jsonCaller(env, model)
): Promise<'saved' | 'skipped'> {
  const novel = await getNovelWithChapters(prisma, target.novelId)
  const row = await findChapterVersion(prisma, target.chapterId)
  if (novel === null || row === null || row.novel_id !== target.novelId) return 'skipped'
  const outline = parseOutline(novel.outline)
  if (outline === null) return 'skipped'
  const inputs = reviewInputsOf({
    outline,
    chapterNumber: target.chapterNumber,
    title: row.title,
    content: row.content,
    targetChars: novel.target_chars,
    style: styleOf(novel),
    cast: buildCastForGemini(novel.character_links),
    bible: novel.bible === null ? null : toStoryBible(novel.bible),
    bibleUnreadable: novel.bible_unreadable,
    chapters: contextChapters(novel)
  })
  if (inputs === null) return 'skipped'
  const checks = checkChapter(inputs.check).slice(0, REVIEW_CHECKS_MAX)
  const model = inputs.review === null ? null : await reviewChapterFlow(makeCall(novel.editor_model), inputs.review)
  if (model !== null) {
    await recordCostsBestEffort(
      prisma,
      env,
      { novelId: target.novelId, chapterNumber: target.chapterNumber, kind: 'review' },
      model.usages
    )
  }
  const issues = model === null || !model.ok ? null : model.issues
  const review: ChapterReview = { checks, issues: issues === null ? [] : issues, reviewed: issues !== null }
  await saveChapterReview(prisma, target.chapterId, review)
  return 'saved'
}
