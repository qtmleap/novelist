import { describe, expect, test } from 'bun:test'
import {
  adultBibleIssues,
  type BibleFlowInput,
  bibleOutdated,
  bibleSourceInput,
  brokenBibleError,
  castForPrompt,
  createBibleFlow,
  currentBibleHash,
  extractRecordFlow,
  generateBibleFlow,
  generateOutlineFlow,
  type JsonCaller,
  type JsonCallOptions,
  type OutlineFlowInput,
  outlineTimeoutMs,
  normalizeBible,
  outlinePromptInput,
  prepareBibleFlow,
  type RecordFlowInput,
  regenerateOutlineChapterFlow,
  regenerateOutlineChapters,
  replaceOutlineChapter
} from '@/lib/novel/assist'
import { buildBiblePrompt, buildRecordPrompt } from '@/lib/novel/assist-prompts'
import { bibleJsonSchema, recordJsonSchema } from '@/lib/novel/json-schemas'
import { outlineChapterJsonSchema, outlineJsonSchema } from '@/lib/novel/outline'
import { buildOutlineChapterPrompt, buildOutlinePrompt, type CastMember, type Prompt } from '@/lib/novel/prompts'
import type { UsageCounts } from '@/lib/openai/protocol'
import type { Outline, StoredBible } from '@/schemas/novel.dto'
import type { StoryBible } from '@/schemas/story.dto'

function member(name: string, role: string): CastMember {
  return {
    name,
    role,
    gender: '',
    age: '',
    occupation: '',
    appearance: '',
    first_person: '私',
    address_others: '',
    speech_examples: [],
    description: ''
  }
}

const input: OutlineFlowInput = {
  novel: { title: 't', genre: 'ファンタジー', setting: '港町', num_chapters: 3, outline_summary_chars: 200 },
  style: { pov: '一人称', tone: '一般文芸', viewpointChar: { name: '酒寄彩葉', first_person: '私' } },
  cast: [member('酒寄彩葉', '主人公'), member('月見ヤチヨ', '相棒')],
  relations: [],
  alwaysInclude: [],
  bible: null
}

// 新しく作る章立ては、各章に出来事と章末の状況が要る (requirePlan)。応答の見本に入れる計画の項目。
const PLAN = { events: ['出来事'], end_state: '章末の状況' }

// 保存済みの章立ての 1 章 (計画の項目は既定値)。
function storedChapter(fields: { chapter_number: number; title: string; summary: string; characters: string[] }) {
  return { events: [], time_place: '', end_state: '', setups: [], payoffs: [], ...fields }
}

function usage(n: number): UsageCounts {
  return { model: 'gemini-2.5-flash', promptTokens: n, outputTokens: n, totalTokens: n * 2 }
}

type Reply = { text: string; usage?: UsageCounts } | Error

type Call = { prompt: Prompt; options: JsonCallOptions }

// replies を順に返す偽の呼び出し。受け取った引数を calls に残す。Error を渡すとその回は throw する。
function fakeCall(replies: Reply[]): { call: JsonCaller; calls: Call[] } {
  const calls: Call[] = []
  const queue = [...replies]
  const call: JsonCaller = async (prompt, options) => {
    calls.push({ prompt, options })
    const next = queue.shift()
    if (next === undefined) throw new Error('unexpected extra call')
    if (next instanceof Error) throw next
    return { text: next.text, usage: next.usage }
  }
  return { call, calls }
}

function outlineJson(chapters: Array<{ n: number; title?: string; characters?: string[] }>): string {
  return JSON.stringify({
    chapters: chapters.map((c) => ({
      chapter_number: c.n,
      title: c.title === undefined ? `第${c.n}章の題` : c.title,
      summary: `第${c.n}章の概要`,
      characters: c.characters === undefined ? ['月見ヤチヨ'] : c.characters,
      ...PLAN
    }))
  })
}

const threeChapters = outlineJson([{ n: 1 }, { n: 2 }, { n: 3 }])

