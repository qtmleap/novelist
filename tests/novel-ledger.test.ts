import { describe, expect, test } from 'bun:test'
import {
  ACTIONS_LIMIT,
  buildLedger,
  FACTS_LIMIT,
  type FinalizeContext,
  finalizeRecord,
  LEARNED_LIMIT,
  LEDGER_MAX_CHARS,
  type Ledger,
  type RecordedChapter,
  renderLedger,
  STATE_MAX
} from '@/lib/novel/ledger'
import { type ChapterRecord, type ChapterRecordDraft, ChapterRecordSchema } from '@/schemas/story.dto'

type DraftCharacter = ChapterRecordDraft['characters'][number]

const character = (name: string, overrides: Partial<DraftCharacter> = {}): DraftCharacter => ({
  name,
  actions: [],
  learned: [],
  state: '',
  ...overrides
})

const draft = (overrides: Partial<ChapterRecordDraft> = {}): ChapterRecordDraft => ({
  summary: '主人公は学校へ向かった。',
  facts: [],
  characters: [],
  new_threads: [],
  resolved_thread_ids: [],
  written_setup_ids: [],
  end_state: { time: '', place: '', present: [] },
  ...overrides
})

const context = (overrides: Partial<FinalizeContext> = {}): FinalizeContext => ({
  chapterNumber: 3,
  openThreads: [],
  plannedSetups: [],
  knownNames: [],
  ...overrides
})

// 結果は必ず保存用のスキーマを通る
const finalize = (input: ChapterRecordDraft, ctx: FinalizeContext = context()): ChapterRecord => {
  const result = finalizeRecord(input, ctx)
  expect(ChapterRecordSchema.safeParse(result).success).toBe(true)
  return result
}

describe('limits', () => {
  test('exported limits', () => {
    expect(FACTS_LIMIT).toBe(15)
    expect(ACTIONS_LIMIT).toBe(6)
    expect(LEARNED_LIMIT).toBe(6)
    expect(STATE_MAX).toBe(300)
  })
})

describe('finalizeRecord: summary', () => {
  test('trims surrounding whitespace', () => {
    expect(finalize(draft({ summary: '  \n起きたこと。\n  ' })).summary).toBe('起きたこと。')
  })
  test('truncates to 1,200 chars', () => {
    expect(finalize(draft({ summary: 'あ'.repeat(1500) })).summary).toHaveLength(1200)
  })
  test('does not cut a surrogate pair in half', () => {
    const text = `${'あ'.repeat(1199)}𠮷${'い'.repeat(10)}`
    expect(finalize(draft({ summary: text })).summary).toBe('あ'.repeat(1199))
  })
  test('rejects a draft whose summary is empty or only whitespace', () => {
    expect(() => finalizeRecord(draft({ summary: '' }), context())).toThrow()
    expect(() => finalizeRecord(draft({ summary: '   ' }), context())).toThrow()
  })
})

describe('finalizeRecord: facts', () => {
  test('trims, drops empty, removes duplicates, keeps the first occurrence', () => {
    const result = finalize(
      draft({ facts: ['  金髪を隠している ', '', '   ', '金髪を隠している', '眼鏡をかけている'] })
    )
    expect(result.facts).toEqual(['金髪を隠している', '眼鏡をかけている'])
  })
  test('truncates each fact to 200 chars', () => {
    expect(finalize(draft({ facts: ['あ'.repeat(300)] })).facts).toEqual(['あ'.repeat(200)])
  })
  test('keeps at most FACTS_LIMIT', () => {
    const facts = Array.from({ length: 30 }, (_, index) => `事実${index + 1}`)
    expect(finalize(draft({ facts })).facts).toEqual(facts.slice(0, FACTS_LIMIT))
  })
  test('facts that become identical after truncation are one fact', () => {
    const result = finalize(draft({ facts: [`${'あ'.repeat(200)}い`, `${'あ'.repeat(200)}う`] }))
    expect(result.facts).toEqual(['あ'.repeat(200)])
  })
})

