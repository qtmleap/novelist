import { describe, expect, test } from 'bun:test'
import { buildLedger, renderLedger } from '@/lib/novel/ledger'
import {
  buildChapterPrompt,
  buildChapterPromptForStorage,
  buildOutlineChapterPrompt,
  buildOutlinePrompt,
  type CastMember,
  type CastRelation,
  type ChapterPromptInput,
  type NovelParams,
  type PriorChapterInput,
  type PriorChapterText,
  renderPromptForStorage,
  type StyleParams,
  sceneGuide
} from '@/lib/novel/prompts'
import { FIRST_PERSON_AS_NAME } from '@/schemas/character.dto'
import type { Outline } from '@/schemas/novel.dto'

// ---------------------- 入力の見本 ----------------------

const mio: CastMember = {
  name: '朝倉澪',
  role: '主人公',
  gender: '女性',
  age: '17',
  occupation: '学生',
  appearance: '肩までの黒髪。',
  first_person: '私',
  address_others: '苗字＋さん',
  speech_examples: ['そういうの、後でまとめて聞くから'],
  description: '天文部の部長。\n\n段取りを決めてから動く。'
}

const runa: CastMember = {
  name: 'ルナ',
  role: 'ヒロイン',
  gender: '女性',
  age: '',
  occupation: '',
  appearance: '銀色の髪。',
  first_person: FIRST_PERSON_AS_NAME,
  address_others: '名前',
  speech_examples: ['ルナはね、流れ星を数えるのが好きなの！', 'それって、すっごく変だよ'],
  description: '屋上の望遠鏡の前に現れた少女。'
}

const hiiragi: CastMember = {
  name: '柊誠',
  role: '脇役',
  gender: '男性',
  age: '42',
  occupation: '教師',
  appearance: '白衣に寝癖。',
  first_person: '僕',
  address_others: '苗字',
  speech_examples: ['提出は金曜まで、いいね'],
  description: '天文部の顧問。'
}

const cast: CastMember[] = [mio, runa, hiiragi]

const relations: CastRelation[] = [
  {
    source_name: '朝倉澪',
    target_name: 'ルナ',
    relation: '友人',
    description: '屋上で出会った',
    address_override: '名前'
  },
  { source_name: 'ルナ', target_name: '朝倉澪', relation: '友人', description: '', address_override: '名前＋ちゃん' },
  {
    source_name: '朝倉澪',
    target_name: '柊誠',
    relation: '教師',
    description: '部の顧問',
    address_override: '苗字＋先生'
  },
  { source_name: '柊誠', target_name: 'ルナ', relation: '教え子', description: '', address_override: '苗字＋さん' }
]

const novel: NovelParams = {
  title: '屋上の観測記録',
  genre: '青春',
  setting: '地方の高校の天文部。屋上に古い望遠鏡がある。',
  num_chapters: 5,
  outline_summary_chars: 300,
  notes: '- 流星群の夜を入れる'
}

const style: StyleParams = {
  pov: '一人称',
  tone: 'ライトノベル調',
  ending: 'ハッピーエンド',
  age_rating: '全年齢',
  viewpointChar: { name: '朝倉澪', first_person: '私' }
}

// 第 2 章は語り手 (朝倉澪) が characters から漏れている。第 4 章は characters が空 (旧データ)。
const outline: Outline = {
  chapters: [
    { chapter_number: 1, title: '屋上の少女', summary: '澪が屋上でルナと出会う。', characters: ['朝倉澪', 'ルナ'] },
    { chapter_number: 2, title: '入部届', summary: 'ルナが天文部に入りたいと言い出す。', characters: ['ルナ'] },
    {
      chapter_number: 3,
      title: '顧問の条件',
      summary: '柊が入部の条件を出す。',
      characters: ['朝倉澪', 'ルナ', '柊誠']
    },
    { chapter_number: 4, title: '準備', summary: '観測会の準備を進める。', characters: [] },
    { chapter_number: 5, title: '流星群の夜', summary: '観測会の夜、約束を果たす。', characters: ['朝倉澪', 'ルナ'] }
  ]
}

const chapterText = (n: number): string =>
  `　第${n}章の地の文、一段落め。\n「第${n}章の台詞」\n\n　第${n}章の地の文、二段落め。`

const prior = (numbers: number[]): PriorChapterText[] =>
  numbers.map((n) => ({ chapter_number: n, title: `保存済みの題${n}`, content: chapterText(n) }))

const input = (chapterNumber: number, overrides: Partial<ChapterPromptInput> = {}): ChapterPromptInput => ({
  novel,
  outline,
  chapterNumber,
  priorChapters: prior(Array.from({ length: chapterNumber - 1 }, (_, i) => i + 1)),
  targetChars: 4000,
  style,
  cast,
  relations,
  ...overrides
})

// user の中の節の見出しを、出てくる順に取り出す。
const headings = (text: string): string[] => [...text.matchAll(/^【(.+?)】$/gm)].map((m) => m[1])

// 見出しから次の見出しの直前まで。無ければ ''。
const section = (text: string, heading: string): string => {
  const start = text.indexOf(`【${heading}】\n`)
  if (start < 0) return ''
  const rest = text.slice(start)
  const next = rest.indexOf('\n\n【')
  return next < 0 ? rest : rest.slice(0, next)
}

// ---------------------- 分量 ----------------------

describe('sceneGuide', () => {
  test('場面数は目標 ÷ 1,000 を 2〜8 に収める', () => {
    expect(sceneGuide(500).scenes).toBe(2)
    expect(sceneGuide(2000).scenes).toBe(2)
    expect(sceneGuide(3000).scenes).toBe(3)
    expect(sceneGuide(4000).scenes).toBe(4)
    expect(sceneGuide(8000).scenes).toBe(8)
    expect(sceneGuide(20000).scenes).toBe(8)
  })

  test('1 場面あたりの字数は 100 字単位', () => {
    expect(sceneGuide(4000)).toEqual({ scenes: 4, charsPerScene: 1000 })
    expect(sceneGuide(20000)).toEqual({ scenes: 8, charsPerScene: 2500 })
    expect(sceneGuide(3500)).toEqual({ scenes: 4, charsPerScene: 900 })
    expect(sceneGuide(500).charsPerScene % 100).toBe(0)
  })
})

// ---------------------- 保存用 ----------------------

