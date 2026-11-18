// 生成済みの小説の整合性の指標を Markdown で標準出力に出す。
// フェーズごとに同じ小説で数値を比べるための道具で、生成も DB の読み書きもしない。
//
//   bun scripts/eval-consistency.ts --novel <ファイルか URL> [--characters <ファイルか URL>]
//   bun scripts/eval-consistency.ts --base http://localhost:11675 --id <novelId>
//
// --novel     GET /api/novels/:id の応答 JSON
// --characters GET /api/characters の応答 JSON。口調の例の丸写しは、これを渡したときだけ数える
// --base --id  上の 2 つを API から取得する (サーバーは利用者が自分で起動しておく)

import { readFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import {
  type CheckChapter,
  type EndingOverlap,
  findEndingOverlaps,
  findMissingCharacters,
  findSpeechCopies,
  findUnexpectedCharacters,
  type IndentStyle,
  indentStats,
  indentStyle,
  lengthRatio
} from '../src/lib/novel/checks'
import { type Character, CharacterSchema } from '../src/schemas/character.dto'
import { type NovelWithChapters, NovelWithChaptersSchema } from '../src/schemas/novel.dto'

const USAGE = `使い方:
  bun scripts/eval-consistency.ts --novel <ファイルか URL> [--characters <ファイルか URL>]
  bun scripts/eval-consistency.ts --base http://localhost:11675 --id <novelId>`

const FETCH_TIMEOUT_MS = 30_000
// 目標の 80% 以上を「足りている」とみなす (checks.ts の length 警告と同じ境界)
const ENOUGH_RATIO = 0.8

type Result<T> = { ok: true; value: T } | { ok: false; error: string }
const succeed = <T>(value: T): Result<T> => ({ ok: true, value })
const fail = (error: string): Result<never> => ({ ok: false, error })
const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error))

// ---------------------- 入力 ----------------------

type Sources = { novel: string; characters: string | undefined }

