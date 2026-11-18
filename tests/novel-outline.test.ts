import { describe, expect, test } from 'bun:test'
import {
  matchCastName,
  normalizeOutlineCharacters,
  OUTLINE_PLAN_LIMITS,
  outlineChapterJsonSchema,
  outlineJsonSchema,
  parseOutlineChapterResponse,
  parseOutlineResponse,
  sortOutline,
  validateOutlineShape,
  validateThreads
} from '@/lib/novel/outline'
import type { Outline, OutlineChapter } from '@/schemas/novel.dto'

const CAST = ['酒寄彩葉', '月見ヤチヨ', '八千代']

// 計画の項目 (events など) の既定値。省いた入力を parse すると、これが入る。
function planDefaults() {
  return { time_place: '', events: [], end_state: '', setups: [], payoffs: [] }
}
function withPlanDefaults<T extends object>(chapterInput: T) {
  return { ...planDefaults(), ...chapterInput }
}

function chapter(
  chapterNumber: number,
  characters: string[] = [],
  title = `題${chapterNumber}`,
  summary = '概要',
  plan: Partial<OutlineChapter> = {}
): OutlineChapter {
  return { chapter_number: chapterNumber, title, summary, characters, ...planDefaults(), ...plan }
}

describe('matchCastName', () => {
  test('完全一致はそのまま返す', () => {
    expect(matchCastName('酒寄彩葉', CAST)).toBe('酒寄彩葉')
  })
  test('前後の空白 (全角を含む) を除いてから比べる', () => {
    expect(matchCastName('　酒寄彩葉 \n', CAST)).toBe('酒寄彩葉')
  })
  test('raw が名簿の名前の一部なら救済する', () => {
    expect(matchCastName('彩葉', CAST)).toBe('酒寄彩葉')
  })
  test('raw が名簿の名前に敬称を足しただけでも救済する', () => {
    expect(matchCastName('酒寄彩葉さん', CAST)).toBe('酒寄彩葉')
  })
  test('完全一致は部分一致より優先する', () => {
    expect(matchCastName('彩葉', ['酒寄彩葉', '彩葉'])).toBe('彩葉')
  })
  test('部分一致が 2 人に当たるときは null', () => {
    expect(matchCastName('ヤチヨ', ['月見ヤチヨ', 'ヤチヨの母'])).toBeNull()
  })
  test('どれにも当たらないときは null', () => {
    expect(matchCastName('神崎', CAST)).toBeNull()
  })
  test('1 字は部分一致しない', () => {
    expect(matchCastName('彩', CAST)).toBeNull()
    expect(matchCastName('　彩　', CAST)).toBeNull()
  })
  test('名簿の名前に別の語が付いた名前は別人なので寄せない', () => {
    expect(matchCastName('ルナの母', ['ルナ'])).toBeNull()
    expect(matchCastName('ルナたち', ['ルナ'])).toBeNull()
    expect(matchCastName('ルナと彩葉', ['ルナ', '酒寄彩葉'])).toBeNull()
    expect(matchCastName('ルナと彩葉', ['ルナ', '彩葉'])).toBeNull()
  })
  test('名簿の名前に敬称・注記・区切りを足しただけならその名前', () => {
    const cast = ['ルナ', '酒寄彩葉']
    expect(matchCastName('ルナさん', cast)).toBe('ルナ')
    expect(matchCastName('ルナ ちゃん', cast)).toBe('ルナ')
    expect(matchCastName('ルナ　くん', cast)).toBe('ルナ')
    expect(matchCastName('ルナ先生', cast)).toBe('ルナ')
    expect(matchCastName('ルナ（回想）', cast)).toBe('ルナ')
    expect(matchCastName('ルナ(声のみ)', cast)).toBe('ルナ')
    expect(matchCastName('ルナさん（声のみ）', cast)).toBe('ルナ')
    expect(matchCastName('ルナ (回想) (声のみ)', cast)).toBe('ルナ')
    expect(matchCastName('・ルナ', cast)).toBe('ルナ')
    expect(matchCastName('ルナ・', cast)).toBe('ルナ')
  })
  test('敬称のあとに別の語が続く・括弧が閉じていないときは寄せない', () => {
    expect(matchCastName('ルナさんの母', ['ルナ'])).toBeNull()
    expect(matchCastName('ルナ（回想', ['ルナ'])).toBeNull()
    expect(matchCastName('ルナさんさん', ['ルナ'])).toBeNull()
    expect(matchCastName('ルナ（回想）の母', ['ルナ'])).toBeNull()
  })
  test('名簿の名前の一部 + 敬称・注記なら、その名前に寄せる', () => {
    const cast = ['酒寄彩葉', '月見八千代']
    expect(matchCastName('彩葉ちゃん', cast)).toBe('酒寄彩葉')
    expect(matchCastName('月見先輩', cast)).toBe('月見八千代')
    expect(matchCastName('八千代さん（回想）', cast)).toBe('月見八千代')
    expect(matchCastName('八千代 さん', cast)).toBe('月見八千代')
    expect(matchCastName('・彩葉くん', cast)).toBe('酒寄彩葉')
    expect(matchCastName('彩葉(声のみ)', cast)).toBe('酒寄彩葉')
    expect(matchCastName('彩葉・', cast)).toBe('酒寄彩葉')
  })
  test('一部 + 敬称が名簿の 2 人に当たるときは null', () => {
    expect(matchCastName('彩葉ちゃん', ['酒寄彩葉', '彩葉子'])).toBeNull()
  })
  test('一部 + 敬称でも、残りを含む名前が名簿に無ければ null', () => {
    expect(matchCastName('神崎さん', CAST)).toBeNull()
  })
  test('一部 + 敬称で残りが 1 字になるときは null', () => {
    expect(matchCastName('葉ちゃん', ['酒寄彩葉'])).toBeNull()
    expect(matchCastName('彩さん', ['酒寄彩葉'])).toBeNull()
  })
  test('付け足しの後ろにさらに別の語が付くときは、一部でも寄せない', () => {
    expect(matchCastName('ルナの母さん', ['ルナ'])).toBeNull()
    expect(matchCastName('彩葉ちゃんの母', ['酒寄彩葉'])).toBeNull()
    expect(matchCastName('彩葉たち', ['酒寄彩葉'])).toBeNull()
    expect(matchCastName('彩葉ちゃん（回想', ['酒寄彩葉'])).toBeNull()
  })
  test('名簿に名前の包含関係があるときは、いちばん長い名前を選ぶ', () => {
    const cast = ['八千代', '月見八千代']
    expect(matchCastName('月見八千代さん', cast)).toBe('月見八千代')
    expect(matchCastName('八千代', cast)).toBe('八千代')
    expect(matchCastName('月見八千代', cast)).toBe('月見八千代')
    expect(matchCastName('月見', cast)).toBe('月見八千代')
  })
  test('raw を含む名前が 2 人いるときは null (どちらか決められない)', () => {
    expect(matchCastName('月見', ['月見八千代', '月見ヤチヨ'])).toBeNull()
  })
  test('空文字と空白だけは null (空の名簿名にも一致しない)', () => {
    expect(matchCastName('', CAST)).toBeNull()
    expect(matchCastName('　 ', ['', '酒寄彩葉'])).toBeNull()
    expect(matchCastName('彩葉', ['', '酒寄彩葉'])).toBe('酒寄彩葉')
  })
  test('名簿に同じ名前が重複していても 1 人として数える', () => {
    expect(matchCastName('彩葉', ['酒寄彩葉', '酒寄彩葉'])).toBe('酒寄彩葉')
  })
  test('名簿が空なら null', () => {
    expect(matchCastName('酒寄彩葉', [])).toBeNull()
  })
})

