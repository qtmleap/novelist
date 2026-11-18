import { describe, expect, test } from 'bun:test'
import {
  type ContextChapter,
  type ContextSource,
  contextBudget,
  ledgerOf,
  outlineHasChapter,
  planChapterContext,
  provisionalRecord,
  recordMaterials,
  recordNarrator,
  recordStageAction,
  resolveChapterContext,
  restartState,
  resumePoint
} from '@/lib/novel/chapter-context'
import { renderLedger } from '@/lib/novel/ledger'
import { RECORDED_CHAPTER_CHARS } from '@/lib/novel/memory'
import { buildChapterPrompt, type CastMember, type StyleParams } from '@/lib/novel/prompts'
import type { Outline } from '@/schemas/novel.dto'
import type { ChapterRecord, StoryThread } from '@/schemas/story.dto'

// 本文の大きさ (字)。予算の境目を作りやすいよう、どの章も同じにする。
const SIZE = 3000

function marker(n: number): string {
  return `【第${n}章の本文の目印】`
}

function content(n: number): string {
  const head = `　${marker(n)}`
  return head + 'あ'.repeat(SIZE - head.length)
}

function record(n: number, overrides: Partial<ChapterRecord> = {}): ChapterRecord {
  return {
    summary: `第${n}章の記録の要約`,
    facts: [],
    characters: [],
    threads_opened: [],
    threads_resolved: [],
    end_state: { time: '', place: '', present: [] },
    ...overrides
  }
}

function chapter(n: number, rec: ChapterRecord | null = record(n)): ContextChapter {
  return { id: `v${n}`, number: n, title: `題${n}`, content: content(n), record: rec }
}

const outline: Outline = {
  chapters: [1, 2, 3, 4, 5, 6].map((n) => ({
    chapter_number: n,
    title: `題${n}`,
    summary: `第${n}章の章立ての概要`,
    characters: []
  }))
}

const style: StyleParams = { pov: '三人称多元視点', tone: '一般文芸' }

function source(chapters: ContextChapter[], chapterNumber = 5): ContextSource {
  return {
    novel: { title: 't', genre: 'ファンタジー', setting: '港町', num_chapters: 6, outline_summary_chars: 200 },
    outline,
    chapterNumber,
    targetChars: 2000,
    style,
    cast: [],
    relations: [],
    chapters
  }
}

const huge = { budgetTokens: 10_000_000, tokensPerChar: 1 }

// 既出の章を 1 つも入れず、確定事項は入れたプロンプトの文字数 (planChapterContext の reservedChars と同じ計算)。
function reservedChars(src: ContextSource): number {
  const prior = src.chapters.filter((c) => c.number < src.chapterNumber)
  const skeleton = buildChapterPrompt({
    novel: src.novel,
    outline: src.outline,
    chapterNumber: src.chapterNumber,
    targetChars: src.targetChars,
    style: src.style,
    cast: src.cast,
    relations: src.relations,
    ledgerText: renderLedger(ledgerOf(prior, new Map())),
    priorChapters: []
  })
  return skeleton.system.length + skeleton.user.length
}

const sixChapters = [1, 2, 3, 4, 5, 6].map((n) => chapter(n))

