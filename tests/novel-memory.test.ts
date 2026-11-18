import { describe, expect, test } from 'bun:test'
import {
  contextBudgetTokens,
  DEFAULT_CONTEXT_BUDGET_TOKENS,
  estimateTokens,
  KEEP_RECENT_FULL,
  type PriorChapter,
  RECORDED_CHAPTER_CHARS,
  selectPriorChapters,
  TOKENS_PER_CHAR
} from '@/lib/novel/memory'

// 係数 1.0 にすると、見積もりトークン数 = 文字数になって計算が読みやすい。
const TPC = 1

// 本文が chars 字の章。
const chapter = (number: number, chars: number): PriorChapter => ({
  number,
  title: `第${number}章の題`,
  content: 'あ'.repeat(chars)
})

const options = (budgetTokens: number, reservedChars = 0) => ({ budgetTokens, tokensPerChar: TPC, reservedChars })

describe('constants', () => {
  test('conversion factors and defaults', () => {
    expect(TOKENS_PER_CHAR).toEqual({ gemini: 0.65, openai: 1.0 })
    expect(DEFAULT_CONTEXT_BUDGET_TOKENS).toBe(120_000)
    expect(KEEP_RECENT_FULL).toBe(2)
  })
  test('a chapter replaced by a record counts as its heading only', () => {
    expect(RECORDED_CHAPTER_CHARS).toBe(80)
  })
})

describe('contextBudgetTokens', () => {
  test('unknown window uses the default', () => {
    expect(contextBudgetTokens(null)).toBe(120_000)
  })
  test('large window is capped at the default', () => {
    expect(contextBudgetTokens(1_000_000)).toBe(120_000)
    expect(contextBudgetTokens(240_000)).toBe(120_000)
  })
  test('small window gets half, rounded down', () => {
    expect(contextBudgetTokens(32_000)).toBe(16_000)
    expect(contextBudgetTokens(8_001)).toBe(4_000)
  })
  test('a window that cannot be used does not collapse the budget to zero', () => {
    expect(contextBudgetTokens(0)).toBe(120_000)
    expect(contextBudgetTokens(-1)).toBe(120_000)
    expect(contextBudgetTokens(Number.NaN)).toBe(120_000)
  })
})

describe('estimateTokens', () => {
  test('rounds up', () => {
    expect(estimateTokens(1, 0.65)).toBe(1)
    expect(estimateTokens(10, 0.65)).toBe(7)
    expect(estimateTokens(3, 0.5)).toBe(2)
  })
  test('exact products are not bumped by floating point error', () => {
    // 0.65 * 20 は浮動小数点では 13.000000000000002 になる
    expect(estimateTokens(20, 0.65)).toBe(13)
    expect(estimateTokens(2000, 0.65)).toBe(1300)
  })
  test('zero chars is zero tokens', () => {
    expect(estimateTokens(0, 0.65)).toBe(0)
  })
  test('openai factor is one token per char', () => {
    expect(estimateTokens(1234, TOKENS_PER_CHAR.openai)).toBe(1234)
  })
})

