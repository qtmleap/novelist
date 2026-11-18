import { matchCastName } from '@/lib/novel/outline'
import {
  type ChapterRecord,
  type ChapterRecordDraft,
  ChapterRecordSchema,
  type EndState,
  type StoryThread
} from '@/schemas/story.dto'

// 章の記録の確定と、全章の記録を累積した「確定事項」の組み立て (純粋関数)。
// モデルが返した下書きは形しか検査されておらず、空の項目も長さも重複も名簿との照合も済んでいない。
// 保存の前にここで全部整える。

// 下書きを切り詰める上限。story.dto.ts の保存上限よりも小さく取り、後続の章のプロンプトを太らせない。
const SUMMARY_MAX = 1200
const FACT_MAX = 200
// 次の 4 つは記録の抽出のプロンプト (assist-prompts.ts) が「〜項目まで」「〜字まで」を作るのに参照する
export const FACTS_LIMIT = 15
export const ACTIONS_LIMIT = 6
export const LEARNED_LIMIT = 6
export const STATE_MAX = 300
const ACTION_MAX = 120
const LEARNED_MAX = 120
const NEW_THREAD_MAX = 200
const NEW_THREADS_LIMIT = 10
const END_STATE_TEXT_MAX = 100
const PRESENT_LIMIT = 20
// 人物名と在席者の名前の上限は保存側 (story.dto.ts) と同じ
const NAME_MAX = 100
const CHARACTERS_LIMIT = 50
const RESOLVED_LIMIT = 60
const THREADS_OPENED_LIMIT = 30

export type RecordedChapter = { number: number; record: ChapterRecord }
export type LedgerFlow = { chapter: number; summary: string }
export type LedgerFact = { chapter: number; text: string }
export type LedgerCharacter = {
  name: string
  // 空でない最新の章末の状態。どの章にも無ければ null
  state: { chapter: number; text: string } | null
  // 知ったことの累積 (章順。同じ文は最初の 1 つ)
  knowledge: LedgerFact[]
  // したことの累積 (章ごと。項目が空の章は入れない)
  actions: Array<{ chapter: number; items: string[] }>
}
export type LedgerThread = { id: string; description: string; chapter: number }
export type Ledger = {
  flow: LedgerFlow[]
  facts: LedgerFact[]
  characters: LedgerCharacter[]
  openThreads: LedgerThread[]
  endState: { chapter: number; time: string; place: string; present: string[] } | null
}