describe('finalizeRecord: characters', () => {
  const cast = ['酒寄彩葉', '月見八千代', 'ルナ']

  test('drops empty items', () => {
    const result = finalize(
      draft({
        characters: [
          character('ルナ', { actions: ['', '  ', '走った'], learned: ['   ', '鍵のありかを知った'], state: '' })
        ]
      })
    )
    expect(result.characters).toEqual([
      { name: 'ルナ', actions: ['走った'], learned: ['鍵のありかを知った'], state: '' }
    ])
  })

  test('trims names, items and state', () => {
    const result = finalize(
      draft({
        characters: [character('  ルナ ', { actions: [' 走った '], learned: [' 知った '], state: ' 屋上にいる ' })]
      })
    )
    expect(result.characters).toEqual([{ name: 'ルナ', actions: ['走った'], learned: ['知った'], state: '屋上にいる' }])
  })

  test('maps a short name to the full name in the cast', () => {
    const result = finalize(
      draft({
        characters: [character('彩葉', { actions: ['登校した'] }), character('ルナ', { learned: ['秘密を知った'] })]
      }),
      context({ knownNames: cast })
    )
    expect(result.characters.map((entry) => entry.name)).toEqual(['酒寄彩葉', 'ルナ'])
  })

  test('maps a name with an honorific to the full name', () => {
    const result = finalize(
      draft({ characters: [character('ルナさん', { actions: ['笑った'] })] }),
      context({ knownNames: cast })
    )
    expect(result.characters.map((entry) => entry.name)).toEqual(['ルナ'])
  })

  test('drops people who are not in the cast', () => {
    const result = finalize(
      draft({
        characters: [
          character('通りすがりの人', { actions: ['道を尋ねた'] }),
          character('酒寄彩葉', { actions: ['答えた'] }),
          character('ルナの母', { actions: ['手を振った'] })
        ]
      }),
      context({ knownNames: cast })
    )
    expect(result.characters.map((entry) => entry.name)).toEqual(['酒寄彩葉'])
  })

  test('drops a name that could be two people in the cast', () => {
    const result = finalize(
      draft({ characters: [character('酒寄', { actions: ['歩いた'] })] }),
      context({ knownNames: ['酒寄彩葉', '酒寄彩人'] })
    )
    expect(result.characters).toEqual([])
  })

  test('keeps names as written when the cast is empty', () => {
    const result = finalize(
      draft({
        characters: [
          character(' 通りすがりの人 ', { actions: ['道を尋ねた'] }),
          character('彩葉', { state: '帰宅した' })
        ]
      }),
      context({ knownNames: [] })
    )
    expect(result.characters.map((entry) => entry.name)).toEqual(['通りすがりの人', '彩葉'])
  })

  test('merges several rows for the same person', () => {
    const result = finalize(
      draft({
        characters: [
          character('彩葉', {
            actions: ['登校した', '席に着いた'],
            learned: ['席替えがあると知った'],
            state: '教室にいる'
          }),
          character('ルナ', { actions: ['手を振った'] }),
          character('酒寄彩葉', {
            actions: ['席に着いた', '手を挙げた'],
            learned: ['席替えがあると知った', '当番だと知った'],
            state: ''
          }),
          character('酒寄彩葉さん', { state: '廊下にいる' })
        ]
      }),
      context({ knownNames: cast })
    )
    expect(result.characters).toEqual([
      {
        name: '酒寄彩葉',
        actions: ['登校した', '席に着いた', '手を挙げた'],
        learned: ['席替えがあると知った', '当番だと知った'],
        // state は後の空でないもの。後の行が空なら前のものを残す
        state: '廊下にいる'
      },
      { name: 'ルナ', actions: ['手を振った'], learned: [], state: '' }
    ])
  })

  test('keeps the earlier state when the later row has none', () => {
    const result = finalize(
      draft({ characters: [character('ルナ', { state: '屋上にいる' }), character('ルナ', { actions: ['歩いた'] })] })
    )
    expect(result.characters).toEqual([{ name: 'ルナ', actions: ['歩いた'], learned: [], state: '屋上にいる' }])
  })

  test('limits and truncates actions and learned', () => {
    const many = Array.from({ length: 12 }, (_, index) => `項目${index + 1}`)
    const result = finalize(
      draft({
        characters: [
          character('ルナ', { actions: [...many, 'あ'.repeat(200)], learned: [`${'い'.repeat(200)}`, ...many] })
        ]
      })
    )
    const [luna] = result.characters
    expect(luna.actions).toEqual(many.slice(0, ACTIONS_LIMIT))
    expect(luna.learned).toHaveLength(LEARNED_LIMIT)
    expect(luna.learned[0]).toBe('い'.repeat(120))
    expect(luna.learned.slice(1)).toEqual(many.slice(0, LEARNED_LIMIT - 1))
  })

  test('truncates a long item before removing duplicates', () => {
    const result = finalize(
      draft({ characters: [character('ルナ', { actions: [`${'あ'.repeat(120)}い`, `${'あ'.repeat(120)}う`] })] })
    )
    expect(result.characters[0].actions).toEqual(['あ'.repeat(120)])
  })

  test('truncates state to STATE_MAX', () => {
    const result = finalize(draft({ characters: [character('ルナ', { state: 'あ'.repeat(500) })] }))
    expect(result.characters[0].state).toHaveLength(STATE_MAX)
  })

  test('drops a person with nothing to record', () => {
    const result = finalize(
      draft({
        characters: [
          character('ルナ', { actions: ['', ' '], learned: [' '], state: '  ' }),
          character('酒寄彩葉', { learned: ['知った'] })
        ]
      })
    )
    expect(result.characters.map((entry) => entry.name)).toEqual(['酒寄彩葉'])
  })

  test('drops rows with an empty name', () => {
    const result = finalize(draft({ characters: [character('  ', { actions: ['走った'] })] }))
    expect(result.characters).toEqual([])
  })

  test('keeps at most 50 people', () => {
    const characters = Array.from({ length: 80 }, (_, index) => character(`人物${index + 1}`, { actions: ['歩いた'] }))
    expect(finalize(draft({ characters })).characters).toHaveLength(50)
  })
})

