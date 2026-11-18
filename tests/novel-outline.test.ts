import { describe, expect, test } from 'bun:test'
import {
  matchCastName,
  normalizeOutlineCharacters,
  outlineChapterJsonSchema,
  outlineJsonSchema,
  parseOutlineChapterResponse,
  parseOutlineResponse,
  sortOutline,
  validateOutlineShape
} from '@/lib/novel/outline'
import type { Outline } from '@/schemas/novel.dto'

const CAST = ['酒寄彩葉', '月見ヤチヨ', '八千代']

function chapter(chapterNumber: number, characters: string[] = [], title = `題${chapterNumber}`, summary = '概要') {
  return { chapter_number: chapterNumber, title, summary, characters }
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
  test('章の題・概要・番号は変えない', () => {
    const outline: Outline = { chapters: [chapter(3, ['彩葉'], '出会い', '二人が出会う')] }
    const result = normalizeOutlineCharacters(outline, CAST)
    expect(result.outline.chapters[0]).toEqual({
      chapter_number: 3,
      title: '出会い',
      summary: '二人が出会う',
      characters: ['酒寄彩葉']
    })
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
})

describe('parseOutlineResponse', () => {
  const body = [
    { chapter_number: 1, title: '出会い', summary: '概要 1', characters: ['酒寄彩葉'] },
    { chapter_number: 2, title: '別れ', summary: '概要 2' }
  ]

  test('{ chapters } をそのまま受ける (characters の既定値は空配列)', () => {
    const result = parseOutlineResponse(JSON.stringify({ chapters: body }))
    expect(result).toEqual({
      ok: true,
      outline: {
        chapters: [
          { chapter_number: 1, title: '出会い', summary: '概要 1', characters: ['酒寄彩葉'] },
          { chapter_number: 2, title: '別れ', summary: '概要 2', characters: [] }
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
    expect(parseOutlineChapterResponse(JSON.stringify(entry))).toEqual({ ok: true, chapter: entry })
    expect(parseOutlineChapterResponse(JSON.stringify(entry), 5)).toEqual({ ok: true, chapter: entry })
  })
  test('{ chapters: [...] } に複数あれば、対象の番号の章を選ぶ', () => {
    const chapters = [chapterEntry(1), entry, chapterEntry(3)]
    expect(parseOutlineChapterResponse(JSON.stringify({ chapters }), 2)).toEqual({ ok: true, chapter: entry })
    expect(parseOutlineChapterResponse(JSON.stringify({ chapters }), 3)).toEqual({ ok: true, chapter: chapterEntry(3) })
  })
  test('配列でも同じ', () => {
    const chapters = [chapterEntry(1), entry, chapterEntry(3)]
    expect(parseOutlineChapterResponse(JSON.stringify(chapters), 1)).toEqual({ ok: true, chapter: chapterEntry(1) })
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
    expect(parseOutlineChapterResponse(JSON.stringify({ chapters: [entry] }), 5)).toEqual({ ok: true, chapter: entry })
    expect(parseOutlineChapterResponse(JSON.stringify([entry]), 5)).toEqual({ ok: true, chapter: entry })
  })
  test('対象の番号を渡さず 1 件なら受け、複数なら失敗する', () => {
    expect(parseOutlineChapterResponse(JSON.stringify([entry]))).toEqual({ ok: true, chapter: entry })
    const result = parseOutlineChapterResponse(JSON.stringify({ chapters: [chapterEntry(1), entry] }))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain('2 件')
  })
  test('chapter_number が数値でない要素は一致しないものとして扱う', () => {
    const chapters = [{ ...entry, chapter_number: '2' }, { ...entry, chapter_number: null }, chapterEntry(3)]
    expect(parseOutlineChapterResponse(JSON.stringify(chapters), 2).ok).toBe(false)
    expect(parseOutlineChapterResponse(JSON.stringify(chapters), 3)).toEqual({ ok: true, chapter: chapterEntry(3) })
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

describe('JSON Schema', () => {
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
              summary: { type: 'string' },
              characters: { type: 'array', items: { type: 'string', enum: ['酒寄彩葉', '月見ヤチヨ'] } }
            },
            required: ['chapter_number', 'title', 'summary', 'characters']
          }
        }
      },
      required: ['chapters']
    })
  })
  test('名簿が空なら characters の項目を入れない', () => {
    const schema = outlineJsonSchema([])
    const text = JSON.stringify(schema)
    expect(text).not.toContain('characters')
    expect(text).not.toContain('enum')
    expect(text).toContain('chapter_number')
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
    expect(chapterSchema.required).toEqual(['chapter_number', 'title', 'summary', 'characters'])
  })
  test('長さの制約は入れない', () => {
    const text = JSON.stringify(outlineJsonSchema(['酒寄彩葉']))
    expect(text).not.toMatch(/minLength|maxLength|minItems|maxItems|minimum|maximum/)
  })
})
