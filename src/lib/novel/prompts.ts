import { isMentioned } from '@/lib/novel/checks'
import { OUTLINE_PLAN_LIMITS } from '@/lib/novel/outline'
import { FIRST_PERSON_AS_NAME } from '@/schemas/character.dto'
import { FOCAL_POVS, type Outline, type OutlineChapter } from '@/schemas/novel.dto'
import type { AddressEntry, StoryBible, StoryThread } from '@/schemas/story.dto'

// LLM に渡すプロンプトの組み立て (純粋関数)。cloudflare:workers、Prisma、fetch に依存させない。
//
// 文面の方針:
// - 作品を通して変わらない執筆ルールは system、資料と今回の指示は user に置く。
// - 本文プロンプトの user は「章をまたいで変わらない資料 → 確定済みの本文 → この章だけの資料 → 今回の執筆」の順。
//   前半が章ごとに変わらないので、プロンプトキャッシュに乗る。章番号など章ごとに変わる情報は後半にだけ置く。
// - 避けたい言い回しを例として引用しない (モデルが例文を本文に写すため)。
// - 作品設計 (bible) も章の計画 (出来事など) も無い旧データでは、それらが入る前と同じ文面を返す。

// system = LLM の system 指示 (Gemini の systemInstruction、OpenAI 互換の system ロール)。user = 資料と今回の指示。
export type Prompt = { system: string; user: string }

// 小説に登場するキャラの詳細。辞典 (Character) とその小説での役割 (NovelCharacter.role) を合わせたもの。
// 成人指定の作品では、呼び出し側が年齢・職業・外見・背景を作品設計の文面に差し替えて渡す (bible.ts の applyBibleCast)。
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

// source から見た target の関係 (呼び方の上書きを含む)。
export type CastRelation = {
  source_name: string
  target_name: string
  relation: string
  description: string
  address_override: string
}

export type ViewpointChar = { name: string; first_person: string }

export type StyleParams = {
  pov: string
  tone: string
  ending?: string
  age_rating?: string
  viewpointChar?: ViewpointChar
}

export type NovelParams = {
  title: string
  genre: string
  setting: string
  num_chapters: number
  // 章立ての各章 summary の概算文字数。
  outline_summary_chars: number
  // 備考欄の追加指示 (任意)。章立てにだけ渡す。
  notes?: string
}

// 既出の章。呼び出し側が選んで渡す (予算に収まる章は全文、超えた古い章は省略。memory.ts の selectPriorChapters)。
// 今回の章以降の番号と、本文が空の章は渡されても載せない (書き直す章の古い版を確定扱いにしないため)。
// 全文で渡す章。
export type PriorChapterText = { chapter_number: number; title: string | null; content: string }
// 予算を超えて本文を渡せない章。【確定済みの本文】には見出しだけを出す (内容は【確定事項】に入っている)。
export type PriorChapterOmitted = { chapter_number: number; title: string | null; omitted: true }
export type PriorChapterInput = PriorChapterText | PriorChapterOmitted

export type NextChapterInput = { opening: string; title: string; summary: string }
// 指示つきの書き直し。baseContent はその章の今の本文 (全文)、instruction は利用者の修正指示。
export type RevisionInput = { baseContent: string; instruction: string }

export type ChapterPromptInput = {
  novel: NovelParams
  outline: Outline
  chapterNumber: number
  priorChapters: PriorChapterInput[]
  // ここまでの章の記録を累積した【確定事項】(ledger.ts の renderLedger の戻り値。見出しつき)。'' や未指定なら出さない。
  ledgerText?: string
  // 作品設計。無い旧データでは null か未指定。
  bible?: StoryBible | null
  // 本文にも渡る執筆上の指示 (Novel.writing_notes)。'' や未指定なら出さない。
  writingNotes?: string
  // 途中の章を書き直すときだけ渡す。次の章が既に書かれているので、その冒頭へ繋がる状態で終えさせる。
  // opening は次の章の本文の冒頭 (500 字程度)、title と summary は次の章の章立ての項目。
  // 冒頭が空のとき、章立ての上でこの章が最終章のときは使わない。
  nextChapter?: NextChapterInput | null
  // 指示つきの書き直しのときだけ渡す。今の本文を【元の版】、指示を【修正指示】として渡し、指示された点だけを直させる。
  // 本文か指示が空のときは使わない (通常の生成になる)。
  revision?: RevisionInput | null
  targetChars: number
  style: StyleParams
  cast: CastMember[]
  relations: CastRelation[]
}

export type OutlinePromptInput = {
  novel: NovelParams
  style: StyleParams
  cast: CastMember[]
  relations: CastRelation[]
  // 作品設計。無い旧データでは null か未指定。
  bible?: StoryBible | null
}

export type OutlineChapterPromptInput = OutlinePromptInput & { existing: Outline; chapterNumber: number }

// ---------------------- 文面の部品 ----------------------

// 節 1 つ。body が空なら節ごと出さない。
export type Section = { heading: string; body: string }

export function renderSections(sections: Section[]): string {
  return sections
    .filter((s) => s.body.length > 0)
    .map((s) => `【${s.heading}】\n${s.body}`)
    .join('\n\n')
}