describe('finalizeRecord: threads', () => {
  const planned = [
    { id: 'p1', description: '計画した伏線その 1' },
    { id: 'p2', description: '計画した伏線その 2' },
    { id: 'p3', description: '計画した伏線その 3' }
  ]

  test('planned setups that were written come first, with the planned id and description', () => {
    const result = finalize(
      draft({ written_setup_ids: ['p3', 'p1'], new_threads: ['モデルが見つけた伏線'] }),
      context({ plannedSetups: planned })
    )
    // 並びは計画の順 (モデルが答えた順ではない)
    expect(result.threads_opened).toEqual([
      { id: 'p1', description: '計画した伏線その 1' },
      { id: 'p3', description: '計画した伏線その 3' },
      { id: 'c3-1', description: 'モデルが見つけた伏線' }
    ])
  })
  test('unknown written_setup_ids are ignored', () => {
    const result = finalize(draft({ written_setup_ids: ['zzz', 'p2', 'p2'] }), context({ plannedSetups: planned }))
    expect(result.threads_opened).toEqual([{ id: 'p2', description: '計画した伏線その 2' }])
  })
  test('new threads get c{chapter}-{n} ids from 1', () => {
    const result = finalize(draft({ new_threads: ['一つ目', '二つ目', '三つ目'] }), context({ chapterNumber: 7 }))
    expect(result.threads_opened).toEqual([
      { id: 'c7-1', description: '一つ目' },
      { id: 'c7-2', description: '二つ目' },
      { id: 'c7-3', description: '三つ目' }
    ])
  })
  test('new threads skip ids that collide with open threads or planned setups', () => {
    const result = finalize(
      draft({ new_threads: ['一つ目', '二つ目', '三つ目'] }),
      context({
        chapterNumber: 3,
        openThreads: [{ id: 'c3-1', description: '以前の伏線' }],
        plannedSetups: [{ id: 'c3-3', description: '計画の伏線' }]
      })
    )
    expect(result.threads_opened.map((thread) => thread.id)).toEqual(['c3-2', 'c3-4', 'c3-5'])
  })
  test('new threads are trimmed, emptied ones dropped, truncated to 200 chars and capped at 10', () => {
    const many = Array.from({ length: 14 }, (_, index) => `伏線${index + 1}`)
    const result = finalize(draft({ new_threads: ['', '  ', ` ${'あ'.repeat(300)} `, ...many] }))
    expect(result.threads_opened).toHaveLength(10)
    expect(result.threads_opened[0]).toEqual({ id: 'c3-1', description: 'あ'.repeat(200) })
    expect(result.threads_opened[1]).toEqual({ id: 'c3-2', description: '伏線1' })
    expect(result.threads_opened[9]).toEqual({ id: 'c3-10', description: '伏線9' })
  })
  test('resolved ids are limited to open threads and deduplicated', () => {
    const result = finalize(
      draft({ resolved_thread_ids: ['a', 'ghost', 'b', 'a', ''] }),
      context({
        openThreads: [
          { id: 'a', description: 'A' },
          { id: 'b', description: 'B' },
          { id: 'c', description: 'C' }
        ]
      })
    )
    expect(result.threads_resolved).toEqual(['a', 'b'])
  })
  test('nothing is resolved when there are no open threads', () => {
    expect(finalize(draft({ resolved_thread_ids: ['a'] })).threads_resolved).toEqual([])
  })
})

describe('finalizeRecord: end_state', () => {
  test('truncates time and place to 100 chars', () => {
    const result = finalize(
      draft({ end_state: { time: 'あ'.repeat(150), place: ` ${'い'.repeat(150)} `, present: [] } })
    )
    expect(result.end_state.time).toHaveLength(100)
    expect(result.end_state.place).toBe('い'.repeat(100))
  })
  test('present drops empty entries, removes duplicates and keeps at most 20', () => {
    const names = Array.from({ length: 30 }, (_, index) => `人物${index + 1}`)
    const result = finalize(draft({ end_state: { time: '', place: '', present: ['', ' 人物1 ', ...names, '人物1'] } }))
    expect(result.end_state.present).toEqual(names.slice(0, 20))
  })
  test('present maps to the full names in the cast and drops people who are not in it', () => {
    const result = finalize(
      draft({
        end_state: { time: '夜', place: '駅', present: ['彩葉', 'ルナさん', '通りすがりの人', '酒寄彩葉', ''] }
      }),
      context({ knownNames: ['酒寄彩葉', 'ルナ'] })
    )
    // 「彩葉」と「酒寄彩葉」は同じ人物なので 1 人
    expect(result.end_state.present).toEqual(['酒寄彩葉', 'ルナ'])
  })
  test('present keeps names as written when the cast is empty', () => {
    const result = finalize(draft({ end_state: { time: '', place: '', present: [' 彩葉 ', '通りすがりの人'] } }))
    expect(result.end_state.present).toEqual(['彩葉', '通りすがりの人'])
  })
  test('an empty draft end_state stays empty', () => {
    expect(finalize(draft()).end_state).toEqual({ time: '', place: '', present: [] })
  })
})

describe('finalizeRecord: schema', () => {
  test('an oversized draft still produces a valid record', () => {
    const big = draft({
      summary: 'あ'.repeat(10_000),
      facts: Array.from({ length: 100 }, (_, index) => `${index}${'い'.repeat(1000)}`),
      characters: Array.from({ length: 100 }, (_, index) =>
        character(`人物${index}`, {
          actions: Array.from({ length: 50 }, (_, item) => `${item}${'う'.repeat(1000)}`),
          learned: Array.from({ length: 50 }, (_, item) => `${item}${'え'.repeat(1000)}`),
          state: 'お'.repeat(2000)
        })
      ),
      new_threads: Array.from({ length: 100 }, (_, index) => `${index}${'か'.repeat(1000)}`),
      resolved_thread_ids: Array.from({ length: 100 }, (_, index) => `t${index}`),
      end_state: {
        time: 'き'.repeat(2000),
        place: 'く'.repeat(2000),
        present: Array.from({ length: 100 }, (_, index) => `在席${index}`)
      }
    })
    const open = Array.from({ length: 100 }, (_, index) => ({ id: `t${index}`, description: '未回収' }))
    const result = finalize(big, context({ openThreads: open }))
    expect(result.threads_resolved).toHaveLength(60)
    expect(result.characters).toHaveLength(50)
    expect(result.characters[0].actions).toHaveLength(ACTIONS_LIMIT)
  })
  test('does not mutate the draft or the context', () => {
    const input = draft({
      facts: ['  a ', 'a'],
      new_threads: ['x'],
      characters: [character('彩葉', { actions: [' a '] })]
    })
    const ctx = context({ openThreads: [{ id: 'c3-1', description: 'd' }], knownNames: ['酒寄彩葉'] })
    const before = JSON.stringify([input, ctx])
    finalize(input, ctx)
    expect(JSON.stringify([input, ctx])).toBe(before)
  })
})