describe('normalizeOutlineCharacters', () => {
  test('正式名に揃え、重複を除き、元の順序を保つ', () => {
    const outline: Outline = { chapters: [chapter(1, ['月見ヤチヨ', '彩葉', '酒寄彩葉', '月見ヤチヨ'])] }
    const result = normalizeOutlineCharacters(outline, CAST)
    expect(result.outline.chapters[0].characters).toEqual(['月見ヤチヨ', '酒寄彩葉'])
    expect(result.warnings).toEqual([])
  })
  test('照合できない名前は捨てて、章ごとに警告にする', () => {
    const outline: Outline = {
      chapters: [chapter(1, ['酒寄彩葉']), chapter(2, ['月見ヤチヨ', '神崎蓮', '神崎蓮', '鳴海']), chapter(3, ['誰か'])]
    }
    const result = normalizeOutlineCharacters(outline, CAST)
    expect(result.outline.chapters.map((c) => c.characters)).toEqual([['酒寄彩葉'], ['月見ヤチヨ'], []])
    expect(result.warnings).toEqual([
      {
        chapter_number: 2,
        kind: 'dropped_character',
        message: '第 2 章の登場人物「神崎蓮」は名簿に無いため外しました'
      },
      { chapter_number: 2, kind: 'dropped_character', message: '第 2 章の登場人物「鳴海」は名簿に無いため外しました' },
      { chapter_number: 3, kind: 'dropped_character', message: '第 3 章の登場人物「誰か」は名簿に無いため外しました' }
    ])
  })
  test('空文字の名前は黙って外す', () => {
    const result = normalizeOutlineCharacters({ chapters: [chapter(1, ['', '　', '酒寄彩葉'])] }, CAST)
    expect(result.outline.chapters[0].characters).toEqual(['酒寄彩葉'])
    expect(result.warnings).toEqual([])
  })
  test('長い名前は警告の文を長くしすぎない', () => {
    const result = normalizeOutlineCharacters({ chapters: [chapter(1, ['あ'.repeat(1000)])] }, CAST)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0].message.length).toBeLessThan(200)
  })
  test('入力を変更しない', () => {
    const outline: Outline = { chapters: [chapter(2, ['彩葉', '神崎蓮']), chapter(1, ['月見ヤチヨ'])] }
    const snapshot = structuredClone(outline)
    const result = normalizeOutlineCharacters(outline, CAST, ['酒寄彩葉'])
    expect(outline).toEqual(snapshot)
    expect(result.outline).not.toBe(outline)
    expect(result.outline.chapters[0]).not.toBe(outline.chapters[0])
  })
  test('alwaysInclude は名簿にある名前だけを、無い章の先頭に足す', () => {
    const outline: Outline = { chapters: [chapter(1, ['月見ヤチヨ']), chapter(2, [])] }
    const result = normalizeOutlineCharacters(outline, CAST, ['酒寄彩葉', '名簿に無い語り手'])
    expect(result.outline.chapters.map((c) => c.characters)).toEqual([['酒寄彩葉', '月見ヤチヨ'], ['酒寄彩葉']])
    expect(result.warnings).toEqual([])
  })
  test('alwaysInclude の名前が既にあれば重複させず、位置も変えない', () => {
    const outline: Outline = { chapters: [chapter(1, ['月見ヤチヨ', '彩葉'])] }
    const result = normalizeOutlineCharacters(outline, CAST, ['酒寄彩葉'])
    expect(result.outline.chapters[0].characters).toEqual(['月見ヤチヨ', '酒寄彩葉'])
  })
  test('alwaysInclude は部分一致で救済しない', () => {
    const result = normalizeOutlineCharacters({ chapters: [chapter(1, [])] }, CAST, ['彩葉'])
    expect(result.outline.chapters[0].characters).toEqual([])
  })
  test('名簿が空なら全章の characters を空にし、警告は出さない', () => {
    const outline: Outline = { chapters: [chapter(1, ['酒寄彩葉', '誰か']), chapter(2, ['月見ヤチヨ'])] }
    const result = normalizeOutlineCharacters(outline, [], ['酒寄彩葉'])
    expect(result.outline.chapters.map((c) => c.characters)).toEqual([[], []])
    expect(result.warnings).toEqual([])
    expect(outline.chapters[0].characters).toEqual(['酒寄彩葉', '誰か'])
  })
  test('章の題・概要・番号と、計画の項目は変えない', () => {
    const plan = {
      time_place: '春の朝、駅前',
      events: ['出会う', '別れる'],
      end_state: '彩葉は駅のホームに一人でいる',
      setups: [{ id: 's1', description: '腕輪が熱を持つ' }],
      payoffs: ['s0']
    }
    const outline: Outline = { chapters: [chapter(3, ['彩葉'], '出会い', '二人が出会う', plan)] }
    const result = normalizeOutlineCharacters(outline, CAST)
    expect(result.outline.chapters[0]).toEqual({
      chapter_number: 3,
      title: '出会い',
      summary: '二人が出会う',
      characters: ['酒寄彩葉'],
      ...plan
    })
  })
  test('名簿が空のときも計画の項目は変えない', () => {
    const outline: Outline = {
      chapters: [chapter(1, ['誰か'], '題', '概要', { events: ['出来事'], end_state: '章末' })]
    }
    const result = normalizeOutlineCharacters(outline, [])
    expect(result.outline.chapters[0]).toEqual(chapter(1, [], '題', '概要', { events: ['出来事'], end_state: '章末' }))
  })
})