describe('generateOutlineFlow', () => {
  test('succeeds on the first call', async () => {
    const { call, calls } = fakeCall([{ text: threeChapters, usage: usage(1) }])
    const result = await generateOutlineFlow(call, input)
    expect(calls).toHaveLength(1)
    if (!result.ok) throw new Error(result.error)
    expect(result.outline.chapters.map((c) => c.chapter_number)).toEqual([1, 2, 3])
    expect(result.warnings).toEqual([])
    expect(result.usages).toEqual([usage(1)])
  })

  test('sorts chapters returned out of order', async () => {
    const { call } = fakeCall([{ text: outlineJson([{ n: 3 }, { n: 1 }, { n: 2 }]) }])
    const result = await generateOutlineFlow(call, input)
    if (!result.ok) throw new Error(result.error)
    expect(result.outline.chapters.map((c) => c.chapter_number)).toEqual([1, 2, 3])
  })

  test('passes the prompt, op, schema and timeout to call', async () => {
    const { call, calls } = fakeCall([{ text: threeChapters }])
    await generateOutlineFlow(call, input)
    expect(calls[0].prompt).toEqual(buildOutlinePrompt(input))
    expect(calls[0].options).toEqual({
      op: 'generateOutline',
      schema: outlineJsonSchema(['酒寄彩葉', '月見ヤチヨ']),
      // 180 秒 + 3 章 × 15 秒
      timeoutMs: 225_000
    })
  })

  test('the timeout grows with the chapter count up to 10 minutes', async () => {
    const thirty = outlineJson(Array.from({ length: 30 }, (_, i) => ({ n: i + 1 })))
    const { call, calls } = fakeCall([{ text: thirty }])
    const result = await generateOutlineFlow(call, { ...input, novel: { ...input.novel, num_chapters: 30 } })
    if (!result.ok) throw new Error(result.error)
    // 180 秒 + 30 章 × 15 秒 = 630 秒は上限の 600 秒で頭打ち
    expect(calls[0].options.timeoutMs).toBe(600_000)
    expect(outlineTimeoutMs(3)).toBe(225_000)
    expect(outlineTimeoutMs(28)).toBe(600_000)
    expect(outlineTimeoutMs(27)).toBe(585_000)
  })

  test('retries once after invalid JSON and keeps both usages', async () => {
    const { call, calls } = fakeCall([
      { text: 'not json', usage: usage(1) },
      { text: threeChapters, usage: usage(2) }
    ])
    const result = await generateOutlineFlow(call, input)
    expect(calls).toHaveLength(2)
    // やり直しは同じプロンプト
    expect(calls[1].prompt).toEqual(calls[0].prompt)
    expect(calls[1].options).toEqual(calls[0].options)
    if (!result.ok) throw new Error(result.error)
    expect(result.usages).toEqual([usage(1), usage(2)])
  })

  test('fails after two wrong chapter counts and reports the last reason', async () => {
    const { call, calls } = fakeCall([
      { text: outlineJson([{ n: 1 }, { n: 2 }]), usage: usage(1) },
      { text: outlineJson([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]), usage: usage(2) }
    ])
    const result = await generateOutlineFlow(call, input)
    expect(calls).toHaveLength(2)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('章の数が 3 章であるべきところ 4 章です')
    expect(result.usages).toEqual([usage(1), usage(2)])
  })

  test('joins several shape problems into one sentence', async () => {
    const bad = outlineJson([{ n: 1, title: '' }, { n: 2 }, { n: 2 }])
    const { call } = fakeCall([{ text: bad }, { text: bad }])
    const result = await generateOutlineFlow(call, input)
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toContain('章番号 2 が重複しています、章番号 3 の章がありません')
    expect(result.error).toContain('第 1 章の題が空です')
  })

  test('a throwing call is not retried', async () => {
    const { call, calls } = fakeCall([new Error('Gemini generateOutline failed: 500 boom')])
    const result = await generateOutlineFlow(call, input)
    expect(calls).toHaveLength(1)
    expect(result).toEqual({ ok: false, error: 'Gemini generateOutline failed: 500 boom', usages: [] })
  })

  test('a throw on the retry keeps the usage of the first call', async () => {
    const { call, calls } = fakeCall([{ text: '{', usage: usage(1) }, new Error('timeout')])
    const result = await generateOutlineFlow(call, input)
    expect(calls).toHaveLength(2)
    expect(result).toEqual({ ok: false, error: 'timeout', usages: [usage(1)] })
  })

  test('calls without usage are not listed', async () => {
    const { call } = fakeCall([{ text: 'x' }, { text: threeChapters, usage: usage(2) }])
    const result = await generateOutlineFlow(call, input)
    expect(result.usages).toEqual([usage(2)])
  })

  test('names not in the cast are dropped with a warning', async () => {
    const text = outlineJson([{ n: 1, characters: ['月見ヤチヨ', '謎の男'] }, { n: 2 }, { n: 3 }])
    const { call } = fakeCall([{ text }])
    const result = await generateOutlineFlow(call, input)
    if (!result.ok) throw new Error(result.error)
    expect(result.outline.chapters[0].characters).toEqual(['月見ヤチヨ'])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toMatchObject({ chapter_number: 1, kind: 'dropped_character' })
    expect(result.warnings[0].message).toContain('謎の男')
  })

  test('partial names are resolved to the cast name', async () => {
    const text = outlineJson([{ n: 1, characters: ['彩葉'] }, { n: 2 }, { n: 3 }])
    const { call } = fakeCall([{ text }])
    const result = await generateOutlineFlow(call, input)
    if (!result.ok) throw new Error(result.error)
    expect(result.outline.chapters[0].characters).toEqual(['酒寄彩葉'])
    expect(result.warnings).toEqual([])
  })

  test('the narrator in alwaysInclude is added to every chapter', async () => {
    const { call } = fakeCall([{ text: threeChapters }])
    const result = await generateOutlineFlow(call, { ...input, alwaysInclude: ['酒寄彩葉'] })
    if (!result.ok) throw new Error(result.error)
    for (const chapter of result.outline.chapters) {
      expect(chapter.characters).toEqual(['酒寄彩葉', '月見ヤチヨ'])
    }
  })

  test('an empty cast clears characters and sends no characters in the schema', async () => {
    const { call, calls } = fakeCall([{ text: threeChapters }])
    const result = await generateOutlineFlow(call, { ...input, cast: [] })
    if (!result.ok) throw new Error(result.error)
    expect(result.outline.chapters.every((c) => c.characters.length === 0)).toBe(true)
    expect(calls[0].options.schema).toEqual(outlineJsonSchema([]))
  })
})

