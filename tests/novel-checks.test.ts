import { describe, expect, test } from 'bun:test'
import {
  type ChapterCheckInput,
  chapterTail,
  checkChapter,
  findEndingOverlaps,
  findMissingCharacters,
  findSpeechCopies,
  findUnexpectedCharacters,
  indentStats,
  indentStyle,
  isMentioned,
  lengthRatio,
  longestCommonSubstring,
  nameAliases
} from '@/lib/novel/checks'
import { CheckWarningSchema } from '@/schemas/story.dto'

// 段落頭を全角空白で下げた地の文の行
const indentedLine = (text: string) => `　${text}`

describe('lengthRatio', () => {
  test('content length over target', () => {
    expect(lengthRatio('あ'.repeat(2000), 4000)).toBe(0.5)
    expect(lengthRatio('あ'.repeat(6000), 4000)).toBe(1.5)
  })
  test('empty content and non-positive target do not throw', () => {
    expect(lengthRatio('', 4000)).toBe(0)
    expect(lengthRatio('あ', 0)).toBe(0)
    expect(lengthRatio('あ', -1)).toBe(0)
  })
})

describe('chapterTail', () => {
  test('takes the last chars without trailing whitespace', () => {
    expect(chapterTail('0123456789\n\n  ', 4)).toBe('6789')
    expect(chapterTail('abc', 200)).toBe('abc')
  })
  test('default is 200 chars', () => {
    expect(chapterTail('あ'.repeat(500)).length).toBe(200)
  })
  test('empty content and zero chars', () => {
    expect(chapterTail('')).toBe('')
    expect(chapterTail('abc', 0)).toBe('')
  })
})

describe('longestCommonSubstring', () => {
  test('finds the longest contiguous run', () => {
    expect(longestCommonSubstring('私は確信する。まだ始まったばかりだ', '彼は絶望した。まだ始まったばかりだ')).toBe(
      '。まだ始まったばかりだ'
    )
    expect(longestCommonSubstring('abcdef', 'xxcdexx')).toBe('cde')
  })
  test('no overlap or empty input gives an empty string', () => {
    expect(longestCommonSubstring('abc', 'xyz')).toBe('')
    expect(longestCommonSubstring('', 'abc')).toBe('')
    expect(longestCommonSubstring('abc', '')).toBe('')
  })
  test('does not mix up non-contiguous matches', () => {
    expect(longestCommonSubstring('abXcd', 'abcd')).toBe('ab')
  })
})

describe('findEndingOverlaps', () => {
  const chapter1 = { number: 1, content: `${'あ'.repeat(300)}\n\n私は確信していた。この旅は、まだ始まったばかりだ。\n` }
  const chapter3 = { number: 3, content: `${'い'.repeat(300)}\n\n彼女は笑った。そう、まだ始まったばかりだ。` }

  test('detects the same ending phrase and returns a < b', () => {
    const overlaps = findEndingOverlaps([chapter3, chapter1])
    expect(overlaps).toHaveLength(1)
    expect(overlaps[0]?.a).toBe(1)
    expect(overlaps[0]?.b).toBe(3)
    expect(overlaps[0]?.phrase).toBe('まだ始まったばかりだ')
  })
  test('ignores overlaps shorter than minLength', () => {
    const a = { number: 1, content: 'ただ、風が吹いた。さよなら' }
    const b = { number: 2, content: '空は青かった。さよなら' }
    // 共通部分は「さよなら」の 4 字だけ
    expect(findEndingOverlaps([a, b])).toEqual([])
    expect(findEndingOverlaps([a, b], { minLength: 4 })).toHaveLength(1)
  })
  test('ignores differences in whitespace and punctuation', () => {
    const a = { number: 1, content: '最後に彼は呟いた。「まだ、始まった ばかりだ！」' }
    const b = { number: 2, content: '最後に彼女は笑う……まだ始まった\n\nばかりだ。' }
    const [overlap] = findEndingOverlaps([a, b])
    expect(overlap?.phrase).toBe('まだ始まったばかりだ')
  })
  test('keeps the prolonged sound mark as a character', () => {
    const a = { number: 1, content: 'ラーメンを食べよう' }
    const b = { number: 2, content: 'ラメンを食べよう' }
    // 「ー」を取り除くと両方が「ラメンを食べよう」になり 8 字そろってしまう。残すので共通部分は「メンを食べよう」
    expect(findEndingOverlaps([a, b])[0]?.phrase).toBe('メンを食べよう')
  })
  test('only compares the tail window', () => {
    const a = { number: 1, content: `共通の言い回しがここにある${'あ'.repeat(300)}` }
    const b = { number: 2, content: `共通の言い回しがここにある${'い'.repeat(300)}` }
    expect(findEndingOverlaps([a, b])).toEqual([])
    expect(findEndingOverlaps([a, b], { tailChars: 400 })).toHaveLength(1)
  })
  test('compares every pair', () => {
    const phrase = 'この物語はまだ終わらない'
    const chapters = [1, 2, 3].map((number) => ({ number, content: `${'あ'.repeat(number * 50)}${phrase}` }))
    expect(findEndingOverlaps(chapters).map((o) => [o.a, o.b])).toEqual([
      [1, 2],
      [1, 3],
      [2, 3]
    ])
  })
  test('does not mutate the input and tolerates empty values', () => {
    const chapters = [chapter3, chapter1]
    findEndingOverlaps(chapters)
    expect(chapters.map((c) => c.number)).toEqual([3, 1])
    expect(findEndingOverlaps([])).toEqual([])
    expect(findEndingOverlaps([{ number: 1, content: '' }])).toEqual([])
    expect(
      findEndingOverlaps([
        { number: 1, content: '' },
        { number: 2, content: '' }
      ])
    ).toEqual([])
  })
})

