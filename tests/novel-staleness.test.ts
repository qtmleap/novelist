import { describe, expect, test } from 'bun:test'
import { canonicalJson, stableHash } from '@/lib/novel/hash'
import {
  computeStaleness,
  missingPredecessors,
  normalizeTargets,
  type OutlineEntryForHash,
  outlineEntryHash,
  type StalenessChapter
} from '@/lib/novel/staleness'

describe('canonicalJson', () => {
  test('sorts object keys regardless of insertion order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(canonicalJson({ a: 2, b: 1 })).toBe(canonicalJson({ b: 1, a: 2 }))
  })
  test('sorts nested keys, including objects inside arrays', () => {
    const left = { x: { b: 1, a: [{ d: 1, c: 2 }] } }
    const right = { x: { a: [{ c: 2, d: 1 }], b: 1 } }
    expect(canonicalJson(left)).toBe('{"x":{"a":[{"c":2,"d":1}],"b":1}}')
    expect(canonicalJson(left)).toBe(canonicalJson(right))
  })
  test('keeps array order', () => {
    expect(canonicalJson([1, 2, 3])).toBe('[1,2,3]')
    expect(canonicalJson([3, 2, 1])).not.toBe(canonicalJson([1, 2, 3]))
  })
  test('drops keys whose value is undefined, keeps null', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}')
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }))
    expect(canonicalJson({ a: 1, b: null })).toBe('{"a":1,"b":null}')
  })
  test('undefined inside an array and at the top level becomes null, like JSON.stringify', () => {
    expect(canonicalJson([1, undefined])).toBe('[1,null]')
    expect(canonicalJson(undefined)).toBe('null')
  })
  test('primitives and Japanese text', () => {
    expect(canonicalJson('吾輩は猫である')).toBe('"吾輩は猫である"')
    expect(canonicalJson(1.5)).toBe('1.5')
    expect(canonicalJson(true)).toBe('true')
    expect(canonicalJson(null)).toBe('null')
    expect(canonicalJson({ 題: '猫', '': 1 })).toBe('{"":1,"題":"猫"}')
  })
})

describe('stableHash', () => {
  test('is 16 lowercase hex digits', () => {
    const values: unknown[] = ['', 'a', 0, null, undefined, [], {}, { a: 1 }, '吾輩は猫である', 'x'.repeat(10_000)]
    for (const value of values) {
      expect(stableHash(value)).toMatch(/^[0-9a-f]{16}$/)
    }
  })
  test('does not depend on key order', () => {
    expect(stableHash({ a: 1, b: { c: 2, d: 3 } })).toBe(stableHash({ b: { d: 3, c: 2 }, a: 1 }))
  })
  test('depends on array order', () => {
    expect(stableHash(['a', 'b'])).not.toBe(stableHash(['b', 'a']))
  })
  test('ignores undefined keys', () => {
    expect(stableHash({ a: 1, b: undefined })).toBe(stableHash({ a: 1 }))
  })
  test('handles Japanese and is stable for equal content', () => {
    expect(stableHash({ title: '吾輩は猫である' })).toBe(stableHash({ title: '吾輩は猫である' }))
    expect(stableHash({ title: '吾輩は猫である' })).not.toBe(stableHash({ title: '吾輩は猫でない' }))
    expect(stableHash('🐈')).toMatch(/^[0-9a-f]{16}$/)
  })
  test('different values give different hashes', () => {
    const values: unknown[] = [
      '',
      'a',
      'b',
      0,
      1,
      '1',
      null,
      false,
      [],
      {},
      [[]],
      [{}],
      { a: 1 },
      { a: 2 },
      { b: 1 },
      { a: null },
      { a: '' }
    ]
    const hashes = new Set(values.map((value) => stableHash(value)))
    expect(hashes.size).toBe(values.length)
  })
  test('is a fixed value (pinned so that the hash does not drift between runtimes or releases)', () => {
    // FNV-1a 64 ビットを '"a"' (canonicalJson('a')) の UTF-8 バイト列にかけた値
    expect(stableHash('a')).toBe('d4272417d7c77eea')
  })
})