describe('sortOutline', () => {
  test('chapter_number の昇順に並べ、入力は変更しない', () => {
    const outline: Outline = { chapters: [chapter(3), chapter(1), chapter(2)] }
    const sorted = sortOutline(outline)
    expect(sorted.chapters.map((c) => c.chapter_number)).toEqual([1, 2, 3])
    expect(outline.chapters.map((c) => c.chapter_number)).toEqual([3, 1, 2])
  })
  test('番号が同じ章は元の順序を保つ', () => {
    const sorted = sortOutline({ chapters: [chapter(2, [], 'b'), chapter(1, [], 'a'), chapter(2, [], 'c')] })
    expect(sorted.chapters.map((c) => c.title)).toEqual(['a', 'b', 'c'])
  })
})

describe('validateOutlineShape', () => {
  test('正常なら空配列', () => {
    expect(validateOutlineShape({ chapters: [chapter(1), chapter(2), chapter(3)] }, 3)).toEqual([])
  })
  test('順序が入れ替わっていても番号が揃っていれば問題なし', () => {
    expect(validateOutlineShape({ chapters: [chapter(2), chapter(1)] }, 2)).toEqual([])
  })
  test('章数が違う', () => {
    const issues = validateOutlineShape({ chapters: [chapter(1), chapter(2)] }, 3)
    expect(issues).toContain('章の数が 3 章であるべきところ 2 章です')
    expect(issues).toContain('章番号 3 の章がありません')
  })
  test('章番号の重複', () => {
    const issues = validateOutlineShape({ chapters: [chapter(1), chapter(2), chapter(2)] }, 3)
    expect(issues).toEqual(['章番号 2 が重複しています', '章番号 3 の章がありません'])
  })
  test('章番号の欠番', () => {
    const issues = validateOutlineShape({ chapters: [chapter(1), chapter(4)] }, 4)
    expect(issues).toEqual(['章の数が 4 章であるべきところ 2 章です', '章番号 2、3 の章がありません'])
  })
  test('章番号が範囲外', () => {
    const issues = validateOutlineShape({ chapters: [chapter(0), chapter(1), chapter(5)] }, 3)
    expect(issues).toContain('章番号 0、5 は 1 から 3 の範囲外です')
    expect(issues).toContain('章番号 2、3 の章がありません')
  })
  test('題が空 (空白だけも空)', () => {
    const issues = validateOutlineShape({ chapters: [chapter(1, [], '　 '), chapter(2)] }, 2)
    expect(issues).toEqual(['第 1 章の題が空です'])
  })
  test('概要が空 (空白だけも空)', () => {
    const issues = validateOutlineShape({ chapters: [chapter(1), chapter(2, [], '題', ' \n ')] }, 2)
    expect(issues).toEqual(['第 2 章の概要が空です'])
  })
  test('章が 1 件も無い', () => {
    expect(validateOutlineShape({ chapters: [] }, 2)).toEqual([
      '章の数が 2 章であるべきところ 0 章です',
      '章番号 1、2 の章がありません'
    ])
  })
  test('requirePlan が無ければ、出来事も章末の状況も検査しない', () => {
    expect(validateOutlineShape({ chapters: [chapter(1), chapter(2)] }, 2)).toEqual([])
    expect(validateOutlineShape({ chapters: [chapter(1), chapter(2)] }, 2, { requirePlan: false })).toEqual([])
    expect(validateOutlineShape({ chapters: [chapter(1), chapter(2)] }, 2, {})).toEqual([])
  })
  test('requirePlan なら、出来事が無い・章末の状況が空の章を指摘する', () => {
    const outline: Outline = {
      chapters: [
        chapter(1, [], '題1', '概要', { events: ['出来事'], end_state: '章末' }),
        chapter(2, [], '題2', '概要', { events: ['出来事'] }),
        chapter(3, [], '題3', '概要', { end_state: '章末' }),
        chapter(4)
      ]
    }
    expect(validateOutlineShape(outline, 4, { requirePlan: true })).toEqual([
      '第 2 章の章末の状況が空です',
      '第 3 章の出来事がありません',
      '第 4 章の出来事がありません',
      '第 4 章の章末の状況が空です'
    ])
  })
  test('requirePlan で、空白だけの出来事・章末の状況は空とみなす', () => {
    const outline: Outline = { chapters: [chapter(1, [], '題', '概要', { events: [' ', '　'], end_state: ' \n ' })] }
    expect(validateOutlineShape(outline, 1, { requirePlan: true })).toEqual([
      '第 1 章の出来事がありません',
      '第 1 章の章末の状況が空です'
    ])
  })
  test('requirePlan で計画が揃っていれば問題なし。形の問題は先に並ぶ', () => {
    const planned = { events: ['出来事'], end_state: '章末' }
    expect(
      validateOutlineShape({ chapters: [chapter(1, [], '題', '概要', planned)] }, 1, { requirePlan: true })
    ).toEqual([])
    const issues = validateOutlineShape({ chapters: [chapter(1, [], '題', '概要', planned)] }, 2, { requirePlan: true })
    expect(issues).toEqual(['章の数が 2 章であるべきところ 1 章です', '章番号 2 の章がありません'])
  })
})