describe('findSpeechCopies', () => {
  const example = 'しかもいい話ふうになってるのが余計許せないよ！'

  test('detects a copied example and returns the original string', () => {
    const content = `彼女は言った。\n「しかもいい話ふうになってるのが余計許せないよ！」\n`
    expect(findSpeechCopies(content, [example])).toEqual([example])
  })
  test('ignores the trailing exclamation, question mark, punctuation and whitespace of the example', () => {
    const content = '「しかもいい話ふうになってるのが余計許せないよ。」'
    expect(findSpeechCopies(content, [example])).toEqual([example])
    expect(findSpeechCopies(content, [`  ${example.replace('！', '？！')} \n`])).toHaveLength(1)
  })
  test('ignores short examples', () => {
    expect(findSpeechCopies('「やったー！」と叫んだ。', ['やったー！'])).toEqual([])
    // 末尾の記号を除いて 8 字未満
    expect(findSpeechCopies('「そうなんだよね。」', ['そうなんだよね！！！'])).toEqual([])
  })
  test('minLength can be changed', () => {
    expect(findSpeechCopies('「やったー！」と叫んだ。', ['やったー！'], { minLength: 4 })).toEqual(['やったー！'])
  })
  test('does not report examples that are absent or only partly present', () => {
    expect(findSpeechCopies('しかもいい話ふうになってるのが', [example])).toEqual([])
    expect(findSpeechCopies('まったく関係のない本文', [example])).toEqual([])
  })
  test('empty inputs do not throw', () => {
    expect(findSpeechCopies('', [example])).toEqual([])
    expect(findSpeechCopies('本文', [])).toEqual([])
    expect(findSpeechCopies('本文', ['', '   '])).toEqual([])
  })
})