describe('renderPromptForStorage', () => {
  test('system と user の両方を見出しつきで含む', () => {
    const text = renderPromptForStorage({ system: '執筆の規則', user: '資料と指示' })
    expect(text).toContain('執筆の規則')
    expect(text).toContain('資料と指示')
    expect(text.indexOf('system')).toBeLessThan(text.indexOf('執筆の規則'))
    expect(text.indexOf('執筆の規則')).toBeLessThan(text.indexOf('user'))
    expect(text.indexOf('user')).toBeLessThan(text.indexOf('資料と指示'))
  })
})

// ---------------------- 本文: 並びと安定性 ----------------------

describe('buildChapterPrompt: 節の並び', () => {
  test('作品情報 → 文体・視点 → 全体の章立て → 確定済みの本文 → この章の登場人物 → 今回の執筆', () => {
    expect(headings(buildChapterPrompt(input(3)).user)).toEqual([
      '作品情報',
      '文体・視点',
      '全体の章立て',
      '確定済みの本文',
      'この章の登場人物',
      'キャラクター間の関係',
      '今回の執筆'
    ])
  })

  test('登場しない人物の節は、関係の後・今回の執筆の前', () => {
    expect(headings(buildChapterPrompt(input(2)).user)).toEqual([
      '作品情報',
      '文体・視点',
      '全体の章立て',
      '確定済みの本文',
      'この章の登場人物',
      'キャラクター間の関係',
      'この章に登場しない人物',
      '今回の執筆'
    ])
  })

  test('第 1 章では確定済みの本文の節が出ない', () => {
    const { user } = buildChapterPrompt(input(1))
    expect(headings(user)).not.toContain('確定済みの本文')
    expect(user).toContain('執筆済み: なし')
  })

  test('節の間は空行 1 つで、user は今回の執筆で終わる', () => {
    const { system, user } = buildChapterPrompt(input(3))
    expect(user).not.toContain('\n\n\n')
    expect(system).not.toContain('\n\n\n')
    expect(user.startsWith('【作品情報】\n')).toBe(true)
    expect(user.endsWith('\n')).toBe(false)
    expect(user.slice(user.lastIndexOf('【'))).toStartWith('【今回の執筆】')
  })

  test('空の入力の節は見出しごと出ない', () => {
    const { system, user } = buildChapterPrompt(input(1, { cast: [], relations: [] }))
    expect(headings(user)).toEqual(['作品情報', '文体・視点', '全体の章立て', '今回の執筆'])
    expect(system).not.toContain('【人物】')
    expect(system).toContain('【表記】')
  })
})

describe('buildChapterPrompt: 前半の安定性', () => {
  test('第 N 章の user の、第 N−1 章の本文の終わりまでが、第 N+1 章の user の先頭と一致する', () => {
    for (const n of [2, 3, 4]) {
      const current = buildChapterPrompt(input(n)).user
      const next = buildChapterPrompt(input(n + 1)).user
      const lastText = chapterText(n - 1)
      const end = current.indexOf(lastText) + lastText.length
      expect(current.indexOf(lastText)).toBeGreaterThan(0)
      expect(next.startsWith(current.slice(0, end))).toBe(true)
      // 続きは、新しく確定した第 N 章の本文
      expect(next.slice(end)).toStartWith(`\n\n▼ 第${n}章「保存済みの題${n}」\n${chapterText(n)}`)
    }
  })

  test('第 1 章の user の章立てまでが、第 2 章の user の先頭と一致する', () => {
    const first = buildChapterPrompt(input(1)).user
    const second = buildChapterPrompt(input(2)).user
    const stable = first.slice(0, first.indexOf('\n\n【この章の登場人物】'))
    expect(stable).toContain('【全体の章立て】')
    expect(second.startsWith(`${stable}\n\n【確定済みの本文】\n`)).toBe(true)
  })

  test('確定済みの本文より前に、章番号ごとに変わる情報が入らない', () => {
    const stableOf = (n: number): string => {
      const { user } = buildChapterPrompt(input(n, { priorChapters: [] }))
      return user.slice(0, user.indexOf('\n\n【この章の登場人物】'))
    }
    expect(stableOf(2)).toBe(stableOf(5))
    expect(stableOf(2)).toBe(stableOf(1))
  })

  test('system は章が変わっても同じで、章番号を含まない', () => {
    const second = buildChapterPrompt(input(2)).system
    const fifth = buildChapterPrompt(input(5)).system
    expect(second).toBe(fifth)
    expect(second).toBe(buildChapterPrompt(input(1)).system)
    expect(second).not.toMatch(/第\s*[0-9０-９]+\s*章/)
    expect(second).not.toContain('入部届')
    expect(second).not.toContain('朝倉澪')
  })
})

// ---------------------- 本文: 確定済みの本文 ----------------------

describe('buildChapterPrompt: 確定済みの本文', () => {
  test('「（参考）」と書かず、確定した事実として扱う規則を system に書く', () => {
    const { system, user } = buildChapterPrompt(input(3))
    expect(`${system}\n${user}`).not.toContain('参考')
    expect(user).toContain('【確定済みの本文】')
    expect(system).toContain('【確定済みの本文】')
    expect(system).toContain('確定している')
    expect(system).toContain('矛盾させない')
    expect(system).toContain('本文を正とする')
  })

  test('番号順に並べ、今回の章以降と空の本文は載せない', () => {
    const { user } = buildChapterPrompt(
      input(3, {
        priorChapters: [
          { chapter_number: 3, title: '古い版', content: '　書き直す前の第3章。' },
          { chapter_number: 2, title: null, content: '\n\n　二章の本文。\n\n' },
          { chapter_number: 4, title: '後の章', content: '　後の章の本文。' },
          { chapter_number: 1, title: '一章の題', content: '　一章の本文。' }
        ]
      })
    )
    const body = section(user, '確定済みの本文')
    expect(body).toBe('【確定済みの本文】\n▼ 第1章「一章の題」\n　一章の本文。\n\n▼ 第2章\n　二章の本文。')
    expect(user).not.toContain('書き直す前の第3章')
    expect(user).not.toContain('後の章の本文')
  })

  test('直前の章の本文が無いときは、その旨を今回の執筆に書く', () => {
    const withText = section(buildChapterPrompt(input(3)).user, '今回の執筆')
    const withoutText = section(buildChapterPrompt(input(3, { priorChapters: prior([1]) })).user, '今回の執筆')
    expect(withText).toContain('執筆済み: 第1〜2章（第2章の終わりから続けて書く）')
    expect(withoutText).toContain('執筆済み: 第1〜2章（第2章の本文は資料に無い。概要の続きとして書き始める）')
    // 執筆済みが 1 章だけのときは章番号を繰り返さない
    expect(section(buildChapterPrompt(input(2)).user, '今回の執筆')).toContain(
      '執筆済み: 第1章（その終わりから続けて書く）'
    )
    expect(section(buildChapterPrompt(input(2, { priorChapters: [] })).user, '今回の執筆')).toContain(
      '執筆済み: 第1章（その本文は資料に無い。概要の続きとして書き始める）'
    )
  })
})