describe('regenerateOutlineChapterFlow', () => {
  const existing: Outline = {
    chapters: [1, 2, 3].map((n) =>
      storedChapter({ chapter_number: n, title: `旧${n}`, summary: `旧概要${n}`, characters: ['月見ヤチヨ'] })
    )
  }
  const chapterInput = { ...input, existing, chapterNumber: 2 }

  function chapterJson(chapter: { chapter_number: number; title: string; characters?: string[] }): string {
    return JSON.stringify({
      ...chapter,
      summary: '新しい概要',
      characters: chapter.characters === undefined ? ['月見ヤチヨ'] : chapter.characters,
      ...PLAN
    })
  }

  test('overwrites the chapter number with the target', async () => {
    const { call } = fakeCall([{ text: chapterJson({ chapter_number: 99, title: '新しい題' }), usage: usage(1) }])
    const result = await regenerateOutlineChapterFlow(call, chapterInput)
    if (!result.ok) throw new Error(result.error)
    // 章立ての項目は増えていく (Phase 3 の events など。既定値つき) ので、この流れが決める項目だけを見る
    expect(result.chapter).toMatchObject({
      chapter_number: 2,
      title: '新しい題',
      summary: '新しい概要',
      characters: ['月見ヤチヨ']
    })
    expect(result.usages).toEqual([usage(1)])
  })

  test('passes the prompt, op, chapter schema and a fixed timeout to call', async () => {
    const { call, calls } = fakeCall([{ text: chapterJson({ chapter_number: 2, title: '題' }) }])
    await regenerateOutlineChapterFlow(call, chapterInput)
    expect(calls[0].prompt).toEqual(buildOutlineChapterPrompt(chapterInput))
    expect(calls[0].options).toEqual({
      op: 'regenerateOutlineChapter',
      schema: outlineChapterJsonSchema(['酒寄彩葉', '月見ヤチヨ']),
      timeoutMs: 180_000
    })
  })

  test('a 30-chapter novel still waits 180 seconds for one chapter', async () => {
    const { call, calls } = fakeCall([{ text: chapterJson({ chapter_number: 2, title: '題' }) }])
    await regenerateOutlineChapterFlow(call, { ...chapterInput, novel: { ...input.novel, num_chapters: 30 } })
    expect(calls[0].options.timeoutMs).toBe(180_000)
  })

  test('picks the target chapter when several chapters come back', async () => {
    const text = JSON.stringify({
      chapters: [1, 2, 3].map((n) => ({ chapter_number: n, title: `返答${n}`, summary: `概要${n}`, characters: [], ...PLAN }))
    })
    const { call, calls } = fakeCall([{ text }])
    const result = await regenerateOutlineChapterFlow(call, chapterInput)
    expect(calls).toHaveLength(1)
    if (!result.ok) throw new Error(result.error)
    expect(result.chapter).toMatchObject({ chapter_number: 2, title: '返答2', summary: '概要2' })
  })

  test('picks the target chapter from a bare array too', async () => {
    const text = JSON.stringify(
      [3, 2].map((n) => ({ chapter_number: n, title: `返答${n}`, summary: `概要${n}`, characters: [], ...PLAN }))
    )
    const { call } = fakeCall([{ text }])
    const result = await regenerateOutlineChapterFlow(call, chapterInput)
    if (!result.ok) throw new Error(result.error)
    expect(result.chapter.title).toBe('返答2')
  })

  test('retries when several chapters come back without the target', async () => {
    const others = JSON.stringify({
      chapters: [1, 3].map((n) => ({ chapter_number: n, title: `返答${n}`, summary: `概要${n}`, characters: [], ...PLAN }))
    })
    const { call, calls } = fakeCall([
      { text: others, usage: usage(1) },
      { text: chapterJson({ chapter_number: 2, title: '題' }), usage: usage(2) }
    ])
    const result = await regenerateOutlineChapterFlow(call, chapterInput)
    expect(calls).toHaveLength(2)
    if (!result.ok) throw new Error(result.error)
    expect(result.chapter.title).toBe('題')
    expect(result.usages).toEqual([usage(1), usage(2)])
  })

  test('fails when the target is missing twice', async () => {
    const others = JSON.stringify({
      chapters: [1, 3].map((n) => ({ chapter_number: n, title: `返答${n}`, summary: `概要${n}`, characters: [], ...PLAN }))
    })
    const { call } = fakeCall([{ text: others }, { text: others }])
    const result = await regenerateOutlineChapterFlow(call, chapterInput)
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toContain('第 2 章のものがありません')
  })

  test('retries when the title is empty', async () => {
    const { call, calls } = fakeCall([
      { text: chapterJson({ chapter_number: 2, title: '  ' }), usage: usage(1) },
      { text: chapterJson({ chapter_number: 2, title: '題' }), usage: usage(2) }
    ])
    const result = await regenerateOutlineChapterFlow(call, chapterInput)
    expect(calls).toHaveLength(2)
    if (!result.ok) throw new Error(result.error)
    expect(result.chapter.title).toBe('題')
    expect(result.usages).toEqual([usage(1), usage(2)])
  })

  test('fails after two empty titles', async () => {
    const empty = { text: chapterJson({ chapter_number: 2, title: '' }), usage: usage(1) }
    const { call } = fakeCall([empty, empty])
    const result = await regenerateOutlineChapterFlow(call, chapterInput)
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toContain('第 2 章の題が空です')
    expect(result.usages).toHaveLength(2)
  })

  test('accepts a chapter wrapped in chapters[]', async () => {
    const text = JSON.stringify({ chapters: [{ chapter_number: 2, title: '題', summary: '概要', characters: [], ...PLAN }] })
    const { call } = fakeCall([{ text }])
    const result = await regenerateOutlineChapterFlow(call, chapterInput)
    if (!result.ok) throw new Error(result.error)
    expect(result.chapter.title).toBe('題')
  })

  test('normalizes characters and adds the narrator', async () => {
    const text = chapterJson({ chapter_number: 2, title: '題', characters: ['ヤチヨ', '通行人'] })
    const { call } = fakeCall([{ text }])
    const result = await regenerateOutlineChapterFlow(call, { ...chapterInput, alwaysInclude: ['酒寄彩葉'] })
    if (!result.ok) throw new Error(result.error)
    expect(result.chapter.characters).toEqual(['酒寄彩葉', '月見ヤチヨ'])
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toMatchObject({ chapter_number: 2, kind: 'dropped_character' })
  })

  test('a throwing call is not retried', async () => {
    const { call, calls } = fakeCall([new Error('blocked')])
    const result = await regenerateOutlineChapterFlow(call, chapterInput)
    expect(calls).toHaveLength(1)
    expect(result).toEqual({ ok: false, error: 'blocked', usages: [] })
  })
})

describe('replaceOutlineChapter', () => {
  function entry(n: number, title: string) {
    return storedChapter({ chapter_number: n, title, summary: `概要${n}`, characters: [] })
  }

  test('replaces a chapter that exists', () => {
    const outline: Outline = { chapters: [entry(1, '一'), entry(2, '二'), entry(3, '三')] }
    const result = replaceOutlineChapter(outline, entry(2, '新'))
    expect(result.chapters.map((c) => [c.chapter_number, c.title])).toEqual([
      [1, '一'],
      [2, '新'],
      [3, '三']
    ])
  })

  test('adds a chapter that is missing, in number order', () => {
    const outline: Outline = { chapters: [entry(1, '一'), entry(3, '三')] }
    const result = replaceOutlineChapter(outline, entry(2, '新'))
    expect(result.chapters.map((c) => [c.chapter_number, c.title])).toEqual([
      [1, '一'],
      [2, '新'],
      [3, '三']
    ])
  })

  test('sorts chapters that were out of order', () => {
    const outline: Outline = { chapters: [entry(3, '三'), entry(1, '一')] }
    const result = replaceOutlineChapter(outline, entry(4, '四'))
    expect(result.chapters.map((c) => c.chapter_number)).toEqual([1, 3, 4])
  })

  test('does not change the input', () => {
    const outline: Outline = { chapters: [entry(2, '二'), entry(1, '一')] }
    replaceOutlineChapter(outline, entry(1, '新'))
    expect(outline.chapters.map((c) => [c.chapter_number, c.title])).toEqual([
      [2, '二'],
      [1, '一']
    ])
  })
})