describe('planChapterContext', () => {
  test('within the budget every earlier chapter is sent in full', () => {
    const plan = planChapterContext(source(sixChapters), huge)
    expect(plan.full).toEqual([1, 2, 3, 4])
    expect(plan.recorded).toEqual([])
    expect(plan.missing).toEqual([])
    for (const n of [1, 2, 3, 4]) expect(plan.prompt.user).toContain(marker(n))
  })

  test('chapters from the current one on are not included', () => {
    const plan = planChapterContext(source(sixChapters), huge)
    expect(plan.prompt.user).not.toContain(marker(5))
    expect(plan.prompt.user).not.toContain(marker(6))
    // 今回の章の古い版の記録も、後の章の記録も確定事項に入れない
    expect(plan.prompt.user).not.toContain('第5章の記録の要約')
    expect(plan.prompt.user).not.toContain('第6章の記録の要約')
    expect(plan.ledger.flow.map((entry) => entry.chapter)).toEqual([1, 2, 3, 4])
  })

  test('the ledger is included, even for chapters sent in full', () => {
    const plan = planChapterContext(source(sixChapters), huge)
    expect(plan.prompt.user).toContain('【確定事項】')
    expect(plan.prompt.user).toContain('第1章の記録の要約')
    expect(plan.prompt.user).toContain('第4章の記録の要約')
  })

  test('over the budget the oldest chapters become records first', () => {
    const src = source(sixChapters)
    // 第 1 章だけを記録に置き換えればちょうど収まる予算
    const budgetTokens = reservedChars(src) + 3 * SIZE + RECORDED_CHAPTER_CHARS
    const plan = planChapterContext(src, { budgetTokens, tokensPerChar: 1 })
    expect(plan.recorded).toEqual([1])
    expect(plan.full).toEqual([2, 3, 4])
    expect(plan.prompt.user).not.toContain(marker(1))
    expect(plan.prompt.user).toContain('本文は省略')
    expect(plan.prompt.user).toContain(marker(2))
    // 1 字でも足りなければ第 2 章も記録になる
    const tighter = planChapterContext(src, { budgetTokens: budgetTokens - 1, tokensPerChar: 1 })
    expect(tighter.recorded).toEqual([1, 2])
  })

  test('the two most recent chapters stay in full however small the budget', () => {
    const plan = planChapterContext(source(sixChapters), { budgetTokens: 1, tokensPerChar: 1 })
    expect(plan.recorded).toEqual([1, 2])
    expect(plan.full).toEqual([3, 4])
    expect(plan.prompt.user).toContain(marker(3))
    expect(plan.prompt.user).toContain(marker(4))
  })

  test('the tokens-per-char factor is applied', () => {
    const src = source(sixChapters)
    const budgetTokens = reservedChars(src) + 4 * SIZE
    expect(planChapterContext(src, { budgetTokens, tokensPerChar: 1 }).recorded).toEqual([])
    // 同じ予算でも 1 字あたりのトークンが多ければ収まらない
    expect(planChapterContext(src, { budgetTokens, tokensPerChar: 1.5 }).recorded.length).toBeGreaterThan(0)
  })

  test('a recorded chapter without a record is listed as missing; a full one is not', () => {
    const chapters = [chapter(1, null), chapter(2, null), chapter(3, null), chapter(4, null)]
    const plan = planChapterContext(source(chapters), { budgetTokens: 1, tokensPerChar: 1 })
    expect(plan.recorded).toEqual([1, 2])
    expect(plan.missing).toEqual([1, 2])
    // 記録が 1 つも無ければ確定事項は出さない
    expect(plan.prompt.user).not.toContain('【確定事項】')
    const inBudget = planChapterContext(source(chapters), huge)
    expect(inBudget.missing).toEqual([])
  })

  test('extra records fill the ledger and clear missing', () => {
    const chapters = [chapter(1, null), chapter(2), chapter(3), chapter(4)]
    const extra = new Map([[1, record(1, { summary: 'その場で作った第1章の記録' })]])
    const plan = planChapterContext(source(chapters), { budgetTokens: 1, tokensPerChar: 1 }, extra)
    expect(plan.missing).toEqual([])
    expect(plan.prompt.user).toContain('その場で作った第1章の記録')
  })

  test('the storage prompt keeps headings but not the chapter text', () => {
    const plan = planChapterContext(source(sixChapters), { budgetTokens: 1, tokensPerChar: 1 })
    expect(plan.storagePrompt).toContain('===== system =====')
    expect(plan.storagePrompt).toContain('【確定事項】')
    for (const n of [1, 2, 3, 4]) expect(plan.storagePrompt).not.toContain(marker(n))
    expect(plan.storagePrompt.length).toBeLessThan(plan.prompt.system.length + plan.prompt.user.length)
  })

  test('the first chapter has no earlier chapters', () => {
    const plan = planChapterContext(source(sixChapters, 1), huge)
    expect(plan.full).toEqual([])
    expect(plan.recorded).toEqual([])
    expect(plan.prompt.user).not.toContain('【確定事項】')
  })

  test('throws when the outline has no entry for the chapter', () => {
    expect(() => planChapterContext(source(sixChapters, 7), huge)).toThrow()
  })
})

describe('resolveChapterContext', () => {
  const thread: StoryThread = { id: 'c1-1', description: '灯台の鍵の行方' }
  const nullChapters = [1, 2, 3, 4].map((n) => chapter(n, null))
  const tiny = { budgetTokens: 1, tokensPerChar: 1 }

  test('extracts missing records oldest first and falls back to the outline summary', async () => {
    const seen: Array<{ number: number; openThreads: StoryThread[] }> = []
    let progress = 0
    const result = await resolveChapterContext(
      source(nullChapters),
      tiny,
      async (target, openThreads) => {
        seen.push({ number: target.number, openThreads })
        return target.number === 1 ? record(1, { summary: '抽出した第1章', threads_opened: [thread] }) : null
      },
      () => {
        progress += 1
      }
    )
    expect(seen.map((entry) => entry.number)).toEqual([1, 2])
    // 第 2 章の抽出には、第 1 章で張られた未回収の伏線が渡る
    expect(seen[0].openThreads).toEqual([])
    expect(seen[1].openThreads).toEqual([thread])
    expect(result.extracted).toEqual([1])
    expect(result.provisional).toEqual([2])
    expect(progress).toBe(4)
    expect(result.plan.missing).toEqual([])
    expect(result.plan.prompt.user).toContain('抽出した第1章')
    // 抽出できなかった章は章立ての概要で代用する
    expect(result.plan.prompt.user).toContain('第2章の章立ての概要')
    expect(result.plan.ledger.openThreads.map((t) => t.id)).toEqual(['c1-1'])
  })

  test('a throwing extractor counts as a failure', async () => {
    const result = await resolveChapterContext(source(nullChapters), tiny, async () => {
      throw new Error('boom')
    })
    expect(result.extracted).toEqual([])
    expect(result.provisional).toEqual([1, 2])
  })

  test('chapters with no outline summary are tried once and then left out', async () => {
    const noSummary: Outline = { chapters: outline.chapters.map((c) => ({ ...c, summary: '' })) }
    let calls = 0
    const result = await resolveChapterContext({ ...source(nullChapters), outline: noSummary }, tiny, async () => {
      calls += 1
      return null
    })
    expect(calls).toBe(2)
    expect(result.provisional).toEqual([])
    expect(result.plan.missing).toEqual([1, 2])
  })

  test('nothing is extracted while everything fits', async () => {
    let calls = 0
    const result = await resolveChapterContext(source(nullChapters), huge, async () => {
      calls += 1
      return null
    })
    expect(calls).toBe(0)
    expect(result.plan.full).toEqual([1, 2, 3, 4])
  })

  test('stored records are never re-extracted', async () => {
    let calls = 0
    const result = await resolveChapterContext(source(sixChapters), tiny, async () => {
      calls += 1
      return null
    })
    expect(calls).toBe(0)
    expect(result.plan.recorded).toEqual([1, 2])
  })
})

