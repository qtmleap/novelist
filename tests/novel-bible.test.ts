import { describe, expect, test } from 'bun:test'
import {
  ADDRESS_ALL_PAIRS_MAX_CAST,
  ADDRESS_MAX_ROWS,
  addressesFor,
  applyBibleCast,
  type BibleCastInput,
  type BibleRelationInput,
  type BibleSourceInput,
  bibleSourceHash,
  callsByName,
  completeAddresses,
  isAddressPattern,
  isAdultRating,
  missingAddressPairs,
  findMinorTerms,
  locateMinorTerms,
  normalizeForMinorScan,
  parseExactAge,
  requiredAddressPairs,
  validateAdultBibleText,
  validateAdultCast
} from '@/lib/novel/bible'
import { ADDRESS_STYLES } from '@/schemas/character.dto'
import type { AddressEntry, BibleCast } from '@/schemas/story.dto'

describe('isAddressPattern', () => {
  test('a bare 名前 or 苗字 is a pattern', () => {
    expect(isAddressPattern('名前')).toBe(true)
    expect(isAddressPattern('苗字')).toBe(true)
  })
  test('a pattern with an honorific after ＋ is a pattern', () => {
    expect(isAddressPattern('苗字＋さん')).toBe(true)
    expect(isAddressPattern('名前＋ちゃん')).toBe(true)
    expect(isAddressPattern('苗字＋先輩')).toBe(true)
  })
  test('a hand-written pattern that is not in ADDRESS_STYLES is a pattern too', () => {
    expect(isAddressPattern('苗字＋先生')).toBe(true)
    expect(isAddressPattern('名前＋くん')).toBe(true)
    expect(isAddressPattern('名前＋様')).toBe(true)
  })
  test('a half-width + is accepted', () => {
    expect(isAddressPattern('苗字+先生')).toBe(true)
    expect(isAddressPattern('名前+さん')).toBe(true)
  })
  test('ignores surrounding whitespace', () => {
    expect(isAddressPattern(' 苗字＋さん ')).toBe(true)
    expect(isAddressPattern('\n名前\t')).toBe(true)
  })
  test('every ADDRESS_STYLES value except 君 is a pattern', () => {
    for (const style of ADDRESS_STYLES) {
      expect(isAddressPattern(style)).toBe(style !== '君')
    }
  })
  test('a call that does not use the name is not a pattern', () => {
    expect(isAddressPattern('君')).toBe(false)
    expect(isAddressPattern('いろP')).toBe(false)
    expect(isAddressPattern('先輩')).toBe(false)
    expect(isAddressPattern('お兄ちゃん')).toBe(false)
    expect(isAddressPattern('花子さん')).toBe(false)
  })
  test('the empty string is not a pattern', () => {
    expect(isAddressPattern('')).toBe(false)
    expect(isAddressPattern('  ')).toBe(false)
  })
  test('the pattern must be the whole value', () => {
    expect(isAddressPattern('名前で呼ぶ')).toBe(false)
    expect(isAddressPattern('お名前')).toBe(false)
    expect(isAddressPattern('苗字＋')).toBe(false)
    expect(isAddressPattern('苗字さん')).toBe(false)
    expect(isAddressPattern('名前苗字')).toBe(false)
  })
})

const cast = (...names: string[]): BibleCastInput[] => names.map((name) => ({ name, address_others: '' }))
const entry = (from: string, to: string, call: string): AddressEntry => ({ from, to, call })
const relation = (source_name: string, target_name: string, address_override = ''): BibleRelationInput => ({
  source_name,
  target_name,
  address_override
})

describe('completeAddresses', () => {
  const roster = cast('太郎', '花子', '次郎')

  test('keeps valid rows as they are', () => {
    const rows = [entry('太郎', '花子', '花子さん'), entry('花子', '太郎', '太郎くん')]
    expect(completeAddresses(rows, roster, [])).toEqual(rows)
  })
  test('drops rows whose from or to is not in the cast', () => {
    const rows = [
      entry('太郎', '花子', '花子さん'),
      entry('三郎', '花子', 'あの子'),
      entry('太郎', '三郎', 'あいつ'),
      entry('四郎', '五郎', 'お前')
    ]
    expect(completeAddresses(rows, roster, [])).toEqual([entry('太郎', '花子', '花子さん')])
  })
  test('drops rows from a character to themselves', () => {
    const rows = [entry('太郎', '太郎', '俺'), entry('太郎', '花子', '花子さん')]
    expect(completeAddresses(rows, roster, [])).toEqual([entry('太郎', '花子', '花子さん')])
  })
  test('drops rows with an empty call', () => {
    const rows = [entry('太郎', '花子', ''), entry('花子', '太郎', '   '), entry('太郎', '次郎', '次郎')]
    expect(completeAddresses(rows, roster, [])).toEqual([entry('太郎', '次郎', '次郎')])
  })
  test('trims names and calls', () => {
    const rows = [entry(' 太郎 ', '\n花子', ' 花子さん\t')]
    expect(completeAddresses(rows, roster, [])).toEqual([entry('太郎', '花子', '花子さん')])
  })
  test('trims the names in the cast as well', () => {
    expect(completeAddresses([entry('太郎', '花子', '花子さん')], cast(' 太郎 ', '花子 '), [])).toEqual([
      entry('太郎', '花子', '花子さん')
    ])
  })
  test('keeps only the first row for the same (from, to)', () => {
    const rows = [
      entry('太郎', '花子', '花子さん'),
      entry('太郎', '花子', '君'),
      entry(' 太郎', '花子 ', 'あんた'),
      entry('花子', '太郎', '太郎くん')
    ]
    expect(completeAddresses(rows, roster, [])).toEqual([
      entry('太郎', '花子', '花子さん'),
      entry('花子', '太郎', '太郎くん')
    ])
  })
  test('a row dropped for an empty call does not count as the first row', () => {
    const rows = [entry('太郎', '花子', ''), entry('太郎', '花子', '花子さん')]
    expect(completeAddresses(rows, roster, [])).toEqual([entry('太郎', '花子', '花子さん')])
  })
  test('a concrete override replaces the model row', () => {
    const rows = [entry('太郎', '花子', '花子さん'), entry('花子', '太郎', '太郎くん')]
    const result = completeAddresses(rows, roster, [relation('太郎', '花子', 'いろP')])
    expect(result).toEqual([entry('太郎', '花子', 'いろP'), entry('花子', '太郎', '太郎くん')])
  })
  test('a concrete override adds the row when the model did not return one', () => {
    const result = completeAddresses([], roster, [relation('太郎', '花子', 'いろP')])
    expect(result).toContainEqual(entry('太郎', '花子', 'いろP'))
  })
  test('an override only applies in the direction source to target', () => {
    const rows = [entry('花子', '太郎', '太郎くん')]
    const result = completeAddresses(rows, roster, [relation('太郎', '花子', 'いろP')])
    expect(result).toEqual([entry('太郎', '花子', 'いろP'), entry('花子', '太郎', '太郎くん')])
  })
  test('an override is trimmed', () => {
    const result = completeAddresses([], roster, [relation('太郎', '花子', '  いろP ')])
    expect(result).toContainEqual(entry('太郎', '花子', 'いろP'))
  })
  test('an override that is a pattern is ignored', () => {
    const rows = [entry('太郎', '花子', '花子さん')]
    const patterns = ADDRESS_STYLES.filter((style) => style !== '君')
    for (const pattern of patterns) {
      const result = completeAddresses(rows, roster, [relation('太郎', '花子', pattern)])
      expect(result).toEqual([entry('太郎', '花子', '花子さん')])
    }
  })
  test('a hand-written pattern keeps the row the model resolved (柊先生 is not overwritten by 苗字＋先生)', () => {
    const rows = [entry('太郎', '花子', '柊先生')]
    expect(completeAddresses(rows, roster, [relation('太郎', '花子', '苗字＋先生')])).toEqual([
      entry('太郎', '花子', '柊先生')
    ])
    expect(completeAddresses(rows, roster, [relation('太郎', '花子', '苗字+先生')])).toEqual([
      entry('太郎', '花子', '柊先生')
    ])
  })
  test('君 is a concrete call, so an override of 君 is adopted', () => {
    const rows = [entry('太郎', '花子', '花子さん')]
    expect(completeAddresses(rows, roster, [relation('太郎', '花子', '君')])).toEqual([entry('太郎', '花子', '君')])
    expect(completeAddresses([], roster, [relation('太郎', '花子', '君')])).toEqual([entry('太郎', '花子', '君')])
  })
  test('an empty override is ignored', () => {
    const rows = [entry('太郎', '花子', '花子さん')]
    expect(
      completeAddresses(rows, roster, [relation('太郎', '花子', ''), relation('次郎', '太郎', '  ')])
    ).toContainEqual(entry('太郎', '花子', '花子さん'))
  })
  test('with several relations for one pair the first concrete override wins', () => {
    const result = completeAddresses([], roster, [
      relation('太郎', '花子', '苗字＋さん'),
      relation('太郎', '花子', 'いろP'),
      relation('太郎', '花子', 'はなちゃん')
    ])
    expect(result).toEqual([entry('太郎', '花子', 'いろP')])
  })
  test('does not make up rows for a missing direction, even when a relation is defined', () => {
    const rows = [entry('太郎', '花子', '花子さん')]
    expect(completeAddresses(rows, roster, [relation('太郎', '花子')])).toEqual([entry('太郎', '花子', '花子さん')])
    expect(completeAddresses([], roster, [relation('太郎', '花子'), relation('花子', '次郎', '名前＋さん')])).toEqual(
      []
    )
  })
  test('an override adds only its own direction', () => {
    const result = completeAddresses([], roster, [relation('太郎', '花子', 'いろP')])
    expect(result).toEqual([entry('太郎', '花子', 'いろP')])
  })
  test('cuts the table at 600 rows, keeping the first ones in the order of the cast', () => {
    const names = Array.from({ length: 30 }, (_, index) => `人${String(index).padStart(2, '0')}`)
    const rows = names.flatMap((from) => names.filter((to) => to !== from).map((to) => entry(from, to, `${to}さん`)))
    expect(rows).toHaveLength(870)
    const result = completeAddresses(rows.reverse(), cast(...names), [])
    expect(result).toHaveLength(ADDRESS_MAX_ROWS)
    expect(ADDRESS_MAX_ROWS).toBe(600)
    expect(result[0]).toEqual(entry('人00', '人01', '人01さん'))
    // 600 行 = 29 行 × 20 人 (人00〜人19) + 20 行。最後の行は人20 から人19 への行
    expect(result[599]).toEqual(entry('人20', '人19', '人19さん'))
  })
  test('does not cut a table of exactly 600 rows', () => {
    const names = Array.from({ length: 25 }, (_, index) => `人${String(index).padStart(2, '0')}`)
    const rows = names.flatMap((from) => names.filter((to) => to !== from).map((to) => entry(from, to, `${to}さん`)))
    expect(rows).toHaveLength(600)
    expect(completeAddresses(rows, cast(...names), [])).toHaveLength(600)
  })
  test('ignores relations that mention people outside the cast, or themselves', () => {
    const result = completeAddresses([], roster, [
      relation('太郎', '三郎', 'いろP'),
      relation('四郎', '太郎'),
      relation('花子', '花子', 'いろP')
    ])
    expect(result).toEqual([])
  })
  test('orders by the cast, then by the cast within the same from', () => {
    const rows = [
      entry('次郎', '太郎', 'a'),
      entry('花子', '次郎', 'b'),
      entry('太郎', '次郎', 'c'),
      entry('花子', '太郎', 'd'),
      entry('太郎', '花子', 'e'),
      entry('次郎', '花子', 'f')
    ]
    const result = completeAddresses(rows, roster, [])
    expect(result.map((row) => `${row.from}>${row.to}`)).toEqual([
      '太郎>花子',
      '太郎>次郎',
      '花子>太郎',
      '花子>次郎',
      '次郎>太郎',
      '次郎>花子'
    ])
  })
  test('the order does not depend on the order of the model rows', () => {
    const rows = [entry('太郎', '花子', 'a'), entry('花子', '太郎', 'b'), entry('次郎', '太郎', 'c')]
    const relations = [relation('次郎', '花子', 'いろP')]
    expect(completeAddresses([...rows].reverse(), roster, relations)).toEqual(
      completeAddresses(rows, roster, relations)
    )
  })
  test('does not modify the input', () => {
    const rows = [entry(' 太郎 ', '花子', ' 花子さん '), entry('太郎', '花子', 'x'), entry('三郎', '太郎', 'y')]
    const people = cast('太郎', '花子')
    const relations = [relation('太郎', '花子', ' いろP '), relation('花子', '太郎')]
    const before = JSON.stringify([rows, people, relations])
    completeAddresses(rows, people, relations)
    expect(JSON.stringify([rows, people, relations])).toBe(before)
  })
  test('returns new row objects', () => {
    const rows = [entry('太郎', '花子', '花子さん')]
    const result = completeAddresses(rows, roster, [])
    expect(result[0]).toEqual(rows[0])
    expect(result[0]).not.toBe(rows[0])
  })
  test('an empty cast gives an empty table', () => {
    expect(completeAddresses([entry('太郎', '花子', '花子さん')], [], [relation('太郎', '花子')])).toEqual([])
  })
})