// ---------------------- 本文: 省略した章と確定事項 (Phase 2) ----------------------

// ledger.ts の renderLedger が返す形 (見出しつき、小見出しの間は空行 1 つ)。
const ledgerText = [
  '【確定事項】',
  'ここまでの本文から抜き出した記録である。',
  '',
  '■ これまでの流れ',
  '- 第1章: 澪が屋上でルナと出会った。',
  '',
  '■ 人物ごとの記録',
  '● 朝倉澪',
  '  知っていること:',
  '  - 第1章: ルナから、流れ星を数えに来たと聞いた'
].join('\n')

// user の中で、行がちょうど見出しになっている数。
const headingCount = (text: string, heading: string): number =>
  text.split('\n').filter((line) => line === `【${heading}】`).length

describe('buildChapterPrompt: 省略した章', () => {
  // 第 1・2 章は本文を渡せない (予算を超えた古い章)、第 3 章は全文。順不同で渡す。
  const mixed: PriorChapterInput[] = [
    { chapter_number: 3, title: '保存済みの題3', content: chapterText(3) },
    { chapter_number: 1, title: '保存済みの題1', omitted: true },
    { chapter_number: 2, title: null, omitted: true }
  ]

  test('見出しの 1 行だけを、番号順の位置に出す (全文の章と混ざってよい)', () => {
    const { user } = buildChapterPrompt(input(4, { priorChapters: mixed, ledgerText }))
    expect(section(user, '確定済みの本文')).toBe(
      [
        '【確定済みの本文】',
        '▼ 第1章「保存済みの題1」（本文は省略。内容は【確定事項】を参照）',
        '',
        '▼ 第2章（本文は省略。内容は【確定事項】を参照）',
        '',
        `▼ 第3章「保存済みの題3」\n${chapterText(3)}`
      ].join('\n')
    )
    expect(user).not.toContain('\n\n\n')
  })

  test('確定事項が無いときは、章立ての概要を指す', () => {
    const { user } = buildChapterPrompt(input(4, { priorChapters: mixed }))
    expect(section(user, '確定済みの本文')).toContain(
      '▼ 第1章「保存済みの題1」（本文は省略。内容は【全体の章立て】の概要を参照）'
    )
    expect(user).not.toContain('確定事項')
  })

  test('今回の章以降の番号は載せない', () => {
    const { user } = buildChapterPrompt(
      input(2, {
        priorChapters: [
          { chapter_number: 1, title: '保存済みの題1', omitted: true },
          { chapter_number: 2, title: '書き直す前の題', omitted: true },
          { chapter_number: 3, title: '後の章の題', omitted: true }
        ],
        ledgerText
      })
    )
    expect(section(user, '確定済みの本文')).toBe(
      '【確定済みの本文】\n▼ 第1章「保存済みの題1」（本文は省略。内容は【確定事項】を参照）'
    )
  })

  test('直前の章が省略なら、確定事項の続きとして書き始めさせる', () => {
    const omittedAll: PriorChapterInput[] = [
      { chapter_number: 1, title: null, omitted: true },
      { chapter_number: 2, title: null, omitted: true }
    ]
    const withLedger = section(
      buildChapterPrompt(input(3, { priorChapters: omittedAll, ledgerText })).user,
      '今回の執筆'
    )
    expect(withLedger).toContain(
      '執筆済み: 第1〜2章（第2章の本文は省略している。【確定事項】の内容の続きとして書き始める）'
    )
    // 確定事項も無ければ、資料は章立ての概要だけ
    const withoutLedger = section(buildChapterPrompt(input(3, { priorChapters: omittedAll })).user, '今回の執筆')
    expect(withoutLedger).toContain('執筆済み: 第1〜2章（第2章の本文は資料に無い。概要の続きとして書き始める）')
    // 直前の章が全文なら、それより前が省略でも、終わりから続けて書かせる
    const previousFull = section(buildChapterPrompt(input(4, { priorChapters: mixed, ledgerText })).user, '今回の執筆')
    expect(previousFull).toContain('執筆済み: 第1〜3章（第3章の終わりから続けて書く）')
  })
})

