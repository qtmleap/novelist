import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChapterReviewView, hasMinorTermWarning, MINOR_TERM_NOTE } from '@/components/novel/ChapterReviewView'
import type { ChapterReview } from '@/schemas/story.dto'

const review = (overrides: Partial<ChapterReview>): ChapterReview => ({
  checks: [],
  issues: [],
  reviewed: true,
  ...overrides
})

const minorTerm = { kind: 'minor_term' as const, message: '成人指定の作品ですが、本文に未成年を指す語があります: 高校生' }
const length = { kind: 'length' as const, message: '文字数が目標より少ない' }
const issue = { kind: 'address' as const, quote: '先輩', reason: '呼び方が違う' }

const render = (r: ChapterReview, selectable: boolean) =>
  renderToStaticMarkup(
    createElement(ChapterReviewView, selectable ? { review: r, selectedIssues: new Set<number>(), onToggleIssue: () => {} } : { review: r })
  )

describe('hasMinorTermWarning', () => {
  test('minor_term の警告があるときだけ true', () => {
    expect(hasMinorTermWarning(review({ checks: [length, minorTerm] }))).toBe(true)
    expect(hasMinorTermWarning(review({ checks: [length] }))).toBe(false)
    expect(hasMinorTermWarning(review({ issues: [issue] }))).toBe(false)
    expect(hasMinorTermWarning(null)).toBe(false)
  })
})

describe('ChapterReviewView の minor_term', () => {
  test('警告の近くに再生成の案内を出す', () => {
    const html = render(review({ checks: [minorTerm] }), true)
    expect(html).toContain(minorTerm.message)
    expect(html).toContain(MINOR_TERM_NOTE)
    // 色だけに頼らず、アイコンも付ける。
    expect(html).toContain('lucide-triangle-alert')
  })

  test('ほかの警告には案内を出さない', () => {
    const html = render(review({ checks: [length] }), true)
    expect(html).not.toContain(MINOR_TERM_NOTE)
  })

  test('案内は minor_term の警告の数だけ出る', () => {
    const html = render(review({ checks: [minorTerm, length] }), false)
    expect(html.split(MINOR_TERM_NOTE).length - 1).toBe(1)
  })

  test('書き直しに選べるのは内容の指摘だけで、機械的な検査にはチェックボックスが付かない', () => {
    const html = render(review({ checks: [minorTerm, length], issues: [issue] }), true)
    expect(html.match(/role="checkbox"/g)?.length).toBe(1)
    const onlyChecks = render(review({ checks: [minorTerm, length] }), true)
    expect(onlyChecks).not.toContain('role="checkbox"')
  })
})