const names = (count: number): string[] =>
  Array.from({ length: count }, (_, index) => `人${String(index).padStart(2, '0')}`)
const pairLabels = (pairs: Array<{ from: string; to: string }>): string[] =>
  pairs.map((pair) => `${pair.from}>${pair.to}`)

describe('requiredAddressPairs', () => {
  test('a cast of up to ADDRESS_ALL_PAIRS_MAX_CAST gets every pair, in both directions', () => {
    expect(ADDRESS_ALL_PAIRS_MAX_CAST).toBe(8)
    expect(pairLabels(requiredAddressPairs(['太郎', '花子', '次郎'], [], ''))).toEqual([
      '太郎>花子',
      '太郎>次郎',
      '花子>太郎',
      '花子>次郎',
      '次郎>太郎',
      '次郎>花子'
    ])
  })
  test('eight people give 56 pairs, with no pair to oneself and no duplicates', () => {
    const pairs = requiredAddressPairs(names(8), [], '')
    expect(pairs).toHaveLength(56)
    expect(pairs.every((pair) => pair.from !== pair.to)).toBe(true)
    expect(new Set(pairLabels(pairs)).size).toBe(56)
  })
  test('the order follows the cast, not the order of the relations', () => {
    const pairs = requiredAddressPairs(['次郎', '太郎', '花子'], [relation('花子', '次郎')], '花子')
    expect(pairLabels(pairs)).toEqual(['次郎>太郎', '次郎>花子', '太郎>次郎', '太郎>花子', '花子>次郎', '花子>太郎'])
  })
  test('nine or more people get only the related pairs (both directions) and the narrator pairs', () => {
    // 関係は 人05 と 人02、語り手は 人07。名簿の順 (from、同じ from の中は to) に並ぶ
    const pairs = requiredAddressPairs(names(9), [relation('人05', '人02')], '人07')
    expect(pairLabels(pairs)).toEqual([
      '人00>人07',
      '人01>人07',
      '人02>人05',
      '人02>人07',
      '人03>人07',
      '人04>人07',
      '人05>人02',
      '人05>人07',
      '人06>人07',
      '人07>人00',
      '人07>人01',
      '人07>人02',
      '人07>人03',
      '人07>人04',
      '人07>人05',
      '人07>人06',
      '人07>人08',
      '人08>人07'
    ])
  })
  test('nine or more people without a narrator get only the related pairs', () => {
    const pairs = requiredAddressPairs(names(9), [relation('人05', '人02'), relation('人00', '人08')], '')
    expect(pairLabels(pairs)).toEqual(['人00>人08', '人02>人05', '人05>人02', '人08>人00'])
  })
  test('nine or more people with neither relations nor a narrator need nothing', () => {
    expect(requiredAddressPairs(names(9), [], '')).toEqual([])
  })
  test('a pair that is both a relation and a narrator pair appears once', () => {
    const pairs = requiredAddressPairs(names(10), [relation('人03', '人01'), relation('人01', '人03')], '人01')
    const labels = pairLabels(pairs)
    expect(new Set(labels).size).toBe(labels.length)
    expect(labels.filter((label) => label === '人01>人03')).toHaveLength(1)
    expect(labels.filter((label) => label === '人03>人01')).toHaveLength(1)
    // 語り手 人01 と他の 9 人の両方向 = 18 組。関係の組はその中に含まれる
    expect(labels).toHaveLength(18)
  })
  test('relations with a name outside the cast are ignored', () => {
    const pairs = requiredAddressPairs(
      names(9),
      [relation('人01', '人99'), relation('人98', '人02'), relation('人03', '人04')],
      ''
    )
    expect(pairLabels(pairs)).toEqual(['人03>人04', '人04>人03'])
  })
  test('a narrator who is not in the cast adds nothing', () => {
    expect(requiredAddressPairs(names(9), [], '誰か')).toEqual([])
  })
  test('a relation from a person to themselves adds nothing', () => {
    expect(requiredAddressPairs(names(9), [relation('人01', '人01')], '人01')).toHaveLength(16)
  })
  test('trims names and ignores duplicate or empty names in the cast', () => {
    const pairs = requiredAddressPairs([' 太郎 ', '花子', '太郎', ''], [], '')
    expect(pairLabels(pairs)).toEqual(['太郎>花子', '花子>太郎'])
  })
  test('a single person, or nobody, needs nothing', () => {
    expect(requiredAddressPairs(['太郎'], [], '太郎')).toEqual([])
    expect(requiredAddressPairs([], [relation('太郎', '花子')], '')).toEqual([])
  })
  test('does not modify the input', () => {
    const people = ['次郎', '太郎']
    const relations = [relation('次郎', '太郎')]
    const before = JSON.stringify([people, relations])
    requiredAddressPairs(people, relations, '太郎')
    expect(JSON.stringify([people, relations])).toBe(before)
  })
})

describe('missingAddressPairs', () => {
  const required = [
    { from: '太郎', to: '花子' },
    { from: '花子', to: '太郎' },
    { from: '太郎', to: '次郎' }
  ]
  test('returns the required pairs that have no row, in the order of required', () => {
    const rows = [entry('花子', '太郎', '太郎くん')]
    expect(missingAddressPairs(rows, required)).toEqual([
      { from: '太郎', to: '花子' },
      { from: '太郎', to: '次郎' }
    ])
  })
  test('is empty when every required pair has a row', () => {
    const rows = [entry('太郎', '次郎', 'a'), entry('太郎', '花子', 'b'), entry('花子', '太郎', 'c')]
    expect(missingAddressPairs(rows, required)).toEqual([])
  })
  test('rows that are not required are ignored', () => {
    const rows = [entry('次郎', '太郎', '兄貴'), entry('花子', '次郎', '次郎くん')]
    expect(missingAddressPairs(rows, required)).toEqual(required)
  })
  test('the direction matters', () => {
    expect(missingAddressPairs([entry('花子', '太郎', 'x')], [{ from: '太郎', to: '花子' }])).toEqual([
      { from: '太郎', to: '花子' }
    ])
  })
  test('nothing required, or an empty table', () => {
    expect(missingAddressPairs([entry('太郎', '花子', 'x')], [])).toEqual([])
    expect(missingAddressPairs([], required)).toEqual(required)
  })
  test('names containing the same characters do not collide', () => {
    expect(missingAddressPairs([entry('a|b', 'c', 'x')], [{ from: 'a', to: 'b|c' }])).toEqual([
      { from: 'a', to: 'b|c' }
    ])
  })
  test('works with the output of requiredAddressPairs and completeAddresses', () => {
    const roster = ['太郎', '花子', '次郎']
    const model = [entry('太郎', '花子', '花子さん'), entry('花子', '太郎', '太郎くん'), entry('三郎', '太郎', '誰か')]
    const completed = completeAddresses(model, cast(...roster), [])
    const missing = missingAddressPairs(completed, requiredAddressPairs(roster, [], ''))
    expect(pairLabels(missing)).toEqual(['太郎>次郎', '花子>次郎', '次郎>太郎', '次郎>花子'])
  })
  test('does not modify the input', () => {
    const rows = [entry('花子', '太郎', '太郎くん')]
    const before = JSON.stringify([rows, required])
    missingAddressPairs(rows, required)
    expect(JSON.stringify([rows, required])).toBe(before)
  })
})

describe('addressesFor', () => {
  const table = [
    entry('太郎', '花子', '花子さん'),
    entry('花子', '太郎', '太郎くん'),
    entry('太郎', '次郎', '次郎'),
    entry('次郎', '太郎', '兄貴'),
    entry('花子', '次郎', '次郎くん')
  ]
  test('keeps rows where both people are in the chapter', () => {
    expect(addressesFor(table, ['太郎', '花子'])).toEqual([
      entry('太郎', '花子', '花子さん'),
      entry('花子', '太郎', '太郎くん')
    ])
  })
  test('drops rows with a person who is not in the chapter', () => {
    expect(addressesFor(table, ['太郎'])).toEqual([])
    expect(addressesFor(table, ['次郎', '太郎']).map((row) => row.call)).toEqual(['次郎', '兄貴'])
  })
  test('keeps the order of the table, not of the names', () => {
    expect(addressesFor(table, ['次郎', '花子', '太郎']).map((row) => row.call)).toEqual([
      '花子さん',
      '太郎くん',
      '次郎',
      '兄貴',
      '次郎くん'
    ])
  })
  test('no names or no table gives an empty result', () => {
    expect(addressesFor(table, [])).toEqual([])
    expect(addressesFor([], ['太郎', '花子'])).toEqual([])
  })
  test('does not modify the input', () => {
    const before = JSON.stringify(table)
    addressesFor(table, ['太郎', '花子'])
    expect(JSON.stringify(table)).toBe(before)
  })
})

describe('callsByName', () => {
  test('groups the calls by the person who is called', () => {
    const table = [
      entry('太郎', '花子', '花子さん'),
      entry('次郎', '花子', 'はな'),
      entry('花子', '太郎', '太郎くん'),
      entry('次郎', '太郎', '兄貴')
    ]
    expect(callsByName(table)).toEqual({ 花子: ['花子さん', 'はな'], 太郎: ['太郎くん', '兄貴'] })
  })
  test('removes duplicates and keeps the first-seen order', () => {
    const table = [
      entry('太郎', '花子', '花子さん'),
      entry('次郎', '花子', 'はな'),
      entry('三郎', '花子', '花子さん'),
      entry('四郎', '花子', 'はな'),
      entry('五郎', '花子', '花ちゃん')
    ]
    expect(callsByName(table)).toEqual({ 花子: ['花子さん', 'はな', '花ちゃん'] })
  })
  test('people nobody calls are absent', () => {
    expect(callsByName([entry('太郎', '花子', '花子さん')])).toEqual({ 花子: ['花子さん'] })
    expect(callsByName([])).toEqual({})
  })
  test('is safe for names that collide with Object.prototype members', () => {
    const result = callsByName([entry('太郎', 'constructor', 'ctor'), entry('太郎', '__proto__', 'proto')])
    expect(Object.keys(result).sort()).toEqual(['__proto__', 'constructor'])
    expect(Object.getOwnPropertyDescriptor(result, '__proto__')?.value).toEqual(['proto'])
  })
  test('does not modify the input', () => {
    const table = [entry('太郎', '花子', '花子さん'), entry('次郎', '花子', '花子さん')]
    const before = JSON.stringify(table)
    callsByName(table)
    expect(JSON.stringify(table)).toBe(before)
  })
})

describe('isAdultRating', () => {
  test('R15 and R18 are adult ratings', () => {
    expect(isAdultRating('R15')).toBe(true)
    expect(isAdultRating('R18')).toBe(true)
  })
  test('everything else is not', () => {
    expect(isAdultRating('全年齢')).toBe(false)
    expect(isAdultRating('')).toBe(false)
    expect(isAdultRating('r18')).toBe(false)
    expect(isAdultRating('R12')).toBe(false)
  })
})