describe('buildChapterPrompt: 確定事項', () => {
  test('確定済みの本文の後、この章の登場人物の前に、渡された文面のまま置く', () => {
    const { user } = buildChapterPrompt(input(3, { ledgerText }))
    expect(headings(user)).toEqual([
      '作品情報',
      '文体・視点',
      '全体の章立て',
      '確定済みの本文',
      '確定事項',
      'この章の登場人物',
      'キャラクター間の関係',
      '今回の執筆'
    ])
    expect(user).toContain(`${chapterText(2)}\n\n${ledgerText}\n\n【この章の登場人物】\n`)
    expect(user).not.toContain('\n\n\n')
  })

  test('見出しは 1 つ (見出しつきで渡しても、見出し無しで渡しても)', () => {
    const withHeading = buildChapterPrompt(input(3, { ledgerText })).user
    const withoutHeading = buildChapterPrompt(input(3, { ledgerText: ledgerText.slice('【確定事項】\n'.length) })).user
    expect(headingCount(withHeading, '確定事項')).toBe(1)
    expect(withoutHeading).toBe(withHeading)
    // 前後の空行や CRLF があっても同じ
    expect(buildChapterPrompt(input(3, { ledgerText: `\n\n${ledgerText.replace(/\n/g, '\r\n')}\n\n` })).user).toBe(
      withHeading
    )
  })

  test("'' や空白だけ、未指定なら出さない", () => {
    const base = buildChapterPrompt(input(3)).user
    expect(headings(base)).not.toContain('確定事項')
    for (const empty of ['', '  \n\n', '【確定事項】', '【確定事項】\n\n']) {
      expect(buildChapterPrompt(input(3, { ledgerText: empty })).user).toBe(base)
    }
  })

  test('ledger.ts の renderLedger の出力をそのまま置ける', () => {
    const rendered = renderLedger(
      buildLedger([
        {
          number: 1,
          record: {
            summary: '澪が屋上でルナと出会った。',
            facts: ['屋上の鍵は朝倉澪が預かっている。'],
            characters: [
              {
                name: '朝倉澪',
                actions: ['屋上でルナに声をかけた'],
                learned: ['ルナから名前を聞いた'],
                state: '屋上にいる。'
              }
            ],
            threads_opened: [{ id: 'c1-1', description: '望遠鏡の持ち主が分からない。' }],
            threads_resolved: [],
            end_state: { time: '夜', place: '屋上', present: ['朝倉澪', 'ルナ'] }
          }
        }
      ])
    )
    expect(rendered).toStartWith('【確定事項】\n')
    const { user } = buildChapterPrompt(input(2, { ledgerText: rendered }))
    expect(headingCount(user, '確定事項')).toBe(1)
    expect(user).toContain(`\n\n${rendered}\n\n【この章の登場人物】\n`)
    expect(user).not.toContain('\n\n\n')
    // system の規則は、確定事項の中の小見出しを名前で指している。ledger.ts の文面が変わったら、規則の側も直す
    const { system } = buildChapterPrompt(input(2, { ledgerText: rendered }))
    for (const label of ['知っていること', '未回収の伏線']) {
      expect(system).toContain(`【確定事項】の「${label}」`)
      expect(rendered).toContain(label)
    }
    // renderLedger は何も無ければ '' を返す。その場合は節を出さない
    expect(headings(buildChapterPrompt(input(2, { ledgerText: renderLedger(buildLedger([])) })).user)).not.toContain(
      '確定事項'
    )
  })

  test('system は確定事項の有無で変わらない', () => {
    expect(buildChapterPrompt(input(3, { ledgerText })).system).toBe(buildChapterPrompt(input(3)).system)
    expect(buildChapterPrompt(input(1)).system).toBe(buildChapterPrompt(input(5, { ledgerText })).system)
  })

  test('前半の安定性: 確定事項が章ごとに変わっても、前の章の本文の終わりまでが次の章の先頭と一致する', () => {
    const ledgerOf = (n: number): string => `${ledgerText}\n\n■ 直前の章の終わり（第${n}章）\n- 場所: 屋上`
    for (const n of [2, 3, 4]) {
      const current = buildChapterPrompt(input(n, { ledgerText: ledgerOf(n - 1) })).user
      const next = buildChapterPrompt(input(n + 1, { ledgerText: ledgerOf(n) })).user
      const lastText = chapterText(n - 1)
      const end = current.indexOf(lastText) + lastText.length
      expect(next.startsWith(current.slice(0, end))).toBe(true)
      // 確定事項は、変わらない部分より後にある
      expect(current.indexOf('【確定事項】\n')).toBeGreaterThan(end)
    }
  })
})

describe('buildChapterPromptForStorage', () => {
  // 第 1 章は省略、第 2・3 章は全文。
  const priorChapters: PriorChapterInput[] = [
    { chapter_number: 1, title: '保存済みの題1', omitted: true },
    { chapter_number: 2, title: '保存済みの題2', content: chapterText(2) },
    { chapter_number: 3, title: null, content: `\n\n${'あ'.repeat(2254)}\n\n` }
  ]
  const storageInput = input(4, { priorChapters, ledgerText })
  const stored = buildChapterPromptForStorage(storageInput)

  test('全文の章は見出しを残し、本文を字数の 1 行に置き換える', () => {
    expect(section(stored, '確定済みの本文')).toBe(
      [
        '【確定済みの本文】',
        '▼ 第1章「保存済みの題1」（本文は省略。内容は【確定事項】を参照）',
        '',
        '▼ 第2章「保存済みの題2」',
        `（本文${chapterText(2).length}字。モデルには全文を渡し、保存では省略）`,
        '',
        '▼ 第3章',
        // 字数は前後の空行を除いて数え、3 桁で区切る
        '（本文2,254字。モデルには全文を渡し、保存では省略）'
      ].join('\n')
    )
    expect(stored).not.toContain('第2章の地の文')
    expect(stored).not.toContain('ああああ')
  })

  test('それ以外は、送るプロンプトを renderPromptForStorage したものと同じ', () => {
    const sent = renderPromptForStorage(buildChapterPrompt(storageInput))
    const replaced = sent
      .replace(chapterText(2), `（本文${chapterText(2).length}字。モデルには全文を渡し、保存では省略）`)
      .replace('あ'.repeat(2254), '（本文2,254字。モデルには全文を渡し、保存では省略）')
    expect(stored).toBe(replaced)
    // system と user の両方、確定事項、人物、今回の執筆が入っている
    expect(stored).toStartWith('===== system =====\n')
    expect(stored).toContain('\n\n===== user =====\n【作品情報】\n')
    expect(stored).toContain(`\n\n${ledgerText}\n\n【この章の登場人物】\n`)
    expect(stored).toContain('【今回の執筆】\n第4章（全5章）の本文を書く。')
    expect(stored.length).toBeLessThan(sent.length)
  })

  test('既出の章が無ければ、送るプロンプトと同じ', () => {
    const first = input(1)
    expect(buildChapterPromptForStorage(first)).toBe(renderPromptForStorage(buildChapterPrompt(first)))
  })

  test('章立てに無い章番号は throw する', () => {
    expect(() => buildChapterPromptForStorage(input(6))).toThrow('Chapter 6 not found in outline')
  })
})

// ---------------------- 本文: 登場人物 ----------------------

