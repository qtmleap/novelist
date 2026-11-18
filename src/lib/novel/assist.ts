import type { z } from 'zod'
import {
  bibleAddressPairs,
  buildBiblePrompt,
  buildRecordPrompt,
  buildReviewPrompt,
  REVIEW_ISSUES_MAX,
  REVIEW_QUOTE_MIN_CHARS,
  type ReviewPromptInput
} from '@/lib/novel/assist-prompts'
import {
  type AdultBibleText,
  applyBibleCast,
  type BibleSourceInput,
  bibleSourceHash,
  completeAddresses,
  findMinorTerms,
  isAdultRating,
  missingAddressPairs,
  validateAdultBibleText,
  validateAdultCast
} from '@/lib/novel/bible'
import { bibleJsonSchema, recordJsonSchema, reviewJsonSchema } from '@/lib/novel/json-schemas'
import { finalizeRecord } from '@/lib/novel/ledger'
import {
  type JsonSchema,
  normalizeOutlineCharacters,
  outlineChapterJsonSchema,
  outlineJsonSchema,
  parseOutlineChapterResponse,
  parseOutlineResponse,
  sortOutline,
  validateOutlineShape,
  validateThreads
} from '@/lib/novel/outline'
import {
  buildOutlineChapterPrompt,
  buildOutlinePrompt,
  type CastMember,
  type CastRelation,
  type NovelParams,
  narratorName,
  type OutlinePromptInput,
  type Prompt,
  type StyleParams
} from '@/lib/novel/prompts'
import type { UsageCounts } from '@/lib/openai/protocol'
import type { Outline, OutlineChapter, StoredBible } from '@/schemas/novel.dto'
import {
  type BibleCast,
  type ChapterRecord,
  ChapterRecordDraftSchema,
  type OutlineWarning,
  REVIEW_ISSUE_KINDS,
  type ReviewIssue,
  type ReviewIssueKind,
  type StoryBible,
  StoryBibleSchema,
  type StoryThread
} from '@/schemas/story.dto'

// 非ストリームの LLM 呼び出しの流れ (プロンプトを組み立て、呼び、応答を解釈・検証し、通らなければやり直す)。
// LLM の呼び出しは引数 (JsonCaller) で受け取る。このファイルは env にも fetch にも触れないので、
// bun test で偽の呼び出しを渡して検証できる。実際の呼び出しは gemini/client.ts の generateJson。

export type JsonCallOptions = { op: string; schema?: JsonSchema; timeoutMs?: number }

// 通信エラー、空の応答、ブロックは throw する。
export type JsonCaller = (
  prompt: Prompt,
  options: JsonCallOptions
) => Promise<{ text: string; usage: UsageCounts | undefined }>

export type OutlineFlowInput = {
  novel: NovelParams
  style: StyleParams
  // 辞典の人物設定 (variant を反映したもの)。成人指定で作品設計があれば、プロンプトには作品設計の設定に差し替えて渡す
  cast: CastMember[]
  relations: CastRelation[]
  // 各章の登場人物に必ず入れる名前 (語り手)。名簿に無い名前は無視される。
  alwaysInclude: string[]
  // 作品設計。無い旧データ、または保存値が読めないときは null
  bible: StoryBible | null
  // 作品設計の列に値があるのに読めない (壊れている) か。未作成 (列が null) は false
  bibleUnreadable: boolean
}

export type OutlineFlowResult =
  | { ok: true; outline: Outline; warnings: OutlineWarning[]; usages: UsageCounts[] }
  | { ok: false; error: string; usages: UsageCounts[] }

export type OutlineChapterFlowResult =
  | { ok: true; chapter: OutlineChapter; warnings: OutlineWarning[]; usages: UsageCounts[] }
  | { ok: false; error: string; usages: UsageCounts[] }

// 全章の章立ての応答を待つ上限は、章数に応じて伸ばす。全章を 1 回で書かせるので出力は章数に比例して長くなり、
// 思考するモデルでは 30 章で数分かかる。固定の上限では長い作品だけが時間切れ (やり直さず 502) になるため。
// 上限の上限は 10 分 (無応答で止まった呼び出しを、利用者が待ち続けずに済むように)。
const OUTLINE_TIMEOUT_BASE_MS = 180_000
const OUTLINE_TIMEOUT_PER_CHAPTER_MS = 15_000
const OUTLINE_TIMEOUT_MAX_MS = 600_000
// 1 章の書き直しは出力が 1 章ぶんなので、章数によらず 3 分。
const OUTLINE_CHAPTER_TIMEOUT_MS = 180_000

export function outlineTimeoutMs(numChapters: number): number {
  return Math.min(OUTLINE_TIMEOUT_MAX_MS, OUTLINE_TIMEOUT_BASE_MS + numChapters * OUTLINE_TIMEOUT_PER_CHAPTER_MS)
}
// 解釈か検証に失敗したときに、同じプロンプトで呼ぶ回数の上限 (最初の 1 回を含む)。
const MAX_ATTEMPTS = 2

// ---------------------- 呼び出しとやり直し ----------------------

// 解釈の結果。失敗でも acceptable があれば「やり直したいが、最後の手段としては使える」値 (作品設計の呼称表が欠けている、など)。
// acceptableScore は使える値の悪さ (小さいほど良い)。2 回とも使える値だったとき、どちらを採るかに使う。
// 無ければ後の回を採る。
type Interpreted<T> = { ok: true; value: T } | { ok: false; error: string; acceptable?: T; acceptableScore?: number }

type Fallback<T> = { value: T; score: number | undefined }

// 前の回と今回の使える値のどちらを残すか。どちらにも悪さがあれば小さいほう (同じなら今回)。無ければ今回。
function betterFallback<T>(previous: Fallback<T> | undefined, next: Fallback<T> | undefined): Fallback<T> | undefined {
  if (next === undefined) return previous
  if (previous === undefined || previous.score === undefined || next.score === undefined) return next
  return previous.score < next.score ? previous : next
}

type CallOutcome<T> =
  | { ok: true; value: T; usages: UsageCounts[] }
  | { ok: false; error: string; usages: UsageCounts[] }

type CallResponse = { ok: true; text: string; usage: UsageCounts | undefined } | { ok: false; error: string }