describe('parseExactAge', () => {
  test('reads a number with an optional 歳 / 才', () => {
    expect(parseExactAge('18')).toBe(18)
    expect(parseExactAge('18歳')).toBe(18)
    expect(parseExactAge('18才')).toBe(18)
    expect(parseExactAge('18 歳')).toBe(18)
    expect(parseExactAge('17')).toBe(17)
    expect(parseExactAge('120')).toBe(120)
    expect(parseExactAge('300歳')).toBe(300)
  })
  test('reads full-width digits and ignores surrounding whitespace', () => {
    expect(parseExactAge('１８才')).toBe(18)
    expect(parseExactAge('１７')).toBe(17)
    expect(parseExactAge('18　歳')).toBe(18)
    expect(parseExactAge('  25歳\n')).toBe(25)
  })
  test('a word before or after the number is null (「18歳未満」 must not pass as 18)', () => {
    const loopholes = [
      '18歳未満',
      '18歳以下',
      '18に満たない',
      '十四歳（設定上は18）',
      '見た目は18歳、実年齢は十四',
      '10代、18歳',
      '満18歳',
      '約18',
      '18歳くらい',
      '18歳（外見は14歳）'
    ]
    for (const value of loopholes) {
      expect(parseExactAge(value)).toBeNull()
    }
  })
  test('ranges and incomplete numbers are null', () => {
    expect(parseExactAge('18-20')).toBeNull()
    expect(parseExactAge('17〜18歳')).toBeNull()
    expect(parseExactAge('18〜')).toBeNull()
    expect(parseExactAge('18、20')).toBeNull()
    expect(parseExactAge('17.5歳')).toBeNull()
  })
  test('kanji numerals, decades and non-numbers are null', () => {
    for (const value of ['二十歳', '十七歳', '二十代', '20代', '10代後半', '成人', '大人', '不明', '', '   ']) {
      expect(parseExactAge(value)).toBeNull()
    }
  })
  test('four or more digits are null', () => {
    expect(parseExactAge('1800')).toBeNull()
  })
})

describe('findMinorTerms', () => {
  test('finds the words for a status', () => {
    const words = [
      '高校生',
      '中学生',
      '小学生',
      '女子高生',
      '男子高生',
      '女子高校生',
      '男子高校生',
      '女子中学生',
      '男子中学生',
      '未成年',
      '園児',
      '幼女',
      '美少女',
      '美少年'
    ]
    for (const word of words) {
      expect(findMinorTerms(`彼女は${word}だ`)).toEqual([word])
    }
  })
  test('finds 児童 and 幼児 alone, and the Japanese slang', () => {
    expect(findMinorTerms('児童を引率する')).toEqual(['児童'])
    expect(findMinorTerms('幼児のような')).toEqual(['幼児'])
    expect(findMinorTerms('ロリ系の顔立ち')).toEqual(['ロリ'])
    expect(findMinorTerms('ショタっぽい')).toEqual(['ショタ'])
  })
  test('the longer word wins at the same position', () => {
    expect(findMinorTerms('女子高校生')).toEqual(['女子高校生'])
    expect(findMinorTerms('保育園児')).toEqual(['園児'])
  })
  test('finds JK, and JS / JC when a digit follows or hiragana / kanji are on both sides, in any case', () => {
    expect(findMinorTerms('現役JK')).toEqual(['JK'])
    expect(findMinorTerms('jk')).toEqual(['JK'])
    expect(findMinorTerms('JS5')).toEqual(['JS'])
    expect(findMinorTerms('js3年')).toEqual(['JS'])
    expect(findMinorTerms('JC2')).toEqual(['JC'])
    expect(findMinorTerms('彼女はJSだ')).toEqual(['JS'])
    expect(findMinorTerms('現役jcの')).toEqual(['JC'])
    expect(findMinorTerms('ＪＫ制服')).toEqual(['JK'])
    expect(findMinorTerms('革のjacket')).toEqual([])
    expect(findMinorTerms('JKL')).toEqual([])
    expect(findMinorTerms('Vue.js の開発者')).toEqual([])
  })
  test('finds the grade expressions', () => {
    expect(findMinorTerms('高校2年')).toEqual(['高校2年'])
    expect(findMinorTerms('高校一年生')).toEqual(['高校一年'])
    expect(findMinorTerms('高等学校3年')).toEqual(['高等学校3年'])
    expect(findMinorTerms('中学3年生')).toEqual(['中学3年'])
    expect(findMinorTerms('中学校二年')).toEqual(['中学校二年'])
    expect(findMinorTerms('小学五年生')).toEqual(['小学五年'])
    expect(findMinorTerms('小学校6年')).toEqual(['小学校6年'])
  })
  test('finds the short grade expressions', () => {
    expect(findMinorTerms('高1')).toEqual(['高1'])
    expect(findMinorTerms('中学の友人で、中1の弟がいる')).toEqual(['中1'])
    expect(findMinorTerms('小3の妹')).toEqual(['小3'])
    expect(findMinorTerms('彼女は高2だ')).toEqual(['高2'])
    expect(findMinorTerms('高三の夏')).toEqual(['高三'])
    expect(findMinorTerms('高2生')).toEqual(['高2'])
    expect(findMinorTerms('(中2)')).toEqual(['中2'])
  })
  test('a short grade expression after a type of school is still a grade', () => {
    expect(findMinorTerms('女子高2')).toEqual(['高2'])
    expect(findMinorTerms('都立高3')).toEqual(['高3'])
    expect(findMinorTerms('現役高3')).toEqual(['高3'])
    expect(findMinorTerms('現中1')).toEqual(['中1'])
  })
  test('the short grade expression does not match inside other words', () => {
    expect(findMinorTerms('途中1回だけ休んだ')).toEqual([])
    expect(findMinorTerms('標高2000mの山')).toEqual([])
    expect(findMinorTerms('最高3位')).toEqual([])
    expect(findMinorTerms('夢中2時間')).toEqual([])
    expect(findMinorTerms('中1日で登板')).toEqual([])
    expect(findMinorTerms('小1時間ほど')).toEqual([])
    expect(findMinorTerms('高3度の傾き')).toEqual([])
    expect(findMinorTerms('家の中一面に')).toEqual([])
    expect(findMinorTerms('中二病')).toEqual([])
    expect(findMinorTerms('中10人')).toEqual([])
    expect(findMinorTerms('高2m')).toEqual([])
  })
  test('a duration of years at school is not a grade', () => {
    expect(findMinorTerms('高校3年間は野球漬けだった')).toEqual([])
    expect(findMinorTerms('中学2年間')).toEqual([])
  })
  test('finds 十代, 10代 and ティーン, but not 二十代 or 10代目', () => {
    expect(findMinorTerms('十代の頃')).toEqual(['十代'])
    expect(findMinorTerms('10代後半')).toEqual(['10代'])
    expect(findMinorTerms('１０代')).toEqual(['10代'])
    expect(findMinorTerms('ティーンエイジャー')).toEqual(['ティーン'])
    expect(findMinorTerms('二十代')).toEqual([])
    expect(findMinorTerms('三十代')).toEqual([])
    expect(findMinorTerms('20代')).toEqual([])
    expect(findMinorTerms('十代目当主')).toEqual([])
    expect(findMinorTerms('10代目社長')).toEqual([])
    expect(findMinorTerms('第10代当主')).toEqual([])
  })
  test('少女 and 少年 are found only for the appearance', () => {
    expect(findMinorTerms('少女のような顔立ち')).toEqual([])
    expect(findMinorTerms('少年野球のコーチ')).toEqual([])
    expect(findMinorTerms('少女のような顔立ち', { appearance: true })).toEqual(['少女'])
    expect(findMinorTerms('少年のような体つき', { appearance: true })).toEqual(['少年'])
    expect(findMinorTerms('少女のような顔立ち', { appearance: false })).toEqual([])
    expect(findMinorTerms('少女のような顔立ち', {})).toEqual([])
  })
  test('美少女 is found even without the appearance option, and reported once', () => {
    expect(findMinorTerms('美少女')).toEqual(['美少女'])
    expect(findMinorTerms('美少女', { appearance: true })).toEqual(['美少女'])
  })
  test('does not match words that are normal for an adult', () => {
    const adult = [
      '高校教師',
      '高校を卒業後、上京した',
      '中学校の教諭',
      '大学2年生',
      '大学生',
      '少女漫画家',
      '高校生活は楽しかった',
      '児童文学作家',
      '児童福祉士',
      '幼児教育の専門家',
      '二十代半ば',
      'カロリー計算が得意',
      '学生時代はバスケ部',
      '若い頃は旅をしていた'
    ]
    for (const text of adult) {
      expect(findMinorTerms(text)).toEqual([])
    }
  })
  test('reports each word once, in the order found', () => {
    expect(findMinorTerms('女子高生。高2で、十代で、女子高生で、JK')).toEqual(['女子高生', '高2', '十代', 'JK'])
  })
  test('normalizes full-width alphanumerics and half-width katakana', () => {
    expect(findMinorTerms('高２')).toEqual(['高2'])
    expect(findMinorTerms('１０代')).toEqual(['10代'])
    expect(findMinorTerms('ﾛﾘ')).toEqual(['ロリ'])
  })
  test('empty text finds nothing', () => {
    expect(findMinorTerms('')).toEqual([])
    expect(findMinorTerms('', { appearance: true })).toEqual([])
  })
  test('can be called repeatedly (no state is kept between calls)', () => {
    for (const text of ['女子高生', '女子高生', '女子高生']) {
      expect(findMinorTerms(text)).toEqual(['女子高生'])
    }
  })
})

describe('normalizeForMinorScan', () => {
  test('applies NFKC: full-width alphanumerics, half-width katakana', () => {
    expect(normalizeForMinorScan('高２')).toBe('高2')
    expect(normalizeForMinorScan('ＪＫ')).toBe('JK')
    expect(normalizeForMinorScan('ﾛﾘ')).toBe('ロリ')
    expect(normalizeForMinorScan('１０代')).toBe('10代')
  })
  test('removes invisible characters', () => {
    // ゼロ幅スペース、ソフトハイフン、WORD JOINER、BOM、異体字セレクタ、ゼロ幅非接合子、結合文字
    expect(normalizeForMinorScan('高​校­生⁠﻿')).toBe('高校生')
    expect(normalizeForMinorScan('高︀校️生‌‍')).toBe('高校生')
    expect(normalizeForMinorScan('高́校生')).toBe('高校生')
  })
  test('maps variant characters', () => {
    expect(normalizeForMinorScan('髙校生')).toBe('高校生')
    expect(normalizeForMinorScan('中學生')).toBe('中学生')
    expect(normalizeForMinorScan('兒童')).toBe('児童')
    expect(normalizeForMinorScan('十四歲')).toBe('十四歳')
  })
  test('keeps ordinary spaces, newlines and punctuation', () => {
    expect(normalizeForMinorScan('途中。 学生は\n高・校')).toBe('途中。 学生は\n高・校')
    expect(normalizeForMinorScan('高　校')).toBe('高 校')
  })
  test('empty text stays empty', () => {
    expect(normalizeForMinorScan('')).toBe('')
  })
})