describe('regenerateOutlineChapters', () => {
  const existing: Outline = {
    chapters: [1, 2, 3].map((n) =>
      storedChapter({ chapter_number: n, title: `旧${n}`, summary: `旧概要${n}`, characters: ['月見ヤチヨ'] })
    )
  }

  function reply(n: number, title: string, characters: string[] = ['月見ヤチヨ']): string {
    return JSON.stringify({ chapter_number: n, title, summary: `新しい概要${n}`, characters, ...PLAN })
  }

  type UsageCall = { chapterNumber: number; usages: UsageCounts[] }

  function recorder(): { onUsages: (n: number, usages: UsageCounts[]) => Promise<void>; seen: UsageCall[] } {
    const seen: UsageCall[] = []
    return {
      onUsages: async (chapterNumber, usages) => {
        seen.push({ chapterNumber, usages })
      },
      seen
    }
  }

  test('a rewritten chapter is part of the material for the next chapter', async () => {
    const { call, calls } = fakeCall([{ text: reply(1, '新しい題1') }, { text: reply(3, '新しい題3') }])
    const { onUsages } = recorder()
    const result = await regenerateOutlineChapters(call, input, existing, [1, 3], onUsages)
    if (!result.ok) throw new Error(result.error)
    expect(calls).toHaveLength(2)
    // 2 回目 (第 3 章) の資料には、書き直した第 1 章が入っている
    const afterFirst = replaceOutlineChapter(existing, {
      ...storedChapter({ chapter_number: 1, title: '新しい題1', summary: '新しい概要1', characters: ['月見ヤチヨ'] }),
      ...PLAN
    })
    expect(calls[1].prompt).toEqual(buildOutlineChapterPrompt({ ...input, existing: afterFirst, chapterNumber: 3 }))
    expect(calls[1].prompt.user).toContain('新しい題1')
    expect(calls[1].prompt.user).not.toContain('旧1')
    expect(result.outline.chapters.map((c) => c.title)).toEqual(['新しい題1', '旧2', '新しい題3'])
  })

  test('stops at the failing chapter and does not call later chapters', async () => {
    const { call, calls } = fakeCall([
      { text: reply(1, '新しい題1'), usage: usage(1) },
      { text: reply(2, ''), usage: usage(2) },
      { text: reply(2, ''), usage: usage(3) }
    ])
    const { onUsages, seen } = recorder()
    const result = await regenerateOutlineChapters(call, input, existing, [1, 2, 3], onUsages)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error).toContain('第 2 章の題が空です')
    // 第 2 章の 2 回で止まり、第 3 章は呼ばない
    expect(calls).toHaveLength(3)
    expect(calls.every((c) => c.options.op === 'regenerateOutlineChapter')).toBe(true)
    // onUsages は章ごとに呼ばれ、失敗した章の分も渡る
    expect(seen).toEqual([
      { chapterNumber: 1, usages: [usage(1)] },
      { chapterNumber: 2, usages: [usage(2), usage(3)] }
    ])
  })

  test('a throwing call stops the loop and still reports the chapter to onUsages', async () => {
    const { call, calls } = fakeCall([{ text: reply(1, '新しい題1'), usage: usage(1) }, new Error('blocked')])
    const { onUsages, seen } = recorder()
    const result = await regenerateOutlineChapters(call, input, existing, [1, 2, 3], onUsages)
    expect(result).toEqual({ ok: false, error: 'blocked' })
    expect(calls).toHaveLength(2)
    expect(seen).toEqual([
      { chapterNumber: 1, usages: [usage(1)] },
      { chapterNumber: 2, usages: [] }
    ])
  })

  test('warnings of every chapter are collected', async () => {
    const { call } = fakeCall([
      { text: reply(1, '題1', ['月見ヤチヨ', '謎の男']) },
      { text: reply(3, '題3', ['通行人']) }
    ])
    const { onUsages } = recorder()
    const result = await regenerateOutlineChapters(call, input, existing, [1, 3], onUsages)
    if (!result.ok) throw new Error(result.error)
    expect(result.warnings.map((w) => [w.chapter_number, w.kind])).toEqual([
      [1, 'dropped_character'],
      [3, 'dropped_character']
    ])
    expect(result.warnings[0].message).toContain('謎の男')
    expect(result.warnings[1].message).toContain('通行人')
  })

  test('no targets returns the outline untouched without calling', async () => {
    const { call, calls } = fakeCall([])
    const { onUsages, seen } = recorder()
    const result = await regenerateOutlineChapters(call, input, existing, [], onUsages)
    expect(result).toEqual({ ok: true, outline: existing, warnings: [] })
    expect(calls).toHaveLength(0)
    expect(seen).toEqual([])
  })
})

describe('extractRecordFlow', () => {
  const recordInput: RecordFlowInput = {
    chapterNumber: 3,
    title: '港の灯',
    content: '　彩葉は港でヤチヨに会った。',
    castNames: ['酒寄彩葉', '月見ヤチヨ'],
    openThreads: [{ id: 's1', description: '灯台の鍵の行方' }],
    plannedSetups: []
  }

  function draftJson(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      summary: '彩葉が港でヤチヨに会った。',
      facts: ['港の灯台は赤い'],
      characters: [{ name: '彩葉', actions: ['港へ行った'], learned: ['ヤチヨが船乗りだと知った'], state: '港にいる' }],
      new_threads: ['ヤチヨの手紙の差出人'],
      resolved_thread_ids: ['s1'],
      end_state: { time: '夕方', place: '港', present: ['ヤチヨ'] },
      ...overrides
    })
  }

  test('succeeds, normalizes names and assigns thread ids', async () => {
    const { call, calls } = fakeCall([{ text: draftJson(), usage: usage(1) }])
    const result = await extractRecordFlow(call, recordInput)
    expect(calls).toHaveLength(1)
    if (!result.ok) throw new Error(result.error)
    expect(result.usages).toEqual([usage(1)])
    expect(result.record).toEqual({
      summary: '彩葉が港でヤチヨに会った。',
      facts: ['港の灯台は赤い'],
      // 「彩葉」「ヤチヨ」は名簿の正式名に寄せる
      characters: [
        { name: '酒寄彩葉', actions: ['港へ行った'], learned: ['ヤチヨが船乗りだと知った'], state: '港にいる' }
      ],
      threads_opened: [{ id: 'c3-1', description: 'ヤチヨの手紙の差出人' }],
      threads_resolved: ['s1'],
      end_state: { time: '夕方', place: '港', present: ['月見ヤチヨ'] }
    })
  })

  test('passes the prompt, op, schema and a 120 second timeout to call', async () => {
    const { call, calls } = fakeCall([{ text: draftJson() }])
    await extractRecordFlow(call, recordInput)
    expect(calls[0].prompt).toEqual(buildRecordPrompt(recordInput))
    expect(calls[0].options).toEqual({
      op: 'extractRecord',
      schema: recordJsonSchema({ castNames: ['酒寄彩葉', '月見ヤチヨ'], openThreadIds: ['s1'], plannedSetupIds: [] }),
      timeoutMs: 120_000
    })
  })

  test('the narrator reaches the prompt', async () => {
    const { call, calls } = fakeCall([{ text: draftJson() }])
    await extractRecordFlow(call, { ...recordInput, narrator: '酒寄彩葉' })
    expect(calls[0].prompt).toEqual(buildRecordPrompt({ ...recordInput, narrator: '酒寄彩葉' }))
    expect(calls[0].prompt.user).toContain('酒寄彩葉')
  })

  test('retries once after invalid JSON and keeps both usages', async () => {
    const { call, calls } = fakeCall([
      { text: 'not json', usage: usage(1) },
      { text: draftJson(), usage: usage(2) }
    ])
    const result = await extractRecordFlow(call, recordInput)
    expect(calls).toHaveLength(2)
    expect(calls[1].prompt).toEqual(calls[0].prompt)
    if (!result.ok) throw new Error(result.error)
    expect(result.usages).toEqual([usage(1), usage(2)])
  })

  test('a draft that finalizeRecord rejects is retried, then fails', async () => {
    const blank = { text: draftJson({ summary: '   ' }), usage: usage(1) }
    const { call, calls } = fakeCall([blank, { ...blank, usage: usage(2) }])
    const result = await extractRecordFlow(call, recordInput)
    expect(calls).toHaveLength(2)
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toContain('記録を保存できる形にできません')
    expect(result.usages).toEqual([usage(1), usage(2)])
  })

  test('a draft of the wrong shape is retried', async () => {
    const { call, calls } = fakeCall([{ text: JSON.stringify({ summary: 1 }) }, { text: draftJson() }])
    const result = await extractRecordFlow(call, recordInput)
    expect(calls).toHaveLength(2)
    expect(result.ok).toBe(true)
  })

  test('a throwing call is not retried', async () => {
    const { call, calls } = fakeCall([new Error('Gemini extractRecord failed: 503')])
    const result = await extractRecordFlow(call, recordInput)
    expect(calls).toHaveLength(1)
    expect(result).toEqual({ ok: false, error: 'Gemini extractRecord failed: 503', usages: [] })
  })

  test('an empty chapter is not sent to the model', async () => {
    const { call, calls } = fakeCall([])
    const result = await extractRecordFlow(call, { ...recordInput, content: ' \n　\n' })
    expect(calls).toHaveLength(0)
    expect(result.ok).toBe(false)
    expect(result.usages).toEqual([])
  })
})