const entry = (overrides: Partial<OutlineEntryForHash> = {}): OutlineEntryForHash => ({
  title: '出会い',
  summary: '主人公が町で少女と出会う。',
  characters: ['太郎', '花子'],
  ...overrides
})

describe('outlineEntryHash', () => {
  test('a missing field is the same as its default value', () => {
    const base = entry()
    const full = entry({ events: [], time_place: '', end_state: '', setups: [], payoffs: [] })
    expect(outlineEntryHash(base)).toBe(outlineEntryHash(full))
    expect(outlineEntryHash(entry({ events: undefined }))).toBe(outlineEntryHash(entry({ events: [] })))
    expect(outlineEntryHash(entry({ time_place: undefined }))).toBe(outlineEntryHash(entry({ time_place: '' })))
    expect(outlineEntryHash(entry({ setups: undefined }))).toBe(outlineEntryHash(entry({ setups: [] })))
  })
  test('is 16 hex digits', () => {
    expect(outlineEntryHash(entry())).toMatch(/^[0-9a-f]{16}$/)
  })
  test('ignores the order of characters and payoffs', () => {
    expect(outlineEntryHash(entry({ characters: ['花子', '太郎'] }))).toBe(outlineEntryHash(entry()))
    expect(outlineEntryHash(entry({ payoffs: ['s1', 's2'] }))).toBe(outlineEntryHash(entry({ payoffs: ['s2', 's1'] })))
  })
  test('the order of events matters', () => {
    expect(outlineEntryHash(entry({ events: ['a', 'b'] }))).not.toBe(outlineEntryHash(entry({ events: ['b', 'a'] })))
  })
  test('the order of setups matters', () => {
    const a = { id: 's1', description: '古い鍵' }
    const b = { id: 's2', description: '壊れた時計' }
    expect(outlineEntryHash(entry({ setups: [a, b] }))).not.toBe(outlineEntryHash(entry({ setups: [b, a] })))
  })
  test('changes when any covered field changes', () => {
    const base = outlineEntryHash(entry())
    const changed = [
      entry({ title: '別れ' }),
      entry({ summary: '主人公が町で少女と別れる。' }),
      entry({ characters: ['太郎'] }),
      entry({ characters: ['太郎', '花子', '次郎'] }),
      entry({ events: ['事件'] }),
      entry({ time_place: '夕方の駅' }),
      entry({ end_state: '二人は別々に帰る' }),
      entry({ setups: [{ id: 's1', description: '古い鍵' }] }),
      entry({ payoffs: ['s1'] })
    ]
    const hashes = changed.map((value) => outlineEntryHash(value))
    for (const hash of hashes) {
      expect(hash).not.toBe(base)
    }
    expect(new Set(hashes).size).toBe(changed.length)
  })
  test('a setup id and description are both part of the hash', () => {
    const base = outlineEntryHash(entry({ setups: [{ id: 's1', description: '古い鍵' }] }))
    expect(outlineEntryHash(entry({ setups: [{ id: 's2', description: '古い鍵' }] }))).not.toBe(base)
    expect(outlineEntryHash(entry({ setups: [{ id: 's1', description: '新しい鍵' }] }))).not.toBe(base)
  })
  test('ignores keys that are not covered', () => {
    const extra = { ...entry(), chapter_number: 3, notes: 'x', id: 'abc' }
    expect(outlineEntryHash(extra)).toBe(outlineEntryHash(entry()))
    const renumbered = { ...extra, chapter_number: 9 }
    expect(outlineEntryHash(renumbered)).toBe(outlineEntryHash(extra))
  })
  test('ignores leading and trailing whitespace', () => {
    const padded = entry({
      title: '  出会い\n',
      summary: '\t主人公が町で少女と出会う。 ',
      characters: [' 太郎', '花子  '],
      events: [' a '],
      time_place: ' 駅 ',
      end_state: '\n終わり\n',
      setups: [{ id: ' s1 ', description: ' 古い鍵 ' }],
      payoffs: [' p1 ']
    })
    const trimmed = entry({
      events: ['a'],
      time_place: '駅',
      end_state: '終わり',
      setups: [{ id: 's1', description: '古い鍵' }],
      payoffs: ['p1']
    })
    expect(outlineEntryHash(padded)).toBe(outlineEntryHash(trimmed))
  })
  test('whitespace inside a text still matters', () => {
    expect(outlineEntryHash(entry({ summary: '主人公が 町で少女と出会う。' }))).not.toBe(outlineEntryHash(entry()))
  })
})