describe('findMinorTerms: age expressions', () => {
  test('finds an age under 18 in any notation, as a normalized term', () => {
    expect(findMinorTerms('14歳')).toEqual(['14歳'])
    expect(findMinorTerms('十四歳')).toEqual(['14歳'])
    expect(findMinorTerms('１４才')).toEqual(['14歳'])
    expect(findMinorTerms('12 歳')).toEqual(['12歳'])
    expect(findMinorTerms('17さい')).toEqual(['17歳'])
    expect(findMinorTerms('十七歳')).toEqual(['17歳'])
    expect(findMinorTerms('十歳')).toEqual(['10歳'])
    expect(findMinorTerms('一歳')).toEqual(['1歳'])
    expect(findMinorTerms('一七歳')).toEqual(['17歳'])
    expect(findMinorTerms('零歳')).toEqual(['0歳'])
  })
  test('finds it inside a sentence, including a past event', () => {
    expect(findMinorTerms('8歳で両親を亡くし、叔父に育てられた')).toEqual(['8歳'])
    expect(findMinorTerms('実年齢は十四歳です')).toEqual(['14歳'])
    expect(findMinorTerms('戸籍上は18歳だが実年齢は14歳')).toEqual(['14歳'])
  })
  test('18 and over are not minors, but 未満 / 以下 up to 20 are', () => {
    for (const text of ['18歳', '18才', '20歳', '二十歳', '三十七歳', '25歳', '18歳以上', '21歳未満', '21歳以下']) {
      expect(findMinorTerms(text)).toEqual([])
    }
    expect(findMinorTerms('18歳未満')).toEqual(['18歳未満'])
    expect(findMinorTerms('18才未満')).toEqual(['18歳未満'])
    expect(findMinorTerms('18歳以下')).toEqual(['18歳以下'])
    expect(findMinorTerms('20歳未満')).toEqual(['20歳未満'])
    expect(findMinorTerms('十八歳に満たない')).toEqual(['18歳に満たない'])
  })
  test('reads the longest number, so 118歳 is not 18 and 二十歳 is not 十歳', () => {
    expect(findMinorTerms('118歳')).toEqual([])
    expect(findMinorTerms('2018歳')).toEqual([])
    expect(findMinorTerms('二十歳')).toEqual([])
    expect(findMinorTerms('百十八歳')).toEqual([])
    expect(findMinorTerms('万歳三唱')).toEqual([])
    expect(findMinorTerms('千歳飴')).toEqual([])
  })
  test('an age difference is not an age', () => {
    const differences = [
      '3歳年上',
      '5歳年下',
      '2歳上の姉',
      '4歳下の弟',
      '10歳差',
      '3歳違い',
      '5歳離れた兄',
      '3歳ほど年下',
      '2歳くらい年上',
      '3歳若く見える',
      '1歳年長'
    ]
    for (const text of differences) {
      expect(findMinorTerms(text)).toEqual([])
    }
  })
  test('a range or a list is judged by its smallest number', () => {
    expect(findMinorTerms('17〜18歳')).toEqual(['17歳'])
    expect(findMinorTerms('17~18歳')).toEqual(['17歳'])
    expect(findMinorTerms('17-18歳')).toEqual(['17歳'])
    expect(findMinorTerms('14、15歳')).toEqual(['14歳'])
    expect(findMinorTerms('十五か十六歳')).toEqual(['15歳'])
    expect(findMinorTerms('18〜20歳')).toEqual([])
    expect(findMinorTerms('17.5歳')).toEqual(['17歳'])
  })
  test('is found with other terms, in the order found', () => {
    expect(findMinorTerms('12歳の女子高生、実は十四歳')).toEqual(['12歳', '女子高生', '14歳'])
    expect(findMinorTerms('10代、14歳')).toEqual(['10代', '14歳'])
  })
  test('is found whatever the appearance option is', () => {
    expect(findMinorTerms('12歳', { appearance: true })).toEqual(['12歳'])
    expect(findMinorTerms('12歳', { appearance: false })).toEqual(['12歳'])
  })
})

describe('findMinorTerms: preprocessing', () => {
  const hidden = ['​', '­', '⁠', '﻿', '︀', '️', '‌', '‍', '́']
  test('invisible characters in a word do not hide it', () => {
    for (const char of hidden) {
      expect(findMinorTerms(`高${char}校生`)).toEqual(['高校生'])
      expect(findMinorTerms(`女子${char}高生`)).toEqual(['女子高生'])
    }
  })
  test('invisible characters in an age or an English word do not hide it', () => {
    expect(findMinorTerms('1​4歳')).toEqual(['14歳'])
    expect(findMinorTerms('十­四歳')).toEqual(['14歳'])
    expect(findMinorTerms('J​K')).toEqual(['JK'])
    expect(findMinorTerms('tee⁠nager')).toEqual(['TEENAGER'])
  })
  test('spaces, tabs and middle dots inside a line do not hide a word', () => {
    const joined = [
      '高 校 生',
      '高　校　生',
      '高校　生',
      '高\t校生',
      '高・校・生',
      '高･校･生',
      '高 ・ 校 生',
      '高-校-生',
      '高‐校‐生',
      '高―校―生'
    ]
    for (const text of joined) {
      expect(findMinorTerms(text)).toEqual(['高校生'])
    }
    expect(findMinorTerms('高 校 2 年')).toEqual(['高校2年'])
    expect(findMinorTerms('1 4 歳')).not.toEqual([])
    expect(findMinorTerms('女 子 高 生')).toEqual(['女子高生'])
  })
  test('a line break or a punctuation mark is not removed', () => {
    expect(findMinorTerms('途中。学生は')).toEqual([])
    expect(findMinorTerms('途中、学生は')).toEqual([])
    expect(findMinorTerms('途中\n学生は')).toEqual([])
    expect(findMinorTerms('中\n学生')).toEqual([])
    expect(findMinorTerms('高\n校生')).toEqual([])
    expect(findMinorTerms('途中。　学生は')).toEqual([])
  })
  test('a space inside a line is removed, so a word that spans a space is found (a known false positive)', () => {
    expect(findMinorTerms('途中 学生は')).toEqual(['中学生'])
  })
  test('a space inside a number is still caught (it may read only the last digit, which errs on the side of a problem)', () => {
    expect(findMinorTerms('十 四 歳')).not.toEqual([])
    expect(findMinorTerms('1 7 歳')).not.toEqual([])
  })
  test('a number before the age after a space is a list number, not a part of the age', () => {
    expect(findMinorTerms('1 14歳の春')).toEqual(['14歳'])
    expect(findMinorTerms('2 十四歳になった')).toEqual(['14歳'])
    expect(findMinorTerms('3 18歳になる')).toEqual([])
  })
  test('the boundaries still apply after the spaces are removed', () => {
    expect(findMinorTerms('標 高 2000m')).toEqual([])
    expect(findMinorTerms('最 高 3 位')).toEqual([])
    expect(findMinorTerms('高校 生活')).toEqual([])
    expect(findMinorTerms('中 1 日')).toEqual([])
  })
  test('English words are not joined across spaces', () => {
    expect(findMinorTerms('J K')).toEqual([])
    expect(findMinorTerms('t e e n')).toEqual([])
  })
  test('variant characters do not hide a word', () => {
    expect(findMinorTerms('髙校生')).toEqual(['高校生'])
    expect(findMinorTerms('中學生')).toEqual(['中学生'])
    expect(findMinorTerms('小學生')).toEqual(['小学生'])
    expect(findMinorTerms('髙校2年')).toEqual(['高校2年'])
    expect(findMinorTerms('兒童')).toEqual(['児童'])
    expect(findMinorTerms('十四歲')).toEqual(['14歳'])
  })
  test('a word found both ways is reported once', () => {
    expect(findMinorTerms('高校生と高 校 生')).toEqual(['高校生'])
  })
  test('a longer word found with a space wins over a shorter one next to it', () => {
    expect(findMinorTerms('女子 高校生')).toEqual(['高校生'])
  })
})

describe('findMinorTerms: added words and boundaries', () => {
  test('finds the added status words', () => {
    const words = [
      '女子生徒',
      '男子生徒',
      '女生徒',
      '男生徒',
      '生徒会',
      '女児',
      '男児',
      '高等部',
      '中等部',
      '初等部',
      '低学年',
      '高学年',
      '未就学',
      '学童'
    ]
    for (const word of words) {
      expect(findMinorTerms(`彼女は${word}だ`)).toEqual([word])
    }
  })
  test('finds the kana spellings, hiragana and katakana', () => {
    const words = [
      'こうこうせい',
      'コウコウセイ',
      'ちゅうがくせい',
      'チュウガクセイ',
      'しょうがくせい',
      'ショウガクセイ',
      'じょしこうせい',
      'ジョシコウセイ',
      'みせいねん',
      'ミセイネン'
    ]
    for (const word of words) {
      expect(findMinorTerms(`彼女は${word}だ`)).toEqual([word])
    }
  })
  test('a short grade expression after a word for the time is a grade', () => {
    expect(findMinorTerms('現在高2の')).toEqual(['高2'])
    expect(findMinorTerms('今年中3になった')).toEqual(['中3'])
    expect(findMinorTerms('来年小6')).toEqual(['小6'])
    expect(findMinorTerms('去年高1だった')).toEqual(['高1'])
    expect(findMinorTerms('昨年中2')).toEqual(['中2'])
    expect(findMinorTerms('当時高3')).toEqual(['高3'])
    expect(findMinorTerms('まだ高2')).toEqual(['高2'])
    expect(findMinorTerms('春から中1')).toEqual(['中1'])
    expect(findMinorTerms('もう高三')).toEqual(['高三'])
  })
  test('the other words that end in a kanji still block a short grade expression', () => {
    expect(findMinorTerms('途中1回')).toEqual([])
    expect(findMinorTerms('標高2000m')).toEqual([])
    expect(findMinorTerms('最高3位')).toEqual([])
  })
  test('a grade after the school name and の', () => {
    expect(findMinorTerms('高校の2年')).toEqual(['高校の2年'])
    expect(findMinorTerms('高校の二年生')).toEqual(['高校の二年'])
    expect(findMinorTerms('高等学校の3年')).toEqual(['高等学校の3年'])
    expect(findMinorTerms('中学の3年')).toEqual(['中学の3年'])
    expect(findMinorTerms('中学校の一年')).toEqual(['中学校の一年'])
    expect(findMinorTerms('小学校の5年')).toEqual(['小学校の5年'])
    expect(findMinorTerms('小学の六年生')).toEqual(['小学の六年'])
    expect(findMinorTerms('高校の3年間は部活漬けだった')).toEqual([])
  })
  test('finds the English words, any case, only as whole words', () => {
    const words = [
      'teen',
      'teens',
      'teenage',
      'teenager',
      'teenagers',
      'schoolgirl',
      'schoolboy',
      'schoolgirls',
      'high schooler',
      'high school student',
      'high school students',
      'middle schooler',
      'middle school student',
      'underage',
      'minors',
      'a minor',
      'loli',
      'lolita',
      'shota'
    ]
    for (const word of words) {
      expect(findMinorTerms(`a ${word}.`)).toEqual([word.toUpperCase()])
      expect(findMinorTerms(`A ${word.toUpperCase()}.`)).toEqual([word.toUpperCase()])
    }
    expect(findMinorTerms('She is a Teenager')).toEqual(['TEENAGER'])
    expect(findMinorTerms('high  school   student')).toEqual(['HIGH SCHOOL STUDENT'])
    expect(findMinorTerms('high\tschool student')).toEqual(['HIGH SCHOOL STUDENT'])
    expect(findMinorTerms('high\nschool student')).toEqual([])
  })
  test('the English words do not match inside other words', () => {
    const others = [
      'fourteen',
      'sixteen',
      'nineteen',
      'eighteen',
      'minority',
      'minority report',
      'Minor Arcana',
      'a minority',
      'minor injury',
      'Shotaro',
      'terminal',
      'high school',
      'middle school',
      'the school boy'
    ]
    for (const text of others) {
      expect(findMinorTerms(text)).toEqual([])
    }
  })
  test('words for an adult stay clean', () => {
    const adult = [
      '高校教師',
      '高校を卒業後、上京した',
      '高校時代はバスケ部',
      '大学2年生',
      '学生時代',
      '若い頃',
      '子供の頃',
      '警察官の制服',
      '生徒に慕われる教師',
      '三十代',
      '3歳年上の兄'
    ]
    for (const text of adult) {
      expect(findMinorTerms(text)).toEqual([])
      expect(findMinorTerms(text, { appearance: true })).toEqual([])
    }
  })
})