// ---------------------- 作品設計 (Phase 3) ----------------------

// 辞典の原文。未成年を連想させる記述 (成人指定では作品設計の設定に差し替わり、プロンプトに出てはいけない)。
function minorMember(name: string): CastMember {
  return {
    ...member(name, '主人公'),
    age: '17',
    occupation: '星見台高校の二年生',
    appearance: 'セーラー服',
    description: '星見台高校に通う'
  }
}

const adultStyle = { pov: '一人称', tone: '一般文芸', age_rating: 'R18', viewpointChar: { name: '酒寄彩葉', first_person: '私' } }

const bibleInput: BibleFlowInput = {
  novel: input.novel,
  style: { ...input.style, age_rating: '全年齢' },
  cast: input.cast,
  relations: []
}
const adultBibleInput: BibleFlowInput = {
  ...bibleInput,
  style: adultStyle,
  cast: [minorMember('酒寄彩葉'), minorMember('月見ヤチヨ')]
}

const ADDRESSES = [
  { from: '酒寄彩葉', to: '月見ヤチヨ', call: 'ヤチヨ' },
  { from: '月見ヤチヨ', to: '酒寄彩葉', call: '彩葉' }
]
const ADULT_CAST = [
  { name: '酒寄彩葉', age: '20', occupation: '大学二年生', appearance: '短い髪', background: '港町の大学に通う' },
  { name: '月見ヤチヨ', age: '22歳', occupation: '船乗り', appearance: '日に焼けた肌', background: '灯台守の娘' }
]

function bibleJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    premise: '彩葉が灯台の鍵を探す物語',
    ending: '鍵は海へ還る',
    arcs: [{ name: '酒寄彩葉', start: '臆病', end: '決断する' }],
    world: { rules: ['灯台は夜にだけ灯る'], terms: [{ term: '灯の鍵', note: '灯台の鍵' }] },
    timeline: ['夏の一週間'],
    addresses: ADDRESSES,
    cast: ADULT_CAST,
    ...overrides
  })
}

