import { describe, expect, test } from 'bun:test'
import type { PrismaClient } from '@/generated/prisma/client'
import type { Env } from '@/lib/db'
import {
  buildChapterContext,
  checkGenerationTargets,
  generationBlock,
  runningJobPending,
  type ContextChapter,
  type ContextSource,
  contextBlocker,
  decideGenerationStart,
  prepareGenerationStart,
  contextBudget,
  extractAndSaveRecord,
  ledgerMaxChars,
  ledgerOf,
  lineageOf,
  missingChaptersDetail,
  nextChapterOf,
  nextOpening,
  planChapterContext,
  provisionalRecord,
  recordMaterials,
  recordNarrator,
  recordStageAction,
  resolveChapterContext,
  isReviewRunning,
  restartState,
  resumePoint,
  reviewAlarmAction,
  reviewAndSave,
  reviewInputsOf,
  reviewOwnsState,
  revisionBaseOf,
  revisionInstruction,
  setupsOf
} from '@/lib/novel/chapter-context'
import type { JsonCaller } from '@/lib/novel/assist'
import { LEDGER_MAX_CHARS, renderLedger } from '@/lib/novel/ledger'
import { validateAdultCast } from '@/lib/novel/bible'
import { RECORDED_CHAPTER_CHARS } from '@/lib/novel/memory'
import { outlineEntryHash } from '@/lib/novel/staleness'
import { buildChapterPrompt, type CastMember, type StyleParams } from '@/lib/novel/prompts'
import type { Outline } from '@/schemas/novel.dto'
import type { ChapterRecord, StoryBible, StoryThread } from '@/schemas/story.dto'

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
  return { id: `v${n}`, number: n, title: `題${n}`, content: content(n), record: rec, outlineHash: null }
}