describe('indentStats / indentStyle', () => {
  const indented = ['朝の光が差し込んでいた。', '彼女は窓を開けた。', '風が頬を撫でた。'].map(indentedLine).join('\n')
  const flush = ['朝の光が差し込んでいた。', '彼女は窓を開けた。', '風が頬を撫でた。'].join('\n')

  test('counts narration lines and indented lines', () => {
    expect(indentStats(indented)).toEqual({ narration: 3, indented: 3 })
    expect(indentStats(flush)).toEqual({ narration: 3, indented: 0 })
  })
  test('blank lines are not counted', () => {
    expect(indentStats(`${indentedLine('一行目')}\n\n\n　\n${indentedLine('二行目')}\n`)).toEqual({
      narration: 2,
      indented: 2
    })
  })
  test('dialogue lines (opening bracket) are not narration', () => {
    const content = [
      indentedLine('彼は言った。'),
      '「おはよう」',
      '『タイトル』という本',
      '（心の声）',
      indentedLine('朝だった。')
    ].join('\n')
    expect(indentStats(content)).toEqual({ narration: 2, indented: 2 })
  })
  test('half-width space and CRLF line breaks', () => {
    expect(indentStats(' 半角空白で始まる行\r\n　全角空白で始まる行')).toEqual({ narration: 2, indented: 1 })
  })

  test('indented: 90% or more', () => {
    expect(indentStyle(indentStats(indented))).toBe('indented')
    expect(indentStyle({ narration: 10, indented: 9 })).toBe('indented')
  })
  test('flush: 10% or less', () => {
    expect(indentStyle(indentStats(flush))).toBe('flush')
    expect(indentStyle({ narration: 10, indented: 1 })).toBe('flush')
    expect(indentStyle({ narration: 10, indented: 0 })).toBe('flush')
  })
  test('mixed: in between', () => {
    expect(indentStyle(indentStats([indentedLine('字下げあり'), '字下げなし'].join('\n')))).toBe('mixed')
    expect(indentStyle({ narration: 10, indented: 2 })).toBe('mixed')
    expect(indentStyle({ narration: 10, indented: 8 })).toBe('mixed')
  })
  test('none: no narration at all', () => {
    expect(indentStyle(indentStats(''))).toBe('none')
    expect(indentStyle(indentStats('「会話だけ」\n「会話だけ」'))).toBe('none')
  })
})

describe('nameAliases', () => {
  test('the name itself', () => {
    expect(nameAliases('酒寄彩葉')).toEqual(['酒寄彩葉'])
  })
  test('parts split by space, middle dot and equals', () => {
    expect(nameAliases('酒寄 彩葉')).toEqual(['酒寄 彩葉', '酒寄', '彩葉'])
    expect(nameAliases('ルナ・フローレンス')).toEqual(['ルナ・フローレンス', 'ルナ', 'フローレンス'])
    expect(nameAliases('アリス＝リデル')).toContain('リデル')
    expect(nameAliases('酒寄　彩葉')).toContain('彩葉')
  })
  test('common part with a way of being called', () => {
    expect(nameAliases('酒寄彩葉', ['彩葉ちゃん'])).toContain('彩葉')
    expect(nameAliases('酒寄彩葉', ['酒寄さん'])).toContain('酒寄')
  })
  test('calls that do not share two characters with the name are not aliases', () => {
    expect(nameAliases('酒寄彩葉', ['先輩'])).toEqual(['酒寄彩葉'])
    expect(nameAliases('酒寄彩葉', ['君', '葉っぱ'])).toEqual(['酒寄彩葉'])
  })
  test('does not mutate calls and tolerates empty values', () => {
    const calls = ['彩葉ちゃん']
    nameAliases('酒寄彩葉', calls)
    expect(calls).toEqual(['彩葉ちゃん'])
    expect(nameAliases('')).toEqual([])
    expect(nameAliases('   ')).toEqual([])
  })
})