describe('generateBibleFlow', () => {
  test('succeeds and passes the prompt, op, schema and timeout to call', async () => {
    const { call, calls } = fakeCall([{ text: bibleJson(), usage: usage(1) }])
    const result = await generateBibleFlow(call, bibleInput)
    expect(calls).toHaveLength(1)
    expect(calls[0].prompt).toEqual(buildBiblePrompt(bibleInput))
    expect(calls[0].options).toEqual({
      op: 'generateBible',
      schema: bibleJsonSchema({ castNames: ['酒寄彩葉', '月見ヤチヨ'], adult: false }),
      timeoutMs: 180_000
    })
    if (!result.ok) throw new Error(result.error)
    expect(result.usages).toEqual([usage(1)])
    expect(result.bible.premise).toBe('彩葉が灯台の鍵を探す物語')
    expect(result.bible.addresses).toEqual(ADDRESSES)
  })

  test('the cast is dropped for all-ages novels', async () => {
    const { call } = fakeCall([{ text: bibleJson() }])
    const result = await generateBibleFlow(call, bibleInput)
    if (!result.ok) throw new Error(result.error)
    expect(result.bible.cast).toEqual([])
  })

  test('an adult novel keeps the cast and asks for it in the schema', async () => {
    const { call, calls } = fakeCall([{ text: bibleJson() }])
    const result = await generateBibleFlow(call, adultBibleInput)
    expect(calls[0].options.schema).toEqual(bibleJsonSchema({ castNames: ['酒寄彩葉', '月見ヤチヨ'], adult: true }))
    if (!result.ok) throw new Error(result.error)
    expect(result.bible.cast.map((c) => c.age)).toEqual(['20', '22歳'])
  })

  test('an under-age cast is retried, then fails with the validateAdultCast messages', async () => {
    const minor = bibleJson({ cast: [{ ...ADULT_CAST[0], age: '17' }, ADULT_CAST[1]] })
    const { call, calls } = fakeCall([
      { text: minor, usage: usage(1) },
      { text: minor, usage: usage(2) }
    ])
    const result = await generateBibleFlow(call, adultBibleInput)
    expect(calls).toHaveLength(2)
    expect(result).toEqual({ ok: false, error: '酒寄彩葉 の年齢が 17 歳です（18 歳以上にしてください）', usages: [usage(1), usage(2)] })
  })

  test('an under-age cast on the first try is fixed by the retry', async () => {
    const { call } = fakeCall([
      { text: bibleJson({ cast: [{ ...ADULT_CAST[0], age: '16歳' }, ADULT_CAST[1]] }) },
      { text: bibleJson() }
    ])
    const result = await generateBibleFlow(call, adultBibleInput)
    expect(result.ok).toBe(true)
  })

  test('an age that is not a number counts as a problem', async () => {
    const vague = bibleJson({ cast: [{ ...ADULT_CAST[0], age: '二十代' }, ADULT_CAST[1]] })
    const { call, calls } = fakeCall([{ text: vague }, { text: vague }])
    const result = await generateBibleFlow(call, adultBibleInput)
    expect(calls).toHaveLength(2)
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toContain('酒寄彩葉 の年齢が数字で書かれていません')
  })

  test('a missing cast row counts as a problem', async () => {
    const short = bibleJson({ cast: [ADULT_CAST[0]] })
    const { call } = fakeCall([{ text: short }, { text: short }])
    const result = await generateBibleFlow(call, adultBibleInput)
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toBe('月見ヤチヨ の成人としての設定がありません')
  })

  test('missing address pairs are retried', async () => {
    const { call, calls } = fakeCall([
      { text: bibleJson({ addresses: [ADDRESSES[0]] }), usage: usage(1) },
      { text: bibleJson(), usage: usage(2) }
    ])
    const result = await generateBibleFlow(call, bibleInput)
    expect(calls).toHaveLength(2)
    if (!result.ok) throw new Error(result.error)
    expect(result.bible.addresses).toEqual(ADDRESSES)
    expect(result.usages).toEqual([usage(1), usage(2)])
  })

  test('address pairs still missing after the retry are accepted as they are', async () => {
    const half = bibleJson({ addresses: [ADDRESSES[0]] })
    const { call, calls } = fakeCall([{ text: half }, { text: half }])
    const result = await generateBibleFlow(call, bibleInput)
    expect(calls).toHaveLength(2)
    if (!result.ok) throw new Error(result.error)
    expect(result.bible.addresses).toEqual([ADDRESSES[0]])
  })

  test('a usable first answer is kept when the retry is worse', async () => {
    // 1 回目: 成人の設定は揃っているが、呼称表が欠けている。2 回目: 未成年が混ざっている
    const { call } = fakeCall([
      { text: bibleJson({ addresses: [ADDRESSES[0]], premise: '1 回目' }) },
      { text: bibleJson({ cast: [{ ...ADULT_CAST[0], age: '15' }, ADULT_CAST[1]], premise: '2 回目' }) }
    ])
    const result = await generateBibleFlow(call, adultBibleInput)
    if (!result.ok) throw new Error(result.error)
    expect(result.bible.premise).toBe('1 回目')
  })

  test('a usable first answer is kept when the retry throws', async () => {
    const { call } = fakeCall([{ text: bibleJson({ addresses: [] }), usage: usage(1) }, new Error('timeout')])
    const result = await generateBibleFlow(call, bibleInput)
    if (!result.ok) throw new Error(result.error)
    expect(result.bible.addresses).toEqual([])
    expect(result.usages).toEqual([usage(1)])
  })

  test('too long and empty items are trimmed instead of failing the answer', async () => {
    const { call, calls } = fakeCall([
      {
        text: bibleJson({
          premise: 'あ'.repeat(5000),
          timeline: ['夏', '', '秋'],
          arcs: Array.from({ length: 60 }, () => ({ name: '酒寄彩葉', start: 'a', end: 'b' })),
          world: { rules: ['ル'.repeat(700)], terms: [{ term: '', note: '空の用語' }, { term: '灯の鍵', note: '' }] }
        })
      }
    ])
    const result = await generateBibleFlow(call, bibleInput)
    expect(calls).toHaveLength(1)
    if (!result.ok) throw new Error(result.error)
    expect(result.bible.premise).toHaveLength(3000)
    expect(result.bible.timeline).toEqual(['夏', '秋'])
    expect(result.bible.arcs).toHaveLength(50)
    expect(result.bible.world.rules[0]).toHaveLength(600)
    expect(result.bible.world.terms).toEqual([{ term: '灯の鍵', note: '' }])
  })

  test('addresses to names outside the cast and empty calls are dropped', async () => {
    const { call } = fakeCall([
      {
        text: bibleJson({
          addresses: [...ADDRESSES, { from: '酒寄彩葉', to: '通行人', call: 'おじさん' }, { from: '酒寄彩葉', to: '月見ヤチヨ', call: '' }]
        })
      }
    ])
    const result = await generateBibleFlow(call, bibleInput)
    if (!result.ok) throw new Error(result.error)
    expect(result.bible.addresses).toEqual(ADDRESSES)
  })

  test('a wrong shape is retried', async () => {
    const { call, calls } = fakeCall([{ text: JSON.stringify({ premise: 1 }) }, { text: bibleJson() }])
    const result = await generateBibleFlow(call, bibleInput)
    expect(calls).toHaveLength(2)
    expect(result.ok).toBe(true)
  })

  test('a throwing call is not retried', async () => {
    const { call, calls } = fakeCall([new Error('Gemini generateBible failed: 503')])
    const result = await generateBibleFlow(call, bibleInput)
    expect(calls).toHaveLength(1)
    expect(result).toEqual({ ok: false, error: 'Gemini generateBible failed: 503', usages: [] })
  })
})

describe('bible helpers', () => {
  const bible: StoryBible = {
    premise: '核',
    ending: '',
    arcs: [],
    world: { rules: [], terms: [] },
    timeline: [],
    addresses: ADDRESSES,
    cast: ADULT_CAST
  }

  test('normalizeBible drops the cast for all ages and tidies addresses', () => {
    const tidy = normalizeBible({ ...bible, addresses: [...ADDRESSES, { from: '誰か', to: '酒寄彩葉', call: 'x' }] }, bibleInput)
    expect(tidy.cast).toEqual([])
    expect(tidy.addresses).toEqual(ADDRESSES)
    expect(normalizeBible(bible, adultBibleInput).cast).toEqual(ADULT_CAST)
  })

  test('adultBibleIssues and brokenBibleError', () => {
    expect(adultBibleIssues(bible, adultBibleInput)).toEqual([])
    expect(brokenBibleError(bible, adultBibleInput)).toBeNull()
    const broken = { ...bible, cast: [ADULT_CAST[0]] }
    expect(adultBibleIssues(broken, adultBibleInput)).toEqual(['月見ヤチヨ の成人としての設定がありません'])
    expect(brokenBibleError(broken, adultBibleInput)).toContain('作品設計を作り直す')
    // 全年齢では人物設定を問わない
    expect(brokenBibleError(broken, bibleInput)).toBeNull()
  })

  test('castForPrompt replaces the dictionary text only for adult novels with a bible', () => {
    const replaced = castForPrompt(adultBibleInput.cast, adultStyle, bible)
    expect(replaced[0]).toMatchObject({ age: '20', occupation: '大学二年生', description: '港町の大学に通う' })
    expect(castForPrompt(adultBibleInput.cast, adultStyle, null)).toEqual(adultBibleInput.cast)
    expect(castForPrompt(adultBibleInput.cast, { ...adultStyle, age_rating: '全年齢' }, bible)).toEqual(
      adultBibleInput.cast
    )
  })
})