describe('parseOutlineResponse', () => {
  const body = [
    { chapter_number: 1, title: '出会い', summary: '概要 1', characters: ['酒寄彩葉'] },
    { chapter_number: 2, title: '別れ', summary: '概要 2' }
  ]

  test('{ chapters } をそのまま受ける (characters と計画の項目の既定値が入る)', () => {
    const result = parseOutlineResponse(JSON.stringify({ chapters: body }))
    expect(result).toEqual({
      ok: true,
      outline: {
        chapters: [
          withPlanDefaults({ chapter_number: 1, title: '出会い', summary: '概要 1', characters: ['酒寄彩葉'] }),
          withPlanDefaults({ chapter_number: 2, title: '別れ', summary: '概要 2', characters: [] })
        ]
      }
    })
  })
  test('トップレベルが配列なら { chapters } に包む', () => {
    const result = parseOutlineResponse(JSON.stringify(body))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.outline.chapters).toHaveLength(2)
  })
  test('不正な JSON は応答の先頭 200 字までをエラーに入れる', () => {
    const text = `{${'x'.repeat(1000)}`
    const result = parseOutlineResponse(text)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('JSON')
      expect(result.error).toContain(text.slice(0, 200))
      expect(result.error).not.toContain(text.slice(0, 201))
    }
  })
  test('スキーマ違反は場所と理由を返し、応答の全文は入れない', () => {
    const text = JSON.stringify({
      chapters: [{ chapter_number: 1, summary: '概要', padding: 'y'.repeat(1000) }]
    })
    const result = parseOutlineResponse(text)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('chapters.0.title')
      expect(result.error).not.toContain('y'.repeat(300))
    }
  })
  test('chapters が無いオブジェクトは失敗する', () => {
    expect(parseOutlineResponse('{"title":"x"}').ok).toBe(false)
  })
  test('章番号が 0 以下・小数なら失敗する', () => {
    expect(parseOutlineResponse(JSON.stringify([{ chapter_number: 0, title: 'a', summary: 'b' }])).ok).toBe(false)
    expect(parseOutlineResponse(JSON.stringify([{ chapter_number: 1.5, title: 'a', summary: 'b' }])).ok).toBe(false)
  })
  test('空文字は失敗する', () => {
    expect(parseOutlineResponse('').ok).toBe(false)
  })
})