// 第 1〜n 章がすべて新しい状態の最新 version。id は c<番号>、n 章の prev は c<n-1>。
const freshChapters = (count: number): StalenessChapter[] =>
  Array.from({ length: count }, (_, index) => ({
    number: index + 1,
    id: `c${index + 1}`,
    outlineHash: `h${index + 1}`,
    prevChapterId: index === 0 ? null : `c${index}`
  }))

const currentHashes = (count: number): Map<number, string> =>
  new Map(Array.from({ length: count }, (_, index) => [index + 1, `h${index + 1}`]))

const reasonsOf = (result: Map<number, { reasons: string[] }>): Record<number, string[]> =>
  Object.fromEntries([...result.entries()].map(([number, value]) => [number, value.reasons]))

describe('computeStaleness', () => {
  test('nothing is stale when everything is up to date', () => {
    const result = computeStaleness(freshChapters(4), currentHashes(4))
    expect(result.size).toBe(4)
    for (const number of [1, 2, 3, 4]) {
      expect(result.get(number)).toEqual({ stale: false, reasons: [] })
    }
  })
  test('an empty chapter list gives an empty result', () => {
    expect(computeStaleness([], new Map()).size).toBe(0)
  })
  test('a changed outline marks that chapter and chains to the following ones', () => {
    const hashes = currentHashes(5)
    hashes.set(3, 'h3-new')
    const result = computeStaleness(freshChapters(5), hashes)
    expect(reasonsOf(result)).toEqual({
      1: [],
      2: [],
      3: ['outline_changed'],
      4: ['previous_stale'],
      5: ['previous_stale']
    })
    expect(result.get(2)?.stale).toBe(false)
    expect(result.get(3)?.stale).toBe(true)
    expect(result.get(5)?.stale).toBe(true)
  })
  test('regenerating a middle chapter marks the next one as previous_regenerated and the rest as previous_stale', () => {
    // 第 3 章を作り直して id が c3 から c3-v2 に変わった。第 4 章は c3 から作ったまま。
    const chapters = freshChapters(5).map((chapter) => (chapter.number === 3 ? { ...chapter, id: 'c3-v2' } : chapter))
    const result = computeStaleness(chapters, currentHashes(5))
    expect(reasonsOf(result)).toEqual({
      1: [],
      2: [],
      3: [],
      4: ['previous_regenerated'],
      5: ['previous_stale']
    })
  })
  test('regenerating the next chapter as well keeps that chapter clean, so previous_stale does not propagate from it', () => {
    const chapters = freshChapters(5).map((chapter) => {
      if (chapter.number === 3) return { ...chapter, id: 'c3-v2' }
      // 第 4 章も作り直した: 新しい id で、第 3 章の新しい version から作った
      if (chapter.number === 4) return { ...chapter, id: 'c4-v2', prevChapterId: 'c3-v2' }
      return chapter
    })
    const result = computeStaleness(chapters, currentHashes(5))
    // 第 4 章は新しい第 3 章から作り直したので stale ではない。第 5 章は c4 から作ったままなので previous_regenerated
    // だけが付き (第 4 章が stale ではないので previous_stale は付かない)、第 5 章より後ろがあればそこで連鎖が止まる
    expect(reasonsOf(result)).toEqual({
      1: [],
      2: [],
      3: [],
      4: [],
      5: ['previous_regenerated']
    })
  })
  test('regenerating every following chapter leaves nothing stale', () => {
    const chapters: StalenessChapter[] = [
      { number: 1, id: 'c1', outlineHash: 'h1', prevChapterId: null },
      { number: 2, id: 'c2-v2', outlineHash: 'h2', prevChapterId: 'c1' },
      { number: 3, id: 'c3-v2', outlineHash: 'h3', prevChapterId: 'c2-v2' },
      { number: 4, id: 'c4-v2', outlineHash: 'h4', prevChapterId: 'c3-v2' }
    ]
    const result = computeStaleness(chapters, currentHashes(4))
    expect([...result.values()].every((value) => !value.stale)).toBe(true)
  })
  test('a chapter that is both outline_changed and previous_regenerated lists both reasons', () => {
    const chapters = freshChapters(3).map((chapter) => (chapter.number === 2 ? { ...chapter, id: 'c2-v2' } : chapter))
    const hashes = currentHashes(3)
    hashes.set(3, 'h3-new')
    const result = computeStaleness(chapters, hashes)
    expect(result.get(3)).toEqual({ stale: true, reasons: ['outline_changed', 'previous_regenerated'] })
  })
  test('reasons come in a fixed order: outline_changed, previous_regenerated, previous_stale', () => {
    // 第 2 章が章立ての変更で stale、第 3 章は 3 つの理由すべてに当てはまる
    const chapters: StalenessChapter[] = [
      { number: 1, id: 'c1', outlineHash: 'h1', prevChapterId: null },
      { number: 2, id: 'c2', outlineHash: 'h2', prevChapterId: 'c1' },
      { number: 3, id: 'c3', outlineHash: 'h3', prevChapterId: 'c2-old' }
    ]
    const hashes = new Map([
      [1, 'h1'],
      [2, 'h2-new'],
      [3, 'h3-new']
    ])
    const result = computeStaleness(chapters, hashes)
    expect(result.get(2)?.reasons).toEqual(['outline_changed'])
    expect(result.get(3)?.reasons).toEqual(['outline_changed', 'previous_regenerated', 'previous_stale'])
  })
  test('null values are not judged', () => {
    // この機能より前に作られた章: outlineHash も prevChapterId も null。章立てが変わっていても stale にしない。
    const chapters: StalenessChapter[] = [
      { number: 1, id: 'c1', outlineHash: null, prevChapterId: null },
      { number: 2, id: 'c2', outlineHash: null, prevChapterId: null },
      { number: 3, id: 'c3', outlineHash: null, prevChapterId: null }
    ]
    const hashes = new Map([
      [1, 'x'],
      [2, 'y'],
      [3, 'z']
    ])
    const result = computeStaleness(chapters, hashes)
    expect(reasonsOf(result)).toEqual({ 1: [], 2: [], 3: [] })
  })
  test('null values mixed with recorded values judge only the recorded ones', () => {
    const chapters: StalenessChapter[] = [
      { number: 1, id: 'c1', outlineHash: null, prevChapterId: null },
      { number: 2, id: 'c2', outlineHash: 'h2', prevChapterId: null },
      { number: 3, id: 'c3', outlineHash: null, prevChapterId: 'c2' }
    ]
    const hashes = new Map([
      [1, 'changed'],
      [2, 'h2-new'],
      [3, 'changed']
    ])
    const result = computeStaleness(chapters, hashes)
    expect(reasonsOf(result)).toEqual({ 1: [], 2: ['outline_changed'], 3: ['previous_stale'] })
  })
  test('a stale chapter before a chapter with null values still chains previous_stale', () => {
    const chapters: StalenessChapter[] = [
      { number: 1, id: 'c1', outlineHash: 'h1', prevChapterId: null },
      { number: 2, id: 'c2', outlineHash: null, prevChapterId: null }
    ]
    const result = computeStaleness(chapters, new Map([[1, 'h1-new']]))
    expect(reasonsOf(result)).toEqual({ 1: ['outline_changed'], 2: ['previous_stale'] })
  })
  test('the first chapter has no previous chapter to judge', () => {
    // 第 1 章の prevChapterId が (本来は null だが) 入っていても previous_regenerated にはしない
    const chapters: StalenessChapter[] = [{ number: 1, id: 'c1', outlineHash: 'h1', prevChapterId: 'something' }]
    expect(computeStaleness(chapters, currentHashes(1)).get(1)).toEqual({ stale: false, reasons: [] })
  })
  test('a missing previous chapter counts as previous_regenerated, not previous_stale', () => {
    // 第 2 章が消えている (第 3 章は c2 から作った)
    const chapters = freshChapters(4).filter((chapter) => chapter.number !== 2)
    const result = computeStaleness(chapters, currentHashes(4))
    expect(result.has(2)).toBe(false)
    expect(result.get(1)).toEqual({ stale: false, reasons: [] })
    expect(result.get(3)).toEqual({ stale: true, reasons: ['previous_regenerated'] })
    expect(result.get(4)).toEqual({ stale: true, reasons: ['previous_stale'] })
  })
  test('a missing previous chapter is not judged when prevChapterId is null', () => {
    const chapters: StalenessChapter[] = [
      { number: 1, id: 'c1', outlineHash: 'h1', prevChapterId: null },
      { number: 3, id: 'c3', outlineHash: 'h3', prevChapterId: null }
    ]
    const result = computeStaleness(chapters, currentHashes(3))
    expect(reasonsOf(result)).toEqual({ 1: [], 3: [] })
  })
  test('a chapter that is missing from the current outline is outline_changed', () => {
    const hashes = currentHashes(3)
    hashes.delete(3)
    const result = computeStaleness(freshChapters(3), hashes)
    expect(reasonsOf(result)).toEqual({ 1: [], 2: [], 3: ['outline_changed'] })
  })
  test('an empty outline marks every chapter that recorded a hash', () => {
    const result = computeStaleness(freshChapters(3), new Map())
    expect(reasonsOf(result)).toEqual({
      1: ['outline_changed'],
      2: ['outline_changed', 'previous_stale'],
      3: ['outline_changed', 'previous_stale']
    })
  })
  test('does not depend on the order of the input', () => {
    const hashes = currentHashes(5)
    hashes.set(2, 'h2-new')
    const chapters = freshChapters(5).map((chapter) => (chapter.number === 4 ? { ...chapter, id: 'c4-v2' } : chapter))
    const expected = computeStaleness(chapters, hashes)
    // 番号 1〜5 を 5, 3, 1, 4, 2 の順に並べ替える (昇順でも降順でもない並び)
    const shuffled = [...chapters].sort((a, b) => ((a.number * 7) % 5) - ((b.number * 7) % 5))
    const reversed = [...chapters].reverse()
    expect(reasonsOf(computeStaleness(shuffled, hashes))).toEqual(reasonsOf(expected))
    expect(reasonsOf(computeStaleness(reversed, hashes))).toEqual(reasonsOf(expected))
    expect(reasonsOf(expected)).toEqual({
      1: [],
      2: ['outline_changed'],
      3: ['previous_stale'],
      4: ['previous_stale'],
      5: ['previous_regenerated', 'previous_stale']
    })
  })
  test('does not modify the input', () => {
    const chapters = freshChapters(3).reverse()
    const before = JSON.stringify(chapters)
    computeStaleness(chapters, currentHashes(3))
    expect(JSON.stringify(chapters)).toBe(before)
  })
  test('works with hashes produced by outlineEntryHash', () => {
    const first = entry()
    const second = entry({ title: '再会', summary: '二人が再会する。' })
    const hashes = new Map([
      [1, outlineEntryHash(first)],
      [2, outlineEntryHash(second)]
    ])
    const chapters: StalenessChapter[] = [
      { number: 1, id: 'c1', outlineHash: outlineEntryHash(first), prevChapterId: null },
      { number: 2, id: 'c2', outlineHash: outlineEntryHash(second), prevChapterId: 'c1' }
    ]
    expect(computeStaleness(chapters, hashes).get(2)).toEqual({ stale: false, reasons: [] })
    // 第 1 章の登場人物の並びを変えただけでは変更にならず、概要を変えると変更になる
    const reordered = new Map(hashes)
    reordered.set(1, outlineEntryHash(entry({ characters: ['花子', '太郎'] })))
    expect(computeStaleness(chapters, reordered).get(1)?.stale).toBe(false)
    const rewritten = new Map(hashes)
    rewritten.set(1, outlineEntryHash(entry({ summary: '書き換えた概要' })))
    expect(reasonsOf(computeStaleness(chapters, rewritten))).toEqual({
      1: ['outline_changed'],
      2: ['previous_stale']
    })
  })
})