const record = (overrides: Partial<ChapterRecord> = {}): ChapterRecord => ({
  summary: '要約',
  facts: [],
  characters: [],
  threads_opened: [],
  threads_resolved: [],
  end_state: { time: '', place: '', present: [] },
  ...overrides
})

const chapterRecord = (number: number, overrides: Partial<ChapterRecord> = {}): RecordedChapter => ({
  number,
  record: record(overrides)
})

const recorded = (
  name: string,
  overrides: Partial<ChapterRecord['characters'][number]> = {}
): ChapterRecord['characters'][number] => ({ name, actions: [], learned: [], state: '', ...overrides })

describe('buildLedger', () => {
  test('empty input gives an empty ledger', () => {
    expect(buildLedger([])).toEqual({ flow: [], facts: [], characters: [], openThreads: [], endState: null })
  })

  test('flow is the summaries in chapter order regardless of input order', () => {
    const ledger = buildLedger([
      chapterRecord(3, { summary: '三章の流れ' }),
      chapterRecord(1, { summary: '一章の流れ' }),
      chapterRecord(2, { summary: '二章の流れ' })
    ])
    expect(ledger.flow).toEqual([
      { chapter: 1, summary: '一章の流れ' },
      { chapter: 2, summary: '二章の流れ' },
      { chapter: 3, summary: '三章の流れ' }
    ])
  })

  test('facts are concatenated in chapter order regardless of input order', () => {
    const ledger = buildLedger([
      chapterRecord(3, { facts: ['三章の事実'] }),
      chapterRecord(1, { facts: ['一章の事実 A', '一章の事実 B'] }),
      chapterRecord(2, { facts: ['二章の事実'] })
    ])
    expect(ledger.facts).toEqual([
      { chapter: 1, text: '一章の事実 A' },
      { chapter: 1, text: '一章の事実 B' },
      { chapter: 2, text: '二章の事実' },
      { chapter: 3, text: '三章の事実' }
    ])
  })

  test('an identical fact is kept only at its first appearance', () => {
    const ledger = buildLedger([
      chapterRecord(2, { facts: ['同じ文', '別の文'] }),
      chapterRecord(1, { facts: ['同じ文'] }),
      chapterRecord(3, { facts: ['別の文', '同じ文', '新しい文'] })
    ])
    expect(ledger.facts).toEqual([
      { chapter: 1, text: '同じ文' },
      { chapter: 2, text: '別の文' },
      { chapter: 3, text: '新しい文' }
    ])
  })

  test('what a person learned accumulates across chapters, even when they are absent from later records', () => {
    const ledger = buildLedger([
      chapterRecord(1, { characters: [recorded('アリス', { learned: ['屋上の鍵は職員室にある'] })] }),
      chapterRecord(2, { characters: [recorded('ボブ', { actions: ['寝ていた'] })] }),
      chapterRecord(3, { characters: [recorded('ボブ', { learned: ['アリスが鍵を探している'] })] })
    ])
    const alice = ledger.characters.find((entry) => entry.name === 'アリス')
    expect(alice?.knowledge).toEqual([{ chapter: 1, text: '屋上の鍵は職員室にある' }])
    const bob = ledger.characters.find((entry) => entry.name === 'ボブ')
    expect(bob?.knowledge).toEqual([{ chapter: 3, text: 'アリスが鍵を探している' }])
  })

  test('learned items are in chapter order and an identical sentence is kept once, at its first appearance', () => {
    const ledger = buildLedger([
      chapterRecord(3, { characters: [recorded('アリス', { learned: ['新しい事実', '鍵の場所'] })] }),
      chapterRecord(1, { characters: [recorded('アリス', { learned: ['鍵の場所', '鍵の場所'] })] }),
      chapterRecord(2, { characters: [recorded('アリス', { learned: ['別の事実'] })] })
    ])
    expect(ledger.characters[0].knowledge).toEqual([
      { chapter: 1, text: '鍵の場所' },
      { chapter: 2, text: '別の事実' },
      { chapter: 3, text: '新しい事実' }
    ])
  })

  test('the same sentence learned by two different people is kept for both', () => {
    const ledger = buildLedger([
      chapterRecord(1, {
        characters: [recorded('アリス', { learned: ['合言葉は桜'] }), recorded('ボブ', { learned: ['合言葉は桜'] })]
      })
    ])
    expect(ledger.characters.map((entry) => entry.knowledge.length)).toEqual([1, 1])
  })

  test('state is the latest non-empty one, with its chapter', () => {
    const ledger = buildLedger([
      chapterRecord(1, { characters: [recorded('アリス', { state: '一章のアリス' })] }),
      chapterRecord(3, { characters: [recorded('アリス', { actions: ['歩いた'], state: '' })] }),
      chapterRecord(2, { characters: [recorded('アリス', { state: '二章のアリス' })] })
    ])
    expect(ledger.characters[0].state).toEqual({ chapter: 2, text: '二章のアリス' })
  })

  test('state is null when no chapter has one', () => {
    const ledger = buildLedger([chapterRecord(1, { characters: [recorded('アリス', { actions: ['歩いた'] })] })])
    expect(ledger.characters[0].state).toBeNull()
  })

  test('actions are kept per chapter, in chapter order, without empty chapters', () => {
    const ledger = buildLedger([
      chapterRecord(3, { characters: [recorded('アリス', { actions: ['三章 A', '三章 B'] })] }),
      chapterRecord(1, { characters: [recorded('アリス', { actions: ['一章 A'] })] }),
      chapterRecord(2, { characters: [recorded('アリス', { learned: ['知っただけ'] })] })
    ])
    expect(ledger.characters[0].actions).toEqual([
      { chapter: 1, items: ['一章 A'] },
      { chapter: 3, items: ['三章 A', '三章 B'] }
    ])
  })

  test('two rows for the same person in one record stay one entry per chapter', () => {
    const ledger = buildLedger([
      chapterRecord(1, { characters: [recorded('アリス', { actions: ['A'] }), recorded('アリス', { actions: ['B'] })] })
    ])
    expect(ledger.characters[0].actions).toEqual([{ chapter: 1, items: ['A', 'B'] }])
  })

  test('people are listed in order of first appearance', () => {
    const ledger = buildLedger([
      chapterRecord(3, { characters: [recorded('アリス', { actions: ['三章'] })] }),
      chapterRecord(1, {
        characters: [recorded('アリス', { actions: ['一章'] }), recorded('ボブ', { actions: ['一章'] })]
      }),
      chapterRecord(2, { characters: [recorded('キャロル', { actions: ['二章'] })] })
    ])
    expect(ledger.characters.map((entry) => entry.name)).toEqual(['アリス', 'ボブ', 'キャロル'])
  })

  test('a row with nothing in it does not create a person', () => {
    const ledger = buildLedger([chapterRecord(1, { characters: [recorded('アリス')] })])
    expect(ledger.characters).toEqual([])
  })

  test('threads resolved in the same or a later chapter are removed', () => {
    const ledger = buildLedger([
      chapterRecord(1, {
        threads_opened: [
          { id: 'a', description: '後で回収' },
          { id: 'b', description: '残る' }
        ]
      }),
      chapterRecord(2, { threads_opened: [{ id: 'c', description: '同じ章で回収' }], threads_resolved: ['c'] }),
      chapterRecord(3, { threads_resolved: ['a'] }),
      chapterRecord(4, { threads_opened: [{ id: 'd', description: '新しい' }] })
    ])
    expect(ledger.openThreads).toEqual([
      { id: 'b', description: '残る', chapter: 1 },
      { id: 'd', description: '新しい', chapter: 4 }
    ])
  })

  test('a resolution recorded in an earlier chapter does not remove a thread opened later', () => {
    const ledger = buildLedger([
      chapterRecord(1, { threads_resolved: ['x'] }),
      chapterRecord(2, { threads_opened: [{ id: 'x', description: '後から張った' }] })
    ])
    expect(ledger.openThreads).toEqual([{ id: 'x', description: '後から張った', chapter: 2 }])
  })

  test('endState is the one from the highest chapter number', () => {
    const ledger = buildLedger([
      chapterRecord(2, { end_state: { time: '夜', place: '駅', present: ['アリス'] } }),
      chapterRecord(5, { end_state: { time: '翌朝', place: '学校', present: ['アリス', 'ボブ'] } }),
      chapterRecord(3, { end_state: { time: '昼', place: '公園', present: [] } })
    ])
    expect(ledger.endState).toEqual({ chapter: 5, time: '翌朝', place: '学校', present: ['アリス', 'ボブ'] })
  })

  test('endState is null when the last chapter has nothing in it', () => {
    const ledger = buildLedger([
      chapterRecord(1, { end_state: { time: '夜', place: '駅', present: [] } }),
      chapterRecord(2, { end_state: { time: '', place: '', present: [] } })
    ])
    expect(ledger.endState).toBeNull()
  })

  test('a partially filled endState is kept', () => {
    const ledger = buildLedger([chapterRecord(1, { end_state: { time: '', place: '駅前', present: [] } })])
    expect(ledger.endState).toEqual({ chapter: 1, time: '', place: '駅前', present: [] })
  })

  test('does not mutate or reorder the input', () => {
    const input = [chapterRecord(3), chapterRecord(1), chapterRecord(2)]
    buildLedger(input)
    expect(input.map((entry) => entry.number)).toEqual([3, 1, 2])
  })
})

