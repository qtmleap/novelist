import type { ZodError } from 'zod'
import { type Outline, type OutlineChapter, OutlineChapterSchema, OutlineSchema } from '@/schemas/novel.dto'
import type { OutlineWarning } from '@/schemas/story.dto'

// 章立て (outline) の応答の解釈・登場人物の正規化・検証・構造化出力の JSON Schema。
// 純粋関数だけを置く (Prisma・fetch・cloudflare:workers に依存させない)。

export type JsonSchema = Record<string, unknown>

// 1 字の名前は他の名前の一部に紛れやすいので、「名簿の名前に含まれる」部分一致の対象にしない。
const MIN_PARTIAL_MATCH_CHARS = 2
// エラー文に載せる応答の先頭の長さ。応答の全文はログや画面に出さない。
const EXCERPT_CHARS = 200
// エラー文に載せる検証エラーの件数。
const MAX_REPORTED_ISSUES = 5
// 警告文に載せる名前の長さ (OutlineWarning.message の上限に収めるため)。
const MAX_WARNING_NAME_CHARS = 60

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function truncate(text: string, maxChars: number): string {
  const chars = [...text]
  return chars.length > maxChars ? `${chars.slice(0, maxChars).join('')}…` : text
}

// ---------------------- 登場人物の照合・正規化 ----------------------

// 空の名前は includes で全てに一致してしまうので、最初に除く。
function usableCastNames(castNames: string[]): string[] {
  return unique(castNames.filter((name) => name.length > 0))
}

// 名前の後ろに付いていても同じ人物とみなす敬称。
const HONORIFICS = ['さん', 'ちゃん', 'くん', '君', '様', 'さま', '殿', '氏', '先生', '先輩', '後輩', '嬢'] as const
// 名前の前後に付いていてよい空白と区切り。\s は全角空白 (U+3000) を含む。
const SEPARATORS = '\\s・･＝=、，,'
// 名前の前: 空か、空白・区切りだけ。
const LEADING_PATTERN = new RegExp(`^[${SEPARATORS}]*$`)
// 名前の後: 空白・区切り、敬称、丸括弧の注記 (全角・半角)。敬称の後に注記が続く形も可。
const TRAILING_PATTERN = new RegExp(
  `^[${SEPARATORS}]*(?:(?:${HONORIFICS.join('|')})[${SEPARATORS}]*)?(?:[（(][^（）()]*[）)][${SEPARATORS}]*)*$`
)

// raw が「名簿の名前 + 付け足し」だけで出来ているときの、名簿の名前。
// 付け足しが敬称・注記・区切りなら同じ人物。「ルナの母」「ルナたち」のように別の語が付けば別人 (または複数人) なので外す。
// 候補が複数ならいちばん長い名前 (「月見八千代さん」→「月見八千代」)。同じ長さが複数なら決められないので null。
function matchAnnotatedCastName(raw: string, cast: string[]): string | null {
  const candidates = cast.filter((castName) => {
    const index = raw.indexOf(castName)
    if (index < 0) return false
    return LEADING_PATTERN.test(raw.slice(0, index)) && TRAILING_PATTERN.test(raw.slice(index + castName.length))
  })
  if (candidates.length === 0) return null
  const longest = Math.max(...candidates.map((castName) => castName.length))
  const longestCandidates = candidates.filter((castName) => castName.length === longest)
  return longestCandidates.length === 1 ? longestCandidates[0] : null
}

// モデルが書いた名前を、名簿の正式名に寄せる。上から順に試す。
//   1. 前後の空白を除いて完全一致。
//   2. raw が 2 字以上で、raw を含む(raw より長い)名簿の名前がちょうど 1 人ならその名前 (「彩葉」→「酒寄彩葉」)。
//      2 人以上はどちらか決められないので、次へ進まず null。
//   3. raw が名簿の名前に敬称・注記・区切りを足しただけなら、その名簿の名前 (「ルナさん」「ルナ（回想）」)。
//   4. どれにも当たらなければ null。名簿の名前を含むだけの別人 (「ルナの母」) は寄せない。
export function matchCastName(raw: string, castNames: string[]): string | null {
  // String.prototype.trim は全角空白 (U+3000) も除く。
  const name = raw.trim()
  if (name.length === 0) return null
  const cast = usableCastNames(castNames)
  if (cast.includes(name)) return name
  if ([...name].length >= MIN_PARTIAL_MATCH_CHARS) {
    // 完全一致は 1. で済んでいるので、ここで name を含む名前は必ず name より長い。
    const longer = cast.filter((castName) => castName.includes(name))
    if (longer.length > 0) return longer.length === 1 ? longer[0] : null
  }
  return matchAnnotatedCastName(name, cast)
}