describe('selectPriorChapters', () => {
  const four = [chapter(1, 1000), chapter(2, 1000), chapter(3, 1000), chapter(4, 1000)]
  const five = [...four, chapter(5, 1000)]

  test('keeps every chapter in full while within budget', () => {
    expect(selectPriorChapters(four, options(4000))).toEqual({ full: [1, 2, 3, 4], recorded: [] })
  })

  test('the budget is inclusive', () => {
    const three = [chapter(1, 1000), chapter(2, 1000), chapter(3, 1000)]
    expect(selectPriorChapters(three, options(3000)).recorded).toEqual([])
    expect(selectPriorChapters(three, options(2999)).recorded).toEqual([1])
  })

  test('replaces the oldest chapters with records first', () => {
    // 全文 5000。古い順に 1 章を見出し(80)にすると 4080、2 章で 3160、3 章で 2240。
    expect(selectPriorChapters(five, options(4080))).toEqual({ full: [2, 3, 4, 5], recorded: [1] })
    expect(selectPriorChapters(five, options(4079))).toEqual({ full: [3, 4, 5], recorded: [1, 2] })
    expect(selectPriorChapters(five, options(3160))).toEqual({ full: [3, 4, 5], recorded: [1, 2] })
    expect(selectPriorChapters(five, options(3159))).toEqual({ full: [4, 5], recorded: [1, 2, 3] })
  })

  test('stops replacing as soon as the budget is met', () => {
    expect(selectPriorChapters(five, options(3500))).toEqual({ full: [3, 4, 5], recorded: [1, 2] })
  })

  test('a replaced chapter is estimated at RECORDED_CHAPTER_CHARS whatever its length', () => {
    // 第 1 章だけ 5000 字。全文 8000。第 1 章を見出しにすると 8000 - 5000 + 80 = 3080
    const prior = [chapter(1, 5000), chapter(2, 1000), chapter(3, 1000), chapter(4, 1000)]
    expect(selectPriorChapters(prior, options(3080)).recorded).toEqual([1])
    // 次の第 2 章も見出しにすると 3080 - 1000 + 80 = 2160
    expect(selectPriorChapters(prior, options(3079)).recorded).toEqual([1, 2])
  })

  test('chapters are still replaced oldest first even when a chapter is shorter than a heading', () => {
    // 第 1 章は 20 字なので、見出しにすると増える (3020 -> 3080)。それでも古い順に回し、次の章で収める
    const prior = [chapter(1, 20), chapter(2, 1000), chapter(3, 1000), chapter(4, 1000)]
    expect(selectPriorChapters(prior, options(3000)).recorded).toEqual([1, 2])
  })

  test('the most recent two chapters stay in full even over budget', () => {
    expect(selectPriorChapters(four, options(1))).toEqual({ full: [3, 4], recorded: [1, 2] })
  })

  test('with two or fewer chapters nothing is replaced', () => {
    expect(selectPriorChapters([chapter(1, 5000)], options(1))).toEqual({ full: [1], recorded: [] })
    expect(selectPriorChapters([chapter(1, 5000), chapter(2, 5000)], options(1))).toEqual({
      full: [1, 2],
      recorded: []
    })
  })

  test('keepRecent is configurable', () => {
    expect(selectPriorChapters(four, { ...options(1), keepRecent: 1 })).toEqual({ full: [4], recorded: [1, 2, 3] })
    expect(selectPriorChapters(four, { ...options(1), keepRecent: 3 })).toEqual({ full: [2, 3, 4], recorded: [1] })
    expect(selectPriorChapters(four, { ...options(1), keepRecent: 10 })).toEqual({
      full: [1, 2, 3, 4],
      recorded: []
    })
    expect(selectPriorChapters(four, { ...options(1), keepRecent: 0 })).toEqual({ full: [], recorded: [1, 2, 3, 4] })
  })

  test('reservedChars (including the ledger) counts against the budget', () => {
    expect(selectPriorChapters(four, options(4000, 0)).recorded).toEqual([])
    expect(selectPriorChapters(four, options(4000, 1)).recorded).toEqual([1])
    // 予約 1000 + 全文 4000 = 5000。1 章で 4080、2 章で 3160 ≤ 4000
    expect(selectPriorChapters(four, options(4000, 1000)).recorded).toEqual([1, 2])
  })

  test('tokensPerChar scales the estimate', () => {
    // 全文 4000 字 × 0.65 = 2600 トークンちょうど
    expect(
      selectPriorChapters(four, { budgetTokens: 2600, tokensPerChar: TOKENS_PER_CHAR.gemini, reservedChars: 0 })
        .recorded
    ).toEqual([])
    // 同じ予算でも係数 1.0 なら 4000 トークンで超える。1 章を見出しにして 3080、2 章で 2160 ≤ 2600
    expect(
      selectPriorChapters(four, { budgetTokens: 2600, tokensPerChar: TOKENS_PER_CHAR.openai, reservedChars: 0 })
        .recorded
    ).toEqual([1, 2])
  })

  test('is independent of input order and does not mutate the input', () => {
    const prior = [chapter(3, 1000), chapter(1, 1000), chapter(4, 1000), chapter(2, 1000)]
    const snapshot = prior.map((entry) => entry.number)
    // 全文 4000。1 章を見出しにして 3080 (> 3000)、2 章で 2160
    const result = selectPriorChapters(prior, options(3000))
    expect(result).toEqual({ full: [3, 4], recorded: [1, 2] })
    expect(prior.map((entry) => entry.number)).toEqual(snapshot)
    expect(selectPriorChapters([...prior].reverse(), options(3000))).toEqual(result)
  })

  test('full and recorded are sorted and together cover every chapter', () => {
    const prior = [chapter(5, 800), chapter(2, 1200), chapter(9, 400), chapter(1, 3000), chapter(7, 900)]
    // 昇順は 1(3000) 2(1200) 5(800) 7(900) 9(400)。予約 300 + 全文 6300 = 6600
    // 1 章で 3680、2 章で 2560、3 章で 1840 ≤ 2000
    const result = selectPriorChapters(prior, options(2000, 300))
    expect(result).toEqual({ full: [7, 9], recorded: [1, 2, 5] })
    expect([...result.recorded, ...result.full].sort((a, b) => a - b)).toEqual([1, 2, 5, 7, 9])
  })

  test('empty input gives empty selection', () => {
    expect(selectPriorChapters([], options(0, 100))).toEqual({ full: [], recorded: [] })
  })

  test('uses the default keepRecent when none is given', () => {
    const prior = Array.from({ length: 6 }, (_, index) => chapter(index + 1, 1000))
    const result = selectPriorChapters(prior, options(0))
    expect(result.full).toHaveLength(KEEP_RECENT_FULL)
    expect(result.full).toEqual([5, 6])
  })
})