// 前後の空白を除いて max 字で切る。UTF-16 の上位サロゲートで終わったら 1 つ落とす
// (絵文字や環境依存文字を半端に切らない。保存側の zod の max も UTF-16 の長さで数える)。
const clip = (text: string, max: number): string => {
  const trimmed = text.trim()
  if (trimmed.length <= max) {
    return trimmed
  }
  const cut = trimmed.slice(0, max)
  const last = cut.charCodeAt(cut.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
}

// 各項目を切り詰め、空になったものを捨てる。
const clipItems = (items: string[], max: number): string[] =>
  items.map((item) => clip(item, max)).filter((item) => item !== '')

// 重複を除いて先頭 limit 個だけ残す。
const uniqueFirst = (items: string[], limit: number): string[] => [...new Set(items)].slice(0, limit)

// 新しい伏線の id を count 個作る。`c{章番号}-{連番}` の連番は 1 から数え、taken にあるものは飛ばす。
// 候補を taken.size + count 個並べれば、空いているものが必ず count 個残る。
const freshThreadIds = (chapterNumber: number, count: number, taken: ReadonlySet<string>): string[] =>
  Array.from({ length: taken.size + count }, (_, index) => `c${chapterNumber}-${index + 1}`)
    .filter((id) => !taken.has(id))
    .slice(0, count)

export type FinalizeContext = {
  chapterNumber: number
  // この章の前までに未回収の伏線
  openThreads: StoryThread[]
  // 章立てでこの章に張る予定の伏線
  plannedSetups: StoryThread[]
  // 名簿 (人物名)。空なら人物の名前を名簿と照合せず、書かれたまま使う
  knownNames: string[]
}

type DraftCharacterBody = { actions: string[]; learned: string[]; state: string }

// 名簿があれば正式名に寄せる (照合できなければ null)。名簿が無ければ、書かれた名前をそのまま使う。
const resolveName = (raw: string, cast: string[]): string | null => {
  const name = cast.length === 0 ? clip(raw, NAME_MAX) : matchCastName(raw, cast)
  return name === null || name === '' ? null : clip(name, NAME_MAX)
}

// LLM が返した下書きを保存できる形にする。
// ChapterRecordSchema を通らない下書き (たとえば要約が空白だけ) は、半端な記録を保存しないよう Error を投げる。
// 呼び出し側は「抽出の失敗」として扱い、record を null のままにする。
export const finalizeRecord = (draft: ChapterRecordDraft, context: FinalizeContext): ChapterRecord => {
  // matchCastName は空の名前を使えないものとして外すので、空かどうかの判定も同じ基準にそろえる
  const cast = context.knownNames.filter((name) => name.length > 0)

  // 人物ごとにまとめる。同じ人物の行は actions と learned を出てきた順に連結し、state は後の空でないものを採る。
  // 並びは名前の初出の順 (Map は最初に入れた位置を保つ)。
  const merged = new Map<string, DraftCharacterBody>()
  for (const entry of draft.characters) {
    const name = resolveName(entry.name, cast)
    if (name !== null) {
      const previous = merged.get(name)
      const state = clip(entry.state, STATE_MAX)
      merged.set(name, {
        actions: [...(previous === undefined ? [] : previous.actions), ...clipItems(entry.actions, ACTION_MAX)],
        learned: [...(previous === undefined ? [] : previous.learned), ...clipItems(entry.learned, LEARNED_MAX)],
        state: state === '' && previous !== undefined ? previous.state : state
      })
    }
  }
  const characters = [...merged]
    .map(([name, body]) => ({
      name,
      actions: uniqueFirst(body.actions, ACTIONS_LIMIT),
      learned: uniqueFirst(body.learned, LEARNED_LIMIT),
      state: body.state
    }))
    // 書くことが何も無い人物は記録に入れない
    .filter((character) => character.actions.length > 0 || character.learned.length > 0 || character.state !== '')
    .slice(0, CHARACTERS_LIMIT)

  // 章末の在席者も同じ基準で正式名に寄せる
  const present = uniqueFirst(
    draft.end_state.present.flatMap((raw) => {
      const name = resolveName(raw, cast)
      return name === null ? [] : [name]
    }),
    PRESENT_LIMIT
  )

  // 計画した伏線のうち実際に書かれたもの。id と説明は計画のものを使う
  const written = new Set(draft.written_setup_ids)
  const plannedIds = new Set<string>()
  const planned = context.plannedSetups.filter((setup) => {
    if (!written.has(setup.id) || plannedIds.has(setup.id)) {
      return false
    }
    plannedIds.add(setup.id)
    return true
  })

  // 本文で新しく生まれた伏線。id はモデルに作らせず、計画・未回収の id と衝突しない番号を振る
  const descriptions = clipItems(draft.new_threads, NEW_THREAD_MAX).slice(0, NEW_THREADS_LIMIT)
  const taken = new Set([...context.openThreads, ...context.plannedSetups].map((thread) => thread.id))
  const ids = freshThreadIds(context.chapterNumber, descriptions.length, taken)
  const fresh = descriptions.map((description, index) => ({ id: ids[index], description }))

  // 回収は、渡した未回収の伏線にある id だけ
  const open = new Set(context.openThreads.map((thread) => thread.id))
  const resolved = uniqueFirst(
    draft.resolved_thread_ids.filter((id) => open.has(id)),
    RESOLVED_LIMIT
  )

  const record = {
    summary: clip(draft.summary, SUMMARY_MAX),
    facts: uniqueFirst(clipItems(draft.facts, FACT_MAX), FACTS_LIMIT),
    characters,
    threads_opened: [...planned, ...fresh].slice(0, THREADS_OPENED_LIMIT),
    threads_resolved: resolved,
    end_state: {
      time: clip(draft.end_state.time, END_STATE_TEXT_MAX),
      place: clip(draft.end_state.place, END_STATE_TEXT_MAX),
      present
    }
  }

  const parsed = ChapterRecordSchema.safeParse(record)
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(', ')
    throw new Error(`章の記録が保存できる形になりません: ${detail}`)
  }
  return parsed.data
}

const isEmptyEndState = (endState: EndState): boolean =>
  endState.time.trim() === '' && endState.place.trim() === '' && endState.present.length === 0

const isBlank = (text: string): boolean => text.trim() === ''

// したことを章ごとに足す。同じ章の行が続いたら (同じ人物の行が 1 つの記録に 2 回ある場合) 1 つにまとめる。
// 章は昇順に処理しているので、同じ章があるとすれば末尾。
const addActions = (
  actions: LedgerCharacter['actions'],
  chapter: number,
  items: string[]
): LedgerCharacter['actions'] => {
  const last = actions.length === 0 ? undefined : actions[actions.length - 1]
  return last !== undefined && last.chapter === chapter
    ? [...actions.slice(0, -1), { chapter, items: [...last.items, ...items] }]
    : [...actions, { chapter, items }]
}