describe('normalizeTargets', () => {
  test('removes duplicates and sorts ascending', () => {
    expect(normalizeTargets([3, 1, 2, 3, 1])).toEqual([1, 2, 3])
    expect(normalizeTargets([10, 9, 2])).toEqual([2, 9, 10])
  })
  test('drops values below 1', () => {
    expect(normalizeTargets([0, -1, 2, -5])).toEqual([2])
  })
  test('drops non-integers', () => {
    expect(normalizeTargets([1.5, 2, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 3])).toEqual([
      2, 3
    ])
  })
  test('empty stays empty', () => {
    expect(normalizeTargets([])).toEqual([])
    expect(normalizeTargets([0, -1])).toEqual([])
  })
  test('does not modify the input', () => {
    const targets = [3, 1, 3]
    normalizeTargets(targets)
    expect(targets).toEqual([3, 1, 3])
  })
})

describe('missingPredecessors', () => {
  test('returns the chapters before the last target that have no body and are not targets', () => {
    expect(missingPredecessors([5], new Set([1, 2]))).toEqual([3, 4])
    expect(missingPredecessors([5], new Set())).toEqual([1, 2, 3, 4])
  })
  test('chapters in the same batch count as present', () => {
    expect(missingPredecessors([3, 4, 5], new Set([1, 2]))).toEqual([])
    expect(missingPredecessors([1, 2, 3], new Set())).toEqual([])
    expect(missingPredecessors([2, 4], new Set([1]))).toEqual([3])
  })
  test('regenerating a chapter that already has a body is fine', () => {
    expect(missingPredecessors([3], new Set([1, 2, 3, 4]))).toEqual([])
  })
  test('chapters after the last target are not required', () => {
    expect(missingPredecessors([2], new Set([1, 3, 4]))).toEqual([])
  })
  test('the first chapter has no predecessors', () => {
    expect(missingPredecessors([1], new Set())).toEqual([])
  })
  test('empty targets give an empty result', () => {
    expect(missingPredecessors([], new Set())).toEqual([])
    expect(missingPredecessors([], new Set([1, 2]))).toEqual([])
  })
  test('unsorted, duplicated or invalid targets are normalized first', () => {
    expect(missingPredecessors([5, 5, 3, 0, -2, 1.5], new Set([1]))).toEqual([2, 4])
    expect(missingPredecessors([0, -1], new Set())).toEqual([])
  })
  test('the result is ascending', () => {
    expect(missingPredecessors([8, 2], new Set([4, 6]))).toEqual([1, 3, 5, 7])
  })
})