describe('findMinorTerms: words for the appearance only', () => {
  const found: Array<[string, string]> = [
    ['幼い体つき', '幼い'],
    ['幼げな瞳', '幼げ'],
    ['幼さが残る', '幼さ'],
    ['あどけない顔立ち', 'あどけな'],
    ['あどけなさの残る', 'あどけな'],
    ['童顔', '童顔'],
    ['子供っぽい', '子供っぽ'],
    ['子どもっぽい', '子どもっぽ'],
    ['こどもっぽい', 'こどもっぽ'],
    ['子供のような', '子供のよう'],
    ['子どものような', '子どものよう'],
    ['こどものような', 'こどものよう'],
    ['子供みたいな', '子供みたい'],
    ['子どもみたいな', '子どもみたい'],
    ['こどもみたいな', 'こどもみたい'],
    ['学ラン姿', '学ラン'],
    ['学生服', '学生服'],
    ['高校の制服姿にする', '高校の制服'],
    ['高校制服', '高校制服'],
    ['高等学校の制服', '高等学校の制服'],
    ['中学の制服', '中学の制服'],
    ['中学校の制服', '中学校の制服'],
    ['小学の制服', '小学の制服'],
    ['小学校の制服', '小学校の制服'],
    ['学校の制服', '学校の制服'],
    ['学園の制服', '学園の制服'],
    ['ランドセル', 'ランドセル'],
    ['スクール水着', 'スクール水着'],
    ['ブルマ', 'ブルマ'],
    ['体操服', '体操服'],
    ['通学帽', '通学帽'],
    ['少女のような', '少女'],
    ['少年のような', '少年']
  ]
  test('セーラー服 is found in every field, not only the appearance', () => {
    expect(findMinorTerms('セーラー服')).toEqual(['セーラー服'])
    expect(findMinorTerms('セーラー服', { appearance: true })).toEqual(['セーラー服'])
  })
  test('are found with the appearance option', () => {
    for (const [text, term] of found) {
      expect(findMinorTerms(text, { appearance: true })).toEqual([term])
    }
  })
  test('are not found without it (occupation and background may use them)', () => {
    for (const [text] of found) {
      expect(findMinorTerms(text)).toEqual([])
    }
    expect(findMinorTerms('幼い頃に両親を亡くした')).toEqual([])
    expect(findMinorTerms('少女漫画家')).toEqual([])
  })
  test('the example from the review', () => {
    expect(findMinorTerms('セーラー服にランドセル', { appearance: true })).toEqual(['セーラー服', 'ランドセル'])
    expect(findMinorTerms('幼い体つきで、あどけない顔立ち', { appearance: true })).toEqual(['幼い', 'あどけな'])
  })
  test('the uniform of a school is found only with the appearance option', () => {
    expect(findMinorTerms('高校の制服姿にする', { appearance: true })).toEqual(['高校の制服'])
    expect(findMinorTerms('高校の制服姿にする')).toEqual([])
    expect(findMinorTerms('高校の制服を着ていた頃')).toEqual([])
    expect(findMinorTerms('高 校 の 制 服', { appearance: true })).toEqual(['高校の制服'])
  })
  test('the uniform of an adult school or a company is not found, nor is 制服 alone', () => {
    for (const text of [
      '制服',
      '警察官の制服',
      '会社の制服',
      '警察学校の制服',
      '看護学校の制服',
      '専門学校の制服',
      '消防学校の制服',
      '大学校の制服'
    ]) {
      expect(findMinorTerms(text, { appearance: true })).toEqual([])
    }
  })
  test('制服 alone and ブルマン are not found', () => {
    expect(findMinorTerms('制服', { appearance: true })).toEqual([])
    expect(findMinorTerms('警察官の制服がよく似合う', { appearance: true })).toEqual([])
    expect(findMinorTerms('ブルマンコーヒー', { appearance: true })).toEqual([])
  })
  test('幼児体型 is found as itself with the option and as 幼児 without', () => {
    expect(findMinorTerms('幼児体型', { appearance: true })).toEqual(['幼児体型'])
    expect(findMinorTerms('幼児体型')).toEqual(['幼児'])
  })
  test('they are found after the spaces are removed too', () => {
    expect(findMinorTerms('セ ー ラ ー 服', { appearance: true })).toEqual(['セーラー服'])
    expect(findMinorTerms('ラン ドセル', { appearance: true })).toEqual(['ランドセル'])
  })
})

describe('findMinorTerms: ordinary adult settings that were flagged by mistake', () => {
  test('a list of ages where the later number is one digit takes the tens of the earlier one', () => {
    for (const text of ['25、6歳', '二十五、六歳', '35、6歳くらい', '27、8歳', '49、50歳', '25,6歳']) {
      expect(findMinorTerms(text)).toEqual([])
    }
  })
  test('a list that includes a minor is still a problem', () => {
    expect(findMinorTerms('5、6歳の頃')).toEqual(['5歳'])
    expect(findMinorTerms('15、6歳')).toEqual(['15歳'])
    expect(findMinorTerms('17、8歳')).toEqual(['17歳'])
    expect(findMinorTerms('1,2歳')).toEqual(['1歳'])
    expect(findMinorTerms('七、八歳')).toEqual(['7歳'])
  })
  test('the tens carry over a whole list', () => {
    expect(findMinorTerms('25、6、7歳')).toEqual([])
    expect(findMinorTerms('15、6、7歳')).toEqual(['15歳'])
  })
  test('a comma between thousands is not a list', () => {
    for (const text of ['1,000歳を超える吸血鬼', '1,500歳のエルフ', '10,000歳', '1,000,000歳', '１，０００歳']) {
      expect(findMinorTerms(text)).toEqual([])
    }
  })
  test('the thousands comma is removed from the scanned text', () => {
    expect(normalizeForMinorScan('1,000歳')).toBe('1000歳')
    expect(normalizeForMinorScan('1,000,000歳')).toBe('1000000歳')
    expect(normalizeForMinorScan('１，５００歳')).toBe('1500歳')
    expect(normalizeForMinorScan('1,23歳')).toBe('1,23歳')
    expect(normalizeForMinorScan('1,0000歳')).toBe('1,0000歳')
    expect(normalizeForMinorScan('a,000')).toBe('a,000')
  })
  test('男児 after a place name or 日本 means an adult', () => {
    for (const text of ['九州男児らしい', '日本男児', '薩摩男児', '土佐男児', '江戸男児', '大和男児']) {
      expect(findMinorTerms(text)).toEqual([])
    }
    expect(findMinorTerms('男児')).toEqual(['男児'])
    expect(findMinorTerms('男児を出産した')).toEqual(['男児'])
    expect(findMinorTerms('九州の男児')).toEqual(['男児'])
  })
  test('学童 before 保育 / クラブ / 指導 is a job or a field', () => {
    for (const text of ['学童保育の指導員', '学童クラブのスタッフ', '学童指導員']) {
      expect(findMinorTerms(text)).toEqual([])
    }
    expect(findMinorTerms('学童')).toEqual(['学童'])
    expect(findMinorTerms('学童期の記憶')).toEqual(['学童'])
  })
  test('JS and JC are not read as the abbreviations of JavaScript and the like', () => {
    for (const text of [
      'JSエンジニア',
      'ベテランJSエンジニア',
      'フロントエンド(JS/TS)開発',
      'JS開発',
      'JS',
      'jc と js',
      'JC連合',
      'Vue.js の開発者'
    ]) {
      expect(findMinorTerms(text)).toEqual([])
    }
  })
  test('JK is always found, JS and JC when a digit follows or both sides are hiragana / kanji', () => {
    expect(findMinorTerms('JKエンジニア')).toEqual(['JK'])
    expect(findMinorTerms('JS5')).toEqual(['JS'])
    expect(findMinorTerms('JC3')).toEqual(['JC'])
    expect(findMinorTerms('彼女はJSだ')).toEqual(['JS'])
    expect(findMinorTerms('現役JCの')).toEqual(['JC'])
    expect(findMinorTerms('JSの少女')).toEqual([])
  })
  test('minor is found as minors, a minor and underage only', () => {
    expect(findMinorTerms('Minor Arcana の研究者')).toEqual([])
    expect(findMinorTerms('minors')).toEqual(['MINORS'])
    expect(findMinorTerms('a minor')).toEqual(['A MINOR'])
    expect(findMinorTerms('She is underage')).toEqual(['UNDERAGE'])
  })
  test('ティーン誌 and ロリータファッション are still caught (not changed)', () => {
    expect(findMinorTerms('ティーン誌の編集者')).toEqual(['ティーン'])
    expect(findMinorTerms('ロリータファッションの店員')).toEqual(['ロリ'])
  })
})

describe('findMinorTerms: ordinary ways to write a minor', () => {
  test('saying that the person is not 18 yet counts like 未満', () => {
    const phrases: Array<[string, string]> = [
      ['18歳を迎えていない', '18歳を迎えていない'],
      ['18歳になる前に両親を亡くし', '18歳になる前'],
      ['18歳に届かない', '18歳に届かない'],
      ['18歳まで施設で育った', '18歳まで'],
      ['十八歳までの子供', '18歳まで'],
      ['19歳になる前', '19歳になる前'],
      ['20歳まで', '20歳まで'],
      ['14歳になる前', '14歳になる前'],
      ['10歳まで', '10歳まで']
    ]
    for (const [text, term] of phrases) {
      expect(findMinorTerms(text)).toEqual([term])
    }
  })
  test('the same words after an age above 20, or without the words, are fine', () => {
    for (const text of [
      '21歳まで',
      '25歳になる前',
      '30歳に届かない',
      '18歳になる',
      '18歳から',
      '18歳の誕生日',
      '20歳を迎えた'
    ]) {
      expect(findMinorTerms(text)).toEqual([])
    }
  })
  test('an English age under 18 is found', () => {
    const phrases = [
      '14yo',
      '14 y/o',
      '14 years old',
      '14-year-old',
      '14 year old',
      '14 yrs old',
      'age 14',
      'aged 14',
      'Age: 14'
    ]
    for (const text of phrases) {
      expect(findMinorTerms(text)).toEqual([text.toUpperCase()])
    }
    expect(findMinorTerms('a 17-year-old girl')).toEqual(['17-YEAR-OLD'])
    expect(findMinorTerms('１４ｙｏ')).toEqual(['14YO'])
  })
  test('an English age of 18 or more, and words that only look like it, are fine', () => {
    for (const text of [
      '18yo',
      '18 years old',
      '20-year-old',
      'age 25',
      'aged 30',
      'age 2000',
      '14 yoga',
      'average 14 items',
      'manage 14',
      'x114yo'
    ]) {
      expect(findMinorTerms(text)).toEqual([])
    }
  })
  test('ちゃい is the child form of 歳', () => {
    expect(findMinorTerms('14ちゃい')).toEqual(['14歳'])
    expect(findMinorTerms('十四ちゃい')).toEqual(['14歳'])
    expect(findMinorTerms('20ちゃい')).toEqual([])
  })
  test('a grade without a school name next to a word for a child', () => {
    const phrases = [
      '5年生の女の子',
      '3年生の男の子',
      '6年生の少女',
      '2年生の少年',
      '一年生の女子',
      '四年生の男子',
      '6年生の子供',
      '5年生の子ども',
      '３年生の女の子'
    ]
    for (const text of phrases) {
      expect(findMinorTerms(text)).toHaveLength(1)
    }
    expect(findMinorTerms('5年生の女の子')).toEqual(['5年生の女の子'])
    expect(findMinorTerms('６年生の少女')).toEqual(['6年生の少女'])
    expect(findMinorTerms('2年生の少年', { appearance: true })).toEqual(['2年生の少年'])
  })
  test('the same after a college is an adult, and a grade alone is not a minor', () => {
    const adult = [
      '大学3年生の女の子',
      '大学院2年生の男の子',
      '大学の3年生の女の子',
      '専門学校2年生の男子',
      '短大1年生の女子',
      '短期大学2年生の女の子',
      '3年生の担任',
      '入社3年目',
      '5年生'
    ]
    for (const text of adult) {
      expect(findMinorTerms(text)).toEqual([])
      expect(findMinorTerms(text, { appearance: true })).toEqual([])
    }
  })
  test('a grade with a school name before a child word is found once, as the school grade', () => {
    expect(findMinorTerms('小学5年生の女の子')).toEqual(['小学5年'])
    expect(findMinorTerms('高校の3年生の少女')).toEqual(['高校の3年'])
  })
  test('the old tests: what passed still passes, what was caught is still caught', () => {
    const passed = ['高校教師', '3歳年上', '20歳', '警察官の制服', '入社3年目', '身長158cm', '30代', '小太郎', '中二病']
    for (const text of passed) {
      expect(findMinorTerms(text)).toEqual([])
    }
    expect(findMinorTerms('実年齢は14歳')).toEqual(['14歳'])
    expect(findMinorTerms('高 校 生')).toEqual(['高校生'])
    expect(findMinorTerms('女子生徒')).toEqual(['女子生徒'])
    expect(findMinorTerms('幼い体つき', { appearance: true })).toEqual(['幼い'])
    expect(findMinorTerms('JS5')).toEqual(['JS'])
    expect(findMinorTerms('18歳未満')).toEqual(['18歳未満'])
  })
})