const outline: Outline = {
  chapters: [1, 2, 3, 4, 5, 6].map((n) => ({
    chapter_number: n,
    title: `題${n}`,
    summary: `第${n}章の章立ての概要`,
    characters: [],
    events: [],
    time_place: '',
    end_state: '',
    setups: [{ id: `s${n}`, description: `第${n}章で張る伏線` }],
    payoffs: []
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
    bible: null,
    bibleUnreadable: false,
    revision: null,
    jobPending: [],
    writingNotes: '',
    chapters
  }
}

const huge = { budgetTokens: 10_000_000, tokensPerChar: 1 }

// 既出の章を 1 つも入れず、確定事項は入れたプロンプトの文字数 (planChapterContext の reservedChars と同じ計算)。
// 確定事項の上限は予算で変わるが、ここで使う予算 (budgetTokens が数万字以上) では、テストの確定事項は上限より小さい。
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
    ledgerText: renderLedger(ledgerOf(prior, new Map()), { previousChapter: src.chapterNumber - 1 }),
    bible: src.bible,
    writingNotes: src.writingNotes,
    nextChapter: nextChapterOf(src),
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
    // 次の章は冒頭 (500 字) だけが【次の章の冒頭】に入り、全文は入らない
    expect(plan.prompt.user).not.toContain(content(6))
    expect(plan.prompt.user).toContain(nextOpening(content(6)))
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
    const seen: Array<{ number: number; openThreads: StoryThread[]; plannedSetups: StoryThread[] }> = []
    let progress = 0
    const result = await resolveChapterContext(
      source(nullChapters),
      tiny,
      async (target, threads) => {
        seen.push({ number: target.number, ...threads })
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
    // 張る予定の伏線は、抽出する章の章立てから
    expect(seen[0].plannedSetups).toEqual([{ id: 's1', description: '第1章で張る伏線' }])
    expect(seen[1].plannedSetups).toEqual([{ id: 's2', description: '第2章で張る伏線' }])
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
    const planned = [{ id: 's3', description: '鍵の持ち主' }]
    expect(recordMaterials(cast, { pov: '一人称', tone: '', viewpointChar: vc }, ledger, planned)).toEqual({
      castNames: ['酒寄彩葉', '月見ヤチヨ'],
      narrator: '酒寄彩葉',
      openThreads: [{ id: 'c1-1', description: '鍵' }],
      plannedSetups: planned
    })
  })

  test('contextBudget follows the writer model', () => {
    expect(contextBudget('gemini-2.5-flash', null)).toEqual({ budgetTokens: 120_000, tokensPerChar: 0.65 })
    expect(contextBudget(undefined, null)).toEqual({ budgetTokens: 120_000, tokensPerChar: 0.65 })
    expect(contextBudget('openai:some-model', 100_000)).toEqual({ budgetTokens: 50_000, tokensPerChar: 1 })
    expect(contextBudget('openai:some-model', null)).toEqual({ budgetTokens: 120_000, tokensPerChar: 1 })
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

describe('bible, writing notes and planned setups (Phase 3)', () => {
  function castMember(name: string): CastMember {
    return {
      name,
      role: '',
      gender: '',
      age: '17',
      occupation: '星見台高校の二年生',
      appearance: 'セーラー服',
      first_person: '私',
      address_others: '',
      speech_examples: [],
      description: '星見台高校に通う'
    }
  }
  const adultCast = [castMember('酒寄彩葉'), castMember('月見ヤチヨ')]
  const adultStyle: StyleParams = {
    pov: '一人称',
    tone: '一般文芸',
    age_rating: 'R18',
    viewpointChar: { name: '酒寄彩葉', first_person: '私' }
  }
  const bible: StoryBible = {
    premise: '灯台の鍵を探す物語の核',
    ending: '',
    arcs: [],
    world: { rules: [], terms: [] },
    timeline: [],
    addresses: [],
    cast: [
      { name: '酒寄彩葉', age: '20', occupation: '大学二年生', appearance: '短い髪', background: '港町の大学に通う' },
      { name: '月見ヤチヨ', age: '22', occupation: '船乗り', appearance: '日に焼けた肌', background: '灯台守の娘' }
    ]
  }

  test('the bible and the writing notes reach the chapter prompt', () => {
    const src = { ...source(sixChapters), bible, writingNotes: '擬音語は使わない' }
    const plan = planChapterContext(src, huge)
    expect(plan.prompt.user).toContain('灯台の鍵を探す物語の核')
    expect(plan.prompt.user).toContain('擬音語は使わない')
    expect(plan.storagePrompt).toContain('擬音語は使わない')
  })

  test('an adult novel sends the bible cast, not the dictionary text', () => {
    const src = { ...source(sixChapters), style: adultStyle, cast: adultCast, bible }
    const plan = planChapterContext(src, huge)
    const sent = `${plan.prompt.system}\n${plan.prompt.user}`
    expect(sent).not.toContain('星見台')
    expect(sent).not.toContain('セーラー服')
    expect(sent).toContain('大学二年生')
  })

  test('contextBlocker stops a broken adult bible and lets the rest through', () => {
    const adult = { style: adultStyle, cast: adultCast }
    expect(contextBlocker({ ...adult, bible })).toBeNull()
    // 作品設計が無い旧データは止めない
    expect(contextBlocker({ ...adult, bible: null })).toBeNull()
    const broken = { ...bible, cast: [{ ...bible.cast[0], age: '17' }, bible.cast[1]] }
    const message = contextBlocker({ ...adult, bible: broken })
    const issues = validateAdultCast('R18', broken.cast, ['酒寄彩葉', '月見ヤチヨ'])
    expect(issues).toHaveLength(1)
    expect(message).toContain(issues[0])
    expect(message).toContain('作品設計を作り直す')
    // 全年齢では人物設定を問わない
    expect(contextBlocker({ ...adult, style: { ...adultStyle, age_rating: '全年齢' }, bible: broken })).toBeNull()
  })

  test('the current chapter gets its planned setups for the record', async () => {
    const result = await resolveChapterContext(source(sixChapters), huge, async () => null)
    expect(result.record.plannedSetups).toEqual([{ id: 's5', description: '第5章で張る伏線' }])
    expect(setupsOf(outline, 9)).toEqual([])
  })
})

describe('ledger size and the previous chapter (review fixes)', () => {
  test('ledgerMaxChars is a quarter of the budget, capped at the default', () => {
    expect(ledgerMaxChars({ budgetTokens: 120_000, tokensPerChar: 0.65 })).toBe(LEDGER_MAX_CHARS)
    expect(ledgerMaxChars({ budgetTokens: 120_000, tokensPerChar: 1 })).toBe(30_000)
    expect(ledgerMaxChars({ budgetTokens: 8_000, tokensPerChar: 1 })).toBe(2_000)
    expect(ledgerMaxChars(contextBudget('openai:small', 16_000))).toBe(2_000)
  })

  // 人物の「したこと」が長い記録。予算が小さいと古い章から省かれる。
  function actionRecord(n: number): ChapterRecord {
    return record(n, {
      characters: [{ name: '酒寄彩葉', actions: [`第${n}章の行動の目印${'い'.repeat(400)}`], learned: [], state: '' }]
    })
  }
  const withActions = [1, 2, 3, 4].map((n) => chapter(n, actionRecord(n)))

  test('a small budget shrinks the ledger by dropping the oldest actions', () => {
    const large = planChapterContext(source(withActions), huge)
    expect(large.prompt.user).toContain('第1章の行動の目印')
    // 予算 4,000 トークン → 確定事項は 1,000 字まで
    const small = planChapterContext(source(withActions), { budgetTokens: 4_000, tokensPerChar: 1 })
    expect(small.prompt.user).not.toContain('第1章の行動の目印')
    // 流れ (要約) は削らない
    expect(small.prompt.user).toContain('第1章の記録の要約')
  })

  test('the end of an older chapter is not shown as the previous chapter', () => {
    const ended = (n: number) => record(n, { end_state: { time: `第${n}章の夜`, place: '港', present: [] } })
    // 第 4 章の記録が無い (抽出に失敗した) と、第 3 章の章末を「直前の章の終わり」として出さない
    const gap = [chapter(1), chapter(2), chapter(3, ended(3)), chapter(4, null)]
    expect(planChapterContext(source(gap), huge).prompt.user).not.toContain('第3章の夜')
    const full = [chapter(1), chapter(2), chapter(3), chapter(4, ended(4))]
    expect(planChapterContext(source(full), huge).prompt.user).toContain('第4章の夜')
  })
})

// ---------------------- D1 に触れる関数 (偽の prisma) ----------------------

// Gemini のモデルのコストは env を読まない。読んだら失敗する偽物で、ネットワークに行かないことを確かめる。
const untouchedEnv: Env = new Proxy(Object.create(null), {
  get(_target, key) {
    throw new Error(`env.${String(key)} should not be read`)
  }
})

describe('extractAndSaveRecord', () => {
  const target = { novelId: 'n1', chapterId: 'v3', chapterNumber: 3, title: '題', content: '　本文がある。' }
  const materials = { castNames: [], openThreads: [], plannedSetups: [] }
  const usage = (n: number) => ({ model: 'gemini-2.5-flash', promptTokens: n, outputTokens: n, totalTokens: 2 * n })
  const draft = JSON.stringify({ summary: '要約', facts: [], characters: [], new_threads: [], end_state: {} })

  function fake(options: { failUpdate?: boolean } = {}) {
    const costs: unknown[] = []
    const updates: unknown[] = []
    const prisma: PrismaClient = Object.assign(Object.create(null), {
      chapterGenerationCost: {
        create: async (args: unknown) => {
          costs.push(args)
        }
      },
      chapter: {
        update: async (args: unknown) => {
          if (options.failUpdate === true) throw new Error('Record to update not found')
          updates.push(args)
        }
      }
    })
    return { prisma, costs, updates }
  }

  function caller(replies: Array<{ text: string; usage: ReturnType<typeof usage> }>): JsonCaller {
    const queue = [...replies]
    return async () => {
      const next = queue.shift()
      if (next === undefined) throw new Error('unexpected extra call')
      return next
    }
  }

  test('a failed extraction still records the cost of every answered call', async () => {
    const fx = fake()
    const call = caller([
      { text: 'not json', usage: usage(1) },
      { text: 'still not json', usage: usage(2) }
    ])
    const result = await extractAndSaveRecord(fx.prisma, untouchedEnv, call, target, materials)
    expect(result.ok).toBe(false)
    expect(fx.costs).toHaveLength(2)
    expect(fx.costs[0]).toMatchObject({ data: { novel_id: 'n1', chapter_number: 3, kind: 'record', prompt_tokens: 1 } })
    expect(fx.updates).toEqual([])
  })

  test('a successful extraction is saved on the version', async () => {
    const fx = fake()
    const result = await extractAndSaveRecord(fx.prisma, untouchedEnv, caller([{ text: draft, usage: usage(1) }]), target, materials)
    expect(result.ok).toBe(true)
    expect(fx.updates).toHaveLength(1)
    expect(fx.updates[0]).toMatchObject({ where: { id: 'v3' } })
  })

  test('a failed save still returns the record', async () => {
    const fx = fake({ failUpdate: true })
    const result = await extractAndSaveRecord(fx.prisma, untouchedEnv, caller([{ text: draft, usage: usage(1) }]), target, materials)
    if (!result.ok) throw new Error(result.error)
    expect(result.record.summary).toBe('要約')
    expect(fx.costs).toHaveLength(1)
  })
})

describe('buildChapterContext errors and prepareGenerationStart', () => {
  const storedOutline = JSON.stringify(outline)

  // getNovelWithChapters が読むだけの偽物 (章は無い)。novel が null なら小説が無い。
  function novelPrisma(novel: Record<string, unknown> | null): PrismaClient {
    return Object.assign(Object.create(null), {
      novel: {
        findUnique: async () =>
          novel === null
            ? null
            : {
                id: 'n1',
                title: 't',
                genre: 'g',
                setting: 's',
                num_chapters: 6,
                target_chars: 2000,
                outline_summary_chars: 200,
                pov: '一人称',
                tone: '一般文芸',
                age_rating: '全年齢',
                pov_character_id: '',
                ending: '未指定',
                notes: '',
                writing_notes: null,
                editor_model: 'gemini-2.5-flash',
                bible: null,
                chapters: [],
                character_links: [],
                relations: [],
                generation_costs: [],
                generation_job: null,
                category: null,
                ...novel
              }
      }
    })
  }
  const payload = { novelId: 'n1', chapterNumber: 3, model: 'gemini-2.5-flash' }

  test('a missing novel, outline or chapter fails with a reason', async () => {
    expect(await buildChapterContext(novelPrisma(null), untouchedEnv, payload)).toEqual({
      ok: false,
      error: '小説が見つかりません'
    })
    const noOutline = await buildChapterContext(novelPrisma({ outline: null }), untouchedEnv, payload)
    expect(noOutline.ok).toBe(false)
    const broken = await buildChapterContext(novelPrisma({ outline: '{oops' }), untouchedEnv, payload)
    expect(broken.ok).toBe(false)
    const missing = await buildChapterContext(novelPrisma({ outline: storedOutline }), untouchedEnv, {
      ...payload,
      chapterNumber: 9
    })
    expect(missing).toEqual({ ok: false, error: '章立てに第 9 章がありません' })
  })

  test('a broken adult bible stops before any extraction or model lookup', async () => {
    const bible = {
      premise: '',
      ending: '',
      arcs: [],
      world: { rules: [], terms: [] },
      timeline: [],
      addresses: [],
      cast: [],
      source_hash: ''
    }
    // 名簿に 1 人いて、作品設計にその人の成人としての設定が無い
    const link = {
      character_id: 'c1',
      role: '主人公',
      variant_id: null,
      character: {
        name: '酒寄彩葉',
        gender: '',
        age: '17',
        occupation: '高校生',
        appearance: '',
        first_person: '私',
        address_others: '',
        speech_examples: '[]',
        description: '',
        variants: []
      }
    }
    const result = await buildChapterContext(
      novelPrisma({ outline: storedOutline, age_rating: 'R18', bible: JSON.stringify(bible), character_links: [link] }),
      untouchedEnv,
      payload
    )
    if (result.ok) throw new Error('expected failure')
    const issues = validateAdultCast('R18', [], ['酒寄彩葉'])
    expect(issues).toHaveLength(1)
    expect(result.error).toContain(issues[0])
    expect(result.error).toContain('作品設計を作り直す')
    // 作品設計が無い旧データは止めない
    const legacy = await buildChapterContext(
      novelPrisma({ outline: storedOutline, age_rating: 'R18', character_links: [link] }),
      untouchedEnv,
      payload
    )
    expect(legacy.ok).toBe(true)
  })

  test('prepareGenerationStart: 404 without the novel or the first chapter in the outline', async () => {
    const model = 'gemini-2.5-flash'
    expect(await prepareGenerationStart(novelPrisma(null), 'n1', [1], model)).toEqual({
      ok: false,
      status: 404,
      error: 'not_found'
    })
    for (const raw of [null, '{oops']) {
      expect((await prepareGenerationStart(novelPrisma({ outline: raw }), 'n1', [1], model)).ok).toBe(false)
    }
    const missing = await prepareGenerationStart(novelPrisma({ outline: storedOutline }), 'n1', [9], model)
    expect(missing).toEqual({ ok: false, status: 404, error: 'not_found' })
    expect(await prepareGenerationStart(novelPrisma({ outline: storedOutline }), 'n1', [1], model)).toEqual({
      ok: true,
      payload: { novelId: 'n1', chapterNumber: 1, model },
      targets: [1]
    })
  })

  test('prepareGenerationStart: 409 when an earlier chapter has no text', async () => {
    const start = await prepareGenerationStart(novelPrisma({ outline: storedOutline }), 'n1', [3], 'gemini-2.5-flash')
    expect(start).toEqual({ ok: false, status: 409, error: 'previous_chapters_missing', detail: '第 1、2 章' })
  })

  test('prepareGenerationStart: 400 for an adult novel whose bible fails, before anything starts', async () => {
    const bible = { premise: '', ending: '', arcs: [], world: { rules: [], terms: [] }, timeline: [], addresses: [], cast: [] }
    const link = {
      character_id: 'c1',
      role: '主人公',
      variant_id: null,
      character: {
        name: '酒寄彩葉',
        gender: '',
        age: '20',
        occupation: '',
        appearance: '',
        first_person: '私',
        address_others: '',
        speech_examples: '[]',
        description: '',
        variants: []
      }
    }
    const adult = { outline: storedOutline, age_rating: 'R18', character_links: [link] }
    const broken = await prepareGenerationStart(
      novelPrisma({ ...adult, bible: JSON.stringify(bible) }),
      'n1',
      [1],
      'gemini-2.5-flash'
    )
    if (broken.ok || broken.status !== 400) throw new Error('expected invalid_bible')
    expect(broken.error).toBe('invalid_bible')
    expect(broken.detail).toContain('作品設計を作り直す')
    const unreadable = await prepareGenerationStart(novelPrisma({ ...adult, bible: '{oops' }), 'n1', [1], 'gemini-2.5-flash')
    expect(unreadable).toMatchObject({ ok: false, status: 400, error: 'invalid_bible' })
  })
})

// ---------------------- 下流の追従 (Phase 4) ----------------------

describe('nextOpening', () => {
  test('a short chapter is passed whole, without blank lines around it', () => {
    expect(nextOpening('\n\n　始まり。\n　続き。\n\n')).toBe('　始まり。\n　続き。')
  })

  test('cuts at the last line break within the limit', () => {
    const text = ['あ'.repeat(4), 'い'.repeat(4), 'う'.repeat(4)].join('\n')
    // 上限 12 字: 「ああああ\nいいいい\nう」の途中で切らず、2 行目の終わりまで
    expect(nextOpening(text, 12)).toBe('ああああ\nいいいい')
  })

  test('a line ending exactly at the limit is kept', () => {
    const text = `${'あ'.repeat(5)}\n${'い'.repeat(5)}`
    expect(nextOpening(text, 5)).toBe('あああああ')
  })

  test('without a line break, cuts at the limit', () => {
    expect(nextOpening('あ'.repeat(600))).toBe('あ'.repeat(500))
  })

  test('counts code points and never splits a surrogate pair', () => {
    const text = '𠮷'.repeat(10)
    expect(nextOpening(text, 3)).toBe('𠮷𠮷𠮷')
  })
})

describe('nextChapterOf and lineageOf', () => {
  test('the next chapter text and its outline entry are passed when the next chapter exists', () => {
    const next = nextChapterOf(source(sixChapters, 3))
    expect(next).toEqual({
      opening: nextOpening(content(4)),
      title: '題4',
      summary: '第4章の章立ての概要'
    })
  })

  test('a next chapter written from a different outline entry is not passed', () => {
    const current = outlineEntryHash(outline.chapters[3])
    const withHash = (hash: string | null) => [...[1, 2, 3].map((n) => chapter(n)), { ...chapter(4), outlineHash: hash }]
    // 章立てを作り直した後の古い第 4 章
    expect(nextChapterOf(source(withHash('前の章立てのハッシュ'), 3))).toBeNull()
    // 今の章立てから書かれた第 4 章と、判定できない第 4 章 (null) は渡す
    expect(nextChapterOf(source(withHash(current), 3))?.title).toBe('題4')
    expect(nextChapterOf(source(withHash(null), 3))?.title).toBe('題4')
  })

  test('no next chapter text means no next chapter', () => {
    expect(nextChapterOf(source([1, 2, 3].map((n) => chapter(n)), 3))).toBeNull()
    const blank = { ...chapter(4), content: '\n  \n' }
    expect(nextChapterOf(source([...[1, 2, 3].map((n) => chapter(n)), blank], 3))).toBeNull()
  })

  test('the opening of the next chapter reaches the prompt', () => {
    const plan = planChapterContext(source(sixChapters, 3), huge)
    expect(plan.prompt.user).toContain(marker(4))
  })

  test('lineage records the outline entry hash and the previous version id', () => {
    expect(lineageOf(source(sixChapters, 3))).toEqual({
      outlineHash: outlineEntryHash(outline.chapters[2]),
      prevChapterId: 'v2'
    })
    expect(lineageOf(source(sixChapters, 1)).prevChapterId).toBeNull()
    // 直前の章の本文が無ければ null
    expect(lineageOf(source([chapter(1)], 3)).prevChapterId).toBeNull()
    expect(planChapterContext(source(sixChapters, 3), huge).lineage).toEqual(lineageOf(source(sixChapters, 3)))
  })
})

describe('generation start checks', () => {
  test('targets are sorted and deduplicated', () => {
    expect(checkGenerationTargets([3, 1, 2, 3], new Set())).toEqual({ ok: true, targets: [1, 2, 3] })
  })

  test('a missing earlier chapter blocks the start', () => {
    expect(checkGenerationTargets([4], new Set([1]))).toEqual({ ok: false, missing: [2, 3] })
    // 同じ生成で先に書かれる章は欠けていない
    expect(checkGenerationTargets([2, 4, 3], new Set([1]))).toEqual({ ok: true, targets: [2, 3, 4] })
    // 書き直し (前の章はある) は通る
    expect(checkGenerationTargets([2], new Set([1, 2, 3]))).toEqual({ ok: true, targets: [2] })
    expect(checkGenerationTargets([1], new Set())).toEqual({ ok: true, targets: [1] })
  })

  test('the 409 detail lists the chapters', () => {
    expect(missingChaptersDetail([2, 3])).toBe('第 2、3 章')
    expect(missingChaptersDetail([5])).toBe('第 5 章')
  })
})

describe('decideGenerationStart', () => {
  const ready = { outline, written: new Set([1, 2]), blocker: null, baseVersionError: null }

  test('targets are sorted and deduplicated, and the first one is started', () => {
    expect(decideGenerationStart(ready, 'n1', [4, 3, 3], 'm')).toEqual({
      ok: true,
      payload: { novelId: 'n1', chapterNumber: 3, model: 'm' },
      targets: [3, 4]
    })
  })

  test('404 comes first, then the bible, then missing chapters', () => {
    expect(decideGenerationStart(null, 'n1', [1], 'm')).toMatchObject({ status: 404 })
    expect(decideGenerationStart({ ...ready, outline: null }, 'n1', [1], 'm')).toMatchObject({ status: 404 })
    expect(decideGenerationStart(ready, 'n1', [9], 'm')).toMatchObject({ status: 404 })
    const blocked = {
      ...ready,
      written: new Set<number>(),
      blocker: { error: 'invalid_bible' as const, detail: '作品設計を作り直してください' }
    }
    expect(decideGenerationStart(blocked, 'n1', [3], 'm')).toEqual({
      ok: false,
      status: 400,
      error: 'invalid_bible',
      detail: '作品設計を作り直してください'
    })
    expect(decideGenerationStart({ ...ready, written: new Set<number>() }, 'n1', [3], 'm')).toEqual({
      ok: false,
      status: 409,
      error: 'previous_chapters_missing',
      detail: '第 1、2 章'
    })
  })
})

// ---------------------- 成人指定の作品設計で止める (Phase 3 レビュー) ----------------------

describe('contextBlocker for adult novels', () => {
  function castMember(name: string): CastMember {
    return {
      name,
      role: '',
      gender: '',
      age: '20',
      occupation: '',
      appearance: '',
      first_person: '私',
      address_others: '',
      speech_examples: [],
      description: ''
    }
  }
  const style: StyleParams = { pov: '三人称多元視点', tone: '一般文芸', age_rating: 'R18' }
  const emptyBible: StoryBible = {
    premise: '',
    ending: '',
    arcs: [],
    world: { rules: [], terms: [] },
    timeline: [],
    addresses: [],
    cast: []
  }
  const adultRow = { name: '酒寄彩葉', age: '20', occupation: '大学生', appearance: '', background: '' }

  test('a bible made while the novel was all-ages (no cast) stops after switching to R18', () => {
    const message = contextBlocker({ style, cast: [castMember('酒寄彩葉')], bible: emptyBible, bibleUnreadable: false })
    expect(message).toContain(validateAdultCast('R18', [], ['酒寄彩葉'])[0])
    expect(message).toContain('作品設計を作り直す')
  })

  test('a character added after the bible was made stops the generation', () => {
    const bible = { ...emptyBible, cast: [adultRow] }
    const cast = [castMember('酒寄彩葉'), castMember('月見ヤチヨ')]
    expect(contextBlocker({ style, cast: [castMember('酒寄彩葉')], bible, bibleUnreadable: false })).toBeNull()
    const message = contextBlocker({ style, cast, bible, bibleUnreadable: false })
    expect(message).toContain(validateAdultCast('R18', [adultRow], ['月見ヤチヨ'])[0])
    expect(message).toContain('作品設計を作り直す')
  })

  test('words for minors in the bible text stop the generation', () => {
    const bible = { ...emptyBible, cast: [adultRow], premise: '女子高生の彩葉が灯台の鍵を探す' }
    const message = contextBlocker({ style, cast: [castMember('酒寄彩葉')], bible, bibleUnreadable: false })
    expect(message).not.toBeNull()
    expect(message).toContain('物語の核')
  })

  test('an unreadable bible stops an adult novel, but not an all-ages one', () => {
    const cast = [castMember('酒寄彩葉')]
    expect(contextBlocker({ style, cast, bible: null, bibleUnreadable: true })).toContain('作品設計を作り直してください')
    expect(
      contextBlocker({ style: { ...style, age_rating: '全年齢' }, cast, bible: null, bibleUnreadable: true })
    ).toBeNull()
    // 未作成 (列が null) は旧データとして止めない
    expect(contextBlocker({ style, cast, bible: null, bibleUnreadable: false })).toBeNull()
  })
})

// ---------------------- 指示つきの書き直し (Phase 5) ----------------------

describe('revision', () => {
  test('a whitespace-only instruction is a normal generation', () => {
    expect(revisionInstruction(undefined)).toBe('')
    expect(revisionInstruction(' \n　')).toBe('')
    expect(revisionInstruction(' 呼び方を直す ')).toBe('呼び方を直す')
  })

  const latest = { ...chapter(3), id: 'v3b' }
  const base = { novelId: 'n1', chapterNumber: 3 }

  test('without a version id, the latest version of the chapter is the base', () => {
    expect(revisionBaseOf({ ...base, baseVersionId: '', latest, row: null })).toEqual({ ok: true, content: content(3) })
    expect(revisionBaseOf({ ...base, baseVersionId: '', latest: undefined, row: null }).ok).toBe(false)
  })

  test('a version id must belong to this novel and this chapter', () => {
    const row = { novel_id: 'n1', chapter_number: 3, content: '元の版の本文' }
    expect(revisionBaseOf({ ...base, baseVersionId: 'v3a', latest, row })).toEqual({ ok: true, content: '元の版の本文' })
    expect(revisionBaseOf({ ...base, baseVersionId: 'v3a', latest, row: { ...row, novel_id: 'other' } }).ok).toBe(false)
    expect(revisionBaseOf({ ...base, baseVersionId: 'v3a', latest, row: { ...row, chapter_number: 2 } }).ok).toBe(false)
    expect(revisionBaseOf({ ...base, baseVersionId: 'v3a', latest, row: null }).ok).toBe(false)
    expect(revisionBaseOf({ ...base, baseVersionId: 'v3a', latest, row: { ...row, content: '  ' } }).ok).toBe(false)
  })

  test('the base text and the instruction reach the chapter prompt', () => {
    const src = { ...source(sixChapters, 3), revision: { baseContent: '元の版の本文の目印', instruction: '呼び方の指示の目印' } }
    const plan = planChapterContext(src, huge)
    expect(plan.prompt.user).toContain('元の版の本文の目印')
    expect(plan.prompt.user).toContain('呼び方の指示の目印')
  })
})

// ---------------------- 検査 (Phase 5) ----------------------

describe('reviewInputsOf', () => {
  function castMember(name: string, examples: string[] = []): CastMember {
    return {
      name,
      role: '',
      gender: '',
      age: '20',
      occupation: '',
      appearance: '',
      first_person: '私',
      address_others: '',
      speech_examples: examples,
      description: ''
    }
  }
  const cast = [castMember('酒寄彩葉', ['いくよ！']), castMember('月見ヤチヨ', ['任せて']), castMember('通行人', ['どいて'])]
  const plannedOutline: Outline = {
    chapters: outline.chapters.map((entry) =>
      entry.chapter_number === 3 ? { ...entry, characters: ['酒寄彩葉', '月見ヤチヨ'] } : entry
    )
  }
  const bible: StoryBible = {
    premise: '',
    ending: '',
    arcs: [],
    world: { rules: [], terms: [] },
    timeline: [],
    addresses: [
      { from: '酒寄彩葉', to: '月見ヤチヨ', call: 'ヤチヨ' },
      { from: '月見ヤチヨ', to: '酒寄彩葉', call: '彩葉' },
      { from: '通行人', to: '酒寄彩葉', call: 'お嬢さん' }
    ],
    cast: []
  }
  const reviewSource = {
    outline: plannedOutline,
    chapterNumber: 3,
    title: '題3',
    content: '　検査する本文。',
    targetChars: 2000,
    style: { pov: '三人称多元視点', tone: '一般文芸', age_rating: '全年齢' },
    cast,
    bible,
    bibleUnreadable: false,
    chapters: sixChapters
  }

  test('the mechanical check gets the planned cast, earlier chapters, calls and the rating', () => {
    const inputs = reviewInputsOf(reviewSource)
    if (inputs === null) throw new Error('inputs expected')
    expect(inputs.check).toEqual({
      chapter: { number: 3, content: '　検査する本文。' },
      targetChars: 2000,
      plannedCharacters: ['酒寄彩葉', '月見ヤチヨ'],
      castNames: ['酒寄彩葉', '月見ヤチヨ', '通行人'],
      callsByName: { 月見ヤチヨ: ['ヤチヨ'], 酒寄彩葉: ['彩葉', 'お嬢さん'] },
      speechExamples: ['いくよ！', '任せて'],
      otherChapters: [
        { number: 1, content: content(1) },
        { number: 2, content: content(2) }
      ],
      ageRating: '全年齢'
    })
  })

  test('the model review gets the present cast, their addresses and the ledger before the chapter', () => {
    const inputs = reviewInputsOf(reviewSource)
    const review = inputs === null ? null : inputs.review
    if (review === null) throw new Error('review expected')
    expect(review.cast.map((member) => member.name)).toEqual(['酒寄彩葉', '月見ヤチヨ'])
    expect(review.addresses).toEqual(bible.addresses.slice(0, 2))
    expect(review.ledgerText).toContain('第2章の記録の要約')
    expect(review.ledgerText).not.toContain('第3章の記録の要約')
    expect(review.ledgerText).not.toContain('第4章の記録の要約')
    expect(review.content).toBe('　検査する本文。')
  })

  test('an adult novel whose bible fails gets only the mechanical check', () => {
    const adult = { ...reviewSource, style: { ...reviewSource.style, age_rating: 'R18' } }
    const inputs = reviewInputsOf(adult)
    expect(inputs?.review).toBeNull()
    expect(inputs?.check.ageRating).toBe('R18')
  })

  test('a chapter missing from the outline has no inputs', () => {
    expect(reviewInputsOf({ ...reviewSource, chapterNumber: 9 })).toBeNull()
  })
})

describe('reviewAlarmAction', () => {
  const pending = { reviewPending: true, reviewRunning: false, reviewAttempts: 1, hasTarget: true }

  test('decides whether to keep the DO alive, retry or give up', () => {
    expect(reviewAlarmAction({ ...pending, reviewPending: false })).toBe('none')
    expect(reviewAlarmAction({ ...pending, reviewRunning: true })).toBe('keep')
    // 走っているはずの検査が失われた (DO が落ちた): 1 回だけやり直す
    expect(reviewAlarmAction(pending)).toBe('retry')
    expect(reviewAlarmAction({ ...pending, reviewAttempts: 2 })).toBe('give_up')
    expect(reviewAlarmAction({ ...pending, hasTarget: false })).toBe('give_up')
  })
})

describe('review generations', () => {
  test('a review is running only when this DO runs it for the current generation', () => {
    expect(isReviewRunning(3, 3)).toBe(true)
    // evict でメモリが消えた
    expect(isReviewRunning(null, 3)).toBe(false)
    // 前の生成の検査がまだ走っている
    expect(isReviewRunning(2, 3)).toBe(false)
  })

  test('a finished review may clear the pending mark only if no new generation started', () => {
    expect(reviewOwnsState(3, 3)).toBe(true)
    expect(reviewOwnsState(3, 4)).toBe(false)
  })
})

describe('reviewAndSave and the revision base (fake prisma)', () => {
  type Row = { id: string; novel_id: string; chapter_number: number; title: string | null; content: string; record: null }

  type Update = { where: { id: string }; data: { review: string } }

  function fake(novel: Record<string, unknown> | null, rows: Row[]) {
    const updates: Update[] = []
    const costs: unknown[] = []
    const prisma: PrismaClient = Object.assign(Object.create(null), {
      chapterGenerationCost: {
        create: async (args: unknown) => {
          costs.push(args)
        }
      },
      novel: {
        findUnique: async () =>
          novel === null
            ? null
            : {
                id: 'n1',
                title: 't',
                genre: 'g',
                setting: 's',
                num_chapters: 6,
                target_chars: 2000,
                outline_summary_chars: 200,
                pov: '三人称多元視点',
                tone: '一般文芸',
                age_rating: '全年齢',
                pov_character_id: '',
                ending: '未指定',
                notes: '',
                writing_notes: null,
                editor_model: 'gemini-2.5-flash',
                bible: null,
                outline: JSON.stringify(outline),
                chapters: [],
                character_links: [],
                relations: [],
                generation_costs: [],
                generation_job: null,
                category: null,
                ...novel
              }
      },
      chapter: {
        findUnique: async (args: { where: { id: string } }) => {
          const found = rows.find((row) => row.id === args.where.id)
          return found === undefined ? null : found
        },
        update: async (args: Update) => {
          updates.push(args)
        }
      }
    })
    return { prisma, updates, costs }
  }
  const row: Row = { id: 'v3', novel_id: 'n1', chapter_number: 3, title: '題3', content: '　本文。', record: null }
  const target = { novelId: 'n1', chapterNumber: 3, chapterId: 'v3' }

  test('a deleted version is skipped without saving', async () => {
    const fx = fake({}, [])
    expect(await reviewAndSave(fx.prisma, untouchedEnv, target)).toBe('skipped')
    expect(fx.updates).toEqual([])
  })

  test('a version of another novel is skipped', async () => {
    const fx = fake({}, [{ ...row, novel_id: 'other' }])
    expect(await reviewAndSave(fx.prisma, untouchedEnv, target)).toBe('skipped')
  })

  test('an adult novel with an unreadable bible saves only the mechanical check, without calling the model', async () => {
    const fx = fake({ age_rating: 'R18', bible: '{oops' }, [{ ...row, content: '　女子高生の彩葉は港へ向かった。' }])
    expect(await reviewAndSave(fx.prisma, untouchedEnv, target)).toBe('saved')
    expect(fx.updates).toHaveLength(1)
    const saved = fx.updates[0]
    expect(saved.where).toEqual({ id: 'v3' })
    const review = JSON.parse(saved.data.review)
    expect(review.reviewed).toBe(false)
    expect(review.issues).toEqual([])
    expect(review.checks.map((check: { kind: string }) => check.kind)).toContain('minor_term')
  })

  const usage = (n: number) => ({ model: 'gemini-2.5-flash', promptTokens: n, outputTokens: n, totalTokens: 2 * n })
  const reviewedRow = { ...row, content: '　彩葉は港の灯台へ向かった。ヤチヨは黙って首を振り、赤い灯台を見上げた。' }

  // replies を順に返す偽の呼び出し (Error は throw)。呼ばれたモデルを記録する。
  function fakeMaker(replies: Array<{ text: string; usage?: ReturnType<typeof usage> } | Error>) {
    const models: string[] = []
    const queue = [...replies]
    const make =
      (model: string): JsonCaller =>
      async () => {
        models.push(model)
        const next = queue.shift()
        if (next === undefined) throw new Error('unexpected extra call')
        if (next instanceof Error) throw next
        return { text: next.text, usage: next.usage }
      }
    return { make, models }
  }

  test('a successful model review saves the issues with reviewed: true and records the cost', async () => {
    const fx = fake({}, [reviewedRow])
    const answer = JSON.stringify({
      issues: [{ quote: 'ヤチヨは黙って首を振り、赤い灯台を見上げた', reason: '灯台は白いはず', kind: 'fact' }]
    })
    const maker = fakeMaker([{ text: answer, usage: usage(1) }])
    expect(await reviewAndSave(fx.prisma, untouchedEnv, target, maker.make)).toBe('saved')
    // editor_model で呼ぶ
    expect(maker.models).toEqual(['gemini-2.5-flash'])
    const review = JSON.parse(fx.updates[0].data.review)
    expect(review.reviewed).toBe(true)
    expect(review.issues).toEqual([
      { kind: 'fact', quote: 'ヤチヨは黙って首を振り、赤い灯台を見上げた', reason: '灯台は白いはず' }
    ])
    expect(fx.costs).toHaveLength(1)
    expect(fx.costs[0]).toMatchObject({ data: { kind: 'review', chapter_number: 3, novel_id: 'n1' } })
  })

  test('a failed model review saves only the mechanical check and still records the cost of every answer', async () => {
    const fx = fake({}, [reviewedRow])
    const maker = fakeMaker([
      { text: 'not json', usage: usage(1) },
      { text: 'still not json', usage: usage(2) }
    ])
    expect(await reviewAndSave(fx.prisma, untouchedEnv, target, maker.make)).toBe('saved')
    const review = JSON.parse(fx.updates[0].data.review)
    expect(review.reviewed).toBe(false)
    expect(review.issues).toEqual([])
    expect(Array.isArray(review.checks)).toBe(true)
    expect(fx.costs).toHaveLength(2)
  })

  test('a throwing model call also saves the mechanical check', async () => {
    const fx = fake({}, [reviewedRow])
    expect(await reviewAndSave(fx.prisma, untouchedEnv, target, fakeMaker([new Error('timeout')]).make)).toBe('saved')
    expect(JSON.parse(fx.updates[0].data.review).reviewed).toBe(false)
    expect(fx.costs).toEqual([])
  })

  test('a revision with a version id from another chapter stops the context', async () => {
    const fx = fake({}, [{ ...row, id: 'v2', chapter_number: 2 }])
    const result = await buildChapterContext(fx.prisma, untouchedEnv, {
      novelId: 'n1',
      chapterNumber: 3,
      model: 'gemini-2.5-flash',
      instruction: '呼び方を直す',
      baseVersionId: 'v2'
    })
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toContain('元の版')
    expect(result.error).not.toContain('呼び方を直す')
  })
})

// ---------------------- レビュー (7fdc2d3) の指摘 ----------------------

describe('instruction fields of adult novels', () => {
  const adult: StyleParams = { pov: '三人称多元視点', tone: '一般文芸', age_rating: 'R18' }
  const base = { style: adult, cast: [], bible: null, bibleUnreadable: false, writingNotes: '', instruction: '' }

  test('words for minors in the writing notes or the instruction stop an adult novel', () => {
    const notes = generationBlock({ ...base, writingNotes: 'ヒロインは女子高生として描写する' })
    expect(notes?.error).toBe('invalid_notes')
    expect(notes?.detail).toContain('執筆上の指示')
    const instruction = generationBlock({ ...base, instruction: 'ヒロインを高校生にして' })
    expect(instruction?.error).toBe('invalid_instruction')
    expect(instruction?.detail).toContain('書き直しの指示')
  })

  test('all-ages novels and clean fields are not stopped', () => {
    const allAges = { ...base, style: { ...adult, age_rating: '全年齢' } }
    expect(generationBlock({ ...allAges, writingNotes: '女子高生', instruction: '高校生' })).toBeNull()
    expect(generationBlock({ ...base, writingNotes: '擬音語は使わない', instruction: '呼び方を直す' })).toBeNull()
  })

  test('the bible is checked first', () => {
    const block = generationBlock({ ...base, bibleUnreadable: true, writingNotes: '女子高生' })
    expect(block?.error).toBe('invalid_bible')
  })

  test('the generation start answers 400 with the field code', () => {
    const ready = {
      outline,
      written: new Set([1, 2]),
      blocker: generationBlock({ ...base, writingNotes: '女子高生' }),
      baseVersionError: null
    }
    expect(decideGenerationStart(ready, 'n1', [3], 'm')).toMatchObject({ ok: false, status: 400, error: 'invalid_notes' })
  })

  test('the DO context stops on the instruction too', async () => {
    const fx = Object.assign(Object.create(null), {
      novel: {
        findUnique: async () => ({
          id: 'n1',
          title: 't',
          genre: 'g',
          setting: 's',
          num_chapters: 6,
          target_chars: 2000,
          outline_summary_chars: 200,
          pov: '三人称多元視点',
          tone: '一般文芸',
          age_rating: 'R18',
          pov_character_id: '',
          ending: '未指定',
          notes: '',
          writing_notes: null,
          editor_model: 'gemini-2.5-flash',
          bible: null,
          outline: JSON.stringify(outline),
          chapters: [],
          character_links: [],
          relations: [],
          generation_costs: [],
          generation_job: null,
          category: null
        })
      },
      chapter: { findUnique: async () => ({ id: 'v1', novel_id: 'n1', chapter_number: 1, title: '題', content: '本文', record: null }) }
    })
    const result = await buildChapterContext(fx, untouchedEnv, {
      novelId: 'n1',
      chapterNumber: 1,
      model: 'gemini-2.5-flash',
      instruction: '中学生として描き直して',
      baseVersionId: 'v1'
    })
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toContain('書き直しの指示')
  })
})

describe('the next chapter of a running batch', () => {
  test('runningJobPending reads only running jobs', () => {
    expect(runningJobPending({ status: 'running', pending: '[3,4,5]' })).toEqual([3, 4, 5])
    expect(runningJobPending({ status: 'stopped', pending: '[3,4,5]' })).toEqual([])
    expect(runningJobPending({ status: 'running', pending: '{oops' })).toEqual([])
    expect(runningJobPending(null)).toEqual([])
  })

  test('a next chapter that the batch will rewrite is not passed; otherwise it is', () => {
    expect(nextChapterOf({ ...source(sixChapters, 3), jobPending: [3, 4, 5] })).toBeNull()
    expect(nextChapterOf({ ...source(sixChapters, 3), jobPending: [3] })?.title).toBe('題4')
    // ジョブが止まっていれば (pending を空として読む) 渡す
    expect(nextChapterOf({ ...source(sixChapters, 3), jobPending: [] })?.title).toBe('題4')
  })
})

describe('every target must be in the outline', () => {
  test('a later target missing from the outline is a 404 at the start', () => {
    const ready = { outline, written: new Set([1, 2, 3, 4, 5, 6]), blocker: null, baseVersionError: null }
    expect(decideGenerationStart(ready, 'n1', [5, 6, 7], 'm')).toEqual({ ok: false, status: 404, error: 'not_found' })
    expect(decideGenerationStart(ready, 'n1', [5, 6], 'm')).toMatchObject({ ok: true, targets: [5, 6] })
  })
})

// ---------------------- 書き直しの元の版を開始の時点で確かめる ----------------------

describe('the rewrite base version at the generation start', () => {
  test('decideGenerationStart answers 400 invalid_base_version after the content checks, before 409', () => {
    const source = { outline, written: new Set<number>(), blocker: null, baseVersionError: '書き直す元の版が見つかりません' }
    expect(decideGenerationStart(source, 'n1', [3], 'm')).toEqual({
      ok: false,
      status: 400,
      error: 'invalid_base_version',
      detail: '書き直す元の版が見つかりません'
    })
    const blocked = { ...source, blocker: { error: 'invalid_notes' as const, detail: '指示' } }
    expect(decideGenerationStart(blocked, 'n1', [3], 'm')).toMatchObject({ error: 'invalid_notes' })
  })

  type Row = { id: string; novel_id: string; chapter_number: number; title: string | null; content: string; record: null }

  // 本文がある章は無い (novel.chapters が空) 小説と、id で引ける版の行
  function fake(rows: Row[]): PrismaClient {
    return Object.assign(Object.create(null), {
      novel: {
        findUnique: async () => ({
          id: 'n1',
          title: 't',
          genre: 'g',
          setting: 's',
          num_chapters: 6,
          target_chars: 2000,
          outline_summary_chars: 200,
          pov: '三人称多元視点',
          tone: '一般文芸',
          age_rating: '全年齢',
          pov_character_id: '',
          ending: '未指定',
          notes: '',
          writing_notes: null,
          editor_model: 'gemini-2.5-flash',
          bible: null,
          outline: JSON.stringify(outline),
          chapters: [],
          character_links: [],
          relations: [],
          generation_costs: [],
          generation_job: null,
          category: null
        })
      },
      chapter: {
        findUnique: async (args: { where: { id: string } }) => {
          const found = rows.find((row) => row.id === args.where.id)
          return found === undefined ? null : found
        }
      }
    })
  }
  const own: Row = { id: 'v1', novel_id: 'n1', chapter_number: 1, title: '題1', content: '　元の版。', record: null }
  const rewrite = (baseVersionId: string) => ({ instruction: '呼び方を直す', baseVersionId })

  test('a base version of this chapter is accepted', async () => {
    const start = await prepareGenerationStart(fake([own]), 'n1', [1], 'm', rewrite('v1'))
    expect(start.ok).toBe(true)
  })

  test('a base version of another chapter or novel, or a missing one, is a 400', async () => {
    const rows = [own, { ...own, id: 'v2', chapter_number: 2 }, { ...own, id: 'x1', novel_id: 'other' }]
    for (const id of ['v2', 'x1', 'nope']) {
      const start = await prepareGenerationStart(fake(rows), 'n1', [1], 'm', rewrite(id))
      expect(start).toMatchObject({ ok: false, status: 400, error: 'invalid_base_version' })
    }
  })

  test('a rewrite without a base id needs text in the chapter', async () => {
    const start = await prepareGenerationStart(fake([]), 'n1', [1], 'm', rewrite(''))
    expect(start).toMatchObject({ ok: false, status: 400, error: 'invalid_base_version' })
  })

  test('a rewrite without a base id uses the latest version of the chapter when it has text', async () => {
    // getNovelWithChapters が第 1 章の最新 version (本文あり) を返す偽物
    const latest = { ...own, version: 2, outline_hash: null, prev_chapter_id: null, review: null, created_at: new Date(0) }
    const base = fake([])
    const prisma: PrismaClient = Object.assign(Object.create(null), {
      novel: {
        findUnique: async () => ({
          ...(await base.novel.findUnique({ where: { id: 'n1' } })),
          chapters: [{ id: 'v1', chapter_number: 1, version: 2 }]
        })
      },
      chapter: { findMany: async () => [latest], findUnique: async () => null }
    })
    const start = await prepareGenerationStart(prisma, 'n1', [1], 'm', rewrite(''))
    expect(start.ok).toBe(true)
  })

  test('a normal generation ignores the base version id', async () => {
    const start = await prepareGenerationStart(fake([]), 'n1', [1], 'm', { instruction: '  ', baseVersionId: 'nope' })
    expect(start.ok).toBe(true)
    expect((await prepareGenerationStart(fake([]), 'n1', [1], 'm')).ok).toBe(true)
  })
})
