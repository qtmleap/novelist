import { buildRecordPrompt } from '@/lib/novel/assist-prompts'
import { recordJsonSchema } from '@/lib/novel/json-schemas'
import { finalizeRecord } from '@/lib/novel/ledger'
import {
  type JsonSchema,
  normalizeOutlineCharacters,
  outlineChapterJsonSchema,
  outlineJsonSchema,
  parseOutlineChapterResponse,
  parseOutlineResponse,
  sortOutline,
  validateOutlineShape
} from '@/lib/novel/outline'
import {
  buildOutlineChapterPrompt,
  buildOutlinePrompt,
  type CastMember,
  type CastRelation,
  type NovelParams,
  type Prompt,
  type StyleParams
} from '@/lib/novel/prompts'
import type { UsageCounts } from '@/lib/openai/protocol'
import type { Outline, OutlineChapter } from '@/schemas/novel.dto'
import {
  type ChapterRecord,
  ChapterRecordDraftSchema,
  type OutlineWarning,
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
  cast: CastMember[]
  relations: CastRelation[]
  // 各章の登場人物に必ず入れる名前 (語り手)。名簿に無い名前は無視される。
  alwaysInclude: string[]
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

type Interpreted<T> = { ok: true; value: T } | { ok: false; error: string }

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
async function callUntilValid<T>(
  call: JsonCaller,
  prompt: Prompt,
  options: JsonCallOptions,
  interpret: (text: string) => Interpreted<T>,
  attemptsLeft: number,
  usages: UsageCounts[]
): Promise<CallOutcome<T>> {
  const response = await callSafely(call, prompt, options)
  if (!response.ok) return { ok: false, error: response.error, usages }
  const nextUsages = response.usage === undefined ? usages : [...usages, response.usage]
  const interpreted = interpret(response.text)
  if (interpreted.ok) return { ok: true, value: interpreted.value, usages: nextUsages }
  if (attemptsLeft <= 1) return { ok: false, error: interpreted.error, usages: nextUsages }
  return callUntilValid(call, prompt, options, interpret, attemptsLeft - 1, nextUsages)
}

function castNamesOf(cast: CastMember[]): string[] {
  return cast.map((member) => member.name)
}

// ---------------------- 章立て (全章) ----------------------

function interpretOutline(text: string, numChapters: number): Interpreted<Outline> {
  const parsed = parseOutlineResponse(text)
  if (!parsed.ok) return parsed
  const outline = sortOutline(parsed.outline)
  const issues = validateOutlineShape(outline, numChapters)
  if (issues.length > 0) return { ok: false, error: `章立てが条件を満たしていません: ${issues.join('、')}` }
  return { ok: true, value: outline }
}

// 全章の章立てを作る。解釈か検証に失敗したら 1 回だけやり直す。
// 通ったら登場人物を名簿の正式名に揃え、照合できなかった名前を警告にする。語り手は全章に足す。
export async function generateOutlineFlow(call: JsonCaller, input: OutlineFlowInput): Promise<OutlineFlowResult> {
  const castNames = castNamesOf(input.cast)
  const outcome = await callUntilValid(
    call,
    buildOutlinePrompt(input),
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
  const { outline, warnings } = normalizeOutlineCharacters(outcome.value, castNames, input.alwaysInclude)
  return { ok: true, outline, warnings, usages: outcome.usages }
}

// ---------------------- 章立て (1 章の書き直し) ----------------------

function interpretOutlineChapter(text: string, chapterNumber: number): Interpreted<OutlineChapter> {
  // 応答に複数の章が入っていたら (全章を返された、など)、対象の番号の章を選ばせる。先頭の章を取ると、
  // 別の章の内容を対象の章として保存してしまうため。選べなければ失敗として、やり直しに回す。
  const parsed = parseOutlineChapterResponse(text, chapterNumber)
  if (!parsed.ok) return parsed
  // 章 1 件だけの応答では、章番号をモデルが取り違えることがあるので、対象の章番号に揃える。
  const chapter = { ...parsed.chapter, chapter_number: chapterNumber }
  const issues = [
    chapter.title.trim().length === 0 ? `第 ${chapterNumber} 章の題が空です` : '',
    chapter.summary.trim().length === 0 ? `第 ${chapterNumber} 章の概要が空です` : ''
  ].filter((issue) => issue.length > 0)
  if (issues.length > 0) return { ok: false, error: `章立てが条件を満たしていません: ${issues.join('、')}` }
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
    buildOutlineChapterPrompt(input),
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
  return { ok: true, chapter, warnings: normalized.warnings, usages: outcome.usages }
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

// 選んだ章を targets の順に 1 章ずつ書き直す。書き直した章は、次の章の資料 (他の章) に入れる。
// 途中の章で失敗したら、そこで止めて失敗を返す (それまでの結果は呼び出し側が保存しない)。
// onUsages は章ごとに呼ぶ。後の章で失敗しても、それまでに払った分を記録できるように。
export async function regenerateOutlineChapters(
  call: JsonCaller,
  input: OutlineFlowInput,
  outline: Outline,
  targets: number[],
  onUsages: (chapterNumber: number, usages: UsageCounts[]) => Promise<void>,
  warnings: OutlineWarning[] = []
): Promise<OutlineChaptersResult> {
  if (targets.length === 0) return { ok: true, outline, warnings }
  const [chapterNumber, ...rest] = targets
  const result = await regenerateOutlineChapterFlow(call, { ...input, existing: outline, chapterNumber })
  await onUsages(chapterNumber, result.usages)
  if (!result.ok) return { ok: false, error: result.error }
  return regenerateOutlineChapters(call, input, replaceOutlineChapter(outline, result.chapter), rest, onUsages, [
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

// 記録の応答を待つ上限。抽出に失敗しても章は完了扱いにするので、長く待たせない。
const RECORD_TIMEOUT_MS = 60_000
// エラー文に載せる応答の先頭の長さ。
const RECORD_EXCERPT_CHARS = 200

function excerpt(text: string): string {
  const chars = [...text]
  return chars.length > RECORD_EXCERPT_CHARS ? `${chars.slice(0, RECORD_EXCERPT_CHARS).join('')}…` : text
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

function parseJsonText(text: string): Interpreted<unknown> {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false, error: `応答が JSON として読めません (応答の先頭: ${excerpt(text)})` }
  }
}

// 応答を記録の下書きとして読み、保存できる形に整える。名前の正規化、空の項目の除去、切り詰め、伏線の id 振りは
// finalizeRecord が全部やる。finalizeRecord が throw する下書き (要約が空など) は解釈の失敗として、やり直しに回す。
function interpretRecord(text: string, input: RecordFlowInput): Interpreted<ChapterRecord> {
  const json = parseJsonText(text)
  if (!json.ok) return json
  const draft = ChapterRecordDraftSchema.safeParse(json.value)
  if (!draft.success) {
    const issues = draft.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.map(String).join('.')}: ${issue.message}`)
      .join(' / ')
    return { ok: false, error: `記録が想定の形式ではありません: ${issues} (応答の先頭: ${excerpt(text)})` }
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