describe('isMentioned', () => {
  test('exact name matches in both modes', () => {
    expect(isMentioned('酒寄彩葉は笑った。', '酒寄彩葉')).toBe(true)
    expect(isMentioned('酒寄彩葉は笑った。', '酒寄彩葉', { loose: true })).toBe(true)
    expect(isMentioned('誰も笑わなかった。', '酒寄彩葉', { loose: true })).toBe(false)
  })
  test('loose accepts the given name or family name of a 4+ char name; strict does not', () => {
    const content = '彩葉は窓の外を見た。'
    expect(isMentioned(content, '酒寄彩葉')).toBe(false)
    expect(isMentioned(content, '酒寄彩葉', { loose: true })).toBe(true)
    expect(isMentioned('酒寄は黙っていた。', '酒寄彩葉', { loose: true })).toBe(true)
    expect(isMentioned('酒寄は黙っていた。', '酒寄彩葉')).toBe(false)
  })
  test('loose accepts a prefix or suffix shorter than the whole name', () => {
    expect(isMentioned('フローレは言った。', 'フローレンス', { loose: true })).toBe(true)
    expect(isMentioned('エンスは言った。', 'フローレンス', { loose: true })).toBe(true)
  })
  test('a name with a separator is not split into prefixes in loose mode, but its parts match', () => {
    expect(isMentioned('ルナは言った。', 'ルナ・フローレンス')).toBe(true)
    expect(isMentioned('フローレは言った。', 'ルナ・フローレンス', { loose: true })).toBe(false)
  })
  test('names of 3 chars or fewer only match as a whole, even in loose mode', () => {
    expect(isMentioned('かぐわしい香りがした。', 'かぐや')).toBe(false)
    expect(isMentioned('かぐわしい香りがした。', 'かぐや', { loose: true })).toBe(false)
    expect(isMentioned('かぐやは笑った。', 'かぐや', { loose: true })).toBe(true)
    expect(isMentioned('彩葉は笑った。', '彩葉', { loose: true })).toBe(true)
  })
  test('way of being called', () => {
    expect(isMentioned('彩葉ちゃんは笑った。', '酒寄彩葉', { calls: ['彩葉ちゃん'] })).toBe(true)
    expect(isMentioned('先輩は笑った。', '酒寄彩葉', { calls: ['先輩'] })).toBe(false)
  })
  test('empty content or name does not throw', () => {
    expect(isMentioned('', '酒寄彩葉', { loose: true })).toBe(false)
    expect(isMentioned('本文', '', { loose: true })).toBe(false)
  })
})

describe('findMissingCharacters / findUnexpectedCharacters', () => {
  test('missing: planned people who do not appear, with loose matching', () => {
    const content = '彩葉は窓の外を見た。'
    expect(findMissingCharacters(content, ['酒寄彩葉', '東雲かぐや'])).toEqual(['東雲かぐや'])
    expect(findMissingCharacters(content, [])).toEqual([])
  })
  test('missing: duplicates and blank names are dropped', () => {
    expect(findMissingCharacters('誰もいない', ['東雲かぐや', ' 東雲かぐや ', '', '  '])).toEqual(['東雲かぐや'])
  })
  test('unexpected: needs a strict alias, and is skipped when nobody is planned', () => {
    const cast = ['酒寄彩葉', '東雲かぐや']
    expect(findUnexpectedCharacters('東雲かぐやが来た。', ['酒寄彩葉'], cast)).toEqual(['東雲かぐや'])
    expect(findUnexpectedCharacters('かぐやが来た。', ['酒寄彩葉'], cast)).toEqual([])
    expect(findUnexpectedCharacters('東雲かぐやが来た。', [], cast)).toEqual([])
    expect(findUnexpectedCharacters('東雲かぐやが来た。', ['東雲かぐや'], cast)).toEqual([])
  })
  test('callsByName with an inherited key name does not break', () => {
    expect(findMissingCharacters('本文', ['constructor'], {})).toEqual(['constructor'])
  })
})