const fullLedger: Ledger = {
  flow: [
    { chapter: 1, summary: 'アリスは金髪を黒いウィッグで隠して登校した。' },
    { chapter: 2, summary: '屋上が立入禁止になり、アリスは鍵を探し始めた。' }
  ],
  facts: [
    { chapter: 1, text: '主人公は金髪を黒いウィッグで隠している' },
    { chapter: 2, text: '学校の屋上は立入禁止になった' }
  ],
  characters: [
    {
      name: 'アリス',
      state: { chapter: 2, text: '図書室で待っている' },
      knowledge: [{ chapter: 1, text: '屋上の鍵は職員室にある' }],
      actions: [
        { chapter: 1, items: ['登校した', '席に着いた'] },
        { chapter: 2, items: ['鍵を探した'] }
      ]
    },
    {
      name: 'ボブ',
      state: null,
      knowledge: [],
      actions: [{ chapter: 1, items: ['入院した'] }]
    }
  ],
  openThreads: [{ id: 'c1-1', description: '屋上の鍵の行方', chapter: 1 }],
  endState: { chapter: 2, time: '放課後', place: '図書室', present: ['アリス', 'ボブ'] }
}

describe('renderLedger', () => {
  test('is the empty string when there is nothing to say', () => {
    expect(renderLedger({ flow: [], facts: [], characters: [], openThreads: [], endState: null })).toBe('')
    expect(renderLedger(buildLedger([]))).toBe('')
  })

  test('starts with the heading and a one-line explanation', () => {
    const lines = renderLedger(fullLedger).split('\n')
    expect(lines[0]).toBe('【確定事項】')
    expect(lines[1]).toContain('矛盾')
    expect(lines[2]).toBe('')
  })

  test('renders the whole ledger in the documented layout', () => {
    expect(renderLedger(fullLedger)).toBe(
      [
        '【確定事項】',
        'ここまでの本文から抜き出した記録である。本文と同じく確定しており、矛盾させない。',
        '',
        '◆ これまでの流れ',
        '- 第1章: アリスは金髪を黒いウィッグで隠して登校した。',
        '- 第2章: 屋上が立入禁止になり、アリスは鍵を探し始めた。',
        '',
        '◆ 事実',
        '- 第1章: 主人公は金髪を黒いウィッグで隠している',
        '- 第2章: 学校の屋上は立入禁止になった',
        '',
        '◆ 人物ごとの記録',
        '■ アリス',
        '  状態（第2章の終わり）: 図書室で待っている',
        '  知っていること:',
        '  - 第1章: 屋上の鍵は職員室にある',
        '  したこと:',
        '  - 第1章: 登校した／席に着いた',
        '  - 第2章: 鍵を探した',
        '■ ボブ',
        '  したこと:',
        '  - 第1章: 入院した',
        '',
        '◆ 未回収の伏線',
        '- [c1-1] 第1章: 屋上の鍵の行方',
        '',
        '◆ 直前の章の終わり（第2章）',
        '- 時: 放課後 / 場所: 図書室 / その場にいる人物: アリス、ボブ'
      ].join('\n')
    )
  })

  test('sections come in a fixed order', () => {
    const text = renderLedger(fullLedger)
    const headings = ['◆ これまでの流れ', '◆ 事実', '◆ 人物ごとの記録', '◆ 未回収の伏線', '◆ 直前の章の終わり']
    const positions = headings.map((heading) => text.indexOf(heading))
    expect(positions.every((position) => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((a, b) => a - b))
  })

  test('headings use ◆ and people use ■, so one symbol never means two things', () => {
    const text = renderLedger(fullLedger)
    const lines = text.split('\n')
    expect(lines.filter((line) => line.startsWith('◆ '))).toHaveLength(5)
    expect(lines.filter((line) => line.startsWith('■ '))).toEqual(['■ アリス', '■ ボブ'])
    expect(text).not.toContain('●')
  })

  test('a state is labelled with the chapter it was recorded at, not as the present', () => {
    const text = renderLedger(fullLedger)
    expect(text).toContain('  状態（第2章の終わり）: 図書室で待っている')
    expect(text).not.toContain('現在')
    expect(text).not.toContain('時点')
  })

  test('an open thread is one line in the same shape as the other lines', () => {
    const text = renderLedger({
      ...fullLedger,
      openThreads: [{ id: 'c2-1', description: '鍵を返すと約束した。', chapter: 2 }]
    })
    expect(text).toContain('- [c2-1] 第2章: 鍵を返すと約束した。\n')
    expect(text).not.toContain('で張った')
  })

  test('omits sub-headings whose content is empty', () => {
    const text = renderLedger({ ...fullLedger, flow: [], facts: [], openThreads: [], endState: null })
    expect(text).not.toContain('◆ これまでの流れ')
    expect(text).not.toContain('◆ 事実')
    expect(text).not.toContain('◆ 未回収の伏線')
    expect(text).not.toContain('◆ 直前の章の終わり')
    expect(text).toContain('◆ 人物ごとの記録')
  })

  test('omits the people section when nobody has anything to show', () => {
    const text = renderLedger({
      ...fullLedger,
      characters: [{ name: 'アリス', state: null, knowledge: [], actions: [] }]
    })
    expect(text).not.toContain('◆ 人物ごとの記録')
    expect(text).not.toContain('■ アリス')
  })

  test('omits empty items inside a person', () => {
    const text = renderLedger({
      ...fullLedger,
      characters: [
        { name: 'アリス', state: null, knowledge: [{ chapter: 1, text: '鍵の場所' }], actions: [] },
        { name: 'ボブ', state: { chapter: 2, text: '入院中' }, knowledge: [], actions: [{ chapter: 2, items: [] }] }
      ]
    })
    const alice = text.slice(text.indexOf('■ アリス'), text.indexOf('■ ボブ'))
    expect(alice).toContain('知っていること:')
    expect(alice).not.toContain('状態（')
    expect(alice).not.toContain('したこと:')
    const bob = text.slice(text.indexOf('■ ボブ'))
    expect(bob).toContain('状態（第2章の終わり）: 入院中')
    expect(bob).not.toContain('知っていること:')
    expect(bob).not.toContain('したこと:')
  })

  test('omits empty parts of the ending line', () => {
    const text = renderLedger({
      ...fullLedger,
      endState: { chapter: 4, time: '', place: '駅前', present: [] }
    })
    expect(text).toContain('◆ 直前の章の終わり（第4章）\n- 場所: 駅前')
    expect(text).not.toContain('時:')
    expect(text).not.toContain('その場にいる人物:')
  })

  test('is deterministic regardless of the order the records arrive in', () => {
    const records = [
      chapterRecord(1, {
        summary: '一章',
        facts: ['事実 A'],
        characters: [recorded('アリス', { actions: ['歩いた'], learned: ['鍵の場所'], state: '一章' })],
        threads_opened: [{ id: 'a', description: '伏線' }]
      }),
      chapterRecord(2, {
        summary: '二章',
        facts: ['事実 B'],
        characters: [recorded('ボブ', { actions: ['走った'], state: '二章' })],
        end_state: { time: '夜', place: '駅', present: ['ボブ'] }
      }),
      chapterRecord(3, {
        summary: '三章',
        facts: ['事実 C'],
        characters: [recorded('アリス', { actions: ['止まった'], state: '三章' })]
      })
    ]
    const forward = renderLedger(buildLedger(records))
    expect(forward).not.toBe('')
    expect(renderLedger(buildLedger([...records].reverse()))).toBe(forward)
    expect(renderLedger(buildLedger(records))).toBe(forward)
  })
})

describe('renderLedger: size limit', () => {
  const NO_LIMIT = { maxChars: Number.POSITIVE_INFINITY }
  const CHAPTERS = [1, 2, 3, 4, 5, 6]
  const bigAction = (chapter: number) => `${'あ'.repeat(100)}${chapter}`

  // 2 人 × 6 章ぶんの「したこと」と、省いてはいけない情報が揃った台帳
  const bigLedger: Ledger = {
    flow: CHAPTERS.map((chapter) => ({ chapter, summary: `第${chapter}章の流れ` })),
    facts: [
      { chapter: 1, text: '金髪を黒いウィッグで隠している' },
      { chapter: 4, text: '屋上は立入禁止' }
    ],
    characters: ['アリス', 'ボブ'].map((name) => ({
      name,
      state: { chapter: 6, text: `${name}は図書室にいる` },
      knowledge: [{ chapter: 2, text: `${name}は鍵の場所を知った` }],
      actions: CHAPTERS.map((chapter) => ({ chapter, items: [bigAction(chapter)] }))
    })),
    openThreads: [{ id: 'c1-1', description: '屋上の鍵の行方', chapter: 1 }],
    endState: { chapter: 6, time: '放課後', place: '図書室', present: ['アリス', 'ボブ'] }
  }

  const note = (first: number, last: number): string =>
    first === last
      ? `（第${first}章の「したこと」は省略。流れは「これまでの流れ」を参照）`
      : `（第${first}〜${last}章の「したこと」は省略。流れは「これまでの流れ」を参照）`

  const withoutActionsUpTo = (ledger: Ledger, last: number): Ledger => ({
    ...ledger,
    characters: ledger.characters.map((entry) => ({
      ...entry,
      actions: entry.actions.filter((action) => action.chapter > last)
    }))
  })

  // 古い順に first〜last 章の「したこと」を省いた出力の長さ (注記 1 行ぶんを足す)
  const lengthWithOmitted = (ledger: Ledger, last: number): number =>
    renderLedger(withoutActionsUpTo(ledger, last), NO_LIMIT).length + note(1, last).length + 1

  const personSection = (text: string): string =>
    text.slice(text.indexOf('◆ 人物ごとの記録'), text.indexOf('◆ 未回収の伏線'))

  // 人物の節に残っている「したこと」の章番号 (人物の順、章の順)
  const actionChapters = (text: string): number[] =>
    personSection(text)
      .split('\n')
      .flatMap((line) => {
        const found = /^ {2}- 第(\d+)章: あ{100}/.exec(line)
        return found === null ? [] : [Number(found[1])]
      })

  test('the default limit is 40,000 chars', () => {
    expect(LEDGER_MAX_CHARS).toBe(40_000)
  })

  test('within the limit the output is unchanged', () => {
    const full = renderLedger(bigLedger, NO_LIMIT)
    expect(renderLedger(bigLedger)).toBe(full)
    expect(renderLedger(bigLedger, { maxChars: 1_000_000 })).toBe(full)
    expect(full).not.toContain('省略')
    expect(actionChapters(full)).toEqual([...CHAPTERS, ...CHAPTERS])
    expect(renderLedger(fullLedger)).toBe(renderLedger(fullLedger, NO_LIMIT))
  })

  test('the limit is inclusive', () => {
    const full = renderLedger(bigLedger, NO_LIMIT)
    expect(renderLedger(bigLedger, { maxChars: full.length })).toBe(full)
    expect(renderLedger(bigLedger, { maxChars: full.length - 1 })).not.toBe(full)
  })

  test('over the limit, the oldest chapter is dropped first, for every person at once', () => {
    const full = renderLedger(bigLedger, NO_LIMIT)
    const text = renderLedger(bigLedger, { maxChars: full.length - 1 })
    expect(text.length).toBeLessThanOrEqual(full.length - 1)
    expect(actionChapters(text)).toEqual([2, 3, 4, 5, 6, 2, 3, 4, 5, 6])
    expect(personSection(text)).toContain(note(1, 1))
  })

  test('drops no more than needed', () => {
    const limit = lengthWithOmitted(bigLedger, 3)
    const text = renderLedger(bigLedger, { maxChars: limit })
    expect(text.length).toBe(limit)
    expect(actionChapters(text)).toEqual([4, 5, 6, 4, 5, 6])
    expect(personSection(text)).toContain(note(1, 3))
    // 1 字でも足りなければ、もう 1 章省く
    const tighter = renderLedger(bigLedger, { maxChars: limit - 1 })
    expect(actionChapters(tighter)).toEqual([5, 6, 5, 6])
    expect(personSection(tighter)).toContain(note(1, 4))
  })

  test('the note comes right after the people heading', () => {
    const text = renderLedger(bigLedger, { maxChars: lengthWithOmitted(bigLedger, 2) })
    expect(text).toContain(`◆ 人物ごとの記録\n${note(1, 2)}\n■ アリス`)
  })

  test('the note covers the range of chapters that were actually dropped', () => {
    const sparse: Ledger = {
      ...bigLedger,
      characters: bigLedger.characters.map((entry) => ({
        ...entry,
        actions: entry.actions.filter((action) => action.chapter === 2 || action.chapter === 5)
      }))
    }
    const full = renderLedger(sparse, NO_LIMIT)
    const one = renderLedger(sparse, { maxChars: full.length - 1 })
    expect(actionChapters(one)).toEqual([5, 5])
    expect(personSection(one)).toContain(note(2, 2))
    const both = renderLedger(sparse, { maxChars: 1 })
    expect(actionChapters(both)).toEqual([])
    expect(personSection(both)).toContain(note(2, 5))
  })

  test('flow, facts, what people know, their state, open threads and the ending are never dropped', () => {
    const text = renderLedger(bigLedger, { maxChars: 1 })
    for (const kept of [
      '◆ これまでの流れ',
      ...CHAPTERS.map((chapter) => `- 第${chapter}章: 第${chapter}章の流れ`),
      '- 第1章: 金髪を黒いウィッグで隠している',
      '- 第4章: 屋上は立入禁止',
      '  知っていること:',
      '  - 第2章: アリスは鍵の場所を知った',
      '  - 第2章: ボブは鍵の場所を知った',
      '  状態（第6章の終わり）: アリスは図書室にいる',
      '  状態（第6章の終わり）: ボブは図書室にいる',
      '- [c1-1] 第1章: 屋上の鍵の行方',
      '◆ 直前の章の終わり（第6章）'
    ]) {
      expect(text).toContain(kept)
    }
  })

  test('returns the output as it is when dropping every action still does not fit', () => {
    const text = renderLedger(bigLedger, { maxChars: 1 })
    expect(text.length).toBeGreaterThan(1)
    expect(actionChapters(text)).toEqual([])
    expect(personSection(text)).toContain(note(1, 6))
    expect(personSection(text)).not.toContain('したこと:')
    // 省くものが尽きたあとは、上限をいくら小さくしても同じ
    expect(renderLedger(bigLedger, { maxChars: 0 })).toBe(text)
  })

  test('maxChars decides how much is dropped', () => {
    const full = renderLedger(bigLedger, NO_LIMIT)
    const roomy = renderLedger(bigLedger, { maxChars: full.length - 1 })
    const tight = renderLedger(bigLedger, { maxChars: lengthWithOmitted(bigLedger, 4) })
    expect(actionChapters(roomy)).toHaveLength(10)
    expect(actionChapters(tight)).toEqual([5, 6, 5, 6])
  })

  test('the default limit applies when maxChars is not given', () => {
    // 30 章 × 2 人 × 6 項目 × 120 字 ≒ 43,000 字の「したこと」
    const chapters = Array.from({ length: 30 }, (_, index) => index + 1)
    const long: Ledger = {
      flow: chapters.map((chapter) => ({ chapter, summary: `第${chapter}章の流れ` })),
      facts: [],
      characters: ['アリス', 'ボブ'].map((name) => ({
        name,
        state: { chapter: 30, text: '最後の状態' },
        knowledge: [],
        actions: chapters.map((chapter) => ({
          chapter,
          items: Array.from({ length: 6 }, (_, item) => `${item}${'あ'.repeat(119)}`)
        }))
      })),
      openThreads: [],
      endState: null
    }
    expect(renderLedger(long, NO_LIMIT).length).toBeGreaterThan(LEDGER_MAX_CHARS)
    const text = renderLedger(long)
    expect(text.length).toBeLessThanOrEqual(LEDGER_MAX_CHARS)
    expect(text).toContain('の「したこと」は省略。流れは「これまでの流れ」を参照）')
    // 新しい章の「したこと」が残る
    expect(text).toContain('  - 第30章: ')
  })

  test('the note is still shown when nobody has anything left in the people section', () => {
    const onlyActions: Ledger = {
      ...bigLedger,
      characters: [{ name: 'ボブ', state: null, knowledge: [], actions: [{ chapter: 1, items: [bigAction(1)] }] }]
    }
    const text = renderLedger(onlyActions, { maxChars: 1 })
    expect(text).toContain(`◆ 人物ごとの記録\n${note(1, 1)}`)
    expect(text).not.toContain('■ ボブ')
  })

  test('a ledger without actions never gets a note', () => {
    const none = renderLedger(
      { ...bigLedger, characters: bigLedger.characters.map((entry) => ({ ...entry, actions: [] })) },
      { maxChars: 1 }
    )
    expect(none).not.toContain('省略')
  })

  test('is deterministic and does not mutate the ledger', () => {
    const before = JSON.stringify(bigLedger)
    const limit = lengthWithOmitted(bigLedger, 3)
    const first = renderLedger(bigLedger, { maxChars: limit })
    expect(renderLedger(bigLedger, { maxChars: limit })).toBe(first)
    expect(JSON.stringify(bigLedger)).toBe(before)
  })
})