describe('buildChapterPrompt: 登場人物の絞り込み', () => {
  test('語り手は characters に無くても詳細が出る', () => {
    const { user } = buildChapterPrompt(input(2))
    const body = section(user, 'この章の登場人物')
    expect(body).toContain('■ 朝倉澪（17歳・女性・学生）')
    expect(body).toContain('役割: 主人公・語り手')
    expect(body).toContain('一人称: 私')
    expect(body).toContain('他者の呼び方: 苗字＋さん')
    expect(body).toContain('「そういうの、後でまとめて聞くから」')
    expect(body).toContain('■ ルナ')
    expect(body).not.toContain('柊誠')
  })

  test('関係は両端とも登場する組だけ', () => {
    const body = section(buildChapterPrompt(input(2)).user, 'キャラクター間の関係')
    expect(body).toBe(
      [
        '【キャラクター間の関係】',
        '- 朝倉澪から見たルナ: 友人。ルナへの呼び方は「名前」。屋上で出会った',
        '- ルナから見た朝倉澪: 友人。朝倉澪への呼び方は「名前＋ちゃん」'
      ].join('\n')
    )
    expect(body).not.toContain('柊誠')
  })

  test('登場しない人物は 1 行で出て、詳細は出ない', () => {
    const { user } = buildChapterPrompt(input(2))
    const body = section(user, 'この章に登場しない人物')
    const lines = body.split('\n')
    expect(lines).toHaveLength(3)
    expect(lines[1]).toContain('登場させない')
    // 登場する人物 (朝倉澪) からの呼び方の上書きだけ。登場しない人物どうしや、本人からの呼び方は出さない
    expect(lines[2]).toBe('- 柊誠（脇役）: 朝倉澪からの呼び方は「苗字＋先生」')
    expect(user).not.toContain('提出は金曜まで')
    expect(user).not.toContain('白衣に寝癖')
    expect(user).not.toContain('天文部の顧問。')
    expect(user).not.toContain('■ 柊誠')
  })

  test('全員が登場する章では、登場しない人物の節が出ない', () => {
    const { user } = buildChapterPrompt(input(3))
    expect(headings(user)).not.toContain('この章に登場しない人物')
    expect(section(user, 'この章の登場人物')).toContain('■ 柊誠（42歳・男性・教師）')
    expect(section(user, 'キャラクター間の関係')).toContain('- 柊誠から見たルナ')
  })

  test('characters が空の旧データでは全員の詳細が出て、登場しない人物の節が出ない', () => {
    const { user } = buildChapterPrompt(input(4))
    const body = section(user, 'この章の登場人物')
    expect(body).toContain('■ 朝倉澪')
    expect(body).toContain('■ ルナ')
    expect(body).toContain('■ 柊誠')
    expect(body).toContain('「提出は金曜まで、いいね」')
    expect(headings(user)).not.toContain('この章に登場しない人物')
    expect(section(user, 'キャラクター間の関係').split('\n')).toHaveLength(1 + relations.length)
    // 全員を登場させる指示と読ませない
    expect(body).toContain('出番の無い人物を無理に登場させない')
    expect(section(buildChapterPrompt(input(3)).user, 'この章の登場人物')).not.toContain('無理に登場させない')
  })

  test('characters が名簿の誰とも一致しないときは、全員を載せる', () => {
    const renamed: Outline = {
      chapters: outline.chapters.map((c) => (c.chapter_number === 2 ? { ...c, characters: ['改名前の名前'] } : c))
    }
    const { user } = buildChapterPrompt(input(2, { outline: renamed }))
    expect(section(user, 'この章の登場人物')).toContain('■ 柊誠')
    expect(headings(user)).not.toContain('この章に登場しない人物')
  })

  test('視点人物を持たない視点では、viewpointChar が残っていても全章に登場させない', () => {
    const { user } = buildChapterPrompt(input(2, { style: { ...style, pov: '三人称多元視点' } }))
    expect(section(user, 'この章の登場人物')).not.toContain('■ 朝倉澪')
    expect(section(user, 'この章に登場しない人物')).toContain('- 朝倉澪（主人公）')
  })

  test('三人称一元視点の視点人物も必ず含める', () => {
    const { user } = buildChapterPrompt(input(2, { style: { ...style, pov: '三人称一元視点' } }))
    expect(section(user, 'この章の登場人物')).toContain('役割: 主人公・視点人物')
  })

  test('語り手が名簿にいなければ、characters どおりに絞る', () => {
    const { user } = buildChapterPrompt(
      input(2, { style: { ...style, viewpointChar: { name: '名簿にいない人', first_person: '俺' } } })
    )
    expect(section(user, 'この章の登場人物')).not.toContain('■ 朝倉澪')
    expect(section(user, 'この章の登場人物')).toContain('■ ルナ')
  })
})

// 章立ての characters はモデルが取りこぼすことがある。概要に出てくる人物を「登場しない人物」として禁じない。
describe('buildChapterPrompt: 題と概要に名前が出る人物', () => {
  const chihiro: CastMember = {
    name: '霧島千尋',
    role: '相棒',
    gender: '男性',
    age: '17',
    occupation: '学生',
    appearance: '長身で眼鏡。',
    first_person: '俺',
    address_others: '苗字',
    speech_examples: ['それ、俺がやっとくよ'],
    description: '天文部の副部長。'
  }
  const wideCast: CastMember[] = [...cast, chihiro]

  // 第 2 章 (characters は「ルナ」だけ) の題と概要を差し替える。
  // 語り手を足さない視点にして、名前の照合だけで決まるようにする。
  const planned = (title: string, summary: string, members: CastMember[] = wideCast): ChapterPromptInput =>
    input(2, {
      cast: members,
      style: { ...style, pov: '三人称多元視点' },
      outline: { chapters: outline.chapters.map((c) => (c.chapter_number === 2 ? { ...c, title, summary } : c)) }
    })

  const split = (title: string, summary: string): { present: string; absent: string } => {
    const { user } = buildChapterPrompt(planned(title, summary))
    return { present: section(user, 'この章の登場人物'), absent: section(user, 'この章に登場しない人物') }
  }

  test('フルネームが概要に出る人物は、characters に無くても詳細が出る', () => {
    const { present, absent } = split('入部届', '霧島千尋が部室でルナに入部届を渡す。')
    expect(present).toContain('■ 霧島千尋（17歳・男性・学生）')
    expect(present).toContain('「それ、俺がやっとくよ」')
    expect(absent).not.toContain('- 霧島千尋')
    // 概要に出てこない人物は、登場しない人物のまま
    expect(present).not.toContain('■ 朝倉澪')
    expect(absent).toContain('- 朝倉澪（主人公）')
    expect(absent).toContain('- 柊誠（脇役）')
  })

  test('名だけ、姓だけでも拾う', () => {
    for (const summary of ['千尋がルナに入部届を渡す。', '霧島がルナに入部届を渡す。']) {
      const { present, absent } = split('入部届', summary)
      expect(present).toContain('■ 霧島千尋')
      expect(absent).not.toContain('- 霧島千尋')
    }
  })

  test('題に名前が出る人物も拾う', () => {
    const { present, absent } = split('千尋の提案', 'ルナが天文部に入りたいと言い出す。')
    expect(present).toContain('■ 霧島千尋')
    expect(absent).not.toContain('- 霧島千尋')
  })

  test('漢字 3 字の名前は、先頭の 2 字でも拾う', () => {
    const { present, absent } = split('入部届', '朝倉がルナを部室へ案内する。')
    expect(present).toContain('■ 朝倉澪')
    // 行頭で確かめる (名前は、登場する人物からの呼び方として他の人物の行にも出る)
    expect(absent).not.toContain('- 朝倉澪')
    expect(absent).toContain('- 柊誠（脇役）: 朝倉澪からの呼び方は「苗字＋先生」')
  })

  test('拾った人物は関係にも含める', () => {
    const { user } = buildChapterPrompt(planned('入部届', '朝倉澪がルナを部室へ案内する。'))
    expect(section(user, 'キャラクター間の関係')).toContain('- 朝倉澪から見たルナ: 友人')
    expect(section(user, 'キャラクター間の関係')).not.toContain('柊誠')
  })

  test('1 字の姓や名、かなの名前の一部では拾わない', () => {
    // 「柊」「澪」は一般の語と見分けられない。「かぐや」は「かぐわしい」に一致させない
    const kaguya: CastMember = { ...runa, name: 'かぐや', role: '脇役' }
    const { user } = buildChapterPrompt(
      planned('入部届', '柊と澪が、かぐわしい香りの部室でルナを待つ。', [...wideCast, kaguya])
    )
    const present = section(user, 'この章の登場人物')
    const absent = section(user, 'この章に登場しない人物')
    expect(present).toContain('■ ルナ')
    for (const name of ['柊誠', '朝倉澪', 'かぐや', '霧島千尋']) {
      expect(present).not.toContain(`■ ${name}`)
      expect(absent).toContain(`- ${name}`)
    }
  })

  test('登場しない人物の節は、概要に基づく指示で、概要を優先すると伝える', () => {
    const { absent } = split('入部届', 'ルナが天文部に入りたいと言い出す。')
    expect(absent.split('\n')[1]).toBe(
      '次の人物は、この章の概要に出てこないので、場面に登場させない（概要に出てくる人物がいれば、概要に従う）。会話で話題に出るときは、下の呼び方（指定が無ければ話し手の「他者の呼び方」）で呼ぶ。'
    )
  })
})