function resolveSources(argv: string[]): Result<Sources | 'help'> {
  const parsed = (() => {
    try {
      return succeed(
        parseArgs({
          args: argv,
          options: {
            novel: { type: 'string' },
            characters: { type: 'string' },
            base: { type: 'string' },
            id: { type: 'string' },
            help: { type: 'boolean', short: 'h' }
          },
          strict: true,
          allowPositionals: false
        }).values
      )
    } catch (error) {
      return fail(describeError(error))
    }
  })()
  if (!parsed.ok) return parsed
  const { novel, characters, base, id, help } = parsed.value
  if (help === true) return succeed('help')

  const usesApi = base !== undefined || id !== undefined
  if (usesApi && (novel !== undefined || characters !== undefined)) {
    return fail('--base / --id と --novel / --characters は同時に指定できません')
  }
  if (usesApi) {
    if (base === undefined || id === undefined) return fail('--base と --id は両方指定してください')
    if (!/^https?:\/\//i.test(base)) return fail(`--base は http:// か https:// で始まる URL にしてください: ${base}`)
    if (id.trim() === '') return fail('--id が空です')
    const root = base.replace(/\/+$/, '')
    return succeed({
      novel: `${root}/api/novels/${encodeURIComponent(id)}`,
      characters: `${root}/api/characters`
    })
  }
  if (novel === undefined) return fail('--novel か、--base と --id のどちらかを指定してください')
  return succeed({ novel, characters })
}

// http(s) で始まる値は fetch、それ以外はファイルとして読む。
async function readJson(source: string, label: string): Promise<Result<unknown>> {
  if (/^https?:\/\//i.test(source)) {
    try {
      const response = await fetch(source, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
      if (!response.ok) return fail(`${label}: ${source} が HTTP ${response.status} を返しました`)
      return succeed(await response.json())
    } catch (error) {
      return fail(`${label}: ${source} を取得できません (${describeError(error)})`)
    }
  }
  try {
    return succeed(JSON.parse(await readFile(source, 'utf-8')))
  } catch (error) {
    return fail(`${label}: ${source} を読めません (${describeError(error)})`)
  }
}

function parseWith<T>(schema: z.ZodType<T>, raw: unknown, label: string): Result<T> {
  const parsed = schema.safeParse(raw)
  if (parsed.success) return succeed(parsed.data)
  const reasons = parsed.error.issues.slice(0, 3).map((issue) => {
    const path = issue.path.join('.')
    return path === '' ? issue.message : `${path}: ${issue.message}`
  })
  return fail(`${label} の形が不正です (${reasons.join(' / ')})`)
}

async function loadNovel(source: string): Promise<Result<NovelWithChapters>> {
  const raw = await readJson(source, '小説')
  return raw.ok ? parseWith(NovelWithChaptersSchema, raw.value, '小説') : raw
}

async function loadCharacters(source: string): Promise<Result<Character[]>> {
  const raw = await readJson(source, '人物')
  return raw.ok ? parseWith(z.array(CharacterSchema), raw.value, '人物') : raw
}

// ---------------------- 集計 ----------------------

type ChapterMetrics = {
  number: number
  chars: number
  ratio: number
  indent: IndentStyle
  // null = 計測しない (口調の例が無い / 登場予定が無い)
  speechCopies: string[] | null
  missing: string[] | null
  unexpected: string[] | null
  // この章を含む重複
  overlaps: EndingOverlap[]
}

// 小説の名簿の人物名 → 口調の例。バリエーションに口調の例があればそれ、無ければ本体のもの
// (src/lib/novel/chapter-context.ts の effectiveCharacter と同じ考え方)。
function speechExamplesByName(novel: NovelWithChapters, characters: Character[]): Map<string, string[]> {
  return new Map(
    novel.cast.flatMap((member) => {
      const character = characters.find((c) => c.id === member.character_id)
      if (character === undefined) return []
      const variant =
        member.variant_id === null ? undefined : character.variants.find((v) => v.id === member.variant_id)
      const examples =
        variant !== undefined && variant.speech_examples.length > 0
          ? variant.speech_examples
          : character.speech_examples
      return [[member.name, examples] as const]
    })
  )
}

const examplesFor = (examplesByName: Map<string, string[]>, name: string): string[] => {
  const examples = examplesByName.get(name)
  return examples === undefined ? [] : examples
}

function collectMetrics(novel: NovelWithChapters, characters: Character[] | undefined): ChapterMetrics[] {
  const chapters: CheckChapter[] = [...novel.chapters]
    .sort((a, b) => a.chapter_number - b.chapter_number)
    .map((chapter) => ({ number: chapter.chapter_number, content: chapter.content }))
  const overlaps = findEndingOverlaps(chapters)
  const castNames = novel.cast.map((member) => member.name)
  const examplesByName = characters === undefined ? undefined : speechExamplesByName(novel, characters)

  return chapters.map((chapter) => {
    const entry =
      novel.outline === null ? undefined : novel.outline.chapters.find((e) => e.chapter_number === chapter.number)
    const planned = entry === undefined ? [] : entry.characters
    const hasPlan = planned.length > 0
    // 登場予定の人物の口調の例。登場予定が無い章 (旧い章立て) は名簿全員のものを使う
    const examples =
      examplesByName === undefined
        ? undefined
        : (hasPlan ? planned : castNames).flatMap((name) => examplesFor(examplesByName, name))
    return {
      number: chapter.number,
      chars: chapter.content.length,
      ratio: lengthRatio(chapter.content, novel.target_chars),
      indent: indentStyle(indentStats(chapter.content)),
      speechCopies: examples === undefined ? null : findSpeechCopies(chapter.content, examples),
      missing: hasPlan ? findMissingCharacters(chapter.content, planned) : null,
      unexpected: hasPlan ? findUnexpectedCharacters(chapter.content, planned, castNames) : null,
      overlaps: overlaps.filter((o) => o.a === chapter.number || o.b === chapter.number)
    }
  })
}

// ---------------------- 出力 ----------------------

const INDENT_LABELS: Record<IndentStyle, string> = {
  indented: 'あり',
  flush: 'なし',
  mixed: '混在',
  none: '地の文なし'
}
const INDENT_ORDER: IndentStyle[] = ['indented', 'flush', 'mixed', 'none']

const percent = (ratio: number): string => `${Math.round(ratio * 100)}%`
const countCell = (items: string[] | null): string => (items === null ? '-' : String(items.length))
const chapterLabel = (number: number): string => `第 ${number} 章`
const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}…` : text)

function renderTable(metrics: ChapterMetrics[]): string[] {
  return [
    '| 章 | 文字数 | 目標比 | 字下げ | 口調の丸写し | 未登場 | 予定外 | 章末の重複 |',
    '|---:|---:|---:|---|---:|---:|---:|---:|',
    ...metrics
      .map((m) =>
        [
          m.number,
          m.chars,
          percent(m.ratio),
          INDENT_LABELS[m.indent],
          countCell(m.speechCopies),
          countCell(m.missing),
          countCell(m.unexpected),
          m.overlaps.length
        ].join(' | ')
      )
      .map((row) => `| ${row} |`)
  ]
}

function renderSummary(metrics: ChapterMetrics[], measuresSpeech: boolean): string[] {
  const mean = metrics.length === 0 ? '-' : percent(metrics.reduce((sum, m) => sum + m.ratio, 0) / metrics.length)
  const enough = metrics.filter((m) => m.ratio >= ENOUGH_RATIO).length
  // 重複は章のペアを 1 件と数える (各章の表のセルは、その章を含むペアの数)
  const overlapCount = metrics.reduce((sum, m) => sum + m.overlaps.length, 0) / 2
  const copyCount = metrics.reduce((sum, m) => sum + (m.speechCopies === null ? 0 : m.speechCopies.length), 0)
  const indentCounts = INDENT_ORDER.map(
    (style) => `${INDENT_LABELS[style]} ${metrics.filter((m) => m.indent === style).length}`
  )
  return [
    `- 目標比の平均: ${mean}`,
    `- 目標の 80% 以上の章: ${enough} / ${metrics.length}`,
    `- 章末の重複: ${overlapCount} 件`,
    `- 口調の例の丸写し: ${measuresSpeech ? `${copyCount} 件` : '未計測（--characters なし）'}`,
    `- 字下げの種類ごとの章数: ${indentCounts.join(' / ')}`
  ]
}

// 表のセルには数値だけを置くので、中身 (どの語句か、誰か) はここに書く。
function renderDetails(metrics: ChapterMetrics[]): string[] {
  const overlapLines = metrics.flatMap((m) =>
    m.overlaps
      .filter((o) => o.a === m.number)
      .map((o) => `- 章末の重複: 第 ${o.a} 章と第 ${o.b} 章「${clip(o.phrase, 60)}」`)
  )
  const perChapter = (label: string, pick: (m: ChapterMetrics) => string[] | null, quote: boolean): string[] =>
    metrics.flatMap((m) => {
      const items = pick(m)
      if (items === null || items.length === 0) return []
      const text = items.map((item) => (quote ? `「${clip(item, 40)}」` : item)).join('、')
      return [`- ${label}: ${chapterLabel(m.number)} ${text}`]
    })
  return [
    ...overlapLines,
    ...perChapter('口調の例の丸写し', (m) => m.speechCopies, true),
    ...perChapter('未登場', (m) => m.missing, false),
    ...perChapter('予定外', (m) => m.unexpected, false)
  ]
}

function renderReport(novel: NovelWithChapters, metrics: ChapterMetrics[], measuresSpeech: boolean): string {
  const details = renderDetails(metrics)
  return [
    `# ${novel.title}`,
    '',
    `- 章数: ${novel.num_chapters}（本文あり ${metrics.length}）`,
    `- 目標文字数: ${novel.target_chars} 字`,
    '',
    '## 章ごと',
    '',
    ...(metrics.length === 0 ? ['本文のある章がありません。'] : renderTable(metrics)),
    '',
    '## まとめ',
    '',
    ...renderSummary(metrics, measuresSpeech),
    ...(details.length === 0 ? [] : ['', '## 詳細', '', ...details]),
    ''
  ].join('\n')
}

