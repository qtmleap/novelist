import { findMinorTerms, isAdultRating } from '@/lib/novel/bible'
import type { CheckKind, CheckWarning } from '@/schemas/story.dto'

// 生成された章の機械的な検査 (文字数、章末の重複、口調の例の丸写し、字下げ、人物名の出現、成人指定の本文の未成年を指す語)。
// 純粋関数だけで書く (Prisma・fetch・cloudflare:workers に依存しない)。入力は変更しない。
// 空文字や空配列を渡しても例外を投げない。

export type CheckChapter = { number: number; content: string }

export type EndingOverlap = { a: number; b: number; phrase: string }

export type IndentStats = { narration: number; indented: number }

// indented = 地の文の 9 割以上が字下げ / flush = 1 割以下 / mixed = その間 / none = 地の文なし
export type IndentStyle = 'indented' | 'flush' | 'mixed' | 'none'

export type ChapterCheckInput = {
  chapter: CheckChapter
  targetChars: number
  // 章立ての登場予定。空なら人物の検査をしない
  plannedCharacters: string[]
  // 小説の名簿
  castNames: string[]
  // 人物名 → その人物が呼ばれる呼び方 (呼称表から)
  callsByName?: Record<string, string[]>
  // 登場予定の人物の口調の例
  speechExamples: string[]
  // 比べる他の章
  otherChapters: CheckChapter[]
  // 年齢指定 (全年齢 / R15 / R18)。R15 / R18 のときだけ、本文の未成年を指す語を検査する。渡さなければ検査しない
  ageRating?: string
}

export type MinorTermExcerpt = { term: string; excerpt: string }

const DEFAULT_TAIL_CHARS = 200
const DEFAULT_OVERLAP_MIN_LENGTH = 6
const DEFAULT_SPEECH_MIN_LENGTH = 8
// CheckWarningSchema.message の上限
const MAX_MESSAGE_CHARS = 600
// 未成年を指す語の警告: 並べる語の数、抜粋を添える語の数、抜粋に含める語の前後の字数
const MINOR_TERMS_SHOWN = 8
const MINOR_EXCERPTS_SHOWN = 2
const MINOR_EXCERPT_BEFORE = 10
const MINOR_EXCERPT_AFTER = 15
// 語の位置を確かめるときの窓。findMinorTerms の前後の条件 (直前 4 字ほど、直後 2 字ほど) が窓の端で切れない余白
const MINOR_VERIFY_BEFORE = 10
const MINOR_VERIFY_AFTER = 4