describe('buildChapterPrompt: 人物の表示', () => {
  test('一人称が「自分の名前」の人物は、名前で呼ぶと表示する', () => {
    const { user } = buildChapterPrompt(input(2))
    const body = section(user, 'この章の登場人物')
    expect(body).toContain('一人称: 代名詞を使わず、自分を「ルナ」と名前で呼ぶ')
    expect(body).not.toContain(FIRST_PERSON_AS_NAME)
  })

  test('語り手の一人称が「自分の名前」のときの視点の文面', () => {
    const { user } = buildChapterPrompt(
      input(2, { style: { ...style, viewpointChar: { name: 'ルナ', first_person: FIRST_PERSON_AS_NAME } } })
    )
    expect(section(user, '文体・視点')).toContain(
      '視点: 『ルナ』の一人称視点で、地の文の主語は『ルナ』を用いる(一人称代名詞は使わず、自分自身を「ルナ」と名前で呼ぶ独特な語り口)'
    )
  })

  test('空の項目は行ごと出さず、年齢が数字だけなら「歳」を付ける', () => {
    const body = section(buildChapterPrompt(input(2)).user, 'この章の登場人物')
    expect(body).toContain('■ ルナ（女性）')
    expect(body).toContain('■ 朝倉澪（17歳・女性・学生）')
    // 背景の空行は詰める (節の区切りと紛れないように)
    expect(body).toContain('  背景: 天文部の部長。\n    段取りを決めてから動く。')
  })

  test('口調の例は見本として渡し、例文を使わない規則は system に書く', () => {
    const { system, user } = buildChapterPrompt(input(2))
    expect(section(user, 'この章の登場人物')).toContain(
      '口調の例（話し方の見本）:\n    「ルナはね、流れ星を数えるのが好きなの！」'
    )
    expect(system).toContain('「口調の例」は語尾・調子・口癖の見本')
    expect(system).toContain('例文そのものは本文に使わない')
    // 規則の側に、人物の例文を引用しない
    expect(system).not.toContain('流れ星')
  })
})

// ---------------------- 本文: 今回の執筆と規則 ----------------------

describe('buildChapterPrompt: 今回の執筆', () => {
  test('章番号、全章数、執筆済みの範囲、これからの範囲、題、概要、分量', () => {
    const body = section(buildChapterPrompt(input(3)).user, '今回の執筆')
    expect(body).toBe(
      [
        '【今回の執筆】',
        '第3章（全5章）の本文を書く。',
        '- 執筆済み: 第1〜2章（第2章の終わりから続けて書く）',
        '- この後の章: 第4〜5章（この章では書かない。物語は途中なので、章末で締めくくらない）',
        '- 題: 顧問の条件',
        '- 概要: 柊が入部の条件を出す。',
        '- 分量: 約4,000字。概要の範囲を4場面程度に分け、1場面あたり約1,000字を目安に書く。場面を端折って短く終えない。'
      ].join('\n')
    )
  })

  test('最終章とそれ以外で指示が変わる', () => {
    const middle = section(buildChapterPrompt(input(4)).user, '今回の執筆')
    const last = section(buildChapterPrompt(input(5)).user, '今回の執筆')
    expect(middle).toContain('この後の章: 第5章（この章では書かない。物語は途中なので、章末で締めくくらない）')
    expect(middle).not.toContain('最終章')
    expect(last).toContain('この後の章: なし（この章が最終章。結末まで書き切る）')
    expect(last).not.toContain('物語は途中')
    expect(last).toContain('執筆済み: 第1〜4章')
  })

  test('第 1 章は書き出しとして指示する', () => {
    const body = section(buildChapterPrompt(input(1)).user, '今回の執筆')
    expect(body).toContain('第1章（全5章）の本文を書く。')
    expect(body).toContain('- 執筆済み: なし（この章が物語の書き出し）')
    expect(body).toContain('- この後の章: 第2〜5章')
  })

  test('全 1 章の作品は、書き出しであり最終章', () => {
    const single: Outline = { chapters: [{ chapter_number: 1, title: '一夜', summary: '一晩の話。', characters: [] }] }
    const body = section(buildChapterPrompt(input(1, { outline: single })).user, '今回の執筆')
    expect(body).toContain('第1章（全1章）の本文を書く。')
    expect(body).toContain('執筆済み: なし')
    expect(body).toContain('この章が最終章')
  })

  test('分量は場面数に直して指示する', () => {
    const body = section(buildChapterPrompt(input(2, { targetChars: 20000 })).user, '今回の執筆')
    expect(body).toContain('約20,000字。概要の範囲を8場面程度に分け、1場面あたり約2,500字')
  })

  test('章立ての一覧は並べ替えず、番号順に全章を載せる', () => {
    const shuffled: Outline = { chapters: [...outline.chapters].reverse() }
    const a = section(buildChapterPrompt(input(3)).user, '全体の章立て')
    const b = section(buildChapterPrompt(input(3, { outline: shuffled })).user, '全体の章立て')
    expect(a).toBe(b)
    expect(a.split('\n').slice(1)).toEqual([
      '第1章「屋上の少女」: 澪が屋上でルナと出会う。',
      '第2章「入部届」: ルナが天文部に入りたいと言い出す。',
      '第3章「顧問の条件」: 柊が入部の条件を出す。',
      '第4章「準備」: 観測会の準備を進める。',
      '第5章「流星群の夜」: 観測会の夜、約束を果たす。'
    ])
  })

  test('章立てに無い章番号は throw する', () => {
    expect(() => buildChapterPrompt(input(6))).toThrow('Chapter 6 not found in outline')
  })
})