// 全章の記録を累積する。入力の順序に依らず章番号の昇順で処理する。
export const buildLedger = (records: RecordedChapter[]): Ledger => {
  const sorted = [...records].sort((a, b) => a.number - b.number)

  // 全体の流れは章順の要約
  const flow = sorted.map((entry) => ({ chapter: entry.number, summary: entry.record.summary }))

  // 事実は章順に連結し、完全に同じ文は最初の 1 つだけ残す
  const seenFacts = new Set<string>()
  const facts = sorted.flatMap((entry) =>
    entry.record.facts
      .filter((text) => {
        if (seenFacts.has(text)) {
          return false
        }
        seenFacts.add(text)
        return true
      })
      .map((text) => ({ chapter: entry.number, text }))
  )

  // 人物ごとの累積。Map は初出の位置を保つので、並びは名前の初出の順になる。
  // 状態は空でない最新のもの、知ったことは全章ぶん (同じ文は最初の 1 つ)、したことは章ごと。
  // 前の章で知ったことは、同じ人物がその後の章に出てこなくても残る。
  const byName = new Map<string, LedgerCharacter>()
  for (const entry of sorted) {
    for (const character of entry.record.characters) {
      const items = character.actions.filter((item) => !isBlank(item)).map((item) => item.trim())
      const learned = character.learned.filter((item) => !isBlank(item)).map((item) => item.trim())
      const state = character.state.trim()
      // 書くことが何も無い行は人物として数えない (finalizeRecord も同じ基準で捨てる)
      if (items.length > 0 || learned.length > 0 || state !== '') {
        const previous = byName.get(character.name)
        const base: LedgerCharacter =
          previous === undefined ? { name: character.name, state: null, knowledge: [], actions: [] } : previous
        const known = new Set(base.knowledge.map((fact) => fact.text))
        const added = [...new Set(learned)].filter((text) => !known.has(text))
        byName.set(character.name, {
          name: character.name,
          state: state === '' ? base.state : { chapter: entry.number, text: state },
          knowledge: [...base.knowledge, ...added.map((text) => ({ chapter: entry.number, text }))],
          actions: items.length === 0 ? base.actions : addActions(base.actions, entry.number, items)
        })
      }
    }
  }

  // 伏線は、張った章かそれより後の章で回収されたものを除く (回収された後に同じ id が張り直されたら未回収)
  const resolvedAt = new Map<string, number>()
  for (const entry of sorted) {
    for (const id of entry.record.threads_resolved) {
      resolvedAt.set(id, entry.number)
    }
  }
  const openThreads = sorted.flatMap((entry) =>
    entry.record.threads_opened
      .filter((thread) => {
        const resolved = resolvedAt.get(thread.id)
        return resolved === undefined || resolved < entry.number
      })
      .map((thread) => ({ id: thread.id, description: thread.description, chapter: entry.number }))
  )

  const last = sorted.length === 0 ? undefined : sorted[sorted.length - 1]
  const endState =
    last === undefined || isEmptyEndState(last.record.end_state)
      ? null
      : {
          chapter: last.number,
          time: last.record.end_state.time,
          place: last.record.end_state.place,
          present: last.record.end_state.present
        }

  return { flow, facts, characters: [...byName.values()], openThreads, endState }
}

// 人物 1 人ぶんの行。中身が何も無い人物は出さない。空の項目 (状態なし、知っていることなし、したことなし) も出さない。
// omitted に入っている章の「したこと」は出さない (上限を超えたときの省略。renderLedger を参照)。
const characterLines = (character: LedgerCharacter, omitted: ReadonlySet<number>): string[] => {
  const actions = character.actions.filter((entry) => entry.items.length > 0 && !omitted.has(entry.chapter))
  const body = [
    ...(character.state === null ? [] : [`  状態（第${character.state.chapter}章の終わり）: ${character.state.text}`]),
    ...(character.knowledge.length === 0
      ? []
      : ['  知っていること:', ...character.knowledge.map((fact) => `  - 第${fact.chapter}章: ${fact.text}`)]),
    // したことは 1 章を 1 行にまとめる
    ...(actions.length === 0
      ? []
      : ['  したこと:', ...actions.map((entry) => `  - 第${entry.chapter}章: ${entry.items.join('／')}`)])
  ]
  return body.length === 0 ? [] : [`■ ${character.name}`, ...body]
}

// 章末の状況を 1 行にする。空の項目は出さない。
const endStateLine = (endState: { time: string; place: string; present: string[] }): string[] => {
  const parts = [
    ...(isBlank(endState.time) ? [] : [`時: ${endState.time}`]),
    ...(isBlank(endState.place) ? [] : [`場所: ${endState.place}`]),
    ...(endState.present.length === 0 ? [] : [`その場にいる人物: ${endState.present.join('、')}`])
  ]
  return parts.length === 0 ? [] : [`- ${parts.join(' / ')}`]
}