describe('locateMinorTerms', () => {
  test('gives the positions in normalizeForMinorScan(text)', () => {
    const text = '彼女は高２だ'
    const normalized = normalizeForMinorScan(text)
    expect(normalized).toBe('彼女は高2だ')
    expect(locateMinorTerms(text)).toEqual([{ term: '高2', start: 3, end: 5 }])
    expect(normalized.slice(3, 5)).toBe('高2')
  })
  test('a word with spaces in it covers the range in the normalized text, with the term without the spaces', () => {
    const text = '彼女は高　校　生だ'
    const normalized = normalizeForMinorScan(text)
    expect(normalized).toBe('彼女は高 校 生だ')
    expect(locateMinorTerms(text)).toEqual([{ term: '高校生', start: 3, end: 8 }])
    expect(normalized.slice(3, 8)).toBe('高 校 生')
  })
  test('invisible characters are removed before the positions are taken', () => {
    const text = '彼女は​高⁠２'
    expect(normalizeForMinorScan(text)).toBe('彼女は高2')
    expect(locateMinorTerms(text)).toEqual([{ term: '高2', start: 3, end: 5 }])
  })
  test('an age expression is located with the normalized term', () => {
    const text = '実年齢は十四歳です'
    expect(locateMinorTerms(text)).toEqual([{ term: '14歳', start: 4, end: 7 }])
    expect(normalizeForMinorScan(text).slice(4, 7)).toBe('十四歳')
  })
  test('words, English words and ages come in the order they appear', () => {
    const text = 'JKの女子高生、十四歳'
    expect(locateMinorTerms(text)).toEqual([
      { term: 'JK', start: 0, end: 2 },
      { term: '女子高生', start: 3, end: 7 },
      { term: '14歳', start: 8, end: 11 }
    ])
  })
  test('a word found only after the spaces are removed is placed among the others by position', () => {
    const text = '高 校 生とJKと14歳'
    const found = locateMinorTerms(text)
    expect(found.map((item) => item.term)).toEqual(['高校生', 'JK', '14歳'])
    expect(found.map((item) => item.start)).toEqual([...found.map((item) => item.start)].sort((a, b) => a - b))
    const normalized = normalizeForMinorScan(text)
    expect(found.map((item) => normalized.slice(item.start, item.end))).toEqual(['高 校 生', 'JK', '14歳'])
  })
  test('a word found directly and again after the spaces are removed is not listed twice', () => {
    const text = '女子高校生と高 校 生'
    const normalized = normalizeForMinorScan(text)
    const found = locateMinorTerms(text)
    expect(found.map((item) => item.term)).toEqual(['女子高校生', '高校生'])
    expect(found.map((item) => normalized.slice(item.start, item.end))).toEqual(['女子高校生', '高 校 生'])
    // 空白を取り除いた文で見つかった「女子高校生」は、1 段目で見つかった同じ範囲と重ならない形でだけ足される
    expect(locateMinorTerms('女子高校生')).toEqual([{ term: '女子高校生', start: 0, end: 5 }])
  })
  test('an English word is located on the first pass only', () => {
    expect(locateMinorTerms('She is a teenager.')).toEqual([{ term: 'TEENAGER', start: 9, end: 17 }])
    expect(locateMinorTerms('t e e n')).toEqual([])
  })
  test('the appearance option adds the appearance words', () => {
    expect(locateMinorTerms('少女のような顔')).toEqual([])
    expect(locateMinorTerms('少女のような顔', { appearance: true })).toEqual([{ term: '少女', start: 0, end: 2 }])
  })
  test('nothing found, or an empty text', () => {
    expect(locateMinorTerms('')).toEqual([])
    expect(locateMinorTerms('二十代の会社員')).toEqual([])
    expect(locateMinorTerms('途中。学生は')).toEqual([])
  })
  test('findMinorTerms is the terms of locateMinorTerms without duplicates', () => {
    const text = '女子高生。高2で、十代で、女子高生で、JK、14歳、十四歳'
    const terms = locateMinorTerms(text).map((item) => item.term)
    expect(terms).toEqual(['女子高生', '高2', '十代', '女子高生', 'JK', '14歳', '14歳'])
    expect(findMinorTerms(text)).toEqual([...new Set(terms)])
  })
  test('can be called repeatedly with the same result', () => {
    const first = locateMinorTerms('高2と14歳と高 校 生')
    expect(locateMinorTerms('高2と14歳と高 校 生')).toEqual(first)
    expect(locateMinorTerms('高2と14歳と高 校 生')).toEqual(first)
  })
})

describe('validateAdultCast: loopholes found in the review', () => {
  const row = (overrides: Partial<BibleCast> = {}): BibleCast => ({
    name: 'かぐや',
    age: '18',
    occupation: '会社員',
    appearance: '黒髪',
    background: '都内で働く',
    ...overrides
  })
  const check = (overrides: Partial<BibleCast>): string[] => validateAdultCast('R18', [row(overrides)], ['かぐや'])

  test('an age written in another field is a problem', () => {
    expect(check({ appearance: '見た目は12歳ほどの幼い体つき' })).toEqual([
      'かぐや の外見に、未成年を指す語（「12歳」「幼い」）が残っています'
    ])
    expect(check({ background: '戸籍上は18歳だが実年齢は14歳' })).toEqual([
      'かぐや の背景に、未成年を指す語（「14歳」）が残っています'
    ])
    expect(check({ background: '戸籍上は18歳だが実年齢は十四歳' })).toEqual([
      'かぐや の背景に、未成年を指す語（「14歳」）が残っています'
    ])
    expect(check({ occupation: '14歳の探偵' })).toEqual(['かぐや の職業に、未成年を指す語（「14歳」）が残っています'])
    expect(check({ background: '18歳未満の頃に家を出た' })).toEqual([
      'かぐや の背景に、未成年を指す語（「18歳未満」）が残っています'
    ])
  })
  test('an age difference or an adult age in another field is fine', () => {
    expect(check({ background: '3歳年上の兄と、二十歳の妹がいる。5歳差の姉もいた' })).toEqual([])
    expect(check({ appearance: '18歳の頃から変わらない黒髪' })).toEqual([])
  })
  test('invisible characters and spaces do not hide a word', () => {
    const hiddenForms = [
      '高​校生',
      '高­校生',
      '高⁠校生',
      '高﻿校生',
      '高️校生',
      '高 校 生',
      '高校　生',
      '高・校・生',
      '髙校生'
    ]
    for (const occupation of hiddenForms) {
      expect(check({ occupation })).toEqual(['かぐや の職業に、未成年を指す語（「高校生」）が残っています'])
    }
  })
  test('words that were not in the list before', () => {
    expect(check({ occupation: '女子生徒' })).toEqual(['かぐや の職業に、未成年を指す語（「女子生徒」）が残っています'])
    expect(check({ background: '現在高2の秋' })).toEqual(['かぐや の背景に、未成年を指す語（「高2」）が残っています'])
    expect(check({ background: '今年中3になった' })).toEqual([
      'かぐや の背景に、未成年を指す語（「中3」）が残っています'
    ])
    expect(check({ background: '高校の2年のとき' })).toEqual([
      'かぐや の背景に、未成年を指す語（「高校の2年」）が残っています'
    ])
    expect(check({ appearance: 'セーラー服にランドセル' })).toEqual([
      'かぐや の外見に、未成年を指す語（「セーラー服」「ランドセル」）が残っています'
    ])
    expect(check({ appearance: '幼い体つきで、あどけない顔立ち' })).toEqual([
      'かぐや の外見に、未成年を指す語（「幼い」「あどけな」）が残っています'
    ])
  })
  test('the words for the appearance are fine in the occupation and the background', () => {
    expect(
      check({ occupation: '学生服の仕立て職人', background: '幼い頃は田舎で育ち、ランドセルの工房で働いた' })
    ).toEqual([])
  })
  test('the uniform of a school is a problem in the appearance, not in the background', () => {
    expect(check({ appearance: '高校の制服姿' })).toEqual([
      'かぐや の外見に、未成年を指す語（「高校の制服」）が残っています'
    ])
    expect(check({ background: '高校の制服を着ていた頃に出会った' })).toEqual([])
    expect(check({ appearance: '警察官の制服がよく似合う' })).toEqual([])
  })
  test('セーラー服 is a problem in the occupation and the background too', () => {
    expect(check({ occupation: 'セーラー服の販売員' })).toEqual([
      'かぐや の職業に、未成年を指す語（「セーラー服」）が残っています'
    ])
    expect(check({ background: '昔はセーラー服が好きだった' })).toEqual([
      'かぐや の背景に、未成年を指す語（「セーラー服」）が残っています'
    ])
  })
  test('the ordinary ways to write a minor are problems', () => {
    expect(check({ background: '18歳になる前に両親を亡くした' })).toEqual([
      'かぐや の背景に、未成年を指す語（「18歳になる前」）が残っています'
    ])
    expect(check({ appearance: '14yo のような顔立ち' })).toEqual([
      'かぐや の外見に、未成年を指す語（「14YO」）が残っています'
    ])
    expect(check({ background: '小学5年生の女の子だった' })).not.toEqual([])
    expect(check({ background: '5年生の女の子を助けた' })).toEqual([
      'かぐや の背景に、未成年を指す語（「5年生の女の子」）が残っています'
    ])
  })
  test('the ordinary adult settings that used to be flagged by mistake pass', () => {
    expect(
      check({
        occupation: '学童保育の指導員',
        appearance: '25、6歳に見える黒髪の女性',
        background: '九州男児の父と、1,000歳を超えるエルフの母を持つ。大学3年生の女の子と友達だった'
      })
    ).toEqual([])
  })
  test('an adult setting passes', () => {
    expect(
      check({
        age: '25歳',
        occupation: '高校教師',
        appearance: '警察官の制服がよく似合う、落ち着いた雰囲気',
        background: '高校時代はバスケ部。大学2年生のときに留学した。子供の頃は田舎で育ち、若い頃は旅をした'
      })
    ).toEqual([])
  })
  test('an all-ages work is never checked', () => {
    const bad = row({ occupation: '女子高生', appearance: '12歳ほどの幼い体つき', background: '14歳' })
    expect(validateAdultCast('全年齢', [bad], ['かぐや'])).toEqual([])
  })
})

describe('validateAdultBibleText: ages and hidden words', () => {
  const clean = () => ({
    premise: '竹取の翁が光る竹の中から女性を見つける。',
    ending: 'かぐやは月へ帰る。',
    arcs: [{ name: 'かぐや', start: '竹林で暮らす', end: '月へ帰る' }],
    world: { rules: ['月の民は地上に長く居られない'], terms: [{ term: '月の都', note: '月の民の国' }] },
    timeline: ['春: 竹から生まれる', '夏: 求婚が始まる']
  })
  const check = (override: Record<string, unknown>) => validateAdultBibleText('R18', { ...clean(), ...override })

  test('an age under 18 is a problem in every item', () => {
    expect(check({ premise: '主人公は14歳の少女だ' })).toEqual([
      '作品設計の物語の核に、未成年を指す語（「14歳」）が残っています'
    ])
    expect(check({ ending: '十五歳のかぐやが帰る' })).toEqual([
      '作品設計の結末に、未成年を指す語（「15歳」）が残っています'
    ])
    expect(check({ arcs: [{ name: 'かぐや', start: '12歳の頃', end: '' }] })).toEqual([
      '作品設計の人物の変化に、未成年を指す語（「12歳」）が残っています'
    ])
    expect(check({ world: { rules: ['18歳未満は入れない'], terms: [] } })).toEqual([
      '作品設計の世界のルールに、未成年を指す語（「18歳未満」）が残っています'
    ])
    expect(check({ world: { rules: [], terms: [{ term: '学び舎', note: '10歳から通う' }] } })).toEqual([
      '作品設計の用語に、未成年を指す語（「10歳」）が残っています'
    ])
    expect(check({ timeline: ['春: 8歳で両親を亡くす'] })).toEqual([
      '作品設計の時系列に、未成年を指す語（「8歳」）が残っています'
    ])
    expect(check({ addresses: [{ call: '17歳' }] })).toEqual([
      '作品設計の呼称表に、未成年を指す語（「17歳」）が残っています'
    ])
  })
  test('an adult age or an age difference is fine', () => {
    expect(check({ premise: '20歳の誕生日を迎える。3歳年上の兄がいる' })).toEqual([])
    expect(check({ timeline: ['春: 18歳になる'] })).toEqual([])
  })
  test('invisible characters and spaces do not hide a word', () => {
    expect(check({ premise: '高​校生の物語' })).toEqual([
      '作品設計の物語の核に、未成年を指す語（「高校生」）が残っています'
    ])
    expect(check({ timeline: ['春: 高 校 生活'] })).toEqual([])
    expect(check({ timeline: ['春: 女子 高生が来る'] })).toEqual([
      '作品設計の時系列に、未成年を指す語（「女子高生」）が残っています'
    ])
  })
  test('an all-ages work is never checked', () => {
    expect(
      validateAdultBibleText('全年齢', { ...clean(), premise: '14歳の女子高生', addresses: [{ call: '12歳' }] })
    ).toEqual([])
  })
})