describe('buildChapterPrompt: system の規則', () => {
  const { system } = buildChapterPrompt(input(2))

  test('章の境界', () => {
    expect(system).toContain('後の章に割り当てられた出来事には入らない')
    expect(system).toContain('直前の章が終わったところから続けて書き始める')
    expect(system).toContain('前の章の出来事を要約し直さない')
    expect(system).toContain('既に書かれた場面、説明、言い回しを繰り返さない')
    expect(system).toContain('変わった後の状態を引き継ぐ')
    expect(system).toContain('物語全体を総括したり、決意や希望の独白で締めくくったりしない')
    expect(system).toContain('前の章と同じ言い回しで締めない')
    expect(system).toContain('最終章は、結末まで書き切る')
  })

  test('確定事項: 本文と同じく確定している。食い違うときは 本文 > 確定事項 > 概要', () => {
    expect(system).toContain(
      '【確定事項】は、ここまでの本文から抜き出した記録である。本文と同じく確定していて、矛盾させない'
    )
    expect(system).toContain('本文を省略した章については、これが資料になる')
    expect(system).toContain('【全体の章立て】の概要や【確定事項】が確定済みの本文と食い違うときは、本文を正とする')
    expect(system).toContain('概要と【確定事項】が食い違うときは、【確定事項】を正とする')
  })

  test('確定事項: 知っていることは抜粋。知っているはずのことを忘れさせず、居合わせていない出来事を知らせない', () => {
    expect(system).toContain('その人物が既に知っていることの抜粋で、全部ではない')
    expect(system).toContain('挙がっていることは、知っている前提で書く')
    expect(system).toContain(
      '人物が居合わせていない場面の出来事は、誰かから聞く、自分で気づくといった描写なしに、その人物が知っている前提で書かない'
    )
    // 「一覧に無いことは知らない」とは読ませない (当然知っていることまで知らない扱いになる)
    expect(system).not.toMatch(/(?:挙がっていない|一覧に無い|書かれていない)ことは[^。]*知らない/)
  })

  test('確定事項: 未回収の伏線は、概要に関わるものだけ', () => {
    expect(system).toContain('「未回収の伏線」は、【今回の執筆】の概要に関わるものだけを扱う')
    expect(system).toContain('関わらないものを、この章で無理に回収しない')
  })

  test('人物', () => {
    expect(system).toContain('一人称は各人物の設定どおり')
    expect(system).toContain('関係に呼び方の指定があればそれを使い、無ければその人物の「他者の呼び方」に従う')
    expect(system).toContain('呼び方の「名前」「苗字」は型を表す')
  })

  test('表記', () => {
    expect(system).toContain('段落の頭は全角空白1つで字下げする')
    expect(system).toContain('「 で始まる会話文の行は字下げしない')
    expect(system).toContain('全角空白を1つ入れる。閉じ括弧の直前')
    expect(system).toContain('三点リーダは「……」、ダッシュは「――」')
  })

  test('出力は本文のみ', () => {
    expect(system).toContain('本文だけ')
    expect(system).toContain('章番号、タイトル、場面の見出し、前書き、後書き、注釈は含めない')
  })
})

describe('buildChapterPrompt: 視点・文体・年齢指定', () => {
  test('今の文言を引き継ぎ、結末と備考は渡さない', () => {
    const { system, user } = buildChapterPrompt(input(2))
    expect(section(user, '文体・視点')).toBe(
      [
        '【文体・視点】',
        '視点: 『朝倉澪』(一人称「私」)の一人称視点で、地の文は語り手の主観で執筆',
        '文体: 口語的で軽快なライトノベル調の文体',
        '年齢指定: 性的描写・過度な暴力描写を含めず、誰でも読める内容に留めること'
      ].join('\n')
    )
    expect(`${system}\n${user}`).not.toContain('結末:')
    expect(user).not.toContain('流星群の夜を入れる')
    expect(user).not.toContain('屋上の観測記録')
  })

  test('視点ごとの文面', () => {
    const povOf = (overrides: Partial<StyleParams>): string =>
      section(buildChapterPrompt(input(2, { style: { ...style, ...overrides } })).user, '文体・視点').split('\n')[1]
    expect(povOf({ viewpointChar: undefined })).toBe('視点: 主人公の一人称視点で執筆')
    expect(povOf({ pov: '三人称一元視点' })).toBe('視点: 『朝倉澪』に寄り添う三人称一元視点で執筆')
    expect(povOf({ pov: '三人称一元視点', viewpointChar: undefined })).toBe('視点: 三人称一元視点で執筆')
    expect(povOf({ pov: '三人称多元視点' })).toBe('視点: 複数キャラの視点を切り替える三人称多元視点')
    expect(povOf({ pov: '三人称神視点' })).toBe('視点: 全知の三人称(神視点)')
  })

  test('知らない文体は一般文芸、年齢指定が無ければ行ごと出さない', () => {
    const body = section(
      buildChapterPrompt(input(2, { style: { pov: '三人称神視点', tone: '未知の文体' } })).user,
      '文体・視点'
    )
    expect(body).toBe('【文体・視点】\n視点: 全知の三人称(神視点)\n文体: 標準的な一般文芸の文体')
  })

  test('R15 / R18 は成人の読み替えの文面を渡す', () => {
    const ratingOf = (age_rating: string): string =>
      section(buildChapterPrompt(input(2, { style: { ...style, age_rating } })).user, '文体・視点')
    expect(ratingOf('R15')).toContain('年齢指定: 物語の登場人物はすべて 18 歳以上の成人とする。')
    expect(ratingOf('R15')).toContain('性器を指す放送禁止用語 (露骨な俗語) の使用は禁止。')
    expect(ratingOf('R18')).toContain('年齢指定: 成人向け。物語の登場人物はすべて 18 歳以上の成人とする。')
  })
})