// 【確定事項】の大きさの既定の上限 (文字数)。毎章のプロンプトに入り、章が進むほど大きくなるため、
// 上限いっぱいに書かれても入力の予算 (memory.ts) を確定事項だけで使い切らないようにする歯止め。
export const LEDGER_MAX_CHARS = 40_000

// 省いた章の範囲を注記にする。「したこと」は「これまでの流れ」と重なるので、省いても流れは残る。
const omissionNote = (omitted: number[]): string => {
  const first = omitted[0]
  const last = omitted[omitted.length - 1]
  const range = first === last ? `第${first}章` : `第${first}〜${last}章`
  return `（${range}の「したこと」は省略。流れは「これまでの流れ」を参照）`
}

// omitted (昇順) の章の「したこと」を省いて【確定事項】を組み立てる。何も無ければ空文字。
const renderWithOmission = (ledger: Ledger, omitted: number[]): string => {
  const omittedSet = new Set(omitted)
  const characterBlock = ledger.characters.flatMap((character) => characterLines(character, omittedSet))
  const endLines = ledger.endState === null ? [] : endStateLine(ledger.endState)
  const sections = [
    ledger.flow.length === 0
      ? []
      : ['◆ これまでの流れ', ...ledger.flow.map((entry) => `- 第${entry.chapter}章: ${entry.summary}`)],
    ledger.facts.length === 0 ? [] : ['◆ 事実', ...ledger.facts.map((fact) => `- 第${fact.chapter}章: ${fact.text}`)],
    // 省いたときは、中身が残っていなくても注記だけは出す
    characterBlock.length === 0 && omitted.length === 0
      ? []
      : ['◆ 人物ごとの記録', ...(omitted.length === 0 ? [] : [omissionNote(omitted)]), ...characterBlock],
    ledger.openThreads.length === 0
      ? []
      : [
          '◆ 未回収の伏線',
          ...ledger.openThreads.map((thread) => `- [${thread.id}] 第${thread.chapter}章: ${thread.description}`)
        ],
    ledger.endState === null || endLines.length === 0
      ? []
      : [`◆ 直前の章の終わり（第${ledger.endState.chapter}章）`, ...endLines]
  ].filter((lines) => lines.length > 0)

  if (sections.length === 0) {
    return ''
  }
  const intro = ['【確定事項】', 'ここまでの本文から抜き出した記録である。本文と同じく確定しており、矛盾させない。']
  return [intro.join('\n'), ...sections.map((lines) => lines.join('\n'))].join('\n\n')
}

// 本文プロンプトの【確定事項】の節。見出しを含めて返し、何も無ければ空文字。
// 並びは、これまでの流れ → 事実 → 人物ごとの記録 → 未回収の伏線 → 直前の章の終わり。
// 順序は buildLedger の出力のまま (同じ入力なら同じ文字列)。
//
// maxChars (既定 LEDGER_MAX_CHARS) を超えるときは、人物ごとの「したこと」を古い章から省く。
// 全人物のいちばん古い章の行をまとめて省き、収まるまで、または「したこと」が無くなるまで続ける。
// 「したこと」は「これまでの流れ」と重なるので先に削る。流れ、事実、知っていること、状態、未回収の伏線、
// 直前の章の終わりは、後の章が矛盾させてはいけない情報なので削らない。省いても超えるなら、超えたまま返す。
//
// previousChapter (これから書く章の直前の章番号) を渡すと、ledger.endState がその章のものでないときは
// 「直前の章の終わり」の節を出さない。渡さなければ、endState を章番号つきでそのまま出す。
export const renderLedger = (ledger: Ledger, options: { maxChars?: number; previousChapter?: number } = {}): string => {
  const limit = options.maxChars === undefined ? LEDGER_MAX_CHARS : options.maxChars
  // 直前の章の記録が無い (抽出に失敗した) と、buildLedger の endState はもっと前の章のものになる。
  // それを「直前の章の終わり」として載せると書き出しの位置を誤らせるので、章が違うときは節ごと出さない。
  // 長さの判定も、この節を除いた台帳で行う。
  const shown =
    options.previousChapter === undefined ||
    ledger.endState === null ||
    ledger.endState.chapter === options.previousChapter
      ? ledger
      : { ...ledger, endState: null }
  // 省く候補は、「したこと」が実際にある章 (昇順)
  const candidates = [
    ...new Set(
      shown.characters.flatMap((character) =>
        character.actions.filter((entry) => entry.items.length > 0).map((entry) => entry.chapter)
      )
    )
  ].sort((a, b) => a - b)
  // 古い章から 1 つずつ増やして、収まる最初のものを採る (再帰の深さは章数まで)
  const fit = (count: number): string => {
    const text = renderWithOmission(shown, candidates.slice(0, count))
    return text.length <= limit || count >= candidates.length ? text : fit(count + 1)
  }
  return fit(0)
}