describe('validateAdultCast', () => {
  const row = (name: string, age: string, overrides: Partial<BibleCast> = {}): BibleCast => ({
    name,
    age,
    occupation: '会社員',
    appearance: '黒髪',
    background: '都内で働く',
    ...overrides
  })
  const ageProblem = (name: string, value: string): string =>
    `${name} の年齢は、18 以上の数字だけで書いてください（今の値:「${value}」）`

  test('is always empty for an all-ages work', () => {
    expect(validateAdultCast('全年齢', [], ['かぐや', '翁'])).toEqual([])
    expect(validateAdultCast('全年齢', [row('かぐや', '12')], ['かぐや'])).toEqual([])
    expect(validateAdultCast('全年齢', [row('かぐや', '二十代', { occupation: '女子高生' })], ['かぐや'])).toEqual([])
    expect(validateAdultCast('', [], ['かぐや'])).toEqual([])
  })
  test('reports a person without a row', () => {
    expect(validateAdultCast('R18', [row('翁', '60歳')], ['かぐや', '翁'])).toEqual([
      'かぐや の成人としての設定がありません'
    ])
    expect(validateAdultCast('R15', [], ['かぐや'])).toEqual(['かぐや の成人としての設定がありません'])
  })
  test('reports an age under 18', () => {
    expect(validateAdultCast('R18', [row('かぐや', '17歳')], ['かぐや'])).toEqual([
      'かぐや の年齢が 17 歳です（18 歳以上にしてください）'
    ])
    expect(validateAdultCast('R15', [row('かぐや', '１０才')], ['かぐや'])).toEqual([
      'かぐや の年齢が 10 歳です（18 歳以上にしてください）'
    ])
    expect(validateAdultCast('R18', [row('かぐや', '0')], ['かぐや'])).toEqual([
      'かぐや の年齢が 0 歳です（18 歳以上にしてください）'
    ])
  })
  test('18 and older are fine', () => {
    for (const age of ['18', '18歳', '１８才', '20歳', '19', '300歳']) {
      expect(validateAdultCast('R18', [row('かぐや', age)], ['かぐや'])).toEqual([])
      expect(validateAdultCast('R15', [row('かぐや', age)], ['かぐや'])).toEqual([])
    }
  })
  test('every loophole in the age field is a problem', () => {
    const loopholes = [
      '18歳未満',
      '18歳以下',
      '18に満たない',
      '十四歳（設定上は18）',
      '見た目は18歳、実年齢は十四',
      '10代、18歳',
      '17〜19歳',
      '二十代',
      '二十歳',
      '20代',
      '成人',
      '不明',
      ''
    ]
    for (const age of loopholes) {
      expect(validateAdultCast('R18', [row('かぐや', age)], ['かぐや'])).toEqual([ageProblem('かぐや', age)])
      expect(validateAdultCast('R15', [row('かぐや', age)], ['かぐや'])).toHaveLength(1)
    }
  })
  test('the current value in the message is cut at 30 characters, on one line', () => {
    const long = 'あ'.repeat(40)
    expect(validateAdultCast('R18', [row('かぐや', long)], ['かぐや'])).toEqual([
      `かぐや の年齢は、18 以上の数字だけで書いてください（今の値:「${'あ'.repeat(30)}…」）`
    ])
    const exactly = 'い'.repeat(30)
    expect(validateAdultCast('R18', [row('かぐや', exactly)], ['かぐや'])).toEqual([ageProblem('かぐや', exactly)])
    expect(validateAdultCast('R18', [row('かぐや', ' 18歳\n未満 ')], ['かぐや'])).toEqual([
      ageProblem('かぐや', '18歳 未満')
    ])
  })
  test('a minor term left in the occupation, appearance or background is a problem', () => {
    expect(validateAdultCast('R18', [row('かぐや', '18', { occupation: '女子高生' })], ['かぐや'])).toEqual([
      'かぐや の職業に、未成年を指す語（「女子高生」）が残っています'
    ])
    expect(validateAdultCast('R18', [row('かぐや', '18', { appearance: '中学の制服の少女' })], ['かぐや'])).toEqual([
      'かぐや の外見に、未成年を指す語（「中学の制服」「少女」）が残っています'
    ])
    expect(
      validateAdultCast('R15', [row('かぐや', '18', { background: '高校3年生の秋に出会った' })], ['かぐや'])
    ).toEqual(['かぐや の背景に、未成年を指す語（「高校3年」）が残っています'])
  })
  test('lists every minor term of a field, and every field, after the age problem', () => {
    const bad = row('かぐや', '17', { occupation: '高2のJK', appearance: '少年のような美少女', background: '十代の頃' })
    expect(validateAdultCast('R18', [bad], ['かぐや'])).toEqual([
      'かぐや の年齢が 17 歳です（18 歳以上にしてください）',
      'かぐや の職業に、未成年を指す語（「高2」「JK」）が残っています',
      'かぐや の外見に、未成年を指す語（「少年」「美少女」）が残っています',
      'かぐや の背景に、未成年を指す語（「十代」）が残っています'
    ])
  })
  test('words that are normal for an adult pass', () => {
    const adult = row('かぐや', '25', {
      occupation: '高校教師',
      appearance: '黒髪の女性',
      background: '高校を卒業後、上京した。大学2年生のときに留学した'
    })
    expect(validateAdultCast('R18', [adult], ['かぐや'])).toEqual([])
    expect(validateAdultCast('R18', [row('翁', '60', { occupation: '少女漫画家' })], ['翁'])).toEqual([])
    expect(validateAdultCast('R18', [row('翁', '60', { occupation: '少年野球のコーチ' })], ['翁'])).toEqual([])
  })
  test('少女 and 少年 are a problem in the appearance only', () => {
    expect(validateAdultCast('R18', [row('かぐや', '20', { appearance: '少女のような' })], ['かぐや'])).toEqual([
      'かぐや の外見に、未成年を指す語（「少女」）が残っています'
    ])
    expect(
      validateAdultCast('R18', [row('かぐや', '20', { background: '少女時代は田舎で育った' })], ['かぐや'])
    ).toEqual([])
  })
  test('reports every problem, in the order of the cast names', () => {
    const rows = [row('翁', '15歳'), row('かぐや', '20歳'), row('帝', '16歳'), row('童', '子供')]
    expect(validateAdultCast('R18', rows, ['帝', 'かぐや', '嫗', '翁', '童'])).toEqual([
      '帝 の年齢が 16 歳です（18 歳以上にしてください）',
      '嫗 の成人としての設定がありません',
      '翁 の年齢が 15 歳です（18 歳以上にしてください）',
      ageProblem('童', '子供')
    ])
  })
  test('an empty cast has nothing to report', () => {
    expect(validateAdultCast('R18', [row('かぐや', '10歳')], [])).toEqual([])
  })
  test('rows for people outside the cast are not checked', () => {
    expect(validateAdultCast('R18', [row('かぐや', '20歳'), row('誰か', '5歳')], ['かぐや'])).toEqual([])
  })
  test('matches names ignoring surrounding whitespace', () => {
    expect(validateAdultCast('R18', [row(' かぐや ', '20歳')], ['かぐや'])).toEqual([])
  })
  test('a person listed twice is reported once', () => {
    expect(validateAdultCast('R18', [], ['かぐや', 'かぐや'])).toEqual(['かぐや の成人としての設定がありません'])
  })
})

describe('validateAdultBibleText', () => {
  const clean = () => ({
    premise: '竹取の翁が光る竹の中から女性を見つける。',
    ending: 'かぐやは月へ帰る。',
    arcs: [{ name: 'かぐや', start: '竹林で暮らす', end: '月へ帰る' }],
    world: { rules: ['月の民は地上に長く居られない'], terms: [{ term: '月の都', note: '月の民の国' }] },
    timeline: ['春: 竹から生まれる', '夏: 求婚が始まる']
  })

  test('is empty for a clean bible', () => {
    expect(validateAdultBibleText('R18', clean())).toEqual([])
    expect(validateAdultBibleText('R15', clean())).toEqual([])
  })
  test('is always empty for an all-ages work', () => {
    const bad = { ...clean(), premise: '高校生の物語', ending: '女子高生が泣く' }
    expect(validateAdultBibleText('全年齢', bad)).toEqual([])
    expect(validateAdultBibleText('', bad)).toEqual([])
  })
  test('reports each item that has a minor term', () => {
    const item = (override: Partial<ReturnType<typeof clean>>) =>
      validateAdultBibleText('R18', { ...clean(), ...override })
    expect(item({ premise: '高校生の主人公が旅に出る' })).toEqual([
      '作品設計の物語の核に、未成年を指す語（「高校生」）が残っています'
    ])
    expect(item({ ending: '女子高生に戻る' })).toEqual([
      '作品設計の結末に、未成年を指す語（「女子高生」）が残っています'
    ])
    expect(item({ arcs: [{ name: 'かぐや', start: '高2の少女', end: '大人になる' }] })).toEqual([
      '作品設計の人物の変化に、未成年を指す語（「高2」）が残っています'
    ])
    expect(item({ arcs: [{ name: 'かぐや', start: '', end: '十代に戻る' }] })).toEqual([
      '作品設計の人物の変化に、未成年を指す語（「十代」）が残っています'
    ])
    expect(item({ world: { rules: ['未成年は入れない'], terms: [] } })).toEqual([
      '作品設計の世界のルールに、未成年を指す語（「未成年」）が残っています'
    ])
    expect(item({ world: { rules: [], terms: [{ term: '学園', note: '中学生が通う' }] } })).toEqual([
      '作品設計の用語に、未成年を指す語（「中学生」）が残っています'
    ])
    expect(item({ timeline: ['春: 高校2年の春', '夏: 高校生活'] })).toEqual([
      '作品設計の時系列に、未成年を指す語（「高校2年」）が残っています'
    ])
  })
  test('reports several items in a fixed order, and several terms of one item together', () => {
    const bad = {
      premise: '美少女と高校生の物語',
      ending: 'ティーンの旅',
      arcs: [],
      world: { rules: [], terms: [] },
      timeline: ['JK の頃']
    }
    expect(validateAdultBibleText('R18', bad)).toEqual([
      '作品設計の物語の核に、未成年を指す語（「美少女」「高校生」）が残っています',
      '作品設計の結末に、未成年を指す語（「ティーン」）が残っています',
      '作品設計の時系列に、未成年を指す語（「JK」）が残っています'
    ])
  })
  test('少女 and 少年 are allowed in the bible text (they are only checked in the appearance)', () => {
    expect(validateAdultBibleText('R18', { ...clean(), premise: '少年と少女の冒険' })).toEqual([])
  })
  test('reports a minor term in the call of the address table, after the timeline', () => {
    const addresses = [
      { from: '太郎', to: '花子', call: '花子さん' },
      { from: '次郎', to: '花子', call: '女子高生ちゃん' }
    ]
    expect(validateAdultBibleText('R18', { ...clean(), addresses })).toEqual([
      '作品設計の呼称表に、未成年を指す語（「女子高生」）が残っています'
    ])
    const bad = { ...clean(), timeline: ['JK の頃'], addresses }
    expect(validateAdultBibleText('R15', bad)).toEqual([
      '作品設計の時系列に、未成年を指す語（「JK」）が残っています',
      '作品設計の呼称表に、未成年を指す語（「女子高生」）が残っています'
    ])
  })
  test('lists every minor term found in the calls together', () => {
    const addresses = [{ call: '美少女' }, { call: '高2' }, { call: '美少女' }]
    expect(validateAdultBibleText('R18', { ...clean(), addresses })).toEqual([
      '作品設計の呼称表に、未成年を指す語（「美少女」「高2」）が残っています'
    ])
  })
  test('calls without a minor term pass, and the address table may be empty or absent', () => {
    const addresses = [{ call: '花子さん' }, { call: 'お姉ちゃん' }, { call: '先輩' }, { call: 'いろP' }]
    expect(validateAdultBibleText('R18', { ...clean(), addresses })).toEqual([])
    expect(validateAdultBibleText('R18', { ...clean(), addresses: [] })).toEqual([])
    expect(validateAdultBibleText('R18', clean())).toEqual([])
  })
  test('少女 and 少年 are allowed in the calls (they are only checked in the appearance)', () => {
    expect(validateAdultBibleText('R18', { ...clean(), addresses: [{ call: '少女' }, { call: '少年' }] })).toEqual([])
  })
  test('the address table is not checked for an all-ages work', () => {
    expect(validateAdultBibleText('全年齢', { ...clean(), addresses: [{ call: '女子高生' }] })).toEqual([])
  })
  test('works with a StoryBible-shaped object', () => {
    // 余分なキー (from、to) があっても渡せる: リテラルではなく変数として渡す
    const addresses = [{ from: '太郎', to: '花子', call: '花子さん' }]
    const bible = { ...clean(), arcs: [], addresses }
    expect(validateAdultBibleText('R18', bible)).toEqual([])
  })
})