// ---------------------- 章立て ----------------------

describe('buildOutlinePrompt', () => {
  const prompt = buildOutlinePrompt({ novel, style, cast, relations })

  test('名簿の名前と章数が入る', () => {
    expect(prompt.user).toContain('章数: 5')
    expect(prompt.user).toContain('全5章の章立てを作る。chapter_number は1〜5。')
    expect(prompt.user).toContain('名簿（characters に使える名前）: 朝倉澪、ルナ、柊誠')
    expect(prompt.user).toContain('summary は各章300字程度。')
  })

  test('連番、空にしない、名簿の表記と完全に一致、の規則が system にある', () => {
    expect(prompt.system).toContain('章数ちょうどの章を作る')
    expect(prompt.system).toContain('chapter_number は1から章数までの連番にする')
    expect(prompt.system).toContain('どちらも空にしない')
    expect(prompt.system).toContain('名簿の表記と完全に一致させる')
    expect(prompt.system).toContain('"chapters": [')
    expect(prompt.system).toContain('"characters": [')
  })

  test('資料の並びと、結末・備考', () => {
    expect(headings(prompt.user)).toEqual([
      '作品情報',
      '文体・視点',
      '登場人物',
      'キャラクター間の関係',
      '物語に取り込みたい要素',
      '今回の依頼'
    ])
    expect(section(prompt.user, '文体・視点')).toContain(
      '結末: 主要な葛藤が解決し、登場人物が報われる前向きな結末へ向けて構成すること'
    )
    expect(section(prompt.user, '物語に取り込みたい要素')).toContain('- 流星群の夜を入れる')
    // 章立てには全員の詳細を渡す
    expect(section(prompt.user, '登場人物')).toContain('■ 柊誠（42歳・男性・教師）')
    expect(prompt.user).not.toContain('\n\n\n')
  })

  test('結末が未指定なら行を出さない', () => {
    const { user } = buildOutlinePrompt({ novel, style: { ...style, ending: '未指定' }, cast, relations })
    expect(user).not.toContain('結末:')
  })

  // OpenAI 互換の json_object モードは、入力 (user) に「json」の語が無い要求を拒否する。system は数えられない。
  test('user に「JSON」の語がある', () => {
    expect(prompt.user).toMatch(/json/i)
    expect(section(prompt.user, '今回の依頼').split('\n').at(-1)).toBe('- 出力は JSON だけにする。')
    expect(buildOutlinePrompt({ novel, style, cast: [], relations: [] }).user).toMatch(/json/i)
  })

  test('名簿が空なら characters に触れない', () => {
    const empty = buildOutlinePrompt({ novel: { ...novel, notes: '  ' }, style, cast: [], relations: [] })
    expect(empty.system).not.toContain('characters')
    expect(empty.user).not.toContain('characters')
    expect(headings(empty.user)).toEqual(['作品情報', '文体・視点', '今回の依頼'])
  })

  test('system は作品の内容を含まない', () => {
    expect(prompt.system).not.toContain('朝倉澪')
    expect(prompt.system).not.toContain('天文部')
  })
})

describe('buildOutlineChapterPrompt', () => {
  const prompt = buildOutlineChapterPrompt({ novel, style, cast, relations, existing: outline, chapterNumber: 3 })

  test('他の章を固定の資料として渡し、書き直す章を分けて示す', () => {
    expect(headings(prompt.user)).toEqual([
      '作品情報',
      '文体・視点',
      '登場人物',
      'キャラクター間の関係',
      '物語に取り込みたい要素',
      '他の章',
      '書き直す章',
      '今回の依頼'
    ])
    const others = section(prompt.user, '他の章')
    expect(others).toContain('第2章「入部届」')
    expect(others).toContain('第4章「準備」')
    expect(others).not.toContain('顧問の条件')
    expect(section(prompt.user, '書き直す章')).toBe('【書き直す章】\n第3章「顧問の条件」: 柊が入部の条件を出す。')
  })

  test('章番号、概要の字数、名簿の名前が入る', () => {
    const request = section(prompt.user, '今回の依頼')
    expect(request).toContain('第3章を書き直す。chapter_number は3のまま。')
    expect(request).toContain('summary は300字程度。')
    expect(request).toContain('名簿（characters に使える名前）: 朝倉澪、ルナ、柊誠')
    expect(prompt.system).toContain('"chapter_number": 3')
    expect(prompt.system).toContain('前後の章と矛盾しない内容にする')
    expect(prompt.system).toContain('異なる切り口・展開を提案してよい')
    expect(prompt.system).toContain('名簿の表記と完全に一致させる')
  })

  // OpenAI 互換の json_object モードは、入力 (user) に「json」の語が無い要求を拒否する。system は数えられない。
  test('user に「JSON」の語がある', () => {
    expect(prompt.user).toMatch(/json/i)
    expect(section(prompt.user, '今回の依頼').split('\n').at(-1)).toBe('- 出力は JSON だけにする。')
    const bare = buildOutlineChapterPrompt({
      novel,
      style,
      cast: [],
      relations: [],
      existing: { chapters: [] },
      chapterNumber: 1
    })
    expect(bare.user).toMatch(/json/i)
  })

  test('章立てに無い章番号は、新しく作る章として扱う', () => {
    const added = buildOutlineChapterPrompt({ novel, style, cast, relations, existing: outline, chapterNumber: 6 })
    expect(section(added.user, '書き直す章')).toBe('【書き直す章】\n第6章（まだ内容が無い。新しく作る）')
    expect(section(added.user, '他の章').split('\n')).toHaveLength(1 + outline.chapters.length)
  })

  test('他の章が無ければ節を出さない', () => {
    const single: Outline = { chapters: [{ chapter_number: 1, title: '一夜', summary: '一晩の話。', characters: [] }] }
    const only = buildOutlineChapterPrompt({
      novel,
      style,
      cast: [],
      relations: [],
      existing: single,
      chapterNumber: 1
    })
    expect(headings(only.user)).toEqual([
      '作品情報',
      '文体・視点',
      '物語に取り込みたい要素',
      '書き直す章',
      '今回の依頼'
    ])
    expect(only.system).not.toContain('characters')
  })
})