describe('outline flow with a bible', () => {
  const bible: StoryBible = {
    premise: '灯台守の娘を探す物語の核',
    ending: '',
    arcs: [],
    world: { rules: [], terms: [] },
    timeline: [],
    addresses: ADDRESSES,
    cast: ADULT_CAST
  }

  test('the bible reaches the outline prompt', async () => {
    const { call, calls } = fakeCall([{ text: threeChapters }])
    await generateOutlineFlow(call, { ...input, bible })
    expect(calls[0].prompt).toEqual(buildOutlinePrompt(outlinePromptInput({ ...input, bible })))
    expect(calls[0].prompt.user).toContain('灯台守の娘を探す物語の核')
  })

  test('an adult novel sends the bible cast, not the dictionary text', async () => {
    const adultInput = { ...input, style: adultStyle, cast: adultBibleInput.cast, bible }
    const { call, calls } = fakeCall([{ text: threeChapters }])
    await generateOutlineFlow(call, adultInput)
    const sent = `${calls[0].prompt.system}\n${calls[0].prompt.user}`
    expect(sent).not.toContain('星見台')
    expect(sent).not.toContain('セーラー服')
    expect(sent).toContain('大学二年生')
    // 1 章の書き直しも同じ
    const chapterCall = fakeCall([{ text: JSON.stringify({ chapter_number: 2, title: '題', summary: '概要', characters: [], ...PLAN }) }])
    const existing: Outline = {
      chapters: [1, 2, 3].map((n) => storedChapter({ chapter_number: n, title: `旧${n}`, summary: `旧概要${n}`, characters: [] }))
    }
    await regenerateOutlineChapterFlow(chapterCall.call, { ...adultInput, existing, chapterNumber: 2 })
    const chapterSent = `${chapterCall.calls[0].prompt.system}\n${chapterCall.calls[0].prompt.user}`
    expect(chapterSent).not.toContain('星見台')
    expect(chapterSent).toContain('大学二年生')
  })

  test('chapters without a plan are retried', async () => {
    const noPlan = JSON.stringify({
      chapters: [1, 2, 3].map((n) => ({ chapter_number: n, title: `題${n}`, summary: `概要${n}`, characters: [] }))
    })
    const { call, calls } = fakeCall([{ text: noPlan }, { text: noPlan }])
    const result = await generateOutlineFlow(call, input)
    expect(calls).toHaveLength(2)
    if (result.ok) throw new Error('expected failure')
    expect(result.error).toContain('第 1 章の出来事がありません')
    expect(result.error).toContain('第 1 章の章末の状況が空です')
  })

  test('validateThreads warnings come back with the outline', async () => {
    const text = JSON.stringify({
      chapters: [
        { chapter_number: 1, title: '一', summary: '概要', characters: [], ...PLAN, setups: [{ id: 's1', description: '鍵の行方' }] },
        { chapter_number: 2, title: '二', summary: '概要', characters: [], ...PLAN, payoffs: ['s9'] },
        { chapter_number: 3, title: '三', summary: '概要', characters: [], ...PLAN }
      ]
    })
    const { call } = fakeCall([{ text }])
    const result = await generateOutlineFlow(call, input)
    if (!result.ok) throw new Error(result.error)
    expect(result.warnings.map((w) => [w.chapter_number, w.kind])).toEqual([
      [2, 'dropped_payoff'],
      [1, 'unresolved_setup']
    ])
    expect(result.outline.chapters[1].payoffs).toEqual([])
  })

  test('rewriting a chapter validates threads across the whole outline', async () => {
    const existing: Outline = {
      chapters: [
        { ...storedChapter({ chapter_number: 1, title: '一', summary: '概要', characters: [] }), setups: [{ id: 's1', description: '鍵' }] },
        storedChapter({ chapter_number: 2, title: '二', summary: '概要', characters: [] }),
        { ...storedChapter({ chapter_number: 3, title: '三', summary: '概要', characters: [] }), payoffs: ['s1'] }
      ]
    }
    // 第 3 章を書き直すと、第 1 章の伏線の回収が無くなる
    const { call } = fakeCall([
      { text: JSON.stringify({ chapter_number: 3, title: '新', summary: '概要', characters: [], ...PLAN, payoffs: [] }) }
    ])
    const result = await regenerateOutlineChapters(call, input, existing, [3], async () => {})
    if (!result.ok) throw new Error(result.error)
    expect(result.warnings.map((w) => [w.chapter_number, w.kind])).toEqual([[1, 'unresolved_setup']])
  })
})

describe('setup ids when one chapter is rewritten', () => {
  test('a rewritten chapter does not take over a setup id another chapter owns', async () => {
    const existing: Outline = {
      chapters: [1, 2, 3].map((n) => storedChapter({ chapter_number: n, title: `旧${n}`, summary: '概要', characters: [] }))
    }
    // 第 2 章が s1 を張り、第 3 章が回収している。第 1 章を書き直した応答が、新しい伏線に s1 を使ってしまう
    existing.chapters[1] = { ...existing.chapters[1], setups: [{ id: 's1', description: '第2章の鍵' }] }
    existing.chapters[2] = { ...existing.chapters[2], payoffs: ['s1'] }
    const reply = JSON.stringify({
      chapter_number: 1,
      title: '新',
      summary: '概要',
      characters: [],
      ...PLAN,
      setups: [{ id: 's1', description: '第1章の新しい伏線' }]
    })
    const { call } = fakeCall([{ text: reply }])
    const result = await regenerateOutlineChapters(call, input, existing, [1], async () => {})
    if (!result.ok) throw new Error(result.error)
    const [first, second, third] = result.outline.chapters
    // 第 2 章の s1 はそのまま、第 3 章はそれを回収したまま。書き直した第 1 章の伏線は別の id になる
    expect(second.setups).toEqual([{ id: 's1', description: '第2章の鍵' }])
    expect(third.payoffs).toEqual(['s1'])
    expect(first.setups.map((s) => s.description)).toEqual(['第1章の新しい伏線'])
    expect(first.setups[0].id).not.toBe('s1')
  })

  test('the rewritten chapter may keep its own old ids', async () => {
    const existing: Outline = {
      chapters: [1, 2].map((n) => storedChapter({ chapter_number: n, title: `旧${n}`, summary: '概要', characters: [] }))
    }
    existing.chapters[0] = { ...existing.chapters[0], setups: [{ id: 's1', description: '鍵' }] }
    existing.chapters[1] = { ...existing.chapters[1], payoffs: ['s1'] }
    const reply = JSON.stringify({
      chapter_number: 1,
      title: '新',
      summary: '概要',
      characters: [],
      ...PLAN,
      setups: [{ id: 's1', description: '鍵 (書き直し)' }]
    })
    const { call } = fakeCall([{ text: reply }])
    const result = await regenerateOutlineChapters(call, input, existing, [1], async () => {})
    if (!result.ok) throw new Error(result.error)
    expect(result.outline.chapters[0].setups).toEqual([{ id: 's1', description: '鍵 (書き直し)' }])
    expect(result.outline.chapters[1].payoffs).toEqual(['s1'])
    expect(result.warnings).toEqual([])
  })
})