// ---------------------- 実行 ----------------------

function exitWith(error: string): number {
  process.stderr.write(`エラー: ${error}\n\n${USAGE}\n`)
  return 1
}

async function main(argv: string[]): Promise<number> {
  const sources = resolveSources(argv)
  if (!sources.ok) return exitWith(sources.error)
  if (sources.value === 'help') {
    process.stdout.write(`${USAGE}\n`)
    return 0
  }
  const { novel: novelSource, characters: charactersSource } = sources.value

  const novel = await loadNovel(novelSource)
  if (!novel.ok) return exitWith(novel.error)
  const characters = charactersSource === undefined ? undefined : await loadCharacters(charactersSource)
  if (characters !== undefined && !characters.ok) return exitWith(characters.error)
  const characterList = characters === undefined ? undefined : characters.value

  if (characterList !== undefined) {
    const known = new Set(characterList.map((c) => c.id))
    const unknown = novel.value.cast.filter((member) => !known.has(member.character_id)).map((member) => member.name)
    if (unknown.length > 0) {
      process.stderr.write(`警告: 人物の一覧に無いため口調の例を使えない人物: ${unknown.join('、')}\n`)
    }
  }

  const metrics = collectMetrics(novel.value, characterList)
  process.stdout.write(renderReport(novel.value, metrics, characterList !== undefined))
  return 0
}

process.exitCode = await main(process.argv.slice(2))