function droppedCharacterWarning(chapterNumber: number, name: string): OutlineWarning {
  return {
    chapter_number: chapterNumber,
    kind: 'dropped_character',
    message: `第 ${chapterNumber} 章の登場人物「${truncate(name, MAX_WARNING_NAME_CHARS)}」は名簿に無いため外しました`
  }
}

function normalizeChapterCharacters(
  chapter: OutlineChapter,
  cast: string[],
  always: string[]
): { chapter: OutlineChapter; warnings: OutlineWarning[] } {
  const resolved = chapter.characters.map((raw) => ({ raw: raw.trim(), name: matchCastName(raw, cast) }))
  const kept = unique(resolved.flatMap((entry) => (entry.name === null ? [] : [entry.name])))
  // 空文字は名前ではないので、警告にもしない。
  const dropped = unique(
    resolved.filter((entry) => entry.name === null && entry.raw.length > 0).map((entry) => entry.raw)
  )
  return {
    chapter: { ...chapter, characters: [...always.filter((name) => !kept.includes(name)), ...kept] },
    warnings: dropped.map((name) => droppedCharacterWarning(chapter.chapter_number, name))
  }
}

// 各章の characters を名簿の正式名に揃える。重複は除き、元の順序を保つ。
// 照合できない名前は捨て、章ごとに dropped_character の警告にする。
// alwaysInclude (語り手など) は、名簿にある名前だけを、各章に無ければ先頭に足す。
// 名簿が空なら characters は意味を持たないので全章で空にし、警告は出さない。入力は変更しない。
export function normalizeOutlineCharacters(
  outline: Outline,
  castNames: string[],
  alwaysInclude: string[] = []
): { outline: Outline; warnings: OutlineWarning[] } {
  const cast = usableCastNames(castNames)
  if (cast.length === 0) {
    return { outline: { ...outline, chapters: outline.chapters.map((c) => ({ ...c, characters: [] })) }, warnings: [] }
  }
  const always = unique(alwaysInclude.map((name) => name.trim())).filter((name) => cast.includes(name))
  const results = outline.chapters.map((chapter) => normalizeChapterCharacters(chapter, cast, always))
  return {
    outline: { ...outline, chapters: results.map((r) => r.chapter) },
    warnings: results.flatMap((r) => r.warnings)
  }
}

// ---------------------- 並べ替え・検証 ----------------------

// chapter_number の昇順に並べた新しい Outline を返す (入力は変更しない)。
export function sortOutline(outline: Outline): Outline {
  return { ...outline, chapters: [...outline.chapters].sort((a, b) => a.chapter_number - b.chapter_number) }
}

function joinNumbers(numbers: number[]): string {
  return numbers.join('、')
}

// 章立ての形の問題を日本語の文で返す。空配列なら問題なし。
// 章数が numChapters と合うか、chapter_number が 1 からの連番か (重複・欠番・範囲外)、題と概要が空でないか。
export function validateOutlineShape(outline: Outline, numChapters: number): string[] {
  const chapters = outline.chapters
  const numbers = chapters.map((c) => c.chapter_number)
  const duplicated = unique(numbers.filter((n, i) => numbers.indexOf(n) !== i))
  const outOfRange = unique(numbers.filter((n) => n < 1 || n > numChapters))
  const missing = Array.from({ length: numChapters }, (_, i) => i + 1).filter((n) => !numbers.includes(n))

  const shapeIssues = [
    chapters.length === numChapters ? [] : [`章の数が ${numChapters} 章であるべきところ ${chapters.length} 章です`],
    outOfRange.length === 0 ? [] : [`章番号 ${joinNumbers(outOfRange)} は 1 から ${numChapters} の範囲外です`],
    duplicated.length === 0 ? [] : [`章番号 ${joinNumbers(duplicated)} が重複しています`],
    missing.length === 0 ? [] : [`章番号 ${joinNumbers(missing)} の章がありません`]
  ].flat()

  const textIssues = chapters.flatMap((c) => [
    ...(c.title.trim().length === 0 ? [`第 ${c.chapter_number} 章の題が空です`] : []),
    ...(c.summary.trim().length === 0 ? [`第 ${c.chapter_number} 章の概要が空です`] : [])
  ])

  return [...shapeIssues, ...textIssues]
}

// ---------------------- 応答の解釈 ----------------------

type ParsedJson = { ok: true; value: unknown } | { ok: false; error: string }

function parseJson(text: string): ParsedJson {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    return { ok: false, error: `応答が JSON として読めません (応答の先頭: ${truncate(text, EXCERPT_CHARS)})` }
  }
}