describe('applyBibleCast', () => {
  type Member = {
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
  const member = (name: string, overrides: Partial<Member> = {}): Member => ({
    name,
    role: '主人公',
    gender: '女性',
    age: '17歳',
    occupation: '高校生',
    appearance: '制服姿の少女',
    first_person: 'わたし',
    address_others: '名前＋さん',
    speech_examples: ['そうですか', 'いいえ'],
    description: '女子高生として暮らす',
    ...overrides
  })
  const bible = (name: string, overrides: Partial<BibleCast> = {}): BibleCast => ({
    name,
    age: '20歳',
    occupation: '大学生',
    appearance: '黒髪の女性',
    background: '大学に通いながら暮らす',
    ...overrides
  })

  test('replaces age, occupation, appearance and description', () => {
    const [result] = applyBibleCast([member('かぐや')], [bible('かぐや')])
    expect(result?.age).toBe('20歳')
    expect(result?.occupation).toBe('大学生')
    expect(result?.appearance).toBe('黒髪の女性')
    expect(result?.description).toBe('大学に通いながら暮らす')
  })
  test('leaves a person without a row as they are', () => {
    const original = member('翁', { age: '60歳', occupation: '竹取' })
    const result = applyBibleCast([member('かぐや'), original], [bible('かぐや')])
    expect(result[1]).toEqual(original)
    expect(result[0]?.age).toBe('20歳')
  })
  test('keeps the other fields: name, role, gender, first person, address, speech examples', () => {
    const original = member('かぐや')
    const [result] = applyBibleCast([original], [bible('かぐや')])
    expect(result?.name).toBe(original.name)
    expect(result?.role).toBe(original.role)
    expect(result?.gender).toBe(original.gender)
    expect(result?.first_person).toBe(original.first_person)
    expect(result?.address_others).toBe(original.address_others)
    expect(result?.speech_examples).toEqual(['そうですか', 'いいえ'])
  })
  test('uses the bible text even when it is empty, so the original is not carried over', () => {
    const [result] = applyBibleCast([member('かぐや')], [bible('かぐや', { age: '', appearance: '' })])
    expect(result?.age).toBe('')
    expect(result?.appearance).toBe('')
    expect(result?.description).toBe('大学に通いながら暮らす')
  })
  test('an empty bible cast returns the same content', () => {
    const people = [member('かぐや'), member('翁')]
    const result = applyBibleCast(people, [])
    expect(result).toEqual(people)
  })
  test('keeps the order of the cast and ignores rows for other people', () => {
    const result = applyBibleCast([member('翁'), member('かぐや')], [bible('かぐや'), bible('誰か', { age: '5歳' })])
    expect(result.map((person) => person.name)).toEqual(['翁', 'かぐや'])
    expect(result[0]?.age).toBe('17歳')
    expect(result[1]?.age).toBe('20歳')
  })
  test('matches names ignoring surrounding whitespace', () => {
    const [result] = applyBibleCast([member('かぐや')], [bible(' かぐや ')])
    expect(result?.age).toBe('20歳')
  })
  test('works for a type with only the required fields, and keeps extra fields', () => {
    const people = [{ name: 'かぐや', age: '17', occupation: '学生', appearance: '', description: '', id: 'c1' }]
    const [result] = applyBibleCast(people, [bible('かぐや')])
    expect(result?.id).toBe('c1')
    expect(result?.occupation).toBe('大学生')
  })
  test('does not modify the input', () => {
    const people = [member('かぐや'), member('翁')]
    const rows = [bible('かぐや')]
    const before = JSON.stringify([people, rows])
    const result = applyBibleCast(people, rows)
    expect(JSON.stringify([people, rows])).toBe(before)
    expect(result).not.toBe(people)
  })
})

describe('bibleSourceHash', () => {
  const source = (): BibleSourceInput => ({
    genre: 'ファンタジー',
    setting: '竹林のある山里',
    ending: 'かぐやは月へ帰る',
    age_rating: 'R15',
    pov: '三人称',
    narrator: '',
    cast: [
      {
        name: 'かぐや',
        role: '主人公',
        gender: '女性',
        age: '20歳',
        occupation: '大学生',
        appearance: '黒髪',
        first_person: 'わたし',
        address_others: '名前＋さん',
        speech_examples: ['そうですか', 'いいえ'],
        description: '竹から生まれた'
      },
      {
        name: '翁',
        role: '育ての親',
        gender: '男性',
        age: '60歳',
        occupation: '竹取',
        appearance: '白髪',
        first_person: '儂',
        address_others: '名前',
        speech_examples: ['ふむ'],
        description: '竹を取って暮らす'
      }
    ],
    relations: [
      {
        source_name: 'かぐや',
        target_name: '翁',
        relation: '養父',
        description: '育てられた',
        address_override: 'おじいさま'
      },
      { source_name: '翁', target_name: 'かぐや', relation: '養女', description: '', address_override: '' }
    ]
  })

  test('is 16 hex digits and stable for equal input', () => {
    expect(bibleSourceHash(source())).toMatch(/^[0-9a-f]{16}$/)
    expect(bibleSourceHash(source())).toBe(bibleSourceHash(source()))
  })
  test('does not depend on the order of cast or relations', () => {
    const base = source()
    const reordered: BibleSourceInput = {
      ...base,
      cast: [...base.cast].reverse(),
      relations: [...base.relations].reverse()
    }
    expect(bibleSourceHash(reordered)).toBe(bibleSourceHash(base))
  })
  test('does not depend on the order of rows that share the sort key', () => {
    const base = source()
    const first = { ...base.relations[0], source_name: '翁', target_name: 'かぐや', relation: 'a' }
    const second = { ...base.relations[0], source_name: '翁', target_name: 'かぐや', relation: 'b' }
    const left: BibleSourceInput = { ...base, relations: [first, second] }
    const right: BibleSourceInput = { ...base, relations: [second, first] }
    expect(bibleSourceHash(left)).toBe(bibleSourceHash(right))
  })
  test('the order of speech examples matters', () => {
    const base = source()
    const swapped: BibleSourceInput = {
      ...base,
      cast: base.cast.map((member) =>
        member.name === 'かぐや' ? { ...member, speech_examples: [...member.speech_examples].reverse() } : member
      )
    }
    expect(bibleSourceHash(swapped)).not.toBe(bibleSourceHash(base))
  })
  test('ignores surrounding whitespace', () => {
    const base = source()
    const padded: BibleSourceInput = {
      ...base,
      genre: ` ${base.genre}\n`,
      setting: `\t${base.setting} `,
      narrator: '  ',
      cast: base.cast.map((member) => ({
        ...member,
        name: ` ${member.name} `,
        speech_examples: member.speech_examples.map((example) => `${example} `)
      })),
      relations: base.relations.map((link) => ({ ...link, address_override: ` ${link.address_override}` }))
    }
    expect(bibleSourceHash(padded)).toBe(bibleSourceHash(base))
  })
  test('changes when any top-level field changes', () => {
    const base = source()
    const changed: BibleSourceInput[] = [
      { ...base, genre: 'SF' },
      { ...base, setting: '宇宙船' },
      { ...base, ending: 'かぐやは残る' },
      { ...base, age_rating: 'R18' },
      { ...base, pov: '一人称' },
      { ...base, narrator: 'かぐや' }
    ]
    const hashes = changed.map((value) => bibleSourceHash(value))
    for (const hash of hashes) {
      expect(hash).not.toBe(bibleSourceHash(base))
    }
    expect(new Set(hashes).size).toBe(changed.length)
  })
  test('changes when any cast field changes', () => {
    const base = source()
    const fields = [
      'name',
      'role',
      'gender',
      'age',
      'occupation',
      'appearance',
      'first_person',
      'address_others',
      'description'
    ] as const
    const hashes = fields.map((field) =>
      bibleSourceHash({
        ...base,
        cast: base.cast.map((member, index) => (index === 0 ? { ...member, [field]: `${member[field]}変更` } : member))
      })
    )
    for (const hash of hashes) {
      expect(hash).not.toBe(bibleSourceHash(base))
    }
    expect(new Set(hashes).size).toBe(fields.length)
  })
  test('changes when a speech example is added or edited', () => {
    const base = source()
    const withCast = (speech_examples: string[]): BibleSourceInput => ({
      ...base,
      cast: base.cast.map((member, index) => (index === 0 ? { ...member, speech_examples } : member))
    })
    expect(bibleSourceHash(withCast(['そうですか', 'いいえ', 'はい']))).not.toBe(bibleSourceHash(base))
    expect(bibleSourceHash(withCast(['そうですか', 'ううん']))).not.toBe(bibleSourceHash(base))
  })
  test('changes when any relation field changes', () => {
    const base = source()
    const fields = ['source_name', 'target_name', 'relation', 'description', 'address_override'] as const
    const hashes = fields.map((field) =>
      bibleSourceHash({
        ...base,
        relations: base.relations.map((link, index) =>
          index === 0 ? { ...link, [field]: `${link[field]}変更` } : link
        )
      })
    )
    for (const hash of hashes) {
      expect(hash).not.toBe(bibleSourceHash(base))
    }
    expect(new Set(hashes).size).toBe(fields.length)
  })
  test('changes when a person or a relation is added or removed', () => {
    const base = source()
    const extra = { ...base.cast[0], name: '帝' }
    expect(bibleSourceHash({ ...base, cast: [...base.cast, extra] })).not.toBe(bibleSourceHash(base))
    expect(bibleSourceHash({ ...base, cast: base.cast.slice(1) })).not.toBe(bibleSourceHash(base))
    expect(bibleSourceHash({ ...base, relations: base.relations.slice(1) })).not.toBe(bibleSourceHash(base))
    expect(bibleSourceHash({ ...base, relations: [] })).not.toBe(bibleSourceHash(base))
  })
  test('ignores keys that are not covered', () => {
    const base = source()
    const withExtra = {
      ...base,
      notes: 'メモ',
      style: '文体',
      cast: base.cast.map((member) => ({ ...member, id: 'x', avatar: 'y' })),
      relations: base.relations.map((link) => ({ ...link, id: 'z' }))
    }
    expect(bibleSourceHash(withExtra)).toBe(bibleSourceHash(base))
  })
  test('does not modify the input', () => {
    const base = source()
    const reversed: BibleSourceInput = {
      ...base,
      cast: [...base.cast].reverse().map((member) => ({ ...member, name: ` ${member.name} ` })),
      relations: [...base.relations].reverse()
    }
    const before = JSON.stringify(reversed)
    bibleSourceHash(reversed)
    expect(JSON.stringify(reversed)).toBe(before)
  })
})