async function callSafely(call: JsonCaller, prompt: Prompt, options: JsonCallOptions): Promise<CallResponse> {
  try {
    const { text, usage } = await call(prompt, options)
    return { ok: true, text, usage }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// 応答を interpret で解釈し、失敗したら同じプロンプトでやり直す (合計 attemptsLeft 回まで)。
// 呼び出し自体の失敗 (throw) はやり直さない。通信やブロックの失敗は、すぐ呼び直しても同じ結果になりやすいため。
// usages には、解釈か検証に失敗した回も含めて、usage が取れた全部の呼び出しを入れる (失敗した回もトークンは課金されている)。
// usage が取れるのは応答を受け取れた回だけ。呼び出し自体が失敗した回 (空の応答、ブロック、時間切れ) は取れない。
// 合格の値が得られないまま終わったときは、それまでに得た acceptable で合格にする (悪さが分かれば小さいほう、
// 分からなければ最後のもの)。やり直しの回の応答がより悪い (呼び出しの失敗や、使えない値) こともあるので、前の回の使える値を捨てない。
async function callUntilValid<T>(
  call: JsonCaller,
  prompt: Prompt,
  options: JsonCallOptions,
  interpret: (text: string) => Interpreted<T>,
  attemptsLeft: number,
  usages: UsageCounts[],
  fallback?: Fallback<T>
): Promise<CallOutcome<T>> {
  const response = await callSafely(call, prompt, options)
  if (!response.ok) return settle(fallback, response.error, usages)
  const nextUsages = response.usage === undefined ? usages : [...usages, response.usage]
  const interpreted = interpret(response.text)
  if (interpreted.ok) return { ok: true, value: interpreted.value, usages: nextUsages }
  const nextFallback = betterFallback(
    fallback,
    interpreted.acceptable === undefined
      ? undefined
      : { value: interpreted.acceptable, score: interpreted.acceptableScore }
  )
  if (attemptsLeft <= 1) return settle(nextFallback, interpreted.error, nextUsages)
  return callUntilValid(call, prompt, options, interpret, attemptsLeft - 1, nextUsages, nextFallback)
}

function settle<T>(fallback: Fallback<T> | undefined, error: string, usages: UsageCounts[]): CallOutcome<T> {
  return fallback === undefined ? { ok: false, error, usages } : { ok: true, value: fallback.value, usages }
}

function castNamesOf(cast: CastMember[]): string[] {
  return cast.map((member) => member.name)
}

function isAdultStyle(style: StyleParams): boolean {
  return style.age_rating !== undefined && isAdultRating(style.age_rating)
}

// プロンプトに渡す人物設定。成人指定で作品設計があれば、年齢・職業・外見・背景を作品設計の文面に差し替える
// (辞典の原文には未成年を連想させる記述が残りうるため)。それ以外は辞典の設定のまま。
export function castForPrompt(cast: CastMember[], style: StyleParams, bible: StoryBible | null): CastMember[] {
  return bible !== null && isAdultStyle(style) ? applyBibleCast(cast, bible.cast) : cast
}

// 章立てのプロンプトの入力 (人物設定は castForPrompt を通したもの)。プレビューも同じものを使う。
export function outlinePromptInput(input: OutlineFlowInput): OutlinePromptInput {
  return {
    novel: input.novel,
    style: input.style,
    cast: castForPrompt(input.cast, input.style, input.bible),
    relations: input.relations,
    bible: input.bible
  }
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// エラー文に載せる応答の先頭の長さ。応答の全文はログや画面に出さない。
const EXCERPT_CHARS = 200

function excerpt(text: string): string {
  const chars = [...text]
  return chars.length > EXCERPT_CHARS ? `${chars.slice(0, EXCERPT_CHARS).join('')}…` : text
}

type ParsedJson = { ok: true; value: unknown } | { ok: false; error: string }

function parseJsonText(text: string): ParsedJson {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false, error: `応答が JSON として読めません (応答の先頭: ${excerpt(text)})` }
  }
}

function describeIssues(issues: z.core.$ZodIssue[]): string {
  return issues
    .slice(0, 5)
    .map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`)
    .join(' / ')
}

// ---------------------- 章立て (全章) ----------------------

// 章の計画 (出来事、章末の状況) のうち欠けているもの。空なら欠けていない。
function missingPlanParts(chapter: OutlineChapter): string[] {
  return [
    chapter.events.some((event) => event.trim().length > 0) ? '' : '出来事',
    chapter.end_state.trim().length === 0 ? '章末の状況' : ''
  ].filter((part) => part.length > 0)
}

// 計画が欠けたまま保存した章の警告 (本文のプロンプトは、計画の無い章を旧データと同じ文面で扱える)。
export function missingPlanWarnings(chapters: OutlineChapter[]): OutlineWarning[] {
  return chapters.flatMap((chapter) => {
    const parts = missingPlanParts(chapter)
    if (parts.length === 0) return []
    return [
      {
        chapter_number: chapter.chapter_number,
        kind: 'missing_plan' as const,
        message: `第 ${chapter.chapter_number} 章の${parts.join('と')}がありません。章立てを編集するか、この章だけ作り直してください`
      }
    ]
  })
}

// 計画が欠けている章の、やり直しの理由の文。
function missingPlanError(chapters: OutlineChapter[]): string {
  const listed = chapters
    .filter((chapter) => missingPlanParts(chapter).length > 0)
    .map((chapter) => `第 ${chapter.chapter_number} 章の${missingPlanParts(chapter).join('と')}がありません`)
  return `章の計画が欠けています: ${listed.join('、')}`
}

// 章数・連番・題・概要の問題は不合格 (やり直し、2 回とも落ちたら失敗)。
// 計画 (出来事、章末の状況) が欠けているだけなら、やり直したうえで、やり直しても欠けていれば欠けたまま使う (acceptable)。
// 構造化出力で縛れない経路 (OpenAI 互換、schema を拒否された Gemini) や、章数が多いときに 1 章だけ欠けて、
// 章立て全体が作れなくなるのを避けるため。欠けた章は呼び出し側が missing_plan の警告にする。
function interpretOutline(text: string, numChapters: number): Interpreted<Outline> {
  const parsed = parseOutlineResponse(text)
  if (!parsed.ok) return parsed
  const outline = sortOutline(parsed.outline)
  const issues = validateOutlineShape(outline, numChapters)
  if (issues.length > 0) return { ok: false, error: `章立てが条件を満たしていません: ${issues.join('、')}` }
  if (missingPlanWarnings(outline.chapters).length > 0) {
    // 2 回とも計画が欠けていたら、欠けている章が少ないほうを採る (同じなら後の回)
    return {
      ok: false,
      error: missingPlanError(outline.chapters),
      acceptable: outline,
      acceptableScore: missingPlanWarnings(outline.chapters).length
    }
  }
  return { ok: true, value: outline }
}

// 全章の章立てを作る。解釈か検証に失敗したら 1 回だけやり直す。
// 通ったら登場人物を名簿の正式名に揃え、照合できなかった名前を警告にする。語り手は全章に足す。
// 伏線は validateThreads で検証・修復し、その警告も返す。
export async function generateOutlineFlow(call: JsonCaller, input: OutlineFlowInput): Promise<OutlineFlowResult> {
  const castNames = castNamesOf(input.cast)
  const outcome = await callUntilValid(
    call,
    buildOutlinePrompt(outlinePromptInput(input)),
    {
      op: 'generateOutline',
      schema: outlineJsonSchema(castNames),
      timeoutMs: outlineTimeoutMs(input.novel.num_chapters)
    },
    (text) => interpretOutline(text, input.novel.num_chapters),
    MAX_ATTEMPTS,
    []
  )
  if (!outcome.ok) return outcome
  const normalized = normalizeOutlineCharacters(outcome.value, castNames, input.alwaysInclude)
  const threads = validateThreads(normalized.outline)
  return {
    ok: true,
    outline: threads.outline,
    warnings: [...normalized.warnings, ...threads.warnings, ...missingPlanWarnings(threads.outline.chapters)],
    usages: outcome.usages
  }
}

// ---------------------- 章立て (1 章の書き直し) ----------------------

function interpretOutlineChapter(text: string, chapterNumber: number): Interpreted<OutlineChapter> {
  // 応答に複数の章が入っていたら (全章を返された、など)、対象の番号の章を選ばせる。先頭の章を取ると、
  // 別の章の内容を対象の章として保存してしまうため。選べなければ失敗として、やり直しに回す。
  const parsed = parseOutlineChapterResponse(text, chapterNumber)
  if (!parsed.ok) return parsed
  // 章 1 件だけの応答では、章番号をモデルが取り違えることがあるので、対象の章番号に揃える。
  const chapter = { ...parsed.chapter, chapter_number: chapterNumber }
  // 題と概要が空なら不合格。計画が欠けているだけなら、全章の生成と同じく、やり直しても欠けていれば欠けたまま使う。
  const issues = [
    chapter.title.trim().length === 0 ? `第 ${chapterNumber} 章の題が空です` : '',
    chapter.summary.trim().length === 0 ? `第 ${chapterNumber} 章の概要が空です` : ''
  ].filter((issue) => issue.length > 0)
  if (issues.length > 0) return { ok: false, error: `章立てが条件を満たしていません: ${issues.join('、')}` }
  if (missingPlanWarnings([chapter]).length > 0) {
    return { ok: false, error: missingPlanError([chapter]), acceptable: chapter }
  }
  return { ok: true, value: chapter }
}

// 既存の章立てのうち 1 章を書き直す。失敗したら 1 回だけやり直す。返すのは書き直した 1 章だけ (差し替えは呼び出し側)。
export async function regenerateOutlineChapterFlow(
  call: JsonCaller,
  input: OutlineFlowInput & { existing: Outline; chapterNumber: number }
): Promise<OutlineChapterFlowResult> {
  const { chapterNumber } = input
  const castNames = castNamesOf(input.cast)
  const outcome = await callUntilValid(
    call,
    buildOutlineChapterPrompt({ ...outlinePromptInput(input), existing: input.existing, chapterNumber }),
    {
      op: 'regenerateOutlineChapter',
      schema: outlineChapterJsonSchema(castNames),
      timeoutMs: OUTLINE_CHAPTER_TIMEOUT_MS
    },
    (text) => interpretOutlineChapter(text, chapterNumber),
    MAX_ATTEMPTS,
    []
  )
  if (!outcome.ok) return outcome
  const normalized = normalizeOutlineCharacters({ chapters: [outcome.value] }, castNames, input.alwaysInclude)
  // normalizeOutlineCharacters は章を 1 対 1 で写すので、1 章を渡せば 1 章が返る。
  const [chapter] = normalized.outline.chapters
  const others = input.existing.chapters.filter((other) => other.chapter_number !== chapterNumber)
  return {
    ok: true,
    chapter: freeSetupIds(chapter, others),
    warnings: [...normalized.warnings, ...missingPlanWarnings([chapter])],
    usages: outcome.usages
  }
}

function nextFreeSetupId(taken: ReadonlySet<string>, n = 1): string {
  const id = `s${n}`
  return taken.has(id) ? nextFreeSetupId(taken, n + 1) : id
}

// 書き直した章の伏線の id が、他の章の伏線の id と同じなら振り直す。
// そのままだと、章立て全体の検証 (validateThreads) が「後に出てきた重複」として他の章の伏線のほうを振り直し、
// その伏線を回収していた章が、書き直した章の新しい伏線を指してしまう。
// この章の古い版の id は他の章に無いので、そのまま使える (書き直しで同じ伏線を張り直したとき、回収との繋がりを保つ)。
function freeSetupIds(chapter: OutlineChapter, others: OutlineChapter[]): OutlineChapter {
  const taken = new Set(others.flatMap((other) => other.setups.map((setup) => setup.id.trim())))
  const setups = chapter.setups.map((setup) => {
    const id = setup.id.trim()
    const free = taken.has(id) ? nextFreeSetupId(taken) : id
    taken.add(free)
    return free === setup.id ? setup : { ...setup, id: free }
  })
  return { ...chapter, setups }
}

// ---------------------- 章立て (選んだ章の書き直し) ----------------------

// 章を差し替える (無ければ足す)。章番号の昇順に並べて返す。
export function replaceOutlineChapter(outline: Outline, chapter: OutlineChapter): Outline {
  const others = outline.chapters.filter((ch) => ch.chapter_number !== chapter.chapter_number)
  return sortOutline({ ...outline, chapters: [...others, chapter] })
}

export type OutlineChaptersResult =
  | { ok: true; outline: Outline; warnings: OutlineWarning[] }
  | { ok: false; error: string }

type ChapterUsagesHandler = (chapterNumber: number, usages: UsageCounts[]) => Promise<void>

// 選んだ章を targets の順に 1 章ずつ書き直す。書き直した章は、次の章の資料 (他の章) に入れる。
// 途中の章で失敗したら、そこで止めて失敗を返す (それまでの結果は呼び出し側が保存しない)。
// onUsages は章ごとに呼ぶ。後の章で失敗しても、それまでに払った分を記録できるように。
// 1 章でも書き直したら、差し替えた後の章立て全体に validateThreads をかけ、その警告も返す
// (書き直した章の回収が、別の章の伏線を指していることがあるため)。
export async function regenerateOutlineChapters(
  call: JsonCaller,
  input: OutlineFlowInput,
  outline: Outline,
  targets: number[],
  onUsages: ChapterUsagesHandler
): Promise<OutlineChaptersResult> {
  const result = await rewriteChapters(call, input, outline, targets, onUsages, [])
  if (!result.ok || targets.length === 0) return result
  const threads = validateThreads(result.outline)
  return { ok: true, outline: threads.outline, warnings: [...result.warnings, ...threads.warnings] }
}

async function rewriteChapters(
  call: JsonCaller,
  input: OutlineFlowInput,
  outline: Outline,
  targets: number[],
  onUsages: ChapterUsagesHandler,
  warnings: OutlineWarning[]
): Promise<OutlineChaptersResult> {
  if (targets.length === 0) return { ok: true, outline, warnings }
  const [chapterNumber, ...rest] = targets
  const result = await regenerateOutlineChapterFlow(call, { ...input, existing: outline, chapterNumber })
  await onUsages(chapterNumber, result.usages)
  if (!result.ok) return { ok: false, error: result.error }
  return rewriteChapters(call, input, replaceOutlineChapter(outline, result.chapter), rest, onUsages, [
    ...warnings,
    ...result.warnings
  ])
}

// ---------------------- 章の記録の抽出 (Phase 2) ----------------------

export type RecordFlowInput = {
  chapterNumber: number
  title: string | null
  // この章の本文
  content: string
  // 名簿 (人物の名前を正式名に寄せるのに使う)
  castNames: string[]
  // この章の前までに未回収の伏線
  openThreads: StoryThread[]
  // 章立てでこの章に張る予定の伏線 (Phase 3 から渡る。それまでは空)
  plannedSetups: StoryThread[]
  // 一人称の本文の語り手の名前 (任意)。本文の「私」が誰かをプロンプトに書く
  narrator?: string
}

export type RecordFlowResult =
  | { ok: true; record: ChapterRecord; usages: UsageCounts[] }
  | { ok: false; error: string; usages: UsageCounts[] }

// 記録の応答を待つ上限。抽出に失敗しても章は完了扱いにするので、待ちすぎない。
// 思考するモデルで本文が長いと 60 秒を超えることがある。時間切れは usage も残らず、記録に置き換える古い章では
// 毎回の生成で抽出をやり直すことになるので、2 分まで待つ。
const RECORD_TIMEOUT_MS = 120_000

// 応答を記録の下書きとして読み、保存できる形に整える。名前の正規化、空の項目の除去、切り詰め、伏線の id 振りは
// finalizeRecord が全部やる。finalizeRecord が throw する下書き (要約が空など) は解釈の失敗として、やり直しに回す。
function interpretRecord(text: string, input: RecordFlowInput): Interpreted<ChapterRecord> {
  const json = parseJsonText(text)
  if (!json.ok) return json
  const draft = ChapterRecordDraftSchema.safeParse(json.value)
  if (!draft.success) {
    return {
      ok: false,
      error: `記録が想定の形式ではありません: ${describeIssues(draft.error.issues)} (応答の先頭: ${excerpt(text)})`
    }
  }
  try {
    const record = finalizeRecord(draft.data, {
      chapterNumber: input.chapterNumber,
      openThreads: input.openThreads,
      plannedSetups: input.plannedSetups,
      knownNames: input.castNames
    })
    return { ok: true, value: record }
  } catch (e) {
    return { ok: false, error: `記録を保存できる形にできません: ${errorMessage(e)}` }
  }
}

// 書き上がった 1 章の本文から記録を作る。解釈に失敗したら 1 回だけやり直す。
// 本文が空なら LLM を呼ばずに失敗を返す (buildRecordPrompt が throw する)。
export async function extractRecordFlow(call: JsonCaller, input: RecordFlowInput): Promise<RecordFlowResult> {
  const prompt = buildRecordPromptSafely(input)
  if (!prompt.ok) return { ok: false, error: prompt.error, usages: [] }
  // schema の enum は、プロンプトに渡した伏線と同じ並びの id にする (どちらも重複と空を除いて先頭から並べる)。
  const schema = recordJsonSchema({
    castNames: input.castNames,
    openThreadIds: input.openThreads.map((thread) => thread.id),
    plannedSetupIds: input.plannedSetups.map((thread) => thread.id)
  })
  const outcome = await callUntilValid(
    call,
    prompt.value,
    { op: 'extractRecord', schema, timeoutMs: RECORD_TIMEOUT_MS },
    (text) => interpretRecord(text, input),
    MAX_ATTEMPTS,
    []
  )
  if (!outcome.ok) return outcome
  return { ok: true, record: outcome.value, usages: outcome.usages }
}

function buildRecordPromptSafely(input: RecordFlowInput): Interpreted<Prompt> {
  try {
    return {
      ok: true,
      value: buildRecordPrompt({
        chapterNumber: input.chapterNumber,
        title: input.title,
        content: input.content,
        castNames: input.castNames,
        openThreads: input.openThreads,
        plannedSetups: input.plannedSetups,
        narrator: input.narrator
      })
    }
  } catch (e) {
    return { ok: false, error: errorMessage(e) }
  }
}

// ---------------------- 応答を schema の大きさに収める ----------------------

// 前後の空白は残し、max 字 (UTF-16 の長さ。zod の max と同じ数え方) で切る。上位サロゲートで終わったら 1 つ落とす。
function clipText(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const last = cut.charCodeAt(cut.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// path の位置の値を fn で置き換えた新しい値を返す。path が途中で無ければ、何もしない。入力は変更しない。
function updateAt(value: unknown, path: readonly PropertyKey[], fn: (target: unknown) => unknown): unknown {
  if (path.length === 0) return fn(value)
  const [head, ...rest] = path
  if (Array.isArray(value) && typeof head === 'number') {
    const items: unknown[] = value
    return head >= 0 && head < items.length
      ? items.map((item, index) => (index === head ? updateAt(item, rest, fn) : item))
      : value
  }
  if (isRecordValue(value) && typeof head === 'string' && head in value) {
    return { ...value, [head]: updateAt(value[head], rest, fn) }
  }
  return value
}

// key は同じ操作を 1 回にまとめるためのもの (同じ要素に空の項目が 2 つあると、要素を捨てる操作が 2 つ出る。
// 2 回当てると、詰められた次の要素まで捨ててしまう)。
type Fix = { key: string; path: readonly PropertyKey[]; apply: (target: unknown) => unknown; order: number }

function fixKey(kind: string, path: readonly PropertyKey[]): string {
  return JSON.stringify([kind, ...path.map(String)])
}

// zod の問題 1 つを直す操作。直せない問題は null。
//   長すぎる文字列  上限で切る
//   多すぎる配列    上限までにする (後ろを捨てる)
//   空の文字列      その文字列を含む、いちばん内側の配列の要素ごと捨てる (空の項目は残す意味が無い)
// 要素を捨てる操作は、同じ配列の中で後ろの位置から順に行う (前を捨てると後ろの位置がずれるため)。
function fixFor(issue: z.core.$ZodIssue): Fix | null {
  if (issue.code === 'too_big' && typeof issue.maximum === 'number') {
    const max = issue.maximum
    if (issue.origin === 'string') {
      return {
        key: fixKey('clip', issue.path),
        path: issue.path,
        order: 0,
        apply: (v) => (typeof v === 'string' ? clipText(v, max) : v)
      }
    }
    if (issue.origin === 'array') {
      return {
        key: fixKey('slice', issue.path),
        path: issue.path,
        order: 1,
        apply: (v) => (Array.isArray(v) ? v.slice(0, max) : v)
      }
    }
  }
  if (issue.code === 'too_small' && issue.origin === 'string') {
    const at = issue.path.reduce<number>((last, segment, i) => (typeof segment === 'number' ? i : last), -1)
    const index = issue.path[at]
    if (at === -1 || typeof index !== 'number') return null
    return {
      key: fixKey('remove', issue.path.slice(0, at + 1)),
      path: issue.path.slice(0, at),
      order: 2 + 1 / (index + 1),
      apply: (v) => (Array.isArray(v) ? v.filter((_, i) => i !== index) : v)
    }
  }
  return null
}

const FIT_ROUNDS = 4

// schema の上限 (字数、個数) を超える項目を切り詰め、空の項目を捨ててから検証する。
// 入れ子の配列 (配列の要素の中にさらに配列) を持つ schema では使えない。要素を捨てる順序を、path の最後の番号だけで決めているため。
// モデルの出力は長すぎる 1 項目や空の 1 項目を含みがちで、それだけで応答全体を不合格にしてやり直すのは割に合わないため。
// 上限は schema 自身が報告する値を使う (上限の数字をここに写さない)。形の違い (型が違う、必須が無い) は直さない。
function fitToSchema<T>(
  schema: z.ZodType<T>,
  value: unknown,
  rounds: number = FIT_ROUNDS
): { success: true; data: T } | { success: false; issues: z.core.$ZodIssue[] } {
  const parsed = schema.safeParse(value)
  if (parsed.success) return { success: true, data: parsed.data }
  const candidates = parsed.error.issues.flatMap((issue) => {
    const fix = fixFor(issue)
    return fix === null ? [] : [fix]
  })
  const fixes = candidates.filter((fix, i) => candidates.findIndex((other) => other.key === fix.key) === i)
  if (fixes.length === 0 || rounds <= 0) return { success: false, issues: parsed.error.issues }
  // 字数の切り詰め → 個数の切り詰め → 後ろの要素から捨てる、の順に当てる。
  const fixed = [...fixes].sort((a, b) => a.order - b.order).reduce((v, fix) => updateAt(v, fix.path, fix.apply), value)
  return fitToSchema(schema, fixed, rounds - 1)
}

// ---------------------- 作品設計 (Phase 3) ----------------------

// 作品設計の材料。人物設定は辞典のもの (variant を反映)。語り手はスタイルの視点人物から決まる (プロンプトと同じ決め方)。
export type BibleFlowInput = {
  novel: NovelParams
  style: StyleParams
  cast: CastMember[]
  relations: CastRelation[]
}

export type BibleFlowResult =
  | { ok: true; bible: StoryBible; usages: UsageCounts[] }
  | { ok: false; error: string; usages: UsageCounts[] }

// 作品設計の応答を待つ上限。設定全体と呼称表を 1 回で書かせるので、章立てと同じ程度に待つ。
const BIBLE_TIMEOUT_MS = 180_000
// 欠けた組をエラー文に並べる数。
const MAX_REPORTED_PAIRS = 5

// 人物設定を、名簿の人物ごとに最初の 1 行だけにする (並びは元のまま。名前は前後の空白を除いて照合する)。
// validateAdultCast も applyBibleCast も名簿の人物ごとに最初の行しか見ないので、同じ人物の 2 行目や
// 名簿に無い人物の行は検証されないまま保存され、画面に出てしまう。保存する行を、検証した行と同じにする。
function rosterCast(cast: BibleCast[], roster: CastMember[]): BibleCast[] {
  const names = new Set(roster.map((member) => member.name.trim()))
  const seen = new Set<string>()
  return cast.filter((row) => {
    const name = row.name.trim()
    if (!names.has(name) || seen.has(name)) return false
    seen.add(name)
    return true
  })
}

// 作品設計を名簿と年齢指定に合わせて整える (生成の後と手動の保存で同じ)。
// 全年齢では人物設定 (cast) を持たない。成人指定では名簿の人物ごとに最初の 1 行だけを残す。
// 呼称表は completeAddresses で名簿と関係に照らして整える。
export function normalizeBible(bible: StoryBible, input: BibleFlowInput): StoryBible {
  return {
    ...bible,
    cast: isAdultStyle(input.style) ? rosterCast(bible.cast, input.cast) : [],
    addresses: completeAddresses(bible.addresses, input.cast, input.relations)
  }
}

type AdultCheckInput = { style: StyleParams; cast: CastMember[] }

function ratingOf(style: StyleParams): string {
  return style.age_rating === undefined ? '' : style.age_rating
}

// 成人指定の検証の材料 (人物設定と、人物設定以外の文面)。
type AdultMaterial = { cast: BibleCast[]; text: AdultBibleText }

// 成人指定の検証。全年齢なら常に空。問題の文 (空なら問題なし)。
// 人物設定 (名簿の全員ぶん、年齢は 18 以上の数字だけ、未成年を指す語が無い) と、
// 人物設定以外の文面 (物語の核、結末、人物の変化、世界のルール、用語、時系列) に未成年を指す語が無いこと。
// 作品設計の生成、手動保存、章立ての生成の前、本文の生成の文脈、章立てのプレビュー、生成の開始が、すべてこの関数を通る。
function adultIssuesOf(material: AdultMaterial, input: AdultCheckInput): string[] {
  const rating = ratingOf(input.style)
  return [
    ...validateAdultCast(rating, material.cast, castNamesOf(input.cast)),
    ...validateAdultBibleText(rating, material.text)
  ]
}

export function adultBibleIssues(bible: StoryBible, input: AdultCheckInput): string[] {
  return adultIssuesOf({ cast: bible.cast, text: bible }, input)
}

// 保存済みの作品設計が成人指定の条件を満たさないとき (手で直して壊れた、年齢指定を後から変えた、人物を足した、など) のエラー文。
// 問題が無ければ null。
export function brokenBibleError(bible: StoryBible, input: AdultCheckInput): string | null {
  const issues = adultBibleIssues(bible, input)
  if (issues.length === 0) return null
  return `作品設計が成人指定の条件を満たしていません（${issues.join('、')}）。作品設計を作り直すか、作品設計を直してから生成してください。`
}

export const UNREADABLE_ADULT_BIBLE_ERROR =
  '保存されている作品設計が読み込めません。成人指定の作品は、作品設計の人物設定を確かめられないまま生成しないため止めています。作品設計を作り直してください。'

// 保存済みの作品設計で、生成 (章立て、本文、プレビュー) を止める理由。止めなくてよければ null。
//   成人指定で、作品設計の列に値があるのに読めない → 止める (未作成として辞典の原文で書かない)
//   作品設計が無い (未作成。全年齢で読めない場合も含む) → 止めない (旧データとして扱う。章立ての生成では先に作る)
//   作品設計が成人指定の条件を満たさない → 止める
export function bibleBlocker(
  input: AdultCheckInput & { bible: StoryBible | null; bibleUnreadable: boolean }
): string | null {
  if (input.bible === null) {
    return input.bibleUnreadable && isAdultStyle(input.style) ? UNREADABLE_ADULT_BIBLE_ERROR : null
  }
  return brokenBibleError(input.bible, input)
}

function rawText(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function rawTexts(value: unknown): string[] {
  return Array.isArray(value) ? value.map(rawText) : []
}

function rawRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecordValue) : []
}

// 文字列か、無い (undefined) こと。それ以外 (数値、null、配列など) は読めない形。
function optionalText(value: unknown): string | null {
  if (value === undefined) return ''
  return typeof value === 'string' ? value : null
}

// 生の応答の人物設定。読めない形 (配列でない、要素がオブジェクトでない、name や age が文字列でない) なら null。
// 成人指定の検証を、切り詰める前の値にかけるために使う (切り詰めると「18歳 (…) 実際は14歳」の後ろが落ちて通ってしまう)。
function rawCast(value: unknown): BibleCast[] | null {
  if (value === undefined) return []
  if (!Array.isArray(value)) return null
  const items: unknown[] = value
  const rows = items.map((item): BibleCast | null => {
    if (!isRecordValue(item) || typeof item.name !== 'string' || typeof item.age !== 'string') return null
    const occupation = optionalText(item.occupation)
    const appearance = optionalText(item.appearance)
    const background = optionalText(item.background)
    if (occupation === null || appearance === null || background === null) return null
    return { name: item.name, age: item.age, occupation, appearance, background }
  })
  return rows.some((row) => row === null) ? null : rows.filter((row): row is BibleCast => row !== null)
}

// 生の応答の、人物設定以外の文面。文字列でない値は '' として読む (形が違えば、後の StoryBibleSchema の検証で落ちる)。
function rawBibleText(value: Record<string, unknown>): AdultBibleText {
  const world = isRecordValue(value.world) ? value.world : {}
  return {
    premise: rawText(value.premise),
    ending: rawText(value.ending),
    arcs: rawRecords(value.arcs).map((arc) => ({
      name: rawText(arc.name),
      start: rawText(arc.start),
      end: rawText(arc.end)
    })),
    world: {
      rules: rawTexts(world.rules),
      terms: rawRecords(world.terms).map((term) => ({ term: rawText(term.term), note: rawText(term.note) }))
    },
    timeline: rawTexts(value.timeline),
    // 呼称表の呼び方も見る (文字列でない call は '' として読む)。名簿に無い名前の行は後で捨てられるが、生の値で先に見る
    addresses: rawRecords(value.addresses).map((entry) => ({ call: rawText(entry.call) }))
  }
}

// 生の応答 (JSON として読んだだけの値) に成人指定の検証をかける。全年齢なら常に空。
function rawAdultIssues(value: unknown, input: AdultCheckInput): string[] {
  if (!isAdultStyle(input.style)) return []
  if (!isRecordValue(value)) return ['作品設計が JSON のオブジェクトではありません']
  const cast = rawCast(value.cast)
  if (cast === null) return ['作品設計の人物設定 (cast) が読める形ではありません']
  return adultIssuesOf({ cast, text: rawBibleText(value) }, input)
}

// 順序: JSON として読む → 生の値で成人指定の検証 → schema の大きさに収める → StoryBibleSchema → 呼称表を整える
// → 整えた値でもう一度成人指定の検証 → 呼称表の欠けの確認。
// 成人指定の検証は、切り詰める前の値にかける (後ろが切り落とされて通るのを防ぐ)。保存する値が検証済みであることを保証するため、
// 整えた後の値にもかける。成人指定の検証に落ちた回答は、やり直しの後に使う値 (acceptable) にもしない。
function interpretBible(text: string, input: BibleFlowInput): Interpreted<StoryBible> {
  const json = parseJsonText(text)
  if (!json.ok) return json
  const rawIssues = rawAdultIssues(json.value, input)
  if (rawIssues.length > 0) return { ok: false, error: rawIssues.join('、') }
  const fitted = fitToSchema(StoryBibleSchema, json.value)
  if (!fitted.success) {
    return {
      ok: false,
      error: `作品設計が想定の形式ではありません: ${describeIssues(fitted.issues)} (応答の先頭: ${excerpt(text)})`
    }
  }
  const bible = normalizeBible(fitted.data, input)
  // 成人指定の条件は、満たさなければ保存しない (やり直しても満たさなければ失敗)。
  const adultIssues = adultBibleIssues(bible, input)
  if (adultIssues.length > 0) return { ok: false, error: adultIssues.join('、') }
  // 呼称表の組が欠けていたらやり直す。やり直しても欠けていたら、欠けたまま使う (acceptable)。
  const missing = missingAddressPairs(bible.addresses, bibleAddressPairs(input))
  if (missing.length > 0) {
    const listed = missing
      .slice(0, MAX_REPORTED_PAIRS)
      .map((pair) => `${pair.from}→${pair.to}`)
      .join('、')
    return {
      ok: false,
      error: `呼称表に ${missing.length} 組が欠けています (${listed}${missing.length > MAX_REPORTED_PAIRS ? ' など' : ''})`,
      acceptable: bible
    }
  }
  return { ok: true, value: bible }
}

// 作品設計を作る。解釈できない、成人指定の条件を満たさない、呼称表の組が欠けている、ときは 1 回だけやり直す。
// 2 回目も呼称表の組が欠けているだけなら、欠けたまま合格にする。成人指定の条件は 2 回目も満たさなければ失敗
// (エラー文は validateAdultCast の問題の文をつなげたもの)。呼び出しの失敗 (throw) はやり直さない。
export async function generateBibleFlow(call: JsonCaller, input: BibleFlowInput): Promise<BibleFlowResult> {
  const outcome = await callUntilValid(
    call,
    buildBiblePrompt(input),
    {
      op: 'generateBible',
      schema: bibleJsonSchema({ castNames: castNamesOf(input.cast), adult: isAdultStyle(input.style) }),
      timeoutMs: BIBLE_TIMEOUT_MS
    },
    (text) => interpretBible(text, input),
    MAX_ATTEMPTS,
    []
  )
  if (!outcome.ok) return outcome
  return { ok: true, bible: outcome.value, usages: outcome.usages }
}

// 作品設計の入力のハッシュの材料 (bible.ts の bibleSourceHash に渡す)。語り手はプロンプトと同じ決め方。
export function bibleSourceInput(input: BibleFlowInput): BibleSourceInput {
  const narrator = narratorName(input.style, input.cast)
  return {
    genre: input.novel.genre,
    setting: input.novel.setting,
    ending: input.style.ending === undefined ? '' : input.style.ending,
    age_rating: input.style.age_rating === undefined ? '' : input.style.age_rating,
    pov: input.style.pov,
    narrator: narrator === undefined ? '' : narrator,
    cast: input.cast,
    relations: input.relations
  }
}

// 保存形 (source_hash つき) から API とプロンプトに渡す形にする。
export function toStoryBible(stored: StoredBible): StoryBible {
  return {
    premise: stored.premise,
    ending: stored.ending,
    arcs: stored.arcs,
    world: stored.world,
    timeline: stored.timeline,
    addresses: stored.addresses,
    cast: stored.cast
  }
}

// 作品設計の入力の今のハッシュ。保存時のハッシュ (source_hash) と比べて、作成後に入力が変わったかを見る。
export function currentBibleHash(input: BibleFlowInput): string {
  return bibleSourceHash(bibleSourceInput(input))
}

// 保存済みの作品設計が、作成後に入力 (あらすじ、登場人物、関係など) の変わったものか。未作成は false。
export function bibleOutdated(stored: StoredBible | null, input: BibleFlowInput): boolean {
  return stored !== null && stored.source_hash !== currentBibleHash(input)
}

// 作品設計の保存とコストの記録。D1 に書くのは呼び出し側 (このファイルは DB に触れない)。
export type BibleEffects = {
  save: (stored: StoredBible) => Promise<void>
  // 失敗した回も含めた、usage が取れた全部の呼び出し
  recordUsages: (usages: UsageCounts[]) => Promise<void>
}

// 作品設計を作って保存する (作り直しも同じ)。保存時のハッシュは今の入力のもの。
// 失敗したら保存しない。コストは成否にかかわらず記録する。章立てや本文は作り直さない (消しもしない)。
export async function createBibleFlow(
  call: JsonCaller,
  input: BibleFlowInput,
  effects: BibleEffects
): Promise<BibleFlowResult> {
  const result = await generateBibleFlow(call, input)
  await effects.recordUsages(result.usages)
  if (result.ok) await effects.save({ ...result.bible, source_hash: currentBibleHash(input) })
  return result
}

export type BibleReady =
  | { ok: true; bible: StoryBible }
  | { ok: false; status: 400; error: 'invalid_bible'; detail: string }
  | { ok: false; status: 502; error: 'generation_failed'; detail: string }

// 章立ての生成の前に作品設計を用意する。保存済みならそれを使い (LLM を呼ばない)、無ければ先に作って保存する。
// 成人指定で保存済みの作品設計が条件を満たさないとき (手で直して壊れた、年齢指定を後から変えた、人物を足した)、
// または読めないときは、作り直さずに invalid_bible で止める (利用者の編集を黙って上書きしないため)。
// 全年齢で読めない作品設計は、未作成として作り直す。
export async function prepareBibleFlow(
  call: JsonCaller,
  input: BibleFlowInput & { bible: StoryBible | null; bibleUnreadable: boolean },
  effects: BibleEffects
): Promise<BibleReady> {
  const blocked = bibleBlocker(input)
  if (blocked !== null) return { ok: false, status: 400, error: 'invalid_bible', detail: blocked }
  if (input.bible !== null) return { ok: true, bible: input.bible }
  const created = await createBibleFlow(call, input, effects)
  return created.ok
    ? { ok: true, bible: created.bible }
    : { ok: false, status: 502, error: 'generation_failed', detail: created.error }
}

// ---------------------- 検査 (Phase 5) ----------------------

export type ReviewFlowResult =
  | { ok: true; issues: ReviewIssue[]; usages: UsageCounts[] }
  | { ok: false; error: string; usages: UsageCounts[] }

// 検査の応答を待つ上限。検査は章の完了の後に走り、失敗しても章は完了のまま。
const REVIEW_TIMEOUT_MS = 90_000
// 保存する引用と理由の長さの上限 (字)。
const REVIEW_QUOTE_STORE_CHARS = 200
const REVIEW_REASON_STORE_CHARS = 300

// 引用の照合で無視する文字 (空白、全角空白、改行)。モデルは改行や空白を落として引用することがある。
const QUOTE_SPACE = /\s/u

// 本文から空白を除いた文字列と、その各文字が元の本文のどこにあったか (コードポイント単位)。
function compacted(text: string): { chars: string[]; origin: number[] } {
  const points = [...text]
  const kept = points.map((char, index) => ({ char, index })).filter(({ char }) => !QUOTE_SPACE.test(char))
  return { chars: kept.map(({ char }) => char), origin: kept.map(({ index }) => index) }
}

// 引用が本文にあれば、本文の該当箇所 (空白や改行を含む元の文字列) を返す。無ければ null。
// 空白と改行を除いて比べる。空白を除いて REVIEW_QUOTE_MIN_CHARS 字未満の引用は、どこにでも当たりうるので受けない。
// 返すのは本文の文字列そのもの (画面や書き直しの指示で、本文から探せる形にするため)。
export function findQuote(quote: string, content: string): string | null {
  const needle = compacted(quote).chars
  if (needle.length < REVIEW_QUOTE_MIN_CHARS) return null
  const body = compacted(content)
  const target = needle.join('')
  const start = body.chars.join('').indexOf(target)
  if (start === -1) return null
  // indexOf は UTF-16 の位置を返すので、コードポイントの位置に直す
  const first = [...body.chars.join('').slice(0, start)].length
  const last = first + needle.length - 1
  return [...content].slice(body.origin[first], body.origin[last] + 1).join('')
}

function isReviewIssueKind(value: string): value is ReviewIssueKind {
  return REVIEW_ISSUE_KINDS.some((kind) => kind === value)
}

// モデルの指摘を保存できる形にする。引用が本文に無いもの、引用や理由が空のものは捨てる。
// 種別が分からなければ other。引用と理由は上限で切る。最大 REVIEW_ISSUES_MAX 件。
export function normalizeReviewIssues(raw: unknown[], content: string): ReviewIssue[] {
  return raw
    .flatMap((item): ReviewIssue[] => {
      if (!isRecordValue(item)) return []
      const quote = typeof item.quote === 'string' ? findQuote(item.quote, content) : null
      const reason = typeof item.reason === 'string' ? item.reason.trim() : ''
      if (quote === null || reason.length === 0) return []
      const kind = typeof item.kind === 'string' && isReviewIssueKind(item.kind) ? item.kind : 'other'
      return [
        {
          kind,
          quote: clipText(quote.trim(), REVIEW_QUOTE_STORE_CHARS),
          reason: clipText(reason, REVIEW_REASON_STORE_CHARS)
        }
      ]
    })
    .slice(0, REVIEW_ISSUES_MAX)
}

// 応答を { issues: [...] } として読む (配列をそのまま返されたら、それを issues とみなす)。
// issues が配列でなければ解釈の失敗 (やり直しに回す)。個々の指摘の不備は捨てるだけで、失敗にしない。
function interpretReview(text: string, content: string): Interpreted<ReviewIssue[]> {
  const json = parseJsonText(text)
  if (!json.ok) return json
  const value: unknown = json.value
  const issues = Array.isArray(value) ? value : isRecordValue(value) ? value.issues : undefined
  if (!Array.isArray(issues)) {
    return { ok: false, error: `検査の応答に issues の配列がありません (応答の先頭: ${excerpt(text)})` }
  }
  return { ok: true, value: normalizeReviewIssues(issues, content) }
}

// 書き上がった章を検査する。解釈に失敗したら 1 回だけやり直す。呼び出しの失敗 (throw) はやり直さない。
// 本文が空なら LLM を呼ばずに失敗を返す (buildReviewPrompt が throw する)。
export async function reviewChapterFlow(call: JsonCaller, input: ReviewPromptInput): Promise<ReviewFlowResult> {
  const prompt = buildReviewPromptSafely(input)
  if (!prompt.ok) return { ok: false, error: prompt.error, usages: [] }
  const outcome = await callUntilValid(
    call,
    prompt.value,
    { op: 'reviewChapter', schema: reviewJsonSchema(), timeoutMs: REVIEW_TIMEOUT_MS },
    (text) => interpretReview(text, input.content),
    MAX_ATTEMPTS,
    []
  )
  if (!outcome.ok) return outcome
  return { ok: true, issues: outcome.value, usages: outcome.usages }
}

function buildReviewPromptSafely(input: ReviewPromptInput): Interpreted<Prompt> {
  try {
    return { ok: true, value: buildReviewPrompt(input) }
  } catch (e) {
    return { ok: false, error: errorMessage(e) }
  }
}

// ---------------------- 成人指定の作品の、利用者の指示の欄 ----------------------

function quotedTerms(terms: string[]): string {
  return terms.map((term) => `「${term}」`).join('')
}

// 指示の欄では、外見の欄用の語 (セーラー服、ランドセル、童顔、幼い など) も見る。
// 指示の欄は資料ではなく書き手への直接の指示で、成人指定の表現の許可と一緒に渡るため、この種類の書き方を止める。
// 「幼い頃の回想を入れる」「少年漫画のような展開」も止まるが、成人指定の指示の欄なので安全側に倒す
// (エラー文に語が出るので、利用者は言い換えられる)。本文と書き直しの元の版の検査は外見の語を見ない
// (本文では「幼い頃」「少女」が普通に出るため)。
function instructionTerms(text: string): string[] {
  return findMinorTerms(text, { appearance: true })
}

// 成人指定 (R15 / R18) の作品で、利用者の指示として入る欄に未成年を指す語があれば、止める理由の文。無ければ null。
// 成人指定の読み替えの指示は「資料」(あらすじ、登場人物の辞典) に対するもので、利用者の直接の指示とは正面からぶつかるため、
// 指示の欄は読み替えずに止める。あらすじと辞典は資料なので検査しない。
//   writingNotes: 執筆上の指示 (章立てと全章の本文に渡る)
//   notes:        備考 (章立てにだけ渡る)。本文の生成では渡さない (undefined)
export function notesBlocker(input: { style: StyleParams; writingNotes: string; notes?: string }): string | null {
  if (!isAdultStyle(input.style)) return null
  const fields = [
    { label: '執筆上の指示', terms: instructionTerms(input.writingNotes) },
    { label: '備考（物語に取り込みたい要素）', terms: input.notes === undefined ? [] : instructionTerms(input.notes) }
  ].filter((field) => field.terms.length > 0)
  if (fields.length === 0) return null
  return `${fields.map((field) => `${field.label}に、未成年を指す語（${quotedTerms(field.terms)}）があります`).join('。')}。成人指定の作品では使えません。`
}

// 成人指定の作品で、書き直しの指示に未成年を指す語があれば、止める理由の文。無ければ null。
// 書き直しの元の版 (既に書かれた本文) は、chapter-context.ts の revisionBaseCheck が本文と同じ基準で検査する。
export function instructionBlocker(input: { style: StyleParams; instruction: string }): string | null {
  if (!isAdultStyle(input.style)) return null
  const terms = instructionTerms(input.instruction)
  if (terms.length === 0) return null
  return `書き直しの指示に、未成年を指す語（${quotedTerms(terms)}）があります。成人指定の作品では使えません。`
}