function describeIssues(error: ZodError): string {
  return error.issues
    .slice(0, MAX_REPORTED_ISSUES)
    .map((issue) => {
      const path = issue.path.map(String).join('.')
      return path.length === 0 ? issue.message : `${path}: ${issue.message}`
    })
    .join(' / ')
}

function invalidShapeError(what: string, error: ZodError, text: string): string {
  return `${what}が想定の形式ではありません: ${describeIssues(error)} (応答の先頭: ${truncate(text, EXCERPT_CHARS)})`
}

// モデルは { chapters: [...] } の代わりに配列をそのまま返すことがあるので、包んで受ける。
export function parseOutlineResponse(text: string): { ok: true; outline: Outline } | { ok: false; error: string } {
  const json = parseJson(text)
  if (!json.ok) return json
  const candidate = Array.isArray(json.value) ? { chapters: json.value } : json.value
  const validated = OutlineSchema.safeParse(candidate)
  if (!validated.success) return { ok: false, error: invalidShapeError('章立て', validated.error, text) }
  return { ok: true, outline: validated.data }
}

// 1 章ぶんの応答から、章の候補を選ぶ。
//   単一のオブジェクト         そのまま受ける (章番号が違っていても受ける。呼び出し側が対象の番号に揃える)。
//   配列 / { chapters: [...] } chapterNumber に一致する章 (複数あれば最初)。無ければ、ちょうど 1 件のときだけその 1 件。
//                              複数あって選べない、または 0 件なら失敗。別の章を対象の章として受けないため。
// 一致の判定は検証の前の生の値で行う (chapter_number が数値でない要素は一致しない)。
type ChapterCandidate = { ok: true; candidate: unknown } | { ok: false; reason: string }

function selectChapterCandidate(value: unknown, chapterNumber: number | undefined): ChapterCandidate {
  const list = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.chapters) ? value.chapters : null
  if (list === null) return { ok: true, candidate: value }
  if (list.length === 0) return { ok: false, reason: '応答に章が 1 件も含まれていません' }
  const matched =
    chapterNumber === undefined
      ? undefined
      : list.find((item) => isRecord(item) && item.chapter_number === chapterNumber)
  if (matched !== undefined) return { ok: true, candidate: matched }
  if (list.length === 1) return { ok: true, candidate: list[0] }
  return {
    ok: false,
    reason:
      chapterNumber === undefined
        ? `応答に章が ${list.length} 件含まれていて、どれを使うか決められません`
        : `応答に章が ${list.length} 件含まれていますが、第 ${chapterNumber} 章のものがありません`
  }
}

export function parseOutlineChapterResponse(
  text: string,
  chapterNumber?: number
): { ok: true; chapter: OutlineChapter } | { ok: false; error: string } {
  const json = parseJson(text)
  if (!json.ok) return json
  const selected = selectChapterCandidate(json.value, chapterNumber)
  if (!selected.ok) {
    return { ok: false, error: `${selected.reason} (応答の先頭: ${truncate(text, EXCERPT_CHARS)})` }
  }
  const validated = OutlineChapterSchema.safeParse(selected.candidate)
  if (!validated.success) return { ok: false, error: invalidShapeError('章', validated.error, text) }
  return { ok: true, chapter: validated.data }
}

// ---------------------- 構造化出力の JSON Schema ----------------------
// Gemini の generationConfig.responseFormat.text.schema に渡す。型名は小文字。
// 長さの制約 (minLength など) はサーバーが無視するので入れない。

// 章 1 件ぶんの項目。章立てに項目を足すときはここに 1 行足す (required は properties の全項目から作る)。
function chapterProperties(castNames: string[]): Record<string, JsonSchema> {
  const cast = usableCastNames(castNames)
  return {
    chapter_number: { type: 'integer' },
    title: { type: 'string' },
    summary: { type: 'string' },
    // 名簿が空なら characters は意味を持たないので、項目ごと schema に入れない。
    ...(cast.length > 0 ? { characters: { type: 'array', items: { type: 'string', enum: cast } } } : {})
  }
}

function chapterJsonSchema(castNames: string[]): JsonSchema {
  const properties = chapterProperties(castNames)
  return { type: 'object', properties, required: Object.keys(properties) }
}

export function outlineJsonSchema(castNames: string[]): JsonSchema {
  return {
    type: 'object',
    properties: { chapters: { type: 'array', items: chapterJsonSchema(castNames) } },
    required: ['chapters']
  }
}

export function outlineChapterJsonSchema(castNames: string[]): JsonSchema {
  return chapterJsonSchema(castNames)
}