describe('parseOutlineChapterResponse', () => {
  const entry = { chapter_number: 2, title: '別れ', summary: '概要', characters: ['酒寄彩葉'] }
  const chapterEntry = (n: number) => ({ chapter_number: n, title: `題${n}`, summary: `概要${n}`, characters: [] })

  test('1 章のオブジェクトをそのまま受ける (番号が違っても受ける。呼び出し側が揃える)', () => {
    expect(parseOutlineChapterResponse(JSON.stringify(entry))).toEqual({ ok: true, chapter: withPlanDefaults(entry) })
    expect(parseOutlineChapterResponse(JSON.stringify(entry), 5)).toEqual({
      ok: true,
      chapter: withPlanDefaults(entry)
    })
  })
  test('{ chapters: [...] } に複数あれば、対象の番号の章を選ぶ', () => {
    const chapters = [chapterEntry(1), entry, chapterEntry(3)]
    expect(parseOutlineChapterResponse(JSON.stringify({ chapters }), 2)).toEqual({
      ok: true,
      chapter: withPlanDefaults(entry)
    })
    expect(parseOutlineChapterResponse(JSON.stringify({ chapters }), 3)).toEqual({
      ok: true,
      chapter: withPlanDefaults(chapterEntry(3))
    })
  })
  test('配列でも同じ', () => {
    const chapters = [chapterEntry(1), entry, chapterEntry(3)]
    expect(parseOutlineChapterResponse(JSON.stringify(chapters), 1)).toEqual({
      ok: true,
      chapter: withPlanDefaults(chapterEntry(1))
    })
  })
  test('同じ番号が複数あれば最初の章を選ぶ', () => {
    const chapters = [chapterEntry(1), { ...entry, title: '最初' }, { ...entry, title: '二つ目' }]
    const result = parseOutlineChapterResponse(JSON.stringify(chapters), 2)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.chapter.title).toBe('最初')
  })
  test('対象の番号が無く複数あるときは失敗する (別の章を受けない)', () => {
    const chapters = [chapterEntry(1), chapterEntry(2), chapterEntry(3)]
    for (const text of [JSON.stringify({ chapters }), JSON.stringify(chapters)]) {
      const result = parseOutlineChapterResponse(text, 4)
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('第 4 章')
        expect(result.error).toContain('応答の先頭')
      }
    }
  })
  test('1 件だけなら、番号が違っても受ける', () => {
    expect(parseOutlineChapterResponse(JSON.stringify({ chapters: [entry] }), 5)).toEqual({
      ok: true,
      chapter: withPlanDefaults(entry)
    })
    expect(parseOutlineChapterResponse(JSON.stringify([entry]), 5)).toEqual({
      ok: true,
      chapter: withPlanDefaults(entry)
    })
  })
  test('対象の番号を渡さず 1 件なら受け、複数なら失敗する', () => {
    expect(parseOutlineChapterResponse(JSON.stringify([entry]))).toEqual({ ok: true, chapter: withPlanDefaults(entry) })
    const result = parseOutlineChapterResponse(JSON.stringify({ chapters: [chapterEntry(1), entry] }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('2 件')
  })
  test('chapter_number が数値でない要素は一致しないものとして扱う', () => {
    const chapters = [{ ...entry, chapter_number: '2' }, { ...entry, chapter_number: null }, chapterEntry(3)]
    expect(parseOutlineChapterResponse(JSON.stringify(chapters), 2).ok).toBe(false)
    expect(parseOutlineChapterResponse(JSON.stringify(chapters), 3)).toEqual({
      ok: true,
      chapter: withPlanDefaults(chapterEntry(3))
    })
  })
  test('選んだ要素が不正ならスキーマ違反として失敗する', () => {
    const chapters = [chapterEntry(1), { chapter_number: 2, title: '題' }]
    const result = parseOutlineChapterResponse(JSON.stringify(chapters), 2)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('summary')
  })
  test('空の配列・空の chapters は失敗する', () => {
    expect(parseOutlineChapterResponse('[]').ok).toBe(false)
    expect(parseOutlineChapterResponse('[]', 2).ok).toBe(false)
    expect(parseOutlineChapterResponse('{"chapters":[]}', 2).ok).toBe(false)
  })
  test('不正な JSON・スキーマ違反は失敗する', () => {
    expect(parseOutlineChapterResponse('not json').ok).toBe(false)
    const result = parseOutlineChapterResponse(JSON.stringify({ chapter_number: 2, title: '題' }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('summary')
  })
})

describe('検証の前の切り詰め', () => {
  const L = OUTLINE_PLAN_LIMITS
  const base = { chapter_number: 1, title: '題', summary: '概要' }
  const parseOne = (extra: Record<string, unknown>) =>
    parseOutlineResponse(JSON.stringify({ chapters: [{ ...base, ...extra }] }))
  const parseChapter = (extra: Record<string, unknown>) =>
    parseOutlineChapterResponse(JSON.stringify({ ...base, ...extra }))
  const firstChapter = (result: ReturnType<typeof parseOne>) => {
    if (!result.ok) throw new Error(result.error)
    return result.outline.chapters[0]
  }

  test('上限は保存の上限より小さい', () => {
    expect(L).toEqual({
      eventsMax: 8,
      eventChars: 300,
      timePlaceChars: 200,
      endStateChars: 400,
      setupsMax: 6,
      setupDescriptionChars: 300,
      idChars: 40,
      payoffsMax: 8
    })
  })
  test('文字列は trim して上限で切る', () => {
    const c = firstChapter(
      parseOne({
        time_place: `　${'あ'.repeat(500)} `,
        end_state: `\n${'い'.repeat(900)}\n`,
        events: [` ${'う'.repeat(1500)} `, '  短い出来事  ']
      })
    )
    expect(c.time_place).toBe('あ'.repeat(L.timePlaceChars))
    expect(c.end_state).toBe('い'.repeat(L.endStateChars))
    expect(c.events).toEqual(['う'.repeat(L.eventChars), '短い出来事'])
  })
  test('配列は空の項目を捨ててから、個数の上限で切る', () => {
    const events = ['', '  ', ...Array.from({ length: 12 }, (_, i) => `出来事${i + 1}`), '　']
    const c = firstChapter(parseOne({ events }))
    expect(c.events).toEqual(Array.from({ length: L.eventsMax }, (_, i) => `出来事${i + 1}`))
  })
  test('張る伏線: id・説明を切り、説明が空の項目は捨て、個数の上限で切る', () => {
    const setups = [
      { id: ' s1 ', description: ` ${'あ'.repeat(500)} ` },
      { id: 'x'.repeat(100), description: '長い id' },
      { id: 's3', description: '   ' },
      ...Array.from({ length: 8 }, (_, i) => ({ id: `t${i}`, description: `説明${i}` }))
    ]
    const c = firstChapter(parseOne({ setups }))
    expect(c.setups).toHaveLength(L.setupsMax)
    expect(c.setups[0]).toEqual({ id: 's1', description: 'あ'.repeat(L.setupDescriptionChars) })
    expect(c.setups[1]).toEqual({ id: 'x'.repeat(L.idChars), description: '長い id' })
    expect(c.setups.map((setup) => setup.id)).toEqual(['s1', 'x'.repeat(L.idChars), 't0', 't1', 't2', 't3'])
  })
  test('id が無い・文字列でない・空の伏線には、仮の id を振って通す', () => {
    const setups = [
      { description: 'id が無い' },
      { id: '', description: 'id が空' },
      { id: '  ', description: 'id が空白だけ' },
      { id: 3, description: 'id が数値' },
      { id: null, description: 'id が null' },
      { id: 'a', description: 'id がある' }
    ]
    const c = firstChapter(parseOne({ setups }))
    expect(c.setups.map((setup) => setup.id)).toEqual(['s1', 's2', 's3', 's4', 's5', 'a'])
    expect(c.setups.map((setup) => setup.description)).toEqual(setups.map((setup) => setup.description))
  })
  test('仮の id は、応答の全章の id (張る側も回収する側も) と衝突しない', () => {
    const text = JSON.stringify({
      chapters: [
        { ...base, setups: [{ id: 's1', description: 'a' }, { description: '仮 1' }] },
        { ...base, chapter_number: 2, setups: [{ id: 's2', description: 'b' }, { description: '仮 2' }] },
        { ...base, chapter_number: 3, payoffs: ['s3', ' s4 '] }
      ]
    })
    const result = parseOutlineResponse(text)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.outline.chapters.map((c) => c.setups.map((setup) => setup.id))).toEqual([
        ['s1', 's5'],
        ['s2', 's6'],
        []
      ])
    }
  })
  test('説明が空で id も無い項目は捨て、仮の id を消費しない', () => {
    const c = firstChapter(
      parseOne({ setups: [{ description: ' ' }, { id: ' ', description: '' }, { description: '説明' }] })
    )
    expect(c.setups).toEqual([{ id: 's1', description: '説明' }])
  })
  test('章 1 件の応答では、その 1 章の中で衝突しない仮の id を振る', () => {
    const result = parseChapter({ setups: [{ id: 's1', description: 'a' }, { description: '仮' }], payoffs: ['s2'] })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.chapter.setups.map((setup) => setup.id)).toEqual(['s1', 's3'])
    const wrapped = parseOutlineChapterResponse(JSON.stringify([{ ...base, setups: [{ description: '仮' }] }]), 1)
    expect(wrapped.ok).toBe(true)
    if (wrapped.ok) expect(wrapped.chapter.setups).toEqual([{ id: 's1', description: '仮' }])
  })
  test('他の章と重複した仮の id は、差し替えた後に validateThreads が振り直す', () => {
    const result = parseChapter({ chapter_number: 2, setups: [{ description: '仮' }] })
    if (!result.ok) throw new Error(result.error)
    const existing = chapter(1, [], '題1', '概要', { setups: [{ id: 's1', description: '既存' }] })
    const merged = validateThreads({ chapters: [existing, result.chapter] })
    expect(merged.outline.chapters.map((c) => c.setups.map((setup) => setup.id))).toEqual([['s1'], ['s2']])
  })
  test('回収する伏線: 各項目を切り、空の項目を捨て、個数の上限で切る', () => {
    const payoffs = ['', ' s1 ', 'y'.repeat(100), ...Array.from({ length: 10 }, (_, i) => `p${i}`)]
    const c = firstChapter(parseOne({ payoffs }))
    expect(c.payoffs).toHaveLength(L.payoffsMax)
    expect(c.payoffs.slice(0, 2)).toEqual(['s1', 'y'.repeat(L.idChars)])
  })
  test('サロゲートペアを途中で切って、保存上限を超えたり壊れた文字を作ったりしない', () => {
    const id = `${'あ'.repeat(L.idChars - 1)}😀😀`
    const c = firstChapter(parseOne({ payoffs: [id], setups: [{ id, description: '説明' }] }))
    expect(c.payoffs).toEqual(['あ'.repeat(L.idChars - 1)])
    expect(c.setups[0].id).toBe('あ'.repeat(L.idChars - 1))
  })
  test('上限を超えていた応答も、整えれば通る (呼び直さない)', () => {
    const events = Array.from({ length: 25 }, (_, i) => `出来事${i}`)
    const setups = Array.from({ length: 40 }, (_, i) => ({ id: `s${i}`, description: '説明' }))
    expect(parseOne({ events, setups, end_state: 'あ'.repeat(5000) }).ok).toBe(true)
  })
  test('項目が無ければ足さず、既定値のまま', () => {
    const c = firstChapter(parseOne({}))
    expect(c).toEqual(withPlanDefaults({ ...base, characters: [] }))
  })
  test('型が違う値は触らず、検証で落とす', () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ events: '出来事を並べた文字列' }, 'events'],
      [{ events: ['出来事', 3] }, 'events'],
      [{ time_place: 5 }, 'time_place'],
      [{ end_state: ['章末'] }, 'end_state'],
      [{ setups: 'なし' }, 'setups'],
      [{ setups: ['s1: 説明'] }, 'setups'],
      [{ setups: [{ id: 's1' }] }, 'description'],
      [{ setups: [{ id: 's1', description: 5 }] }, 'description'],
      [{ setups: [{ description: 5 }] }, 'description'],
      [{ payoffs: 's1' }, 'payoffs'],
      [{ payoffs: ['s1', 2] }, 'payoffs']
    ]
    for (const [extra, field] of cases) {
      const result = parseOne(extra)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toContain(field)
    }
  })
  test('章 1 件の応答 (オブジェクト・配列・{ chapters }) も同じように整える', () => {
    const extra = { events: ['', ` ${'あ'.repeat(500)}`], time_place: ` ${'い'.repeat(500)}`, payoffs: ['', 's1'] }
    const expectedEvents = ['あ'.repeat(L.eventChars)]
    const single = parseChapter(extra)
    expect(single.ok).toBe(true)
    if (single.ok) {
      expect(single.chapter.events).toEqual(expectedEvents)
      expect(single.chapter.time_place).toBe('い'.repeat(L.timePlaceChars))
      expect(single.chapter.payoffs).toEqual(['s1'])
    }
    for (const text of [
      JSON.stringify([{ ...base, ...extra }]),
      JSON.stringify({ chapters: [{ ...base, ...extra }] })
    ]) {
      const wrapped = parseOutlineChapterResponse(text, 1)
      expect(wrapped.ok).toBe(true)
      if (wrapped.ok) expect(wrapped.chapter.events).toEqual(expectedEvents)
    }
  })
  test('章 1 件の応答でも、型が違う値は検証で落ちる', () => {
    const result = parseChapter({ events: 'x' })
    expect(result.ok).toBe(false)
  })
})