describe('fitting the bible answer to the schema', () => {
  test('a row with two empty fields is dropped once, and the next row survives', async () => {
    const addresses = [{ from: '', to: '月見ヤチヨ', call: '' }, ...ADDRESSES]
    const { call } = fakeCall([{ text: bibleJson({ addresses }) }])
    const result = await generateBibleFlow(call, bibleInput)
    if (!result.ok) throw new Error(result.error)
    expect(result.bible.addresses).toEqual(ADDRESSES)
  })
})

describe('preparing the bible for the outline', () => {
  const stored: StoryBible = {
    premise: '核',
    ending: '',
    arcs: [],
    world: { rules: [], terms: [] },
    timeline: [],
    addresses: ADDRESSES,
    cast: ADULT_CAST
  }

  function effects() {
    const saved: StoredBible[] = []
    const recorded: UsageCounts[][] = []
    return {
      saved,
      recorded,
      effects: {
        save: async (bible: StoredBible) => {
          saved.push(bible)
        },
        recordUsages: async (usages: UsageCounts[]) => {
          recorded.push(usages)
        }
      }
    }
  }

  test('a stored bible is used as it is, without calling the model', async () => {
    const { call, calls } = fakeCall([])
    const fx = effects()
    const result = await prepareBibleFlow(call, { ...adultBibleInput, bible: stored }, fx.effects)
    expect(result).toEqual({ ok: true, bible: stored })
    expect(calls).toHaveLength(0)
    expect(fx.saved).toEqual([])
    expect(fx.recorded).toEqual([])
  })

  test('a broken stored adult bible stops with invalid_bible, without calling the model', async () => {
    const { call, calls } = fakeCall([])
    const fx = effects()
    const broken = { ...stored, cast: [{ ...ADULT_CAST[0], age: '16' }, ADULT_CAST[1]] }
    const result = await prepareBibleFlow(call, { ...adultBibleInput, bible: broken }, fx.effects)
    if (result.ok) throw new Error('expected failure')
    expect(result.status).toBe(400)
    expect(result.error).toBe('invalid_bible')
    expect(result.detail).toContain('酒寄彩葉 の年齢が 16 歳です')
    expect(calls).toHaveLength(0)
    expect(fx.saved).toEqual([])
  })

  test('without a bible, one is generated and saved with the current input hash', async () => {
    const { call, calls } = fakeCall([{ text: bibleJson(), usage: usage(1) }])
    const fx = effects()
    const result = await prepareBibleFlow(call, { ...adultBibleInput, bible: null }, fx.effects)
    expect(calls).toHaveLength(1)
    if (!result.ok) throw new Error(result.detail)
    expect(fx.saved).toHaveLength(1)
    expect(fx.saved[0]).toEqual({ ...result.bible, source_hash: currentBibleHash(adultBibleInput) })
    expect(fx.recorded).toEqual([[usage(1)]])
  })

  test('a failed generation saves nothing but still reports the usages', async () => {
    const minor = bibleJson({ cast: [{ ...ADULT_CAST[0], age: '15' }, ADULT_CAST[1]] })
    const { call } = fakeCall([
      { text: minor, usage: usage(1) },
      { text: minor, usage: usage(2) }
    ])
    const fx = effects()
    const result = await prepareBibleFlow(call, { ...adultBibleInput, bible: null }, fx.effects)
    if (result.ok) throw new Error('expected failure')
    expect(result.status).toBe(502)
    expect(result.error).toBe('generation_failed')
    expect(fx.saved).toEqual([])
    expect(fx.recorded).toEqual([[usage(1), usage(2)]])
  })

  test('createBibleFlow regenerates even when a bible exists', async () => {
    const { call, calls } = fakeCall([{ text: bibleJson() }])
    const fx = effects()
    const result = await createBibleFlow(call, bibleInput, fx.effects)
    expect(calls).toHaveLength(1)
    expect(result.ok).toBe(true)
    expect(fx.saved).toHaveLength(1)
  })
})

describe('bible source hash', () => {
  test('bibleSourceInput takes the narrator the same way as the prompt', () => {
    const source = bibleSourceInput(bibleInput)
    expect(source).toEqual({
      genre: 'ファンタジー',
      setting: '港町',
      ending: '',
      age_rating: '全年齢',
      pov: '一人称',
      narrator: '酒寄彩葉',
      cast: bibleInput.cast,
      relations: []
    })
    // 多元視点では語り手はいない
    expect(bibleSourceInput({ ...bibleInput, style: { ...bibleInput.style, pov: '三人称多元視点' } }).narrator).toBe('')
  })

  test('bibleOutdated compares the stored hash with the current input', () => {
    const bible: StoryBible = {
      premise: '',
      ending: '',
      arcs: [],
      world: { rules: [], terms: [] },
      timeline: [],
      addresses: [],
      cast: []
    }
    const fresh = { ...bible, source_hash: currentBibleHash(bibleInput) }
    expect(bibleOutdated(fresh, bibleInput)).toBe(false)
    expect(bibleOutdated(fresh, { ...bibleInput, novel: { ...bibleInput.novel, setting: '山奥の村' } })).toBe(true)
    expect(bibleOutdated(fresh, { ...bibleInput, style: { ...bibleInput.style, age_rating: 'R18' } })).toBe(true)
    // 章数と備考は入力に含めない
    expect(bibleOutdated(fresh, { ...bibleInput, novel: { ...bibleInput.novel, num_chapters: 9, notes: '追記' } })).toBe(
      false
    )
    expect(bibleOutdated(null, bibleInput)).toBe(false)
  })
})
