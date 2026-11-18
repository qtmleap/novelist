import { describe, expect, test } from 'bun:test'
import {
  extractRecordFlow,
  generateOutlineFlow,
  type JsonCaller,
  type JsonCallOptions,
  type OutlineFlowInput,
  outlineTimeoutMs,
  type RecordFlowInput,
  regenerateOutlineChapterFlow,
  regenerateOutlineChapters,
  replaceOutlineChapter
} from '@/lib/novel/assist'
import { buildRecordPrompt } from '@/lib/novel/assist-prompts'
import { recordJsonSchema } from '@/lib/novel/json-schemas'
import { outlineChapterJsonSchema, outlineJsonSchema } from '@/lib/novel/outline'
import { buildOutlineChapterPrompt, buildOutlinePrompt, type CastMember, type Prompt } from '@/lib/novel/prompts'
import type { UsageCounts } from '@/lib/openai/protocol'
import type { Outline } from '@/schemas/novel.dto'

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
  alwaysInclude: []
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
      characters: c.characters === undefined ? ['月見ヤチヨ'] : c.characters
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
    chapters: [1, 2, 3].map((n) => ({
      chapter_number: n,
      title: `旧${n}`,
      summary: `旧概要${n}`,
      characters: ['月見ヤチヨ']
    }))
  }
  const chapterInput = { ...input, existing, chapterNumber: 2 }

  function chapterJson(chapter: { chapter_number: number; title: string; characters?: string[] }): string {
    return JSON.stringify({
      ...chapter,
      summary: '新しい概要',
      characters: chapter.characters === undefined ? ['月見ヤチヨ'] : chapter.characters
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
      chapters: [1, 2, 3].map((n) => ({ chapter_number: n, title: `返答${n}`, summary: `概要${n}`, characters: [] }))
    })
    const { call, calls } = fakeCall([{ text }])
    const result = await regenerateOutlineChapterFlow(call, chapterInput)
    expect(calls).toHaveLength(1)
    if (!result.ok) throw new Error(result.error)
    expect(result.chapter).toMatchObject({ chapter_number: 2, title: '返答2', summary: '概要2' })
  })

  test('picks the target chapter from a bare array too', async () => {
    const text = JSON.stringify(
      [3, 2].map((n) => ({ chapter_number: n, title: `返答${n}`, summary: `概要${n}`, characters: [] }))
    )
    const { call } = fakeCall([{ text }])
    const result = await regenerateOutlineChapterFlow(call, chapterInput)
    if (!result.ok) throw new Error(result.error)
    expect(result.chapter.title).toBe('返答2')
  })

  test('retries when several chapters come back without the target', async () => {
    const others = JSON.stringify({
      chapters: [1, 3].map((n) => ({ chapter_number: n, title: `返答${n}`, summary: `概要${n}`, characters: [] }))
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
      chapters: [1, 3].map((n) => ({ chapter_number: n, title: `返答${n}`, summary: `概要${n}`, characters: [] }))
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
    const text = JSON.stringify({ chapters: [{ chapter_number: 2, title: '題', summary: '概要', characters: [] }] })
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
    return { chapter_number: n, title, summary: `概要${n}`, characters: [] }
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
    chapters: [1, 2, 3].map((n) => ({
      chapter_number: n,
      title: `旧${n}`,
      summary: `旧概要${n}`,
      characters: ['月見ヤチヨ']
    }))
  }

  function reply(n: number, title: string, characters: string[] = ['月見ヤチヨ']): string {
    return JSON.stringify({ chapter_number: n, title, summary: `新しい概要${n}`, characters })
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
      chapter_number: 1,
      title: '新しい題1',
      summary: '新しい概要1',
      characters: ['月見ヤチヨ']
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

  test('passes the prompt, op, schema and a 60 second timeout to call', async () => {
    const { call, calls } = fakeCall([{ text: draftJson() }])
    await extractRecordFlow(call, recordInput)
    expect(calls[0].prompt).toEqual(buildRecordPrompt(recordInput))
    expect(calls[0].options).toEqual({
      op: 'extractRecord',
      schema: recordJsonSchema({ castNames: ['酒寄彩葉', '月見ヤチヨ'], openThreadIds: ['s1'], plannedSetupIds: [] }),
      timeoutMs: 60_000
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