describe('checkChapter', () => {
  const target = 1000
  // 目標どおりの長さで、地の文は字下げあり、章末は他の章と重ならない本文
  const goodContent = [
    indentedLine(`彩葉は朝の駅に立っていた。${'空は高く澄んでいた。'.repeat(40)}`),
    '「おはよう」',
    indentedLine(`${'あ'.repeat(450)}静かな夜だった`)
  ].join('\n')

  const baseInput = (overrides: Partial<ChapterCheckInput> = {}): ChapterCheckInput => ({
    chapter: { number: 2, content: goodContent },
    targetChars: target,
    plannedCharacters: ['酒寄彩葉'],
    castNames: ['酒寄彩葉', '東雲かぐや'],
    speechExamples: [],
    otherChapters: [],
    ...overrides
  })

  test('has no warnings when nothing is wrong', () => {
    expect(goodContent.length).toBeGreaterThanOrEqual(800)
    expect(goodContent.length).toBeLessThanOrEqual(1500)
    expect(checkChapter(baseInput())).toEqual([])
  })

  test('length: too short', () => {
    const warnings = checkChapter(
      baseInput({ chapter: { number: 2, content: indentedLine('彩葉は走った。') }, plannedCharacters: [] })
    )
    expect(warnings.map((w) => w.kind)).toEqual(['length'])
    expect(warnings[0]?.message).toBe('目標 1,000 字に対して 8 字（1%）です')
  })
  test('length: too long, and the thousands separator', () => {
    const content = indentedLine('あ'.repeat(1600))
    const [warning] = checkChapter(baseInput({ chapter: { number: 2, content }, plannedCharacters: [] }))
    expect(warning?.kind).toBe('length')
    expect(warning?.message).toBe('目標 1,000 字に対して 1,601 字（160%）です')
  })
  test('length: 80% and 150% are inside the range', () => {
    const at = (chars: number) => ({ number: 2, content: `　${'あ'.repeat(chars - 1)}` })
    expect(checkChapter(baseInput({ chapter: at(800), plannedCharacters: [] }))).toEqual([])
    expect(checkChapter(baseInput({ chapter: at(1500), plannedCharacters: [] }))).toEqual([])
    expect(checkChapter(baseInput({ chapter: at(799), plannedCharacters: [] })).map((w) => w.kind)).toEqual(['length'])
    expect(checkChapter(baseInput({ chapter: at(1501), plannedCharacters: [] })).map((w) => w.kind)).toEqual(['length'])
  })
  test('length: a non-positive target is not checked', () => {
    expect(checkChapter(baseInput({ targetChars: 0, plannedCharacters: [] }))).toEqual([])
  })

  test('missing_character: planned but absent (loose matching)', () => {
    const warnings = checkChapter(baseInput({ plannedCharacters: ['酒寄彩葉', '東雲かぐや'], castNames: [] }))
    expect(warnings.map((w) => w.kind)).toEqual(['missing_character'])
    expect(warnings[0]?.message).toContain('東雲かぐや')
    expect(warnings[0]?.message).not.toContain('酒寄彩葉、')
    expect(warnings[0]?.message).toMatch(/2 人のうち 1 人/)
  })
  test('missing_character: the short form of a name counts as present', () => {
    // 本文は「彩葉」と書く。名簿は「酒寄彩葉」
    expect(goodContent).not.toContain('酒寄彩葉')
    expect(checkChapter(baseInput()).map((w) => w.kind)).not.toContain('missing_character')
  })

  test('unexpected_character: a cast member who is not planned appears (strict matching)', () => {
    const content = `${goodContent}\n　東雲かぐやが現れた。`
    const warnings = checkChapter(baseInput({ chapter: { number: 2, content } }))
    expect(warnings.map((w) => w.kind)).toEqual(['unexpected_character'])
    expect(warnings[0]?.message).toContain('東雲かぐや')
  })
  test('unexpected_character: a loose-only match does not warn', () => {
    // 「かぐや」は名簿の「東雲かぐや」の接尾辞だが、厳密モードでは別名ではない
    const content = `${goodContent}\n　かぐやが現れた。`
    expect(checkChapter(baseInput({ chapter: { number: 2, content } }))).toEqual([])
  })
  test('unexpected_character: a call from the table makes the person detectable', () => {
    const content = `${goodContent}\n　かぐやちゃんが現れた。`
    const warnings = checkChapter(
      baseInput({ chapter: { number: 2, content }, callsByName: { 東雲かぐや: ['かぐやちゃん'] } })
    )
    expect(warnings.map((w) => w.kind)).toEqual(['unexpected_character'])
  })

  test('no character checks when plannedCharacters is empty', () => {
    const content = `${goodContent}\n　東雲かぐやが現れた。`
    expect(checkChapter(baseInput({ chapter: { number: 2, content }, plannedCharacters: [] }))).toEqual([])
    expect(checkChapter(baseInput({ plannedCharacters: [], castNames: ['誰か'] }))).toEqual([])
  })

  test('ending_overlap: names the other chapter and quotes the shared phrase', () => {
    const ending = '私は確信していた。この旅は、まだ始まったばかりだ。'
    const chapter = { number: 3, content: `${goodContent.slice(0, -7)}${ending}` }
    const warnings = checkChapter(
      baseInput({
        chapter,
        otherChapters: [
          { number: 1, content: `${'い'.repeat(300)}私は確信した。まだ始まったばかりだ。` },
          { number: 2, content: `${'う'.repeat(300)}静かな夜だった。` }
        ]
      })
    )
    expect(warnings.map((w) => w.kind)).toEqual(['ending_overlap'])
    expect(warnings[0]?.message).toContain('第 1 章')
    expect(warnings[0]?.message).toContain('まだ始まったばかりだ')
  })
  test('ending_overlap: ignores a chapter with the same number', () => {
    expect(checkChapter(baseInput({ otherChapters: [{ number: 2, content: goodContent }] }))).toEqual([])
  })

  test('speech_copy: a copied example', () => {
    const example = 'しかもいい話ふうになってるのが余計許せないよ！'
    const content = `${goodContent}\n「しかもいい話ふうになってるのが余計許せないよ！」`
    const warnings = checkChapter(baseInput({ chapter: { number: 2, content }, speechExamples: [example, '短い例'] }))
    expect(warnings.map((w) => w.kind)).toEqual(['speech_copy'])
    expect(warnings[0]?.message).toContain(example)
    expect(warnings[0]?.message).toMatch(/\d+ 字/)
  })

  test('indent: flush and mixed warn, indented and none do not', () => {
    const lines = Array.from({ length: 10 }, (_, i) => `${'あ'.repeat(50)}${i}`)
    const flush = lines.join('\n')
    const mixed = lines.map((line, i) => (i < 5 ? indentedLine(line) : line)).join('\n')
    const indented = lines.map(indentedLine).join('\n')
    const kinds = (content: string) =>
      checkChapter(
        baseInput({ chapter: { number: 2, content }, targetChars: content.length, plannedCharacters: [] })
      ).map((w) => w.kind)
    expect(kinds(flush)).toEqual(['indent'])
    expect(kinds(mixed)).toEqual(['indent'])
    expect(kinds(indented)).toEqual([])
    expect(kinds('「会話だけ」'.repeat(20))).toEqual([])
  })

  test('returns warnings in the documented kind order', () => {
    const example = 'しかもいい話ふうになってるのが余計許せないよ！'
    const content = `彩葉は走った。\n東雲かぐやが現れた。「${example}」まだ始まったばかりだ`
    const warnings = checkChapter({
      chapter: { number: 2, content },
      targetChars: 4000,
      plannedCharacters: ['酒寄彩葉', '八雲'],
      castNames: ['酒寄彩葉', '八雲', '東雲かぐや'],
      speechExamples: [example],
      otherChapters: [{ number: 1, content: '……だったのだ。まだ始まったばかりだ。' }]
    })
    expect(warnings.map((w) => w.kind)).toEqual([
      'length',
      'missing_character',
      'unexpected_character',
      'ending_overlap',
      'speech_copy',
      'indent'
    ])
  })

  test('every warning satisfies CheckWarningSchema (message within 600 chars)', () => {
    const longNames = Array.from({ length: 80 }, (_, i) => `とても長い名前の人物${String(i).padStart(3, '0')}`)
    const warnings = checkChapter({
      chapter: { number: 2, content: '短い。' },
      targetChars: 4000,
      plannedCharacters: longNames,
      castNames: longNames,
      speechExamples: [],
      otherChapters: []
    })
    expect(warnings.length).toBeGreaterThan(0)
    for (const warning of warnings) {
      expect(CheckWarningSchema.safeParse(warning).success).toBe(true)
      expect(warning.message.length).toBeLessThanOrEqual(600)
    }
  })

  test('does not mutate the input and tolerates empty values', () => {
    const input = baseInput({ otherChapters: [{ number: 1, content: 'x' }], speechExamples: ['a'] })
    const snapshot = structuredClone(input)
    checkChapter(input)
    expect(input).toEqual(snapshot)
    expect(() =>
      checkChapter({
        chapter: { number: 1, content: '' },
        targetChars: 0,
        plannedCharacters: [],
        castNames: [],
        speechExamples: [],
        otherChapters: []
      })
    ).not.toThrow()
    expect(
      checkChapter({
        chapter: { number: 1, content: '' },
        targetChars: 0,
        plannedCharacters: [],
        castNames: [],
        speechExamples: [],
        otherChapters: []
      })
    ).toEqual([])
  })
})
