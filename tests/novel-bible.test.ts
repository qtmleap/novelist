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
  test('finds JK, JC and JS in any case, only when not part of an English word', () => {
    expect(findMinorTerms('現役JK')).toEqual(['JK'])
    expect(findMinorTerms('jc と js')).toEqual(['JC', 'JS'])
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
      'かぐや の外見に、未成年を指す語（「少女」）が残っています'
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
    const bible: Parameters<typeof validateAdultBibleText>[1] = {
      ...clean(),
      arcs: [],
      addresses: [{ from: '太郎', to: '花子', call: '花子さん' }]
    }
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