// 章末の比較で無視する文字。空白、句読点、記号 (句読点・括弧・ダッシュ・三点リーダ・全角記号を含む)、制御文字。
// 長音符「ー」(U+30FC) は文字 (Lm) なので残る。
const OVERLAP_NOISE = /[\p{White_Space}\p{P}\p{S}\p{C}]/gu
// 地の文でない行 (会話文・心の声) の先頭
const OPENING_BRACKET = /^[「『（(【［[〈《〔｛{“‘]/u
// 口調の例の前後から落とす文字。末尾は空白・句読点・感嘆符・疑問符・三点リーダ
const SPEECH_LEADING_TRIM = /^\p{White_Space}+/u
const SPEECH_TRAILING_TRIM = /[\p{White_Space}、。，．,.!！?？…‥]+$/u
// 名前の区切り (空白、中黒、＝)
const NAME_SEPARATOR = /[\s・･＝=]+/u
const IDEOGRAPHIC_SPACE = '　'

const range = (n: number): number[] => Array.from({ length: Math.max(0, n) }, (_, i) => i)
const unique = <T>(values: T[]): T[] => [...new Set(values)]
const formatInt = (n: number): string => n.toLocaleString('en-US')
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)
const warning = (kind: CheckKind, message: string): CheckWarning => ({
  kind,
  message: clip(message, MAX_MESSAGE_CHARS)
})

// ---------------------- 文字数 ----------------------

// 目標比。目標が 0 以下のときは比を定義できないので 0 を返す。
export function lengthRatio(content: string, targetChars: number): number {
  return targetChars > 0 ? content.length / targetChars : 0
}

// ---------------------- 章末の重複 ----------------------

// 末尾の空白を除いた最後の chars 字。
export function chapterTail(content: string, chars: number = DEFAULT_TAIL_CHARS): string {
  return chars > 0 ? content.trimEnd().slice(-chars) : ''
}

// 最長共通部分文字列 (連続する部分)。同じ長さが複数あるときは a で先に現れるもの。
export function longestCommonSubstring(a: string, b: string): string {
  if (a === '' || b === '') return ''
  // dp[j + 1] = a[i] と b[j] で終わる共通部分の長さ。1 行ぶんだけ持ち、右から更新して前の行の値を壊さない。
  const dp = new Array<number>(b.length + 1).fill(0)
  const columns = range(b.length).reverse()
  const best = { length: 0, end: 0 }
  for (const i of range(a.length)) {
    const ch = a.charAt(i)
    for (const j of columns) {
      const length = ch === b.charAt(j) ? dp[j] + 1 : 0
      dp[j + 1] = length
      if (length > best.length) {
        best.length = length
        best.end = i + 1
      }
    }
  }
  return a.slice(best.end - best.length, best.end)
}

const normalizedTail = (content: string, tailChars: number): string =>
  chapterTail(content, tailChars).replace(OVERLAP_NOISE, '')

// 章末同士の共通部分。空白・句読点・記号の違いは無視し、minLength 字以上共通するペアだけ返す。
// a < b の順。同じ章番号どうしは比べない。
export function findEndingOverlaps(
  chapters: CheckChapter[],
  options: { tailChars?: number; minLength?: number } = {}
): EndingOverlap[] {
  const tailChars = options.tailChars === undefined ? DEFAULT_TAIL_CHARS : options.tailChars
  const minLength = Math.max(1, options.minLength === undefined ? DEFAULT_OVERLAP_MIN_LENGTH : options.minLength)
  const tails = [...chapters]
    .sort((x, y) => x.number - y.number)
    .map((c) => ({ number: c.number, tail: normalizedTail(c.content, tailChars) }))
  return tails.flatMap((x, i) =>
    tails
      .slice(i + 1)
      .filter((y) => y.number !== x.number)
      .flatMap((y) => {
        const phrase = longestCommonSubstring(x.tail, y.tail)
        return phrase.length >= minLength ? [{ a: x.number, b: y.number, phrase }] : []
      })
  )
}

// ---------------------- 口調の例の丸写し ----------------------

const stripSpeechExample = (example: string): string =>
  example.replace(SPEECH_LEADING_TRIM, '').replace(SPEECH_TRAILING_TRIM, '')

// 本文にそのまま含まれる口調の例 (元の文字列で返す)。
// 前後の空白と末尾の句読点・感嘆符・疑問符を除いてから比べ、除いた後が minLength 字未満の例は対象外。
export function findSpeechCopies(content: string, examples: string[], options: { minLength?: number } = {}): string[] {
  const minLength = Math.max(1, options.minLength === undefined ? DEFAULT_SPEECH_MIN_LENGTH : options.minLength)
  const copies = examples.filter((example) => {
    const core = stripSpeechExample(example)
    return core.length >= minLength && content.includes(core)
  })
  return unique(copies)
}

// ---------------------- 字下げ ----------------------

// 行単位で数える。空行 (空白だけの行も) は数えない。行頭が開き括弧の行 (会話文・心の声) は地の文に数えない。
// 行頭の全角空白の後ろに括弧が来る行は、行頭が括弧ではないので地の文として数える。
export function indentStats(content: string): IndentStats {
  return content.split(/\r\n|\r|\n/).reduce<IndentStats>(
    (acc, line) => {
      if (line.trim() === '' || OPENING_BRACKET.test(line)) return acc
      return {
        narration: acc.narration + 1,
        indented: acc.indented + (line.startsWith(IDEOGRAPHIC_SPACE) ? 1 : 0)
      }
    },
    { narration: 0, indented: 0 }
  )
}

// 9 割以上 = indented、1 割以下 = flush、その間 = mixed、地の文なし = none。整数で比べて小数の誤差を避ける。
export function indentStyle(stats: IndentStats): IndentStyle {
  if (stats.narration <= 0) return 'none'
  if (stats.indented * 10 >= stats.narration * 9) return 'indented'
  if (stats.indented * 10 <= stats.narration) return 'flush'
  return 'mixed'
}

// ---------------------- 人物名の出現 ----------------------

// 厳密な別名: 名前そのもの、区切り (空白、・、＝) で分けた各部 (2 字以上)、呼び方 calls と名前の最長共通部分 (2 字以上)。
// 「予定外の人物が出ている」の判定で、誤検出を避けるために使う。
export function nameAliases(name: string, calls: string[] = []): string[] {
  const full = name.trim()
  if (full === '') return []
  const parts = full.split(NAME_SEPARATOR).filter((part) => part.length >= 2)
  const fromCalls = calls
    .map((call) => longestCommonSubstring(full, call.trim()))
    .filter((common) => common.length >= 2)
  return unique([full, ...parts, ...fromCalls])
}

// loose の追加の一致。4 字以上で区切りの無い名前は、2 字以上で名前全体より短い接頭辞・接尾辞のどれかが本文にあれば一致。
// 長い接頭辞・接尾辞は 2 字のものを含むので、2 字ぶんだけ見れば同じ結果になる。
const loosePieces = (name: string): string[] =>
  name.length >= 4 && !NAME_SEPARATOR.test(name) ? [name.slice(0, 2), name.slice(-2)] : []

// 本文に人物が出ているか。
// 既定 (厳密) は別名だけで判定し、「予定外の人物が出ている」に使う。
// loose は「登場予定の人物が出てこない」の見逃しを避けるため、「酒寄彩葉」を「彩葉」「酒寄」でも一致とする。
// 3 字以下の名前は loose でも全体一致だけ (「かぐや」が「かぐわしい」に一致しない)。
export function isMentioned(
  content: string,
  name: string,
  options: { calls?: string[]; loose?: boolean } = {}
): boolean {
  if (content === '') return false
  if (nameAliases(name, options.calls).some((alias) => content.includes(alias))) return true
  return options.loose === true && loosePieces(name.trim()).some((piece) => content.includes(piece))
}

// ---------------------- 成人指定の本文の未成年を指す語 ----------------------

// 元の本文の位置との対応つきで NFKC 正規化した文。findMinorTerms は NFKC で正規化した文に当てるので、
// 全角数字 (高２)、三点リーダ (…)、全角記号 (！) は長さが変わりうる。抜粋は元の本文から切り出したいので、
// 正規化後の 1 字ごとに、元の本文での範囲 [starts, ends) を持つ。
type OffsetText = { text: string; starts: number[]; ends: number[] }

function normalizeWithOffsets(content: string): OffsetText {
  const starts: number[] = []
  const ends: number[] = []
  const pieces: string[] = []
  const cursor = { offset: 0 }
  for (const char of content) {
    const normalized = char.normalize('NFKC')
    const end = cursor.offset + char.length
    pieces.push(normalized)
    starts.push(...Array.from({ length: normalized.length }, () => cursor.offset))
    ends.push(...Array.from({ length: normalized.length }, () => end))
    cursor.offset = end
  }
  return { text: pieces.join(''), starts, ends }
}

// text の中で part が現れる位置 (重ならないもの) を昇順で返す。
function occurrences(text: string, part: string): number[] {
  if (part === '') return []
  const found: number[] = []
  text
    .split(part)
    .slice(0, -1)
    .reduce((at, piece) => {
      found.push(at + piece.length)
      return at + piece.length + part.length
    }, 0)
  return found
}

// 語が実際に当たる最初の位置。「標高2000m」の「高2」のように、文字列としては同じでも語として数えない箇所は飛ばす
// (findMinorTerms を、その位置の前後だけの窓にかけて確かめる)。
function locateMinorTerm(mapped: OffsetText, searchable: string, term: string): number | undefined {
  return occurrences(searchable, term).find((index) => {
    const window = mapped.text.slice(Math.max(0, index - MINOR_VERIFY_BEFORE), index + term.length + MINOR_VERIFY_AFTER)
    return findMinorTerms(window).includes(term)
  })
}

// 元の本文から、語の前 10 字・後 15 字ほどを切り出す。改行や連続する空白は 1 つの空白にし、切れた端には「…」を付ける。
function excerptAround(content: string, mapped: OffsetText, index: number, termLength: number): string {
  const from = Math.max(0, mapped.starts[index] - MINOR_EXCERPT_BEFORE)
  const to = Math.min(content.length, mapped.ends[index + termLength - 1] + MINOR_EXCERPT_AFTER)
  const text = content
    .slice(from, to)
    // 切り口が絵文字などのサロゲートペアの途中になったときの、片割れ
    .replace(/^[\uDC00-\uDFFF]/, '')
    .replace(/[\uD800-\uDBFF]$/, '')
    .replace(/\s+/g, ' ')
    .trim()
  return `${from > 0 ? '…' : ''}${text}${to < content.length ? '…' : ''}`
}

// 本文にある未成年を指す語と、各語の最初の出現箇所の抜粋 (見つかった順、語の重複なし)。
// 抜粋は元の本文の字のまま (改行は空白)。位置が決まらなかった語は excerpt が空文字。
export function findMinorTermsInChapter(content: string): MinorTermExcerpt[] {
  const terms = findMinorTerms(content)
  if (terms.length === 0) return []
  const mapped = normalizeWithOffsets(content)
  // findMinorTerms は英字の語 (JK) を大文字にそろえて返す。位置の検索も大文字にそろえた文で行う (長さは変わらない)
  const searchable = mapped.text.replace(/[a-z]/g, (char) => char.toUpperCase())
  return terms.map((term) => {
    const index = locateMinorTerm(mapped, searchable, term)
    return { term, excerpt: index === undefined ? '' : excerptAround(content, mapped, index, term.length) }
  })
}

// ---------------------- 章の検査 ----------------------

const callsFor = (callsByName: Record<string, string[]> | undefined, name: string): string[] =>
  callsByName !== undefined && Object.hasOwn(callsByName, name) ? callsByName[name] : []

const nameList = (names: string[]): string => clip(names.join('、'), 400)

function lengthWarnings(chapter: CheckChapter, targetChars: number): CheckWarning[] {
  if (targetChars <= 0) return []
  // 0.8 未満か 1.5 超。整数で比べて小数の誤差を避ける。
  const outOfRange = chapter.content.length * 10 < targetChars * 8 || chapter.content.length * 2 > targetChars * 3
  if (!outOfRange) return []
  const percent = Math.round(lengthRatio(chapter.content, targetChars) * 100)
  return [
    warning(
      'length',
      `目標 ${formatInt(targetChars)} 字に対して ${formatInt(chapter.content.length)} 字（${percent}%）です`
    )
  ]
}

const normalizeNames = (names: string[]): string[] =>
  unique(names.map((name) => name.trim()).filter((name) => name !== ''))

// 登場予定なのに本文に出てこない人物。見逃しを避けるため loose で判定する (誤警告を出さない側に倒す)。
export function findMissingCharacters(
  content: string,
  plannedCharacters: string[],
  callsByName?: Record<string, string[]>
): string[] {
  return normalizeNames(plannedCharacters).filter(
    (name) => !isMentioned(content, name, { calls: callsFor(callsByName, name), loose: true })
  )
}

// 登場予定でない名簿の人物が本文に出ているもの。誤検出を避けるため厳密な別名で判定する。
// 登場予定が空の章は予定が決まっていないので、判定しない。
export function findUnexpectedCharacters(
  content: string,
  plannedCharacters: string[],
  castNames: string[],
  callsByName?: Record<string, string[]>
): string[] {
  const planned = new Set(normalizeNames(plannedCharacters))
  if (planned.size === 0) return []
  return normalizeNames(castNames).filter(
    (name) => !planned.has(name) && isMentioned(content, name, { calls: callsFor(callsByName, name) })
  )
}

function characterWarnings(input: ChapterCheckInput): CheckWarning[] {
  const plannedCount = normalizeNames(input.plannedCharacters).length
  if (plannedCount === 0) return []
  const { content } = input.chapter
  const missing = findMissingCharacters(content, input.plannedCharacters, input.callsByName)
  const unexpected = findUnexpectedCharacters(content, input.plannedCharacters, input.castNames, input.callsByName)
  return [
    ...(missing.length > 0
      ? [
          warning(
            'missing_character',
            `登場予定の ${plannedCount} 人のうち ${missing.length} 人が本文に出てきません:${nameList(missing)}`
          )
        ]
      : []),
    ...(unexpected.length > 0
      ? [
          warning(
            'unexpected_character',
            `登場予定にない人物が ${unexpected.length} 人、本文に出ています:${nameList(unexpected)}`
          )
        ]
      : [])
  ]
}

function overlapWarnings(chapter: CheckChapter, others: CheckChapter[]): CheckWarning[] {
  return others
    .filter((other) => other.number !== chapter.number)
    .sort((x, y) => x.number - y.number)
    .flatMap((other) => {
      const [overlap] = findEndingOverlaps([chapter, other])
      return overlap === undefined
        ? []
        : [warning('ending_overlap', `章末が第 ${other.number} 章と重なっています:「${clip(overlap.phrase, 60)}」`)]
    })
}

function indentWarnings(content: string): CheckWarning[] {
  const stats = indentStats(content)
  const style = indentStyle(stats)
  if (style === 'flush') {
    return [warning('indent', `段落頭の字下げがありません（地の文 ${stats.narration} 行中 ${stats.indented} 行）`)]
  }
  if (style === 'mixed') {
    return [
      warning('indent', `段落頭の字下げが揃っていません（地の文 ${stats.narration} 行中 ${stats.indented} 行が字下げ）`)
    ]
  }
  return []
}

// 成人指定 (R15 / R18) の作品の本文に未成年を指す語があれば、1 件の警告にまとめる。
// 語は MINOR_TERMS_SHOWN 語まで、抜粋は先頭の MINOR_EXCERPTS_SHOWN 件まで。年齢指定が無い・全年齢なら出さない。
function minorTermWarnings(content: string, ageRating: string | undefined): CheckWarning[] {
  if (ageRating === undefined || !isAdultRating(ageRating)) return []
  const found = findMinorTermsInChapter(content)
  if (found.length === 0) return []
  const shown = found.slice(0, MINOR_TERMS_SHOWN)
  const rest = found.length - shown.length
  const terms = `${shown.map((item) => `「${item.term}」`).join('')}${rest > 0 ? `ほか ${rest} 語` : ''}`
  const excerpts = shown
    .filter((item) => item.excerpt !== '')
    .slice(0, MINOR_EXCERPTS_SHOWN)
    .map((item) => `（${item.excerpt}）`)
    .join('')
  return [warning('minor_term', `成人指定の作品ですが、本文に未成年を指す語があります:${terms}${excerpts}`)]
}

// 1 章ぶんの検査。警告の並びは minor_term、length、missing_character、unexpected_character、ending_overlap、speech_copy、indent。
// 問題が無ければ空配列。
export function checkChapter(input: ChapterCheckInput): CheckWarning[] {
  const { chapter } = input
  const copies = findSpeechCopies(chapter.content, input.speechExamples)
  return [
    ...minorTermWarnings(chapter.content, input.ageRating),
    ...lengthWarnings(chapter, input.targetChars),
    ...characterWarnings(input),
    ...overlapWarnings(chapter, input.otherChapters),
    ...copies.map((example) =>
      warning(
        'speech_copy',
        `口調の例がそのまま本文に使われています（${stripSpeechExample(example).length} 字）:「${clip(example, 80)}」`
      )
    ),
    ...indentWarnings(chapter.content)
  ]
}