describe('validateThreads', () => {
  const thread = (id: string, description = `説明 ${id}`) => ({ id, description })
  const planned = (
    chapterNumber: number,
    setups: { id: string; description: string }[] = [],
    payoffs: string[] = []
  ): OutlineChapter => chapter(chapterNumber, [], `題${chapterNumber}`, '概要', { setups, payoffs })

  test('伏線が 1 つも無い章立てでは、警告も変更も無い', () => {
    const outline: Outline = { chapters: [chapter(1), chapter(2), chapter(3)] }
    const result = validateThreads(outline)
    expect(result.warnings).toEqual([])
    expect(result.outline).toEqual(outline)
  })
  test('前の章で張った伏線を回収していれば、警告なし', () => {
    const outline: Outline = {
      chapters: [planned(1, [thread('s1')]), planned(2, [thread('s2')], ['s1']), planned(3, [], ['s2', 's1'])]
    }
    const result = validateThreads(outline)
    expect(result.warnings).toEqual([])
    expect(result.outline).toEqual(outline)
  })
  test('存在しない id・同じ章や後の章の setups を指す id は外し、id ごとに警告にする', () => {
    const outline: Outline = {
      chapters: [
        planned(1, [thread('s1')], ['s9', 's2']),
        planned(2, [thread('s2')], ['s2', 's1']),
        planned(3, [], ['s1'])
      ]
    }
    const result = validateThreads(outline)
    expect(result.outline.chapters.map((c) => c.payoffs)).toEqual([[], ['s1'], ['s1']])
    expect(result.warnings.filter((w) => w.kind === 'dropped_payoff')).toEqual([
      {
        chapter_number: 1,
        kind: 'dropped_payoff',
        message: '第 1 章の回収する伏線「s9」は、前の章で張られていないため外しました'
      },
      {
        chapter_number: 1,
        kind: 'dropped_payoff',
        message: '第 1 章の回収する伏線「s2」は、前の章で張られていないため外しました'
      },
      {
        chapter_number: 2,
        kind: 'dropped_payoff',
        message: '第 2 章の回収する伏線「s2」は、前の章で張られていないため外しました'
      }
    ])
  })
  test('同じ章の payoffs の重複は、警告なしで除く', () => {
    const outline: Outline = { chapters: [planned(1, [thread('s1')]), planned(2, [], ['s1', ' s1', 's1', ''])] }
    const result = validateThreads(outline)
    expect(result.outline.chapters[1].payoffs).toEqual(['s1'])
    expect(result.warnings).toEqual([])
  })
  test('どの章でも回収されない setups は、張った章の番号で unresolved_setup の警告にする', () => {
    const outline: Outline = {
      chapters: [planned(1, [thread('s1')]), planned(2, [thread('s3', '腕輪が熱を持つ理由')]), planned(3, [], ['s1'])]
    }
    const result = validateThreads(outline)
    expect(result.warnings).toEqual([
      {
        chapter_number: 2,
        kind: 'unresolved_setup',
        message: '第 2 章で張る伏線「s3: 腕輪が熱を持つ理由」は、どの章でも回収されません'
      }
    ])
  })
  test('回収を外された伏線は、回収されていないものとして警告にする', () => {
    const outline: Outline = { chapters: [planned(1, [thread('s1')], ['s1'])] }
    const result = validateThreads(outline)
    expect(result.warnings.map((w) => w.kind)).toEqual(['dropped_payoff', 'unresolved_setup'])
  })
  test('警告の説明は 60 字で切り、message は 600 字以内', () => {
    const outline: Outline = {
      chapters: [planned(1, [thread('s1', 'あ'.repeat(300))], ['い'.repeat(40)]), planned(2, [], ['う'.repeat(5000)])]
    }
    const result = validateThreads(outline)
    expect(result.warnings).toHaveLength(3)
    expect(result.warnings.find((w) => w.kind === 'unresolved_setup')?.message).toContain(`${'あ'.repeat(60)}…`)
    for (const warning of result.warnings) expect(warning.message.length).toBeLessThanOrEqual(600)
  })
  test('重複した id は、後に出てきたほうを s{連番} に振り直す (警告なし、既存の id と衝突しない)', () => {
    const outline: Outline = {
      chapters: [
        planned(1, [thread('s1')]),
        planned(2, [thread('s1', '重複'), thread('s2')]),
        planned(3, [thread('s2', '重複その 2')]),
        planned(4, [], ['s1', 's2', 's3', 's4'])
      ]
    }
    const result = validateThreads(outline)
    expect(result.outline.chapters.map((c) => c.setups.map((setup) => setup.id))).toEqual([
      ['s1'],
      ['s3', 's2'],
      ['s4'],
      []
    ])
    expect(result.outline.chapters[3].payoffs).toEqual(['s1', 's2', 's3', 's4'])
    expect(result.outline.chapters[1].setups[0].description).toBe('重複')
    expect(result.outline.chapters[2].setups[0].description).toBe('重複その 2')
    expect(result.warnings).toEqual([])
  })
  test('同じ章の中の重複も振り直す', () => {
    const outline: Outline = { chapters: [planned(1, [thread('a'), thread('a')]), planned(2, [], ['a'])] }
    const result = validateThreads(outline)
    expect(result.outline.chapters[0].setups.map((setup) => setup.id)).toEqual(['a', 's1'])
    expect(result.warnings.map((w) => w.kind)).toEqual(['unresolved_setup'])
  })
  test('空の id も振り直す', () => {
    const outline: Outline = {
      chapters: [planned(1, [thread('', '空の id'), thread(' ', '空白の id')]), planned(2, [], ['s1', 's2'])]
    }
    const result = validateThreads(outline)
    expect(result.outline.chapters[0].setups.map((setup) => setup.id)).toEqual(['s1', 's2'])
    expect(result.warnings).toEqual([])
  })
  test('章が番号順に並んでいなくても、章番号の昇順で処理し、返す並びは入力のまま', () => {
    const outline: Outline = {
      chapters: [planned(3, [], ['s1', 's2']), planned(2, [thread('s1', '後ろで重複')]), planned(1, [thread('s1')])]
    }
    const result = validateThreads(outline)
    expect(result.outline.chapters.map((c) => c.chapter_number)).toEqual([3, 2, 1])
    // 第 1 章の s1 が元の id、第 2 章の s1 は振り直されて s2 になる。第 3 章の s1 は第 1 章を指す
    expect(result.outline.chapters.map((c) => c.setups.map((setup) => setup.id))).toEqual([[], ['s2'], ['s1']])
    expect(result.outline.chapters[0].payoffs).toEqual(['s1', 's2'])
    expect(result.warnings).toEqual([])
  })
  test('入力を変更しない', () => {
    const outline: Outline = {
      chapters: [planned(1, [thread('s1'), thread('s1')], ['s9']), planned(2, [thread('s2')], ['s1', 's1', 's2'])]
    }
    const snapshot = structuredClone(outline)
    const result = validateThreads(outline)
    expect(outline).toEqual(snapshot)
    expect(result.outline).not.toBe(outline)
    expect(result.outline.chapters[0]).not.toBe(outline.chapters[0])
    expect(result.outline.chapters[0].setups).not.toBe(outline.chapters[0].setups)
  })
  test('題・概要・登場人物・計画の他の項目は変えない', () => {
    const outline: Outline = {
      chapters: [
        chapter(1, ['酒寄彩葉'], '出会い', '二人が出会う', {
          time_place: '朝の駅前',
          events: ['出会う'],
          end_state: '別れた後',
          setups: [thread('s1')]
        })
      ]
    }
    const result = validateThreads(outline)
    expect(result.outline.chapters[0]).toEqual(outline.chapters[0])
  })
})

