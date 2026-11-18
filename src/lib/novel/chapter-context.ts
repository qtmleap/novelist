import type { PrismaClient } from '@/generated/prisma/client'
import type { Env } from '@/lib/db'
import { generateJson } from '@/lib/gemini/client'
import { extractRecordFlow, type JsonCaller, type RecordFlowInput, type RecordFlowResult } from '@/lib/novel/assist'
import { type GenerationCostInput, recordGenerationCost } from '@/lib/novel/cost'
import { buildLedger, type Ledger, renderLedger } from '@/lib/novel/ledger'
import { contextBudgetTokens, selectPriorChapters, TOKENS_PER_CHAR } from '@/lib/novel/memory'
import {
  buildChapterPrompt,
  buildChapterPromptForStorage,
  type CastMember,
  type CastRelation,
  type ChapterPromptInput,
  type NovelParams,
  narratorName,
  type PriorChapterInput,
  type Prompt,
  type StyleParams
} from '@/lib/novel/prompts'
import { getNovelWithChapters, saveChapterRecord } from '@/lib/novel/repository'
import { findContextWindow } from '@/lib/openai/models'
import type { UsageCounts } from '@/lib/openai/protocol'
import { type ModelRef, type Outline, OutlineSchema, parseModelRef } from '@/schemas/novel.dto'
import { type ChapterRecord, EMPTY_END_STATE, type StoryThread } from '@/schemas/story.dto'

// 本文 1 章の生成の文脈 (送るプロンプト、保存用のプロンプト、記録の抽出の材料) を D1 から組み立てる。
// 判断を含む部分 (既出の章の選び方、確定事項、記録の無い章の扱い、再開の段階) は純粋関数にして bun test で検証する。
// DB と LLM に触れるのは「D1 から読む」の節の関数だけ。

// 章の生成の Durable Object に渡す payload。文脈は DO の中で実行時に D1 から組み立てる。
// DO ストレージに残っている旧形式の payload (novel、outline などを含む) も、この 3 項目は同じ名前で持つ。
export type ChapterGenPayload = { novelId: string; chapterNumber: number; model?: ModelRef }

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
}

// 文脈の組み立ての材料 (D1 から読んだもの)。
export type ContextSource = {
  novel: NovelParams
  outline: Outline
  chapterNumber: number
  targetChars: number
  style: StyleParams
  cast: CastMember[]
  relations: CastRelation[]
  // 各章の最新 version。今回の章以降を含んでいてもよい (組み立てで除く)
  chapters: ContextChapter[]
}

export type ContextBudget = { budgetTokens: number; tokensPerChar: number }

// 既出の章に使う予算。換算係数は書き手のモデルの提供元で、予算はモデルの contextWindow で決める。
// model が無いときは Gemini の既定のモデルで書くので、Gemini の係数を使う。
export function contextBudget(model: ModelRef | undefined, contextWindow: number | null): ContextBudget {
  const provider = model === undefined ? 'gemini' : parseModelRef(model).provider
  return { budgetTokens: contextBudgetTokens(contextWindow), tokensPerChar: TOKENS_PER_CHAR[provider] }
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
    cast: source.cast,
    relations: source.relations,
    ledgerText: renderLedger(ledger)
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
    ledger
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
export function recordMaterials(cast: CastMember[], style: StyleParams, ledger: Ledger): RecordMaterials {
  return {
    castNames: cast.map((member) => member.name),
    narrator: recordNarrator(style, cast),
    openThreads: openThreadsOf(ledger),
    // 章立てから張る予定の伏線が渡るのは Phase 3 から
    plannedSetups: []
  }
}

// ---------------------- 記録の無い章の補い ----------------------

// 章の記録をその場で作る。作れなければ null (呼び出し側が仮の記録で代用する)。
// openThreads は、その章より前の章までに未回収の伏線。
export type RecordExtractor = (chapter: ContextChapter, openThreads: StoryThread[]) => Promise<ChapterRecord | null>

export type ResolvedContext = {
  plan: ContextPlan
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
  openThreads: StoryThread[]
): Promise<ChapterRecord | null> {
  try {
    return await extract(chapter, openThreads)
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
    return { plan, extracted: state.extracted, provisional: state.provisional }
  }
  const earlier = priorChaptersOf(source).filter((candidate) => candidate.number < next)
  const openThreads = openThreadsOf(ledgerOf(earlier, state.extra))
  onProgress()
  const record = await extractSafely(extract, chapter, openThreads)
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

// 保存済みの章立て (JSON 文字列) に、その章があるか。壊れた章立ては「無い」とみなす。
export function outlineHasChapter(raw: string | null, chapterNumber: number): boolean {
  const outline = parseOutline(raw)
  if (outline === null) return false
  return outline.chapters.some((chapter) => chapter.chapter_number === chapterNumber)
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
    record: chapter.record
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
  const source: ContextSource = {
    novel: novelParams(novel),
    outline,
    chapterNumber: payload.chapterNumber,
    targetChars: novel.target_chars,
    style,
    cast,
    relations: buildRelationsForGemini(novel.relations),
    chapters: contextChapters(novel)
  }
  const contextWindow = payload.model === undefined ? null : await findContextWindow(env, payload.model)
  const editorModel = novel.editor_model
  const call = jsonCaller(env, editorModel)
  const narrator = recordNarrator(style, cast)
  const extract: RecordExtractor = async (chapter, openThreads) => {
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
      { castNames: cast.map((member) => member.name), narrator, openThreads, plannedSetups: [] }
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
      record: recordMaterials(cast, style, resolved.plan.ledger)
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
  return {
    editorModel: novel.editor_model,
    materials: recordMaterials(buildCastForGemini(novel.character_links), styleOf(novel), ledgerOf(earlier, new Map()))
  }
}

// 生成の開始 (API) が DO に渡す payload。小説があり、章立てにその章があるときだけ作る (無ければ null)。
// 文脈は DO が組み立てるので、ここでは章立てだけを読む。
export async function chapterGenPayload(
  prisma: PrismaClient,
  novelId: string,
  chapterNumber: number,
  model: ModelRef
): Promise<ChapterGenPayload | null> {
  const novel = await prisma.novel.findUnique({ where: { id: novelId }, select: { outline: true } })
  if (novel === null) return null
  return outlineHasChapter(novel.outline, chapterNumber) ? { novelId, chapterNumber, model } : null
}