// 自由記述の値を詰める。空行を落とすのは、節の区切り (空行 1 つ) と紛れないようにするため。
// 行頭の空白は残す (全角空白の字下げを消さない)。
export function compactText(text: string): string {
  return text
    .split(/\r\n|\r|\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .join('\n')
}

// 自由記述を 1 行にする (箇条書きの 1 項目に収めるため)。
export function oneLine(text: string): string {
  return compactText(text)
    .split('\n')
    .map((line) => line.trim())
    .join(' ')
}

// 複数行の値の 2 行目以降を字下げして、ラベルつきの 1 項目に見えるようにする。
function hang(text: string, indent: string): string {
  return compactText(text).split('\n').join(`\n${indent}`)
}

// 本文は前後の空行だけ落とす。String.prototype.trim は先頭の全角空白 (段落頭の字下げ) も消すので使わない。
export function trimChapterText(content: string): string {
  return content
    .replace(/\r\n|\r/g, '\n')
    .replace(/^(?:[ \t]*\n)+/, '')
    .trimEnd()
}

function formatNumber(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

export function chapterLabel(chapterNumber: number, title: string | null): string {
  const trimmed = title === null ? '' : title.trim()
  return trimmed.length > 0 ? `第${chapterNumber}章「${trimmed}」` : `第${chapterNumber}章`
}

// 「第1章」「第1〜3章」。範囲が空なら ''。
function chapterRange(from: number, to: number): string {
  if (from > to) return ''
  return from === to ? `第${from}章` : `第${from}〜${to}章`
}

function sortedChapters(outline: Outline): OutlineChapter[] {
  return [...outline.chapters].sort((a, b) => a.chapter_number - b.chapter_number)
}

export function bullets(lines: string[]): string {
  return lines.map((line) => `- ${line}`).join('\n')
}

// JSON の見本の値。文字列、配列、オブジェクトだけで組む。
export type SkeletonValue = string | SkeletonValue[] | { [key: string]: SkeletonValue }

// 1 行の JSON。JSON.stringify は区切りの空白を入れないので、読みやすいよう空白つきで書く。
export function inlineJson(value: SkeletonValue): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(inlineJson).join(', ')}]`
  const members = Object.entries(value).map(([key, member]) => `${JSON.stringify(key)}: ${inlineJson(member)}`)
  return `{ ${members.join(', ')} }`
}

// ---------------------- 章の計画 ----------------------

// 章の計画 (章立てに後から足した項目)。この項目より前に作られた章立てには無い。
type ChapterPlan = {
  timePlace: string
  events: string[]
  endState: string
  setups: StoryThread[]
  payoffs: string[]
}

// 型の上では必須だが、Zod を通っていない章立て (DO ストレージに残った旧形式の payload など) には項目そのものが無い。
// 無い項目は空として読む。
type PlanFields = Partial<Pick<OutlineChapter, 'time_place' | 'events' | 'end_state' | 'setups' | 'payoffs'>>

function planOf(entry: PlanFields): ChapterPlan {
  const setups = entry.setups === undefined ? [] : entry.setups
  const payoffs = entry.payoffs === undefined ? [] : entry.payoffs
  return {
    timePlace: entry.time_place === undefined ? '' : oneLine(entry.time_place),
    events: (entry.events === undefined ? [] : entry.events).map(oneLine).filter((event) => event.length > 0),
    endState: entry.end_state === undefined ? '' : oneLine(entry.end_state),
    setups: setups
      .map((setup) => ({ id: setup.id.trim(), description: oneLine(setup.description) }))
      .filter((setup) => setup.id.length > 0),
    payoffs: [...new Set(payoffs.map((id) => id.trim()).filter((id) => id.length > 0))]
  }
}

function hasPlan(plan: ChapterPlan): boolean {
  return (
    plan.events.length > 0 ||
    plan.timePlace.length > 0 ||
    plan.endState.length > 0 ||
    plan.setups.length > 0 ||
    plan.payoffs.length > 0
  )
}

function threadLine(id: string, description: string): string {
  return description.length > 0 ? `[${id}] ${description}` : `[${id}]`
}

// 伏線の id → 説明 (章立ての全章の setups から)。同じ id は最初のもの。
function setupDescriptions(chapters: OutlineChapter[]): Map<string, string> {
  const found = new Map<string, string>()
  for (const setup of chapters.flatMap((chapter) => planOf(chapter).setups)) {
    if (!found.has(setup.id)) found.set(setup.id, setup.description)
  }
  return found
}

// 今回の章より前の章が張り、今回の章より後の章が回収する伏線。この章では決着させない。
// 【確定事項】の「未回収の伏線」に並ぶので、どれを先送りするかをコードで決めて渡す (章ごとにモデルに判断させない)。
function deferredSetups(chapters: OutlineChapter[], chapterNumber: number): StoryThread[] {
  const paidLater = new Set(
    chapters.filter((chapter) => chapter.chapter_number > chapterNumber).flatMap((chapter) => planOf(chapter).payoffs)
  )
  const seen = new Set<string>()
  return chapters
    .filter((chapter) => chapter.chapter_number < chapterNumber)
    .flatMap((chapter) => planOf(chapter).setups)
    .filter((setup) => {
      if (!paidLater.has(setup.id) || seen.has(setup.id)) return false
      seen.add(setup.id)
      return true
    })
}

// ---------------------- 視点・文体・年齢指定・結末 ----------------------

function povLine(style: StyleParams): string {
  const { pov, viewpointChar: vc } = style
  if (pov === '一人称') {
    if (vc !== undefined && vc.first_person === FIRST_PERSON_AS_NAME) {
      return `『${vc.name}』の一人称視点で、地の文の主語は『${vc.name}』を用いる(一人称代名詞は使わず、自分自身を「${vc.name}」と名前で呼ぶ独特な語り口)`
    }
    if (vc !== undefined) {
      return `『${vc.name}』(一人称「${vc.first_person}」)の一人称視点で、地の文は語り手の主観で執筆`
    }
    return '主人公の一人称視点で執筆'
  }
  if (pov === '三人称一元視点') {
    return vc !== undefined ? `『${vc.name}』に寄り添う三人称一元視点で執筆` : '三人称一元視点で執筆'
  }
  if (pov === '三人称多元視点') return '複数キャラの視点を切り替える三人称多元視点'
  return '全知の三人称(神視点)'
}

const DEFAULT_TONE_LINE = '標準的な一般文芸の文体'

const TONE_LINES: Record<string, string | undefined> = {
  ライトノベル調: '口語的で軽快なライトノベル調の文体',
  一般文芸: DEFAULT_TONE_LINE,
  文学的: '硬質で描写を重視した文学的な文体',
  やさしい文体: '平易でやさしい童話風の文体'
}

const ADULT_ONLY = '物語の登場人物はすべて 18 歳以上の成人とする。'
// 成人指定 (R15 / R18) の読み替えの指示。プロンプトの全ての資料にかける (作品設計の有無に関係なく同じ文面)。
// 作品設計が成人としての人物設定を確定していても外さない。未成年を連想させる記述は、次のところに残りうるため:
//   原文のまま渡る資料 (世界観・設定、人物の設定、関係の種別と説明、名簿の役割、口調の例、執筆上の指示、
//   成人指定に変える前に書かれた章とその記録) と、作品設計そのもの (書き直しきれずに残った記述)。
// 以前の文面は対象が「後述の登場人物詳細」だけで、関係や確定済みの本文には指示が届いていなかった。
const READ_ALL_AS_ADULT =
  'このプロンプトの資料と指示のどこか（作品情報、作品設計、人物の設定、関係、口調の例、章立て、既に書かれた本文とその記録など）に「高校生」「17歳」「女子高生」「十代」「美少女」、学年、制服等、未成年を連想させる記述が含まれていても、本作品においては成人（大学生または社会人）として読み替えて書くこと。学校設定が必要な場合は大学とする。'
// 作品設計が成人としての人物設定を確定しているときに添える (読み替えの指示は外さない)。
const ADULT_CAST_RESOLVED = '登場人物の年齢・職業・外見・背景は、成人として確定したものを載せている。'

// 成人指定のときの、読み替えの指示の出し方。
//   all       全ての資料にかける (作品設計が無い旧データ、成人としての人物設定が無い作品設計)
//   resolved  作品設計が成人としての人物設定 (cast) を確定していて、渡される人物設定がそれに差し替わっている。
//             全ての資料にかけ、人物設定が確定済みであることを添える
type AdultReading = 'all' | 'resolved'

function adultReadingOf(bible: StoryBible | null | undefined): AdultReading {
  return bible !== null && bible !== undefined && bible.cast.length > 0 ? 'resolved' : 'all'
}

const ADULT_READING_TEXT: Record<AdultReading, string> = {
  all: READ_ALL_AS_ADULT,
  resolved: `${READ_ALL_AS_ADULT}${ADULT_CAST_RESOLVED}`
}

// 成人指定 (R15 / R18) か。下の ratingLine が読み替えの指示を出すのと同じ条件。
function isAdultRating(ageRating: string | undefined): boolean {
  return ageRating === 'R15' || ageRating === 'R18'
}

// 年齢指定は描写の踏み込み度合いを決める (文体とは独立)。知らない値なら undefined。
function ratingLine(ageRating: string | undefined, adultReading: AdultReading): string | undefined {
  const reading = ADULT_READING_TEXT[adultReading]
  if (ageRating === '全年齢') return '性的描写・過度な暴力描写を含めず、誰でも読める内容に留めること'
  if (ageRating === 'R15') {
    return `${ADULT_ONLY}${reading}性器を指す放送禁止用語 (露骨な俗語) の使用は禁止。それ以外の性的な描写や行為自体は許容する`
  }
  if (ageRating === 'R18') {
    return `成人向け。${ADULT_ONLY}${reading}性的描写・暴力描写・直接的な語彙を含め、必要に応じて踏み込んだ表現を制限なく用いてよい`
  }
  return undefined
}

export const ENDING_LINES: Record<string, string | undefined> = {
  ハッピーエンド: '主要な葛藤が解決し、登場人物が報われる前向きな結末へ向けて構成すること',
  バッドエンド: '救いの少ない悲劇的な結末へ向けて構成し、終章で喪失や敗北を直視すること',
  ビターエンド: '喜びと喪失が混在する苦味のある結末。完全な勝利でも敗北でもなく、余韻を残すこと',
  メリーバッドエンド:
    '表面的にはハッピーエンドに見えるが、実際には何かが歪んでいる/失われていることが読み取れる結末にすること',
  オープンエンド: '物語の結末を断定せず、複数の解釈の余地を残して幕を引くこと'
}

// 本文の【文体・視点】。結末の方向は渡さない (本文は章立てと作品設計を通して結末へ向かう)。
function styleBody(style: StyleParams, adultReading: AdultReading): string {
  const tone = TONE_LINES[style.tone]
  const rating = ratingLine(style.age_rating, adultReading)
  return [
    `視点: ${povLine(style)}`,
    `文体: ${tone === undefined ? DEFAULT_TONE_LINE : tone}`,
    rating === undefined ? '' : `年齢指定: ${rating}`
  ]
    .filter((line) => line.length > 0)
    .join('\n')
}

// ---------------------- 作品設計・呼称表 ----------------------

function labeledList(label: string, items: string[]): string {
  const lines = items.map(oneLine).filter((item) => item.length > 0)
  return lines.length > 0 ? [`${label}:`, ...lines.map((item) => `- ${item}`)].join('\n') : ''
}

// 【作品設計】の中身。物語の核、結末、人物の変化、世界のルールと用語、時系列。空の項目は出さない。
// 呼称表は【呼称表】の節に分ける (本文だけに渡す)。成人としての人物設定 (cast) は人物設定に差し替えて渡るので、ここには出さない。
// 小見出しの語 (「結末」「人物の変化」など) は system の規則が名前で指している。
export function bibleBody(bible: StoryBible | null | undefined): string {
  if (bible === null || bible === undefined) return ''
  const arcs = bible.arcs
    .map((arc) => ({ name: arc.name.trim(), start: oneLine(arc.start), end: oneLine(arc.end) }))
    .filter((arc) => arc.name.length > 0 && (arc.start.length > 0 || arc.end.length > 0))
    .map((arc) =>
      [
        `- ${arc.name}`,
        arc.start.length > 0 ? `  始まり: ${arc.start}` : '',
        arc.end.length > 0 ? `  終わり: ${arc.end}` : ''
      ]
        .filter((line) => line.length > 0)
        .join('\n')
    )
  const terms = bible.world.terms
    .map((entry) => ({ term: entry.term.trim(), note: oneLine(entry.note) }))
    .filter((entry) => entry.term.length > 0)
    .map((entry) => (entry.note.length > 0 ? `${entry.term}: ${entry.note}` : entry.term))
  return [
    bible.premise.trim().length > 0 ? `物語の核: ${hang(bible.premise, '  ')}` : '',
    bible.ending.trim().length > 0 ? `結末: ${hang(bible.ending, '  ')}` : '',
    arcs.length > 0 ? ['人物の変化:', ...arcs].join('\n') : '',
    labeledList('世界のルール', bible.world.rules),
    labeledList('用語', terms),
    labeledList('時系列', bible.timeline)
  ]
    .filter((part) => part.length > 0)
    .join('\n')
}

// 呼称表。from が to を call と呼ぶ。
type AddressTable = { rows: AddressEntry[]; calls: Map<string, string> }

const pairKey = (from: string, to: string): string => `${from}\u0000${to}`

function addressTableOf(bible: StoryBible | null | undefined): AddressTable {
  return addressTableFrom(bible === null || bible === undefined ? [] : bible.addresses)
}

// 空の行を除き、同じ組は最初の 1 行だけにする。並びは渡された順のまま。
function addressTableFrom(entries: AddressEntry[]): AddressTable {
  const rows: AddressEntry[] = []
  const calls = new Map<string, string>()
  for (const entry of entries) {
    const row = { from: entry.from.trim(), to: entry.to.trim(), call: oneLine(entry.call) }
    const key = pairKey(row.from, row.to)
    if (row.from.length > 0 && row.to.length > 0 && row.call.length > 0 && !calls.has(key)) {
      rows.push(row)
      calls.set(key, row.call)
    }
  }
  return { rows, calls }
}

// 【呼称表】の中身。全ての組を載せる (章ごとに絞ると、章をまたいで変わらない部分が章で変わってしまう)。
function addressBody(table: AddressTable): string {
  if (table.rows.length === 0) return ''
  return [
    '「呼ぶ人 → 呼ばれる人: 呼び方」の表。',
    ...table.rows.map((row) => `- ${row.from} → ${row.to}: ${row.call}`)
  ].join('\n')
}

// 呼称表が名簿の全ての組 (A→B と B→A) を持っているか。人物が多い作品では、関係を定義した組と語り手との組だけになる。
function coversAllPairs(cast: CastMember[], table: AddressTable): boolean {
  const names = [...new Set(cast.map((member) => member.name))]
  return names.every((from) => names.every((to) => from === to || table.calls.has(pairKey(from, to))))
}

// 呼び方の資料がどうなっているか (作品単位で決まる。system の【人物】の規則をこれで選ぶ)。
//   none     呼称表が無い。人物ごとの「他者の呼び方」と、関係の呼び方の指定を使う
//   table    呼称表が全ての組を持つ
//   partial  呼称表はあるが、無い組が残る。その組は「他者の呼び方」で補う
type AddressMode = 'none' | 'table' | 'partial'

function addressModeOf(cast: CastMember[], table: AddressTable): AddressMode {
  if (table.rows.length === 0) return 'none'
  return coversAllPairs(cast, table) ? 'table' : 'partial'
}

// ---------------------- 登場人物 ----------------------

function firstPersonDisplay(member: CastMember): string {
  return member.first_person === FIRST_PERSON_AS_NAME
    ? `代名詞を使わず、自分を「${member.name}」と名前で呼ぶ`
    : member.first_person
}

function ageDisplay(age: string): string {
  return /^\d+$/.test(age) ? `${age}歳` : age
}

// 人物 1 人ぶんの詳細。tag は語り手などの注記 (無ければ '')。
function castBlock(member: CastMember, tag: string): string {
  const meta = [ageDisplay(member.age), member.gender, member.occupation].filter((v) => v.length > 0).join('・')
  const role = [member.role, tag].filter((v) => v.length > 0).join('・')
  const firstPerson = firstPersonDisplay(member)
  const examples = member.speech_examples.map((ex) => ex.trim()).filter((ex) => ex.length > 0)
  return [
    meta.length > 0 ? `■ ${member.name}（${meta}）` : `■ ${member.name}`,
    role.length > 0 ? `  役割: ${role}` : '',
    firstPerson.length > 0 ? `  一人称: ${firstPerson}` : '',
    member.address_others.length > 0 ? `  他者の呼び方: ${member.address_others}` : '',
    member.appearance.trim().length > 0 ? `  外見: ${hang(member.appearance, '    ')}` : '',
    // 見出しで「見本」と示す。例文を台詞として写させないため (規則は system の【人物】)。
    examples.length > 0 ? ['  口調の例（話し方の見本）:', ...examples.map((ex) => `    「${ex}」`)].join('\n') : '',
    member.description.trim().length > 0 ? `  背景: ${hang(member.description, '    ')}` : ''
  ]
    .filter((line) => line.length > 0)
    .join('\n')
}

export function castBody(cast: CastMember[], tagFor: (member: CastMember) => string): string {
  return cast.map((member) => castBlock(member, tagFor(member))).join('\n\n')
}

// 「A から見た B」と書く。関係は source から見た向き (A→B が「兄」なら B は A の兄) なので、矢印より取り違えにくい。
// 呼び方は「B への呼び方は〜」と書く。値は「名前＋さん」のような型のことがあるので、「〜と呼ぶ」とは書かない
// (型の文字列そのもので呼ばせないため)。
function relationLine(relation: CastRelation): string {
  const { source_name: source, target_name: target } = relation
  const parts = [
    relation.relation.trim(),
    relation.address_override.length > 0 ? `${target}への呼び方は「${relation.address_override}」` : '',
    hang(relation.description, '  ')
  ]
    .map((part) => part.replace(/。+$/, ''))
    .filter((part) => part.length > 0)
  const head = `- ${source}から見た${target}`
  return parts.length > 0 ? `${head}: ${parts.join('。')}` : head
}

export function relationsBody(relations: CastRelation[]): string {
  return relations.map(relationLine).join('\n')
}

// 語り手として扱う人物の名前。視点人物を指定できる視点 (一人称 / 三人称一元視点) で、名簿にいるときだけ。
// 多元視点・神視点では pov_character_id が残っていても語り手ではないので、全章に登場させない。
export function narratorName(style: StyleParams, cast: CastMember[]): string | undefined {
  const vc = style.viewpointChar
  if (vc === undefined || !FOCAL_POVS.includes(style.pov)) return undefined
  return cast.some((member) => member.name === vc.name) ? vc.name : undefined
}

export function narratorTag(style: StyleParams): string {
  return style.pov === '一人称' ? '語り手' : '視点人物'
}

// scoped = 章立ての指定で絞り込めたか。false のときは名簿の全員を載せている。
type ChapterCast = { present: CastMember[]; absent: CastMember[]; scoped: boolean }

const KANJI_ONLY = /^\p{Script=Han}+$/u

// 章の計画の文面 (題、概要、出来事、章末の状況) に人物の名前が出てくるか。見逃しを避ける側に倒す。
// 拾いすぎても人物設定が 1 人ぶん増えるだけだが、漏らすと、計画に出てくる人物を「登場しない人物」として禁じてしまう。
// checks.ts の loose の判定 (名前そのもの、区切りで分けた各部、4 字以上の名前の先頭・末尾の 2 字) に加えて、
// 漢字だけの 3 字の名前は先頭・末尾の 2 字でも拾う (「朝倉澪」を「朝倉」で)。
// かなの名前に広げないのは、「かぐや」が「かぐわしい」に一致するのを避けるため。
// 1 字の姓や名 (「澪」「柊」) は一般の語と見分けられないので拾わない (漏れた分は absentLead の文面で概要を優先させる)。
function mentionedInPlan(planText: string, name: string): boolean {
  if (isMentioned(planText, name, { loose: true })) return true
  const chars = [...name.trim()]
  if (chars.length !== 3 || !KANJI_ONLY.test(chars.join(''))) return false
  return [chars.slice(0, 2).join(''), chars.slice(1).join('')].some((piece) => planText.includes(piece))
}

// その章に登場する人物と、しない人物に分ける。
// - characters が空 (旧データ) なら全員が登場する扱い。
// - 語り手は characters に無くても登場する扱い (章立てから漏れても口調・一人称・関係を渡すため)。
// - 章の題、概要、出来事、章末の状況に名前が出てくる人物も、characters に無くても登場する扱い。
//   characters はモデルが取りこぼすことがあり、計画に出てくる人物を禁じると指示どうしがぶつかる。
//   張る伏線・回収する伏線は対象にしない (その場に居ない人物についての伏線がありうる)。
// - characters が名簿の誰とも一致しないとき (名前を変えた後など) も全員にする。
//   語り手だけを登場させ、残りを「登場しない人物」として締め出してしまうのを避ける。
function splitCast(cast: CastMember[], entry: OutlineChapter, narrator: string | undefined): ChapterCast {
  const listed = new Set(entry.characters)
  if (!cast.some((member) => listed.has(member.name))) return { present: cast, absent: [], scoped: false }
  const plan = planOf(entry)
  const planText = [entry.title, entry.summary, ...plan.events, plan.endState].join('\n')
  const present = cast.filter(
    (member) => listed.has(member.name) || member.name === narrator || mentionedInPlan(planText, member.name)
  )
  const presentNames = new Set(present.map((member) => member.name))
  return { present, absent: cast.filter((member) => !presentNames.has(member.name)), scoped: true }
}

// 絞り込めなかったときに【この章の登場人物】の先頭へ添える。全員の詳細が並ぶので、全員を出す指示と読ませない。
const UNSCOPED_CAST_LEAD =
  '章立てにこの章の登場人物の指定が無いので、名簿の全員を載せる。誰が登場するかは概要から判断し、出番の無い人物を無理に登場させない。'

// 呼称表があるとき、登場する相手への呼び方が全部表にある人物は「他者の呼び方」の行を出さない (呼称表に 1 本化する)。
// 表に無い相手が残る人物だけ、その相手への呼び方として行を残す。
function castForChapter(present: CastMember[], table: AddressTable): CastMember[] {
  if (table.rows.length === 0) return present
  return present.map((member) => {
    const uncovered = present.some(
      (other) => other.name !== member.name && !table.calls.has(pairKey(member.name, other.name))
    )
    return uncovered ? member : { ...member, address_others: '' }
  })
}

// 検査のプロンプト (assist-prompts.ts) 用。本文プロンプトの【呼称表】と【この章の登場人物】と同じ文面を、
// 呼称の行の一覧から作る。
export function addressTableBody(addresses: AddressEntry[]): string {
  return addressBody(addressTableFrom(addresses))
}

export function castForAddresses(cast: CastMember[], addresses: AddressEntry[]): CastMember[] {
  return castForChapter(cast, addressTableFrom(addresses))
}

// 呼称表にある組は、関係の行の「呼び方は「…」」を出さない (型のままの指定と、表の具体的な呼び方を並べない)。
function relationsForChapter(relations: CastRelation[], table: AddressTable): CastRelation[] {
  return relations.map((relation) =>
    table.calls.has(pairKey(relation.source_name, relation.target_name))
      ? { ...relation, address_override: '' }
      : relation
  )
}

// 登場しない人物の 1 行。名前、役割、登場する人物からの呼び方。
// 呼称表があれば表から引き、表に無い組は関係の呼び方の指定を使う。
function absentLine(member: CastMember, present: CastMember[], relations: CastRelation[], table: AddressTable): string {
  const presentNames = new Set(present.map((p) => p.name))
  const overrides = relations.filter(
    (r) => r.target_name === member.name && presentNames.has(r.source_name) && r.address_override.length > 0
  )
  const calls =
    table.rows.length === 0
      ? overrides.map((r) => ({ from: r.source_name, call: r.address_override }))
      : present.flatMap((p) => {
          const call = table.calls.get(pairKey(p.name, member.name))
          if (call !== undefined) return [{ from: p.name, call }]
          const override = overrides.find((r) => r.source_name === p.name)
          return override === undefined ? [] : [{ from: p.name, call: override.address_override }]
        })
  const head = member.role.length > 0 ? `- ${member.name}（${member.role}）` : `- ${member.name}`
  const text = calls.map((entry) => `${entry.from}からの呼び方は「${entry.call}」`)
  return text.length > 0 ? `${head}: ${text.join('、')}` : head
}

// 設定の詳細は渡さない。名前だけ話題に出る場面で、呼び方を間違えないための節。
// 登場させない理由 (計画に出てこない) を添え、計画と食い違うときは計画を優先させる。
// この一覧は章立ての characters と名前の照合から作るので、計画に出てくる人物が紛れることがあるため。
function absentLead(hasEvents: boolean, hasTable: boolean): string {
  const source = hasEvents ? '概要と出来事' : '概要'
  const calls = hasTable ? '下の呼び方（【呼称表】のとおり）' : '下の呼び方（指定が無ければ話し手の「他者の呼び方」）'
  return `次の人物は、この章の${source}に出てこないので、場面に登場させない（${source}に出てくる人物がいれば、${source}に従う）。会話で話題に出るときは、${calls}で呼ぶ。`
}

function absentBody(
  absent: CastMember[],
  present: CastMember[],
  relations: CastRelation[],
  table: AddressTable,
  hasEvents: boolean
): string {
  if (absent.length === 0) return ''
  return [
    absentLead(hasEvents, table.rows.length > 0),
    ...absent.map((member) => absentLine(member, present, relations, table))
  ].join('\n')
}

// ---------------------- 保存用 ----------------------

// system と user を見出しつきで 1 つの文字列にする。Chapter.prompt への保存と、画面のプレビュー用。
export function renderPromptForStorage(prompt: Prompt): string {
  return `===== system =====\n${prompt.system}\n\n===== user =====\n${prompt.user}`
}

// ---------------------- 分量 ----------------------

const MIN_SCENES = 2
const MAX_SCENES = 8
const CHARS_PER_SCENE_BASE = 1000

// 目標字数を場面数に直す。字数だけを指示すると短く切り上げられるので、場面の数と 1 場面の厚みで伝える。
// 章立てに出来事が無い旧データで使う (出来事があるときは、出来事ごとに割り当てる)。
export function sceneGuide(targetChars: number): { scenes: number; charsPerScene: number } {
  const scenes = Math.min(MAX_SCENES, Math.max(MIN_SCENES, Math.round(targetChars / CHARS_PER_SCENE_BASE)))
  const charsPerScene = Math.max(100, Math.round(targetChars / scenes / 100) * 100)
  return { scenes, charsPerScene }
}

// 出来事 1 つあたりの字数 (100 字単位)。
export function charsPerEvent(targetChars: number, eventCount: number): number {
  return Math.max(100, Math.round(targetChars / Math.max(1, eventCount) / 100) * 100)
}

// ---------------------- 本文 ----------------------

const CHAPTER_ROLE =
  'あなたはプロの小説家として、1つの小説を1章ずつ書き継いでいる。渡された資料に従って、【今回の執筆】で指定された章の本文を日本語で書く。'

// system の文面を決める条件。どれも作品単位で決まり、章では変わらない (system を作品を通して同じ文面にするため)。
type ChapterSystemFlags = {
  hasCast: boolean
  addressMode: AddressMode
  // 【作品設計】の節がある
  hasBible: boolean
  // 作品設計に結末の具体像がある
  hasBibleEnding: boolean
  // 章立てに章の計画 (出来事、章末の状況、伏線) がある
  hasPlan: boolean
  // 【執筆上の指示】の節がある
  hasNotes: boolean
}

// 各章が完結した短編として書かれ、場面や締めの言い回しが章をまたいで重なるのを防ぐ。
function scopeRules(flags: ChapterSystemFlags): string[] {
  return [
    '書くのは【今回の執筆】の概要の範囲。【全体の章立て】で後の章に割り当てられた出来事には入らない。',
    // 出来事が決まっていないと、本文を書くたびにモデルが出来事を決め直し、章をまたいで同じ場面が入る。
    // 「あるときは」と条件にするのは、計画の無い章が混ざる章立て (1 章だけ書き直した旧データ) でも同じ system を使うため。
    flags.hasPlan
      ? '【今回の執筆】に「出来事」があるときは、挙がっている順に、すべてを場面として書く。1つの出来事を数行の説明で済ませず、挙がっていない大きな出来事を足さない。'
      : '',
    '最初の章でなければ、直前の章が終わったところから続けて書き始める。章の間で時間が進む場合も、前の章の出来事を要約し直さない（読者は続けて読んでいる）。',
    '既に書かれた場面、説明、言い回しを繰り返さない。人物や状況の紹介も、済んでいるものはやり直さない。',
    flags.hasPlan
      ? '最終章以外は物語の途中である。【今回の執筆】に「章末の状況」があればその状況になったところで、無ければ最後の出来事を書いたところで止める。その先を書かず、物語全体を総括したり、決意や希望の独白で締めくくったりしない。前の章と同じ言い回しで締めない。'
      : '最終章以外は物語の途中である。その章の最後の出来事を書いたところで止め、物語全体を総括したり、決意や希望の独白で締めくくったりしない。前の章と同じ言い回しで締めない。',
    flags.hasPlan
      ? '「張る伏線」は、この章の出来事の中で読者に見せる。後の章で回収するので、種明かしはしない。「回収する伏線」は、この章で読者に分かる形で決着させる。'
      : '',
    // 作品設計には結末の具体像が書いてある。途中の章で先取りさせない。
    flags.hasBible
      ? '【作品設計】の「結末」と、「人物の変化」の終わりの状態は、最終章で至るものである。最終章より前の章では、人物は変化の途中にあり、結末に先に到達させない。結末を明かす台詞や独白も入れない。'
      : '',
    flags.hasBibleEnding ? '最終章は、【作品設計】の「結末」まで書き切る。' : '最終章は、結末まで書き切る。'
  ].filter((rule) => rule.length > 0)
}

// 【確定事項】が無い章 (第 1 章、記録の無い旧データ) でも同じ文面を使う (system を作品を通して変えないため)。
function consistencyRules(flags: ChapterSystemFlags): string[] {
  return [
    '【確定済みの本文】は既に書き上がった章で、後から変えられない。そこに書かれた事実（外見、持ち物、場所、日時、約束、誰が何を知っているか）、呼称、時系列は確定している。矛盾させない。',
    '【確定事項】は、ここまでの本文から抜き出した記録である。本文と同じく確定していて、矛盾させない。本文を省略した章については、これが資料になる。',
    flags.hasBible
      ? '【作品設計】は作品全体の設計で、全ての章で守る。世界のルールと時系列に反することを書かず、用語は【作品設計】の表記で書く。'
      : '',
    // 記録は抽出を誤ることがあるので、全文がある章は全文を正とする。作品設計と章立ては書く前の計画なので、書かれたものを正とする。
    flags.hasBible
      ? '【作品設計】、【全体の章立て】の概要、【確定事項】が確定済みの本文と食い違うときは、本文を正とする。【作品設計】や概要と【確定事項】が食い違うときは、【確定事項】を正とする。'
      : '【全体の章立て】の概要や【確定事項】が確定済みの本文と食い違うときは、本文を正とする。概要と【確定事項】が食い違うときは、【確定事項】を正とする。',
    // 人物の設定 (辞典) は章が進んでも同じ文面で渡るので、本文で変わった状態 (変装、関係の進展) を巻き戻させない。
    '人物の設定は物語の始まりの時点のものである。ここまでの章で変わったこと（外見、関係、知っていること）は、変わった後の状態を引き継ぐ。',
    // 「知っていること」は 1 章あたり数項目の抜粋。「一覧に無いことは知らない」とは読ませない
    // (当然知っていることまで知らない扱いになるため)。防ぎたいのは次の 2 つ:
    // 知っているはずのことを忘れている、居合わせていない出来事を知っている。
    '【確定事項】の「知っていること」は、その人物が既に知っていることの抜粋で、全部ではない。挙がっていることは、知っている前提で書く（忘れていたり、初めて知ったように反応したりさせない）。',
    '人物が居合わせていない場面の出来事は、誰かから聞く、自分で気づくといった描写なしに、その人物が知っている前提で書かない。',
    // 回収の計画が章立てにあれば、どれを決着させ、どれを先送りするかは【今回の執筆】に書いてある。
    // どちらにも無い伏線 (計画に無く、本文で生まれたもの) は、従来どおり概要に関わるものだけを扱わせる。
    flags.hasPlan
      ? '【確定事項】の「未回収の伏線」のうち、【今回の執筆】の「回収する伏線」はこの章で決着させ、「まだ回収しない伏線」は決着させない。どちらにも無いものは、この章の出来事に関わるものだけを扱い、無理に回収しない。'
      : '【確定事項】の「未回収の伏線」は、【今回の執筆】の概要に関わるものだけを扱う。関わらないものを、この章で無理に回収しない。',
    flags.hasNotes ? '【執筆上の指示】は、この作品についての依頼者の指示である。全ての章で守る。' : ''
  ].filter((rule) => rule.length > 0)
}

export const ADDRESS_PATTERN_RULE =
  '呼び方の「名前」「苗字」は型を表す。相手の名や姓に置き換えて呼ぶ（「苗字＋さん」なら、相手の姓に「さん」を付ける）。'

// 呼び方の規則。呼称表があれば表に 1 本化する。
function addressRules(mode: AddressMode): string[] {
  if (mode === 'table') {
    return ['相手の呼び方は【呼称表】のとおりにする。表に無い相手は、関係と人物像に合わせて呼ぶ。']
  }
  if (mode === 'partial') {
    return [
      '相手の呼び方は【呼称表】のとおりにする。表に無い相手は、関係に呼び方の指定があればそれを使い、無ければその人物の「他者の呼び方」に従う。どちらも無ければ、関係と人物像に合わせて呼ぶ。',
      ADDRESS_PATTERN_RULE
    ]
  }
  return [
    '相手の呼び方は、関係に呼び方の指定があればそれを使い、無ければその人物の「他者の呼び方」に従う。',
    ADDRESS_PATTERN_RULE
  ]
}

function characterRules(flags: ChapterSystemFlags): string[] {
  return [
    '台詞と行動は、各人物の設定（性格、背景、関係）に沿わせる。',
    '「口調の例」は語尾・調子・口癖の見本である。台詞は見本の話し方で新しく書き、例文そのものは本文に使わない。',
    '一人称は各人物の設定どおりにし、別の一人称に変えない。',
    ...addressRules(flags.addressMode)
  ]
}

// 分量の数字は【今回の執筆】に置く。ここには、分量と章の範囲がぶつかったときの決め方だけを書く。
function depthRules(flags: ChapterSystemFlags): string[] {
  const depth = '出来事をあらすじのように要約して進めない。場面として、会話、動作、情景、心情を具体的に書く。'
  // 計画があるときは、分量を出来事ごとに割り当てる。足りない分を、新しい出来事で埋めさせない。
  // 「場面」の数え方の規則は出さない (章立ての「出来事」と紛れる。場面数の指示は出来事の無い章にしか出ない)。
  if (flags.hasPlan) {
    return [
      depth,
      '分量が足りないときは、【今回の執筆】の範囲の中で場面を書き込んで補う。新しい出来事を足して埋めない。'
    ]
  }
  return [
    depth,
    '分量が足りないときは、概要の範囲の中で場面を書き込んで補う。',
    '「場面」は出来事の一区切りを指す。時間や場所が変わらなくても、区切りごとに1場面と数える。'
  ]
}

const CHAPTER_NOTATION_RULES = [
  '段落の頭は全角空白1つで字下げする。',
  '「 で始まる会話文の行は字下げしない（『 や （ で始まる行も同じ）。',
  '！や？の後に同じ行で文が続くときは、全角空白を1つ入れる。閉じ括弧の直前と行末には入れない。',
  '三点リーダは「……」、ダッシュは「――」と、2つ重ねて使う。',
  '確定済みの本文がこの表記と違っていても、新しく書く章はこの表記にする。'
]

const CHAPTER_OUTPUT_RULES = [
  '本文だけをプレーンテキストで出力する。章番号、タイトル、場面の見出し、前書き、後書き、注釈は含めない。'
]

// 作品を通して同じ文面にする (章番号など章ごとに変わる情報を入れない)。
// 人物の規則は名簿が空の作品では出さない。
function chapterSystem(flags: ChapterSystemFlags): string {
  const rules = renderSections([
    { heading: '章の範囲', body: bullets(scopeRules(flags)) },
    { heading: '整合性', body: bullets(consistencyRules(flags)) },
    { heading: '人物', body: flags.hasCast ? bullets(characterRules(flags)) : '' },
    { heading: '描写と分量', body: bullets(depthRules(flags)) },
    { heading: '表記', body: bullets(CHAPTER_NOTATION_RULES) },
    { heading: '出力', body: bullets(CHAPTER_OUTPUT_RULES) }
  ])
  return `${CHAPTER_ROLE}\n\n${rules}`
}

export function novelInfoBody(novel: NovelParams, withChapterCount: boolean): string {
  return [
    novel.genre.trim().length > 0 ? `ジャンル: ${novel.genre.trim()}` : '',
    novel.setting.trim().length > 0 ? `世界観・設定: ${hang(novel.setting, '  ')}` : '',
    withChapterCount ? `章数: ${novel.num_chapters}` : ''
  ]
    .filter((line) => line.length > 0)
    .join('\n')
}

// 【全体の章立て】の 1 章ぶん。題と概要に、章末の状況を 1 行添える (前後の章との繋がりが分かるように)。
// 出来事の一覧は載せない (全章ぶんを並べると長くなり、後の章の出来事を先取りさせやすい。今回の章の分は【今回の執筆】に出す)。
function outlineLine(chapter: OutlineChapter): string {
  const summary = hang(chapter.summary, '  ')
  const label = chapterLabel(chapter.chapter_number, chapter.title)
  const endState = planOf(chapter).endState
  return [summary.length > 0 ? `${label}: ${summary}` : label, endState.length > 0 ? `  章末の状況: ${endState}` : '']
    .filter((line) => line.length > 0)
    .join('\n')
}

// send = モデルに送る文面。storage = 保存・表示用 (全文の章の本文を字数だけにする)。
type PromptMode = 'send' | 'storage'

// 既出の章 1 つぶん。載せない章 (本文が空) は ''。
// 見出しは「▼」で始める。本文の中の空行と、章の区切りを見分けられるようにするため。
function priorChapterBlock(chapter: PriorChapterInput, hasLedger: boolean, mode: PromptMode): string {
  const heading = `▼ ${chapterLabel(chapter.chapter_number, chapter.title)}`
  if ('content' in chapter) {
    const text = trimChapterText(chapter.content)
    if (text.length === 0) return ''
    if (mode === 'send') return `${heading}\n${text}`
    // 保存用には本文を入れない。全文つきで保存すると 1 版あたり数百 KB になり、D1 を圧迫する。
    // モデルには全文を渡したことが、保存された文面を読む人に分かるように書く。
    return `${heading}\n（本文${formatNumber(text.length)}字。モデルには全文を渡し、保存では省略）`
  }
  // 本文を渡せない章は見出しの 1 行だけ。全文の章とは、この括弧書きで見分けがつく。
  // 内容は【確定事項】に入っている。【確定事項】が無いとき (記録が 1 つも無い) は章立ての概要を指す。
  return `${heading}（本文は省略。内容は${hasLedger ? '【確定事項】' : '【全体の章立て】の概要'}を参照）`
}

function priorChaptersBody(
  priorChapters: PriorChapterInput[],
  chapterNumber: number,
  hasLedger: boolean,
  mode: PromptMode
): string {
  return priorChapters
    .filter((chapter) => chapter.chapter_number < chapterNumber)
    .map((chapter) => ({ number: chapter.chapter_number, block: priorChapterBlock(chapter, hasLedger, mode) }))
    .filter(({ block }) => block.length > 0)
    .sort((a, b) => a.number - b.number)
    .map(({ block }) => block)
    .join('\n\n')
}

// 直前の章を資料としてどう渡しているか。text = 全文、omitted = 本文は省略で【確定事項】がある、none = どちらも無い。
type PreviousChapter = 'text' | 'omitted' | 'none'

function previousChapterOf(
  priorChapters: PriorChapterInput[],
  chapterNumber: number,
  hasLedger: boolean
): PreviousChapter {
  const previous = priorChapters.filter((chapter) => chapter.chapter_number === chapterNumber - 1)
  if (previous.some((chapter) => 'content' in chapter && trimChapterText(chapter.content).length > 0)) return 'text'
  return hasLedger && previous.some((chapter) => !('content' in chapter)) ? 'omitted' : 'none'
}

// 【確定事項】の中身 (見出しを除く)。renderLedger の戻り値は見出しつきなので、見出しを外して節の本文にする。
// 見出しの無い文字列を渡されても、そのまま本文として扱う。どちらでも見出しは 1 つになる。
const LEDGER_HEADING = '確定事項'

export function ledgerBody(ledgerText: string | undefined): string {
  if (ledgerText === undefined) return ''
  const text = ledgerText.replace(/\r\n|\r/g, '\n').trim()
  const heading = `【${LEDGER_HEADING}】`
  return text.startsWith(heading) ? text.slice(heading.length).trim() : text
}

// 次の章の冒頭 (既に書かれている次の章へ繋げるとき)。節の中身と、【今回の執筆】の文言の切り替えに使う。
// system は変えない (書き直しでも、作品を通して同じ system と同じ前半を送り、キャッシュに乗せる)。
// そのため、繋げ方の指示は節の中に書く。
const NEXT_OPENING_HEADING = '次の章の冒頭'

function nextOpeningBody(next: NextChapterInput, nextNumber: number): string {
  const label = chapterLabel(nextNumber, next.title)
  const summary = oneLine(next.summary)
  return [
    `${label}は既に書かれていて、変更しない。この章は、下の冒頭に自然に繋がる状態（時、場所、その場にいる人物、直前の出来事）で終える。次の章の冒頭の文や出来事を、この章の中に書かない。`,
    summary.length > 0 ? `次の章の概要: ${summary}` : '',
    `▼ 第${nextNumber}章の冒頭`,
    trimChapterText(next.opening),
    // 冒頭は途中で切ってある。次の章がここで終わると読ませない
    '（冒頭はここまで。続きは省略）'
  ]
    .filter((line) => line.length > 0)
    .join('\n')
}

// 指示つきの書き直し。nextChapter と同じく system は変えず、直し方の指示は【今回の執筆】に書く。
const REVISION_BASE_HEADING = '元の版'
const REVISION_INSTRUCTION_HEADING = '修正指示'

// 【元の版】の中身。保存用には本文を入れない (確定済みの本文と同じ扱い)。
function revisionBaseBody(label: string, text: string, mode: PromptMode): string {
  return [
    // 「既に書かれた言い回しを繰り返さない」の規則は確定済みの本文 (前の章) についてのもの。
    // この章の今の本文は、繰り返しを避ける対象ではなく、直す対象だと示す。
    'この章の今の本文である。確定済みの本文ではなく、これを直したものがこの章の新しい本文になる。',
    `▼ ${label}`,
    mode === 'send' ? text : `（本文${formatNumber(text.length)}字。モデルには全文を渡し、保存では省略）`
  ].join('\n')
}

// 書き直しのときに【今回の執筆】の先頭に置く、直し方の指示。先頭の行が原則で、その後に例外を並べる。
const REVISION_KEEP_RULE = `直すのは【${REVISION_INSTRUCTION_HEADING}】に書かれた点だけにする。それ以外は【${REVISION_BASE_HEADING}】の文章をそのまま保つ（言い回しを変えない。【${REVISION_INSTRUCTION_HEADING}】が求めない限り、場面を足したり削ったりしない）。`

// 成人指定 (R15 / R18) の書き直しのときだけ足す例外。
// 全年齢で書いた章を、成人指定に変えた後に書き直すと、元の版の全文、「そのまま保つ」、成人向けの表現の許可が同時に入る。
// 新しく書くときよりも未成年の記述が残る方向に働くので、読み替えを「そのまま保つ」より優先させる。
// 言葉は年齢指定の行の読み替えの指示 (READ_ALL_AS_ADULT) に揃える。語の一覧は、あちらにあるので重ねない。
// resolved (作品設計が成人としての人物設定を確定している) のときは、その人物設定に合わせさせる。
// all のときの人物設定は辞典の原文で、未成年の記述が残りうるので、合わせる先として指さない。
const REVISION_ADULT_RULES: Record<AdultReading, string> = {
  all: `【${REVISION_BASE_HEADING}】に未成年を連想させる記述（年齢、学年、学校、制服、幼い外見など）が残っていたら、【${REVISION_INSTRUCTION_HEADING}】に書かれていなくても、成人（大学生または社会人）として読み替えて書き直す。この点は、【${REVISION_BASE_HEADING}】の文章をそのまま保つことより優先する。`,
  resolved: `【${REVISION_BASE_HEADING}】に未成年を連想させる記述（年齢、学年、学校、制服、幼い外見など）が残っていたら、【${REVISION_INSTRUCTION_HEADING}】に書かれていなくても、【この章の登場人物】の設定に合わせて、成人（大学生または社会人）として書き直す。この点は、【${REVISION_BASE_HEADING}】の文章をそのまま保つことより優先する。`
}

// adultReading: 成人指定の書き直しなら、読み替えの指示の出し方。全年齢や年齢指定なしなら null。
function revisionRules(adultReading: AdultReading | null): string[] {
  return [
    REVISION_KEEP_RULE,
    ...(adultReading === null ? [] : [REVISION_ADULT_RULES[adultReading]]),
    '直した結果、前後の文と辻褄が合わなくなる箇所は、合わせて直す。',
    // 元の版が表記の規則より前に書かれた章のこともある。system の【表記】と「元のまま保つ」がぶつからないようにする。
    '表記の規則（字下げなど）に合っていない箇所は、規則に合わせて直す。',
    // system の「出来事をすべて場面として書く」「章末の状況で終える」は、新しく書くときの規則。
    // 書き直しでは 修正指示 > 元の版 > 計画 の順に優先させる (計画どおりに書き直させない)。
    // 載せるのは今の章立ての計画で、元の版を書いた後に章立てが変わっていれば、元の版を書いたときの計画とは違う。
    // 書き直した版は元の版の鮮度を引き継ぐ (計画が変わった章は、書き直しても「要再生成」のまま残る)。
    `下の題、概要、出来事などは、章立てにあるこの章の計画である（【${REVISION_BASE_HEADING}】を書いた後に変わっていることがある）。【${REVISION_BASE_HEADING}】が計画と違っていても、【${REVISION_INSTRUCTION_HEADING}】に書かれていなければ直さない。【${REVISION_INSTRUCTION_HEADING}】が計画と食い違うときは、【${REVISION_INSTRUCTION_HEADING}】に従う。`,
    '出力は章の全文にする。直していない部分も含めて最初から最後まで書き、どこを直したかの説明は付けない。'
  ]
}

type WritingBrief = {
  entry: OutlineChapter
  plan: ChapterPlan
  // 次の章が既に書かれていて、【次の章の冒頭】を渡している
  hasNextOpening: boolean
  // 指示つきの書き直しのとき、元の版の字数。通常の生成では null
  revisionBaseChars: number | null
  // 成人指定 (R15 / R18) の書き直しのとき、読み替えの指示の出し方。それ以外は null
  revisionAdultReading: AdultReading | null
  // 伏線の id → 説明 (回収する伏線の説明を引く)
  setups: Map<string, string>
  // 前の章が張り、後の章が回収する伏線
  deferred: StoryThread[]
  totalChapters: number
  previous: PreviousChapter
  targetChars: number
}

// 執筆済みの範囲と、書き出しの位置。
function writtenLine(brief: WritingBrief): string {
  const n = brief.entry.chapter_number
  if (n <= 1) return '執筆済み: なし（この章が物語の書き出し）'
  // 執筆済みが 1 章だけのときは、範囲と同じ章番号を繰り返さない。
  const previous = n === 2 ? 'その' : `第${n - 1}章の`
  const starts: Record<PreviousChapter, string> = {
    text: `${previous}終わりから続けて書く`,
    omitted: `${previous}本文は省略している。【確定事項】の内容の続きとして書き始める`,
    none: `${previous}本文は資料に無い。概要の続きとして書き始める`
  }
  return `執筆済み: ${chapterRange(1, n - 1)}（${starts[brief.previous]}）`
}

// これからの範囲と、章末の扱い。最終章かどうかで変わる。
function upcomingLine(brief: WritingBrief): string {
  const n = brief.entry.chapter_number
  if (n >= brief.totalChapters) return 'この後の章: なし（この章が最終章。結末まで書き切る）'
  const range = chapterRange(n + 1, brief.totalChapters)
  if (brief.hasNextOpening) {
    return `この後の章: ${range}（第${n + 1}章は既に書かれている。この章では書かず、章末は【${NEXT_OPENING_HEADING}】に繋がるように終える。物語は途中なので、締めくくらない）`
  }
  return `この後の章: ${range}（この章では書かない。物語は途中なので、章末で締めくくらない）`
}

// 分量。出来事があれば出来事ごとに割り当てる。無い旧データは場面数で指示する。
function lengthLine(targetChars: number, eventCount: number): string {
  if (eventCount > 0) {
    return `分量: 約${formatNumber(targetChars)}字。出来事1つあたり約${formatNumber(charsPerEvent(targetChars, eventCount))}字を目安に書く。出来事を端折って短く終えない。`
  }
  const { scenes, charsPerScene } = sceneGuide(targetChars)
  return `分量: 約${formatNumber(targetChars)}字。概要の範囲を${scenes}場面程度に分け、1場面あたり約${formatNumber(charsPerScene)}字を目安に書く。場面を端折って短く終えない。`
}

// 書き直しの分量。目標の字数に合わせて水増し・削減させない (元の版の字数を 100 字単位で示す)。
function revisionLengthLine(baseChars: number): string {
  const rounded = Math.max(100, Math.round(baseChars / 100) * 100)
  return `分量: 【${REVISION_BASE_HEADING}】（約${formatNumber(rounded)}字）と同じ程度にする。字数を合わせるために増やしたり削ったりしない。【${REVISION_INSTRUCTION_HEADING}】が分量に触れているときは、それに従う。`
}

// 見出しの行と、字下げした項目の行。項目が無ければ ''。
function nested(label: string, items: string[]): string {
  return items.length > 0 ? [`${label}:`, ...items.map((item) => `  ${item}`)].join('\n') : ''
}

// 括弧書きは、system の規則のどれがこの章に当たるかを末尾で示すためのもの (規則そのものは system にある)。
function writingBody(brief: WritingBrief): string {
  const { entry, plan, totalChapters } = brief
  const isLast = entry.chapter_number >= totalChapters
  const title = entry.title.trim()
  const summary = hang(entry.summary, '  ')
  // 最終章は結末まで書き切るので、章末の状況で止める注記は付けない。
  // 次の章が既に書かれているときは、計画よりも書かれた本文を正とする (次の章は変えられない)。
  const endNote = brief.hasNextOpening
    ? `この状況になったところで章を終える。【${NEXT_OPENING_HEADING}】と食い違うときは、次の章の冒頭に合わせる`
    : 'この状況になったところで章を終える'
  // 書き直しでは注記を付けない (章末は元の版に書かれている。計画どおりに章末を書き直させない)。
  const endState =
    plan.endState.length === 0
      ? ''
      : isLast || brief.revisionBaseChars !== null
        ? `章末の状況: ${plan.endState}`
        : `章末の状況: ${plan.endState.replace(/。+$/, '')}（${endNote}）`
  const revising = brief.revisionBaseChars !== null
  const items = [
    ...(revising ? revisionRules(brief.revisionAdultReading) : []),
    writtenLine(brief),
    upcomingLine(brief),
    title.length > 0 ? `題: ${title}` : '',
    summary.length > 0 ? `概要: ${summary}` : '',
    plan.timePlace.length > 0 ? `時と場所: ${plan.timePlace}` : '',
    // 書き直しでは、計画の項目の見出しを「章立ての計画」として示す。「すべてを場面として書く」「この章の中で書く」
    // 「この章で決着させる」は新しく書くときの指示で、元の版を計画どおりに書き直させてしまう。
    // 伏線の「種明かしはしない」「決着させない」は、書き直しでも守る制約なので残す。
    nested(
      revising
        ? `出来事（章立ての計画。【${REVISION_BASE_HEADING}】をこれに合わせて書き直さない）`
        : '出来事（この順に、すべてを場面として書く）',
      plan.events.map((event, index) => `${index + 1}. ${event}`)
    ),
    endState,
    nested(
      revising ? '張る伏線（章立ての計画。種明かしはしない）' : '張る伏線（この章の中で書く。種明かしはしない）',
      plan.setups.map((setup) => `- ${threadLine(setup.id, setup.description)}`)
    ),
    nested(
      revising ? '回収する伏線（章立ての計画）' : '回収する伏線（この章で決着させる）',
      plan.payoffs.map((id) => {
        const description = brief.setups.get(id)
        return `- ${threadLine(id, description === undefined ? '' : description)}`
      })
    ),
    nested(
      'まだ回収しない伏線（後の章で回収する。この章では決着させない）',
      brief.deferred.map((setup) => `- ${threadLine(setup.id, setup.description)}`)
    ),
    brief.revisionBaseChars === null
      ? lengthLine(brief.targetChars, plan.events.length)
      : revisionLengthLine(brief.revisionBaseChars)
  ].filter((line) => line.length > 0)
  const head = revising
    ? `第${entry.chapter_number}章（全${totalChapters}章）の本文を、【${REVISION_BASE_HEADING}】を直して書く。`
    : `第${entry.chapter_number}章（全${totalChapters}章）の本文を書く。`
  return `${head}\n${bullets(items)}`
}

// 本文 1 章ぶんのプロンプトを組み立てる。章立てに chapterNumber が無ければ throw する。
function assembleChapterPrompt(input: ChapterPromptInput, mode: PromptMode): Prompt {
  const { novel, outline, chapterNumber, priorChapters, targetChars, style, cast, relations, bible } = input
  const chapters = sortedChapters(outline)
  const entry = chapters.find((chapter) => chapter.chapter_number === chapterNumber)
  if (entry === undefined) {
    throw new Error(`Chapter ${chapterNumber} not found in outline`)
  }
  // 全章数は章立ての最後の章番号。最終章かどうかを、本文の計画である章立てで決める。
  const totalChapters = chapters.reduce((max, chapter) => Math.max(max, chapter.chapter_number), chapterNumber)
  const plan = planOf(entry)

  const narrator = narratorName(style, cast)
  const { present, absent, scoped } = splitCast(cast, entry, narrator)
  const presentNames = new Set(present.map((member) => member.name))
  const presentRelations = relations.filter((r) => presentNames.has(r.source_name) && presentNames.has(r.target_name))
  const table = addressTableOf(bible)
  const ledger = ledgerBody(input.ledgerText)
  const hasLedger = ledger.length > 0
  const priorBody = priorChaptersBody(priorChapters, chapterNumber, hasLedger, mode)
  const previous = previousChapterOf(priorChapters, chapterNumber, hasLedger)
  const design = bibleBody(bible)
  const notes = input.writingNotes === undefined ? '' : compactText(input.writingNotes)
  // 章立ての上で最終章なら、次の章の冒頭は使わない (結末まで書き切る指示とぶつかる)。
  const next =
    input.nextChapter === undefined ||
    input.nextChapter === null ||
    chapterNumber >= totalChapters ||
    trimChapterText(input.nextChapter.opening).length === 0
      ? null
      : input.nextChapter
  // 本文か指示が空なら、書き直しとして扱わない。
  const revisionText =
    input.revision === undefined || input.revision === null ? '' : trimChapterText(input.revision.baseContent)
  const revisionInstruction =
    input.revision === undefined || input.revision === null ? '' : compactText(input.revision.instruction)
  const revising = revisionText.length > 0 && revisionInstruction.length > 0
  // 成人指定の書き直しで、元の版を人物設定に合わせさせるのは、【この章の登場人物】の節があるときだけ
  // (名簿が空なら、読み替えだけを指示する)。
  const revisionReading: AdultReading = present.length > 0 ? adultReadingOf(bible) : 'all'

  // 章をまたいで変わらない部分。章番号や今回の登場人物を入れない (前半を 1 字も変えないため)。
  // 全文の章が増えていく間は、前の章のプロンプトのここまでが、次の章のプロンプトの先頭と一致する
  // (古い章が省略に回ったところでは変わる)。
  const stable: Section[] = [
    { heading: '作品情報', body: novelInfoBody(novel, false) },
    { heading: '文体・視点', body: styleBody(style, adultReadingOf(bible)) },
    { heading: '作品設計', body: design },
    { heading: '呼称表', body: addressBody(table) },
    { heading: '執筆上の指示', body: notes },
    { heading: '全体の章立て', body: chapters.map(outlineLine).join('\n') },
    { heading: '確定済みの本文', body: priorBody }
  ]
  // この章だけの部分。【確定事項】は章が進むたびに増えるので、変わらない部分の後に置く。
  const perChapter: Section[] = [
    { heading: LEDGER_HEADING, body: ledger },
    {
      heading: 'この章の登場人物',
      body: [
        scoped || present.length === 0 ? '' : UNSCOPED_CAST_LEAD,
        castBody(castForChapter(present, table), (member) => (member.name === narrator ? narratorTag(style) : ''))
      ]
        .filter((part) => part.length > 0)
        .join('\n')
    },
    { heading: 'キャラクター間の関係', body: relationsBody(relationsForChapter(presentRelations, table)) },
    {
      heading: 'この章に登場しない人物',
      body: absentBody(absent, present, relations, table, plan.events.length > 0)
    },
    { heading: NEXT_OPENING_HEADING, body: next === null ? '' : nextOpeningBody(next, chapterNumber + 1) },
    {
      heading: REVISION_BASE_HEADING,
      body: revising ? revisionBaseBody(chapterLabel(chapterNumber, entry.title), revisionText, mode) : ''
    },
    { heading: REVISION_INSTRUCTION_HEADING, body: revising ? revisionInstruction : '' },
    {
      heading: '今回の執筆',
      body: writingBody({
        entry,
        plan,
        hasNextOpening: next !== null,
        revisionBaseChars: revising ? revisionText.length : null,
        revisionAdultReading: revising && isAdultRating(style.age_rating) ? revisionReading : null,
        setups: setupDescriptions(chapters),
        deferred: deferredSetups(chapters, chapterNumber),
        totalChapters,
        previous,
        targetChars
      })
    }
  ]

  const system = chapterSystem({
    hasCast: cast.length > 0,
    addressMode: addressModeOf(cast, table),
    hasBible: design.length > 0,
    hasBibleEnding: bible !== null && bible !== undefined && bible.ending.trim().length > 0,
    hasPlan: chapters.some((chapter) => hasPlan(planOf(chapter))),
    hasNotes: notes.length > 0
  })
  return { system, user: renderSections([...stable, ...perChapter]) }
}

// 本文 1 章ぶんのプロンプト (モデルに送るもの)。章立てに chapterNumber が無ければ throw する。
export function buildChapterPrompt(input: ChapterPromptInput): Prompt {
  return assembleChapterPrompt(input, 'send')
}

// 保存・表示用 (Chapter.prompt)。buildChapterPrompt と同じ内容で、【確定済みの本文】の全文の章と【元の版】だけ、
// 本文を字数の 1 行に置き換える (見出しは残す)。system と user を renderPromptForStorage で 1 つの文字列にして返す。
export function buildChapterPromptForStorage(input: ChapterPromptInput): string {
  return renderPromptForStorage(assembleChapterPrompt(input, 'storage'))
}

// ---------------------- 章立て ----------------------

// JSON を返させるプロンプトは、user の【今回の依頼】にこの 1 行を入れる。
// OpenAI 互換の Responses API の json_object モードは、input に「json」の語が無い要求を 400 で拒否する。
// system は instructions として送るので数えられない。chat 形式でも同じ制約を持つ互換サーバーがある。
export const JSON_ONLY_REQUEST = '出力は JSON だけにする。'

// 1 章の出来事の数の目安。上限 (OUTLINE_PLAN_LIMITS.eventsMax) を超えた分は、保存の前に切り詰められる。
export const OUTLINE_EVENTS_MIN = 3
export const OUTLINE_EVENTS_MAX = Math.min(6, OUTLINE_PLAN_LIMITS.eventsMax)

type OutlineFlags = {
  hasCast: boolean
  hasBible: boolean
  // 作品設計に結末の具体像がある
  hasBibleEnding: boolean
  // 語り手 (視点人物) がいる
  hasNarrator: boolean
}

// 章立ての文章の書き方 (全章の生成と 1 章の書き直しで共通)。
// 概要が宣伝文の調子や語り手の一人称で書かれると、本文を書くときに何が起きるかが決まらない。
function outlineWritingRules(flags: OutlineFlags): string[] {
  return [
    'どの項目も三人称の常体で、事実として書く。宣伝文のような煽りや問いかけ、語り手の一人称では書かない。',
    flags.hasCast ? '人物は名簿の名前で書く。登場人物の性格・背景・関係を踏まえた内容にする。' : '',
    flags.hasBible ? '【作品設計】に従う。世界のルール、用語、時系列と矛盾させない。' : '',
    // 視点の文面は章立てに渡さない (概要が語り手の一人称になるため)。
    // 誰の視点で本文が書かれるかだけを渡し、その人物が居合わせない出来事を計画させない。
    flags.hasNarrator
      ? '本文は【今回の依頼】に示した語り手（視点人物）の視点で書かれる。その人物を必ず登場させ、その人物が居合わせない出来事を入れない。'
      : ''
  ].filter((rule) => rule.length > 0)
}

const CHARACTERS_RULE =
  'characters: その章に実際に登場する人物。名前は名簿の表記と完全に一致させる。関係に記載があるだけで、その章に登場しない人物は含めない。'

// 各項目の書き方 (全章の生成と 1 章の書き直しで共通)。項目の並びは、出力の見本と JSON Schema (outline.ts) と同じ。
// setups と payoffs の書き方は、全章の生成と 1 章の書き直しで違うので引数で受ける。
function outlineFieldRules(flags: OutlineFlags, setupsRule: string, payoffsRule: string): string[] {
  return [
    'title: 章のタイトル。空にしない。',
    flags.hasCast ? CHARACTERS_RULE : '',
    `time_place: その章がいつ、どこで起きるか。1文で書く。${flags.hasBible ? '【作品設計】の時系列と合わせる。' : ''}`,
    `events: その章で起きる出来事を、起きる順に${OUTLINE_EVENTS_MIN}〜${OUTLINE_EVENTS_MAX}個。1項目に1つの出来事を、誰が何をするかが分かる1文で書く。心情や雰囲気ではなく、起きることを書く。`,
    'end_state: 章末に、誰がどこにいて、どういう状況か。1〜2文で書く。次の章はここから続く。',
    setupsRule,
    payoffsRule,
    'summary: events をまとめた章の概要。空にしない。'
  ].filter((rule) => rule.length > 0)
}

// 章 1 件ぶんの出力の見本。キーの並びは outline.ts の JSON Schema と同じ (テストで突き合わせる)。
function outlineChapterSkeleton(hasCast: boolean, chapterNumber: number): string {
  const characters: Array<[string, string]> = hasCast ? [['characters', inlineJson(['登場する人物の名前'])]] : []
  const entries: Array<[string, string]> = [
    ['chapter_number', String(chapterNumber)],
    ['title', inlineJson('章のタイトル')],
    ...characters,
    ['time_place', inlineJson('いつ、どこで')],
    ['events', inlineJson(['出来事'])],
    ['end_state', inlineJson('章末の状況')],
    ['setups', inlineJson([{ id: '伏線の id', description: '伏線の内容' }])],
    ['payoffs', inlineJson(['回収する伏線の id'])],
    ['summary', inlineJson('章の概要')]
  ]
  return `{ ${entries.map(([key, value]) => `${JSON.stringify(key)}: ${value}`).join(', ')} }`
}

const OUTLINE_PURPOSE = '章立ては本文を書く前の計画で、各章で何が起きるかを具体的に決める。'

function outlineSystem(flags: OutlineFlags): string {
  const rules = [
    '【今回の依頼】の章数ちょうどの章を作る。chapter_number は1から章数までの連番にする。',
    ...outlineWritingRules(flags),
    '隣り合う章で同じ出来事を書かない。各章の end_state と、次の章の time_place・最初の出来事が繋がるようにする。',
    '張った伏線（setups）は、張った章より後の、最終章までのどこかの章で回収する（payoffs）。',
    flags.hasBibleEnding ? '最終章の出来事は、【作品設計】の「結末」に至る。' : '最終章の出来事は、物語の結末に至る。'
  ]
  const fields = outlineFieldRules(
    flags,
    `setups: この章で張る伏線（後の章で回収するもの）。id は s1、s2…と章立て全体の通し番号にし、description に内容を1文で書く。1章に${OUTLINE_PLAN_LIMITS.setupsMax}個まで。無ければ空にする。`,
    'payoffs: この章で回収する伏線の id。それより前の章の setups の id だけを書く。無ければ空にする。'
  )
  const sections = renderSections([
    { heading: '章立ての規則', body: bullets(rules) },
    { heading: '各項目の書き方', body: bullets(fields) },
    {
      heading: '出力',
      body: `${bullets(['JSON だけを出力する。形式は次のとおり。'])}\n{\n  "chapters": [\n    ${outlineChapterSkeleton(flags.hasCast, 1)},\n    ...\n  ]\n}`
    }
  ])
  return `あなたはプロの小説家として、渡されたあらすじと設定に基づいて、小説の章立てを作る。${OUTLINE_PURPOSE}\n\n${sections}`
}

// 備考欄 (物語に取り込みたい要素)。扱い方は資料のすぐ下に添える。
function notesBody(notes: string | undefined, instruction: string): string {
  if (notes === undefined) return ''
  const body = compactText(notes)
  return body.length > 0 ? `${body}\n${instruction}` : ''
}

function castNamesLine(cast: CastMember[]): string {
  return cast.length > 0 ? `名簿（characters に使える名前）: ${cast.map((member) => member.name).join('、')}` : ''
}

// 章立ての【作品情報】。視点と文体は渡さない (概要が語り手の一人称や、本文の文体で書かれる原因になる)。
// 年齢指定と結末の方向は残す。結末の具体像が作品設計にあれば、そちらを正とする。
function outlineInfoBody(input: OutlinePromptInput): string {
  const { novel, style, bible } = input
  const rating = ratingLine(style.age_rating, adultReadingOf(bible))
  const ending = style.ending === undefined ? undefined : ENDING_LINES[style.ending]
  const hasBibleEnding = bible !== null && bible !== undefined && bible.ending.trim().length > 0
  return [
    novelInfoBody(novel, true),
    rating === undefined ? '' : `年齢指定: ${rating}`,
    ending === undefined
      ? ''
      : hasBibleEnding
        ? `結末の方向: ${ending}（具体的な結末は【作品設計】の「結末」に従う）`
        : `結末: ${ending}`
  ]
    .filter((line) => line.length > 0)
    .join('\n')
}

function narratorRequestLine(input: OutlinePromptInput, scope: string): string {
  const narrator = narratorName(input.style, input.cast)
  return narrator === undefined ? '' : `${narratorTag(input.style)}: ${narrator}（${scope}に登場させる）`
}

// 章立ての資料 (全体の生成と 1 章の書き直しで共通)。章立てには登場人物を全員渡す。
// 呼称表は渡さない (章立ては台詞を書かない。呼び方で書かれると、名簿の名前との照合ができなくなる)。
function outlineMaterials(input: OutlinePromptInput, notesInstruction: string): Section[] {
  const narrator = narratorName(input.style, input.cast)
  return [
    { heading: '作品情報', body: outlineInfoBody(input) },
    { heading: '作品設計', body: bibleBody(input.bible) },
    {
      heading: '登場人物',
      body: castBody(input.cast, (member) => (member.name === narrator ? narratorTag(input.style) : ''))
    },
    { heading: 'キャラクター間の関係', body: relationsBody(input.relations) },
    { heading: '物語に取り込みたい要素', body: notesBody(input.novel.notes, notesInstruction) }
  ]
}

function outlineFlags(input: OutlinePromptInput): OutlineFlags {
  const { bible } = input
  return {
    hasCast: input.cast.length > 0,
    hasBible: bibleBody(bible).length > 0,
    hasBibleEnding: bible !== null && bible !== undefined && bible.ending.trim().length > 0,
    hasNarrator: narratorName(input.style, input.cast) !== undefined
  }
}

function chapterNumberSpan(numChapters: number): string {
  return numChapters <= 1 ? '1' : `1〜${numChapters}`
}

// 章立て (全章) のプロンプト。
export function buildOutlinePrompt(input: OutlinePromptInput): Prompt {
  const { novel, cast } = input
  const request = [
    `全${novel.num_chapters}章の章立てを作る。chapter_number は${chapterNumberSpan(novel.num_chapters)}。`,
    `summary は各章${novel.outline_summary_chars}字程度。`,
    castNamesLine(cast),
    narratorRequestLine(input, '全ての章'),
    JSON_ONLY_REQUEST
  ].filter((line) => line.length > 0)
  const sections: Section[] = [
    ...outlineMaterials(
      input,
      '上の各項目を、物語のどこかに自然に組み込み、章立て（各章の出来事と概要）に反映する。配置や順序は任せる。'
    ),
    { heading: '今回の依頼', body: bullets(request) }
  ]
  return { system: outlineSystem(outlineFlags(input)), user: renderSections(sections) }
}

function outlineChapterSystem(flags: OutlineFlags, chapterNumber: number): string {
  const rules = [
    '【他の章】は固定で、書き換えない。物語全体の流れを壊さないように、前後の章と矛盾しない内容にする。',
    '前の章の章末の状況から続き、次の章の時と場所・最初の出来事へ繋がるようにする。前後の章と同じ出来事を書かない。',
    '元のタイトルや概要に固執せず、異なる切り口・展開を提案してよい。',
    ...outlineWritingRules(flags)
  ]
  const fields = outlineFieldRules(
    flags,
    'setups: この章で張る伏線（後の章で回収するもの）。id と、description に内容を1文で書く。どの伏線を書くかは【今回の依頼】に従う。無ければ空にする。',
    'payoffs: この章で回収する伏線の id。【今回の依頼】に挙げた id だけを書く。無ければ空にする。'
  )
  const sections = renderSections([
    { heading: '書き直しの規則', body: bullets(rules) },
    { heading: '各項目の書き方', body: bullets(fields) },
    {
      heading: '出力',
      body: `${bullets(['書き直した1章だけを、次の JSON 形式で出力する。'])}\n${outlineChapterSkeleton(flags.hasCast, chapterNumber)}`
    }
  ])
  return `あなたはプロの小説家として、既存の章立てのうち、指定された1章だけを書き直す。${OUTLINE_PURPOSE}\n\n${sections}`
}

// 【他の章】【書き直す章】の 1 章ぶん。題と概要に、計画の項目を字下げして添える。
export function outlineChapterBlock(chapter: OutlineChapter): string {
  const plan = planOf(chapter)
  const summary = hang(chapter.summary, '  ')
  const label = chapterLabel(chapter.chapter_number, chapter.title)
  return [
    summary.length > 0 ? `${label}: ${summary}` : label,
    plan.timePlace.length > 0 ? `  時と場所: ${plan.timePlace}` : '',
    ...(plan.events.length > 0
      ? ['  出来事:', ...plan.events.map((event, index) => `    ${index + 1}. ${event}`)]
      : []),
    plan.endState.length > 0 ? `  章末の状況: ${plan.endState}` : '',
    ...(plan.setups.length > 0
      ? ['  張る伏線:', ...plan.setups.map((setup) => `    - ${threadLine(setup.id, setup.description)}`)]
      : []),
    plan.payoffs.length > 0 ? `  回収する伏線: ${plan.payoffs.join('、')}` : ''
  ]
    .filter((line) => line.length > 0)
    .join('\n')
}

// 1 章を書き直すときの、伏線についての依頼。ほかの章は固定なので、id の整合をコードで決めて渡す
// (モデルに全章の setups と payoffs を突き合わせさせない)。
//   keep     この章が張っていて、後の章が回収する伏線。同じ id と内容で残させる (消すと後の章の回収が浮く)
//   mustPay  前の章が張っていて、今のこの章が回収している伏線。ほかに回収する章が無いので、この章で回収させる
//   mayPay   前の章が張っていて、どの章でも回収されていない伏線。この章で回収してもよい
//   nextId   新しく張る伏線に使える最初の id (既存のどの id とも重ならない番号)
function threadRequestLines(chapters: OutlineChapter[], chapterNumber: number, isLast: boolean): string[] {
  const plans = chapters.map((chapter) => ({ number: chapter.chapter_number, plan: planOf(chapter) }))
  const target = plans.find((entry) => entry.number === chapterNumber)
  const others = plans.filter((entry) => entry.number !== chapterNumber)
  const paidElsewhere = new Set(others.flatMap((entry) => entry.plan.payoffs))
  const paidLater = new Set(
    others.filter((entry) => entry.number > chapterNumber).flatMap((entry) => entry.plan.payoffs)
  )
  const paidHere = new Set(target === undefined ? [] : target.plan.payoffs)
  const keep = target === undefined ? [] : target.plan.setups.filter((setup) => paidLater.has(setup.id))
  const payable = others
    .filter((entry) => entry.number < chapterNumber)
    .flatMap((entry) => entry.plan.setups)
    .filter((setup) => !paidElsewhere.has(setup.id))
  // 最終章は、残っている伏線を全部回収させる (後に回収できる章が無い)。
  const mustPay = payable.filter((setup) => isLast || paidHere.has(setup.id))
  const mayPay = payable.filter((setup) => !isLast && !paidHere.has(setup.id))
  const numbers = plans
    .flatMap((entry) => entry.plan.setups)
    .map((setup) => /^s(\d+)$/.exec(setup.id))
    .map((found) => (found === null ? 0 : Number(found[1])))
  const nextId = `s${Math.max(0, ...numbers) + 1}`
  const lines = (threads: StoryThread[]): string[] =>
    threads.map((thread) => `- ${threadLine(thread.id, thread.description)}`)
  return [
    nested('次の伏線は後の章が回収する。この章の出来事の中で張り、setups に同じ id と内容で書く', lines(keep)),
    // ほかの章は書き換えないので、最終章で新しく張っても回収する章が無い。
    isLast
      ? 'この章は最終章なので、新しい伏線は張らない。'
      : `新しい伏線を張るときは、id を ${nextId} から付ける。ほかの章は固定で、足した伏線は後の章を書き直すまで回収されないので、必要なときだけにする。`,
    nested(
      isLast
        ? '次の伏線は、最終章のこの章で回収する。payoffs に id を書く'
        : '次の伏線は、この章で回収する（ほかに回収する章が無い）。payoffs に id を書く',
      lines(mustPay)
    ),
    nested('次の伏線は、この章で回収してもよい（前の章が張り、まだどの章でも回収されていない）', lines(mayPay)),
    payable.length === 0 ? 'payoffs は空にする（前の章が張った、未回収の伏線が無い）。' : ''
  ].filter((line) => line.length > 0)
}

// 章立てのうち 1 章だけを書き直すプロンプト。他の章は計画つきで、固定の資料として渡す。
// 章立てに chapterNumber が無い場合 (後から章数を増やした) は、新しく作る章として扱う。
export function buildOutlineChapterPrompt(input: OutlineChapterPromptInput): Prompt {
  const { novel, cast, existing, chapterNumber } = input
  const chapters = sortedChapters(existing)
  const target = chapters.find((chapter) => chapter.chapter_number === chapterNumber)
  const others = chapters.filter((chapter) => chapter.chapter_number !== chapterNumber)
  const lastNumber = Math.max(novel.num_chapters, chapterNumber, ...chapters.map((chapter) => chapter.chapter_number))
  const isLast = chapterNumber >= lastNumber
  const flags = outlineFlags(input)
  const targetBody =
    target === undefined ||
    (target.title.trim().length === 0 && target.summary.trim().length === 0 && !hasPlan(planOf(target)))
      ? `第${chapterNumber}章（まだ内容が無い。新しく作る）`
      : outlineChapterBlock(target)
  const request = [
    `第${chapterNumber}章を書き直す。chapter_number は${chapterNumber}のまま。`,
    isLast ? `この章が最終章。出来事は${flags.hasBibleEnding ? '【作品設計】の「結末」' : '物語の結末'}に至る。` : '',
    `summary は${novel.outline_summary_chars}字程度。`,
    castNamesLine(cast),
    narratorRequestLine(input, 'この章'),
    ...threadRequestLines(chapters, chapterNumber, isLast),
    JSON_ONLY_REQUEST
  ].filter((line) => line.length > 0)
  const sections: Section[] = [
    ...outlineMaterials(input, '上の各項目は物語全体で取り込む要素である。この章に合うものを自然に組み込む。'),
    { heading: '他の章', body: others.map(outlineChapterBlock).join('\n') },
    { heading: '書き直す章', body: targetBody },
    { heading: '今回の依頼', body: bullets(request) }
  ]
  return { system: outlineChapterSystem(flags, chapterNumber), user: renderSections(sections) }
}