describe('JSON Schema', () => {
  const planProperties = {
    time_place: { type: 'string' },
    events: { type: 'array', items: { type: 'string' } },
    end_state: { type: 'string' },
    setups: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, description: { type: 'string' } },
        required: ['id', 'description']
      }
    },
    payoffs: { type: 'array', items: { type: 'string' } }
  }

  test('名簿があれば characters は enum つきで入り、required に含まれる', () => {
    const schema = outlineJsonSchema(['酒寄彩葉', '月見ヤチヨ'])
    expect(schema).toEqual({
      type: 'object',
      properties: {
        chapters: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              chapter_number: { type: 'integer' },
              title: { type: 'string' },
              characters: { type: 'array', items: { type: 'string', enum: ['酒寄彩葉', '月見ヤチヨ'] } },
              ...planProperties,
              summary: { type: 'string' }
            },
            required: [
              'chapter_number',
              'title',
              'characters',
              'time_place',
              'events',
              'end_state',
              'setups',
              'payoffs',
              'summary'
            ]
          }
        }
      },
      required: ['chapters']
    })
  })
  test('キーの順序は、出来事と章末の状況を先に決めて概要を最後に書かせる並び', () => {
    const chapterSchema = outlineChapterJsonSchema(['酒寄彩葉'])
    const expected = [
      'chapter_number',
      'title',
      'characters',
      'time_place',
      'events',
      'end_state',
      'setups',
      'payoffs',
      'summary'
    ]
    expect(Object.keys(chapterSchema.properties as object)).toEqual(expected)
    expect(chapterSchema.required).toEqual(expected)
  })
  test('名簿が空なら characters の項目を入れない (計画の項目は入る)', () => {
    const schema = outlineChapterJsonSchema([])
    expect(JSON.stringify(schema)).not.toContain('characters')
    expect(JSON.stringify(schema)).not.toContain('enum')
    expect(schema.required).toEqual([
      'chapter_number',
      'title',
      'time_place',
      'events',
      'end_state',
      'setups',
      'payoffs',
      'summary'
    ])
    expect(JSON.stringify(outlineJsonSchema([]))).toContain('chapter_number')
  })
  test('enum は重複と空の名前を除く', () => {
    const schema = outlineChapterJsonSchema(['酒寄彩葉', '', '酒寄彩葉'])
    expect(JSON.stringify(schema)).toContain('"enum":["酒寄彩葉"]')
  })
  test('1 章ぶんの schema は章 1 件の定義と同じ', () => {
    const chapterSchema = outlineChapterJsonSchema(['酒寄彩葉'])
    const whole = outlineJsonSchema(['酒寄彩葉'])
    expect(JSON.stringify(whole)).toContain(JSON.stringify(chapterSchema))
    expect(chapterSchema.type).toBe('object')
  })
  test('長さの制約は入れない', () => {
    const text = JSON.stringify(outlineJsonSchema(['酒寄彩葉']))
    expect(text).not.toMatch(/minLength|maxLength|minItems|maxItems|minimum|maximum/)
  })
})