describe('helpers', () => {
  test('provisionalRecord uses the outline summary as is', () => {
    expect(provisionalRecord(outline, 2)).toEqual({
      summary: '第2章の章立ての概要',
      facts: [],
      characters: [],
      threads_opened: [],
      threads_resolved: [],
      end_state: { time: '', place: '', present: [] }
    })
    expect(provisionalRecord(outline, 9)).toBeNull()
  })

  const cast: CastMember[] = ['酒寄彩葉', '月見ヤチヨ'].map((name) => ({
    name,
    role: '',
    gender: '',
    age: '',
    occupation: '',
    appearance: '',
    first_person: '私',
    address_others: '',
    speech_examples: [],
    description: ''
  }))
  const vc = { name: '酒寄彩葉', first_person: '私' }

  test('the narrator is passed only for first person', () => {
    expect(recordNarrator({ pov: '一人称', tone: '', viewpointChar: vc }, cast)).toBe('酒寄彩葉')
    expect(recordNarrator({ pov: '三人称一元視点', tone: '', viewpointChar: vc }, cast)).toBeUndefined()
    expect(recordNarrator({ pov: '一人称', tone: '' }, cast)).toBeUndefined()
  })

  test('recordMaterials takes open threads from the ledger', () => {
    const ledger = ledgerOf([chapter(1, record(1, { threads_opened: [{ id: 'c1-1', description: '鍵' }] }))], new Map())
    expect(recordMaterials(cast, { pov: '一人称', tone: '', viewpointChar: vc }, ledger)).toEqual({
      castNames: ['酒寄彩葉', '月見ヤチヨ'],
      narrator: '酒寄彩葉',
      openThreads: [{ id: 'c1-1', description: '鍵' }],
      plannedSetups: []
    })
  })

  test('contextBudget follows the writer model', () => {
    expect(contextBudget('gemini-2.5-flash', null)).toEqual({ budgetTokens: 120_000, tokensPerChar: 0.65 })
    expect(contextBudget(undefined, null)).toEqual({ budgetTokens: 120_000, tokensPerChar: 0.65 })
    expect(contextBudget('openai:some-model', 100_000)).toEqual({ budgetTokens: 50_000, tokensPerChar: 1 })
    expect(contextBudget('openai:some-model', null)).toEqual({ budgetTokens: 120_000, tokensPerChar: 1 })
  })

  test('outlineHasChapter', () => {
    const raw = JSON.stringify(outline)
    expect(outlineHasChapter(raw, 3)).toBe(true)
    expect(outlineHasChapter(raw, 7)).toBe(false)
    expect(outlineHasChapter(null, 1)).toBe(false)
    expect(outlineHasChapter('', 1)).toBe(false)
    expect(outlineHasChapter('{broken', 1)).toBe(false)
  })
})

describe('resume', () => {
  test('resumePoint resumes only when the chapter was saved', () => {
    expect(resumePoint({ chapterId: null, chapterTitle: null })).toBeNull()
    expect(resumePoint({ chapterId: 'v9', chapterTitle: '港の灯' })).toEqual({ chapterId: 'v9', title: '港の灯' })
    expect(resumePoint({ chapterId: 'v9', chapterTitle: null })).toEqual({ chapterId: 'v9', title: '' })
  })

  test('restartState keeps a saved chapter and its text', () => {
    const saved = { buffer: '本文', chapterId: 'v9', chapterTitle: '港の灯' }
    expect(restartState(saved)).toEqual(saved)
  })

  test('restartState drops unsaved partial text', () => {
    expect(restartState({ buffer: '途中まで', chapterId: null, chapterTitle: null })).toEqual({
      buffer: '',
      chapterId: null,
      chapterTitle: null
    })
  })

  test('recordStageAction', () => {
    expect(recordStageAction(null)).toBe('missing')
    expect(recordStageAction({ record: null })).toBe('extract')
    expect(recordStageAction({ record: record(1) })).toBe('skip')
  })
})
