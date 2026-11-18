import { describe, expect, test } from 'bun:test'
import { buildLedger, renderLedger } from '@/lib/novel/ledger'
import { OUTLINE_PLAN_LIMITS, outlineChapterJsonSchema, outlineJsonSchema } from '@/lib/novel/outline'
import {
  buildChapterPrompt,
  buildChapterPromptForStorage,
  buildOutlineChapterPrompt,
  buildOutlinePrompt,
  type CastMember,
  type CastRelation,
  type ChapterPromptInput,
  charsPerEvent,
  type NovelParams,
  OUTLINE_EVENTS_MAX,
  OUTLINE_EVENTS_MIN,
  type PriorChapterInput,
  type PriorChapterText,
  renderPromptForStorage,
  type StyleParams,
  sceneGuide
} from '@/lib/novel/prompts'
import { FIRST_PERSON_AS_NAME } from '@/schemas/character.dto'
import { type Outline, type OutlineChapter, OutlineChapterSchema } from '@/schemas/novel.dto'
import type { StoryBible } from '@/schemas/story.dto'

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

// 章立ての 1 章。計画の項目 (出来事など) は、指定が無ければ空 (この項目より前に作られた章立てと同じ)。
const ch = (
  chapter: Pick<OutlineChapter, 'chapter_number' | 'title' | 'summary' | 'characters'> & Partial<OutlineChapter>
): OutlineChapter => ({ events: [], time_place: '', end_state: '', setups: [], payoffs: [], ...chapter })

// 計画の無い章立て (旧データ)。第 2 章は語り手 (朝倉澪) が characters から漏れている。第 4 章は characters が空。
const outline: Outline = {
  chapters: [
    ch({ chapter_number: 1, title: '屋上の少女', summary: '澪が屋上でルナと出会う。', characters: ['朝倉澪', 'ルナ'] }),
    ch({ chapter_number: 2, title: '入部届', summary: 'ルナが天文部に入りたいと言い出す。', characters: ['ルナ'] }),
    ch({
      chapter_number: 3,
      title: '顧問の条件',
      summary: '柊が入部の条件を出す。',
      characters: ['朝倉澪', 'ルナ', '柊誠']
    }),
    ch({ chapter_number: 4, title: '準備', summary: '観測会の準備を進める。', characters: [] }),
    ch({
      chapter_number: 5,
      title: '流星群の夜',
      summary: '観測会の夜、約束を果たす。',
      characters: ['朝倉澪', 'ルナ']
    })
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
    const single: Outline = {
      chapters: [ch({ chapter_number: 1, title: '一夜', summary: '一晩の話。', characters: [] })]
    }
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

// ---------------------- 本文: 作品設計と章の計画 (Phase 3) ----------------------

const bible: StoryBible = {
  premise: '朝倉澪は廃部寸前の天文部を、流星群の観測会で立て直そうとするが、部員が足りない。',
  ending: '観測会の夜、屋上で流星群を見上げながら、ルナが部員の名簿に名前を書く。',
  arcs: [
    { name: '朝倉澪', start: '一人で部を背負い込んでいる。', end: '部員に仕事を任せられるようになる。' },
    // 始まりも終わりも空の行は出さない
    { name: 'ルナ', start: '', end: '' }
  ],
  world: {
    rules: ['屋上の鍵は、顧問の許可が無いと借りられない。'],
    terms: [
      { term: '観測会', note: '年に一度、屋上で開く公開の行事。' },
      { term: '星図盤', note: '' }
    ]
  },
  timeline: ['10月上旬: ルナが屋上に現れる。', '10月21日: 流星群の夜。'],
  addresses: [
    { from: '朝倉澪', to: 'ルナ', call: 'ルナ' },
    { from: 'ルナ', to: '朝倉澪', call: 'ミオちゃん' },
    { from: '朝倉澪', to: '柊誠', call: '柊先生' },
    { from: '柊誠', to: '朝倉澪', call: '朝倉' },
    { from: 'ルナ', to: '柊誠', call: 'せんせー' },
    { from: '柊誠', to: 'ルナ', call: 'ルナ君' }
  ],
  cast: []
}

// 計画つきの章立て。第 3 章は出来事が無く回収だけ、第 4 章は計画が無い (1 章だけ書き直した旧データを想定)。
// 第 2 章は characters が「ルナ」だけで、出来事に柊誠が出る。第 5 章は章立てに無い id (s9) を回収に挙げている。
const plannedOutline: Outline = {
  chapters: [
    ch({
      chapter_number: 1,
      title: '屋上の少女',
      summary: '朝倉澪が屋上でルナと出会う。',
      characters: ['朝倉澪', 'ルナ'],
      time_place: '10月上旬の夜、高校の屋上',
      events: ['朝倉澪が屋上で望遠鏡を調整する。', 'ルナが望遠鏡の前に現れる。', '朝倉澪がルナに天文部の話をする。'],
      end_state: '夜、屋上。朝倉澪とルナが並んで空を見ている。',
      setups: [{ id: 's1', description: '屋上の望遠鏡の持ち主が分からない。' }]
    }),
    ch({
      chapter_number: 2,
      title: '入部届',
      summary: 'ルナが天文部に入りたいと言い出す。',
      characters: ['ルナ'],
      time_place: '翌日の放課後、部室',
      events: ['ルナが部室に来て、入部したいと言う。', '柊誠が入部届の用紙を持ってくる。'],
      end_state: '夕方、部室。ルナが入部届を書きかけている。',
      setups: [{ id: 's2', description: 'ルナは入部届の住所の欄を空けたままにする。' }]
    }),
    ch({
      chapter_number: 3,
      title: '顧問の条件',
      summary: '入部の条件が出る。',
      characters: ['朝倉澪', 'ルナ', '柊誠'],
      payoffs: ['s1']
    }),
    ch({ chapter_number: 4, title: '準備', summary: '観測会の準備を進める。', characters: [] }),
    ch({
      chapter_number: 5,
      title: '流星群の夜',
      summary: '観測会の夜、約束を果たす。',
      characters: ['朝倉澪', 'ルナ'],
      time_place: '10月21日の夜、屋上',
      events: ['朝倉澪とルナが屋上に機材を運ぶ。', '流星群が始まる。', 'ルナが部員の名簿に名前を書く。'],
      end_state: '深夜、屋上。朝倉澪とルナが流星群を見上げている。',
      payoffs: ['s2', 's9']
    })
  ]
}

const writingNotes = '- 星の名前は和名で書く。\n\n- 回想は入れない。\n'

// 作品設計と計画つきの入力。
const planned = (chapterNumber: number, overrides: Partial<ChapterPromptInput> = {}): ChapterPromptInput =>
  input(chapterNumber, { outline: plannedOutline, bible, writingNotes, ...overrides })

describe('buildChapterPrompt: 作品設計・呼称表・執筆上の指示', () => {
  test('前半の並び: 作品設計 → 呼称表 → 執筆上の指示 → 全体の章立て → 確定済みの本文', () => {
    expect(headings(buildChapterPrompt(planned(2)).user)).toEqual([
      '作品情報',
      '文体・視点',
      '作品設計',
      '呼称表',
      '執筆上の指示',
      '全体の章立て',
      '確定済みの本文',
      'この章の登場人物',
      'キャラクター間の関係',
      '今回の執筆'
    ])
    expect(buildChapterPrompt(planned(2)).user).not.toContain('\n\n\n')
  })

  test('作品設計: 物語の核、結末、人物の変化、世界のルール、用語、時系列。空の項目は出さない', () => {
    expect(section(buildChapterPrompt(planned(2)).user, '作品設計')).toBe(
      [
        '【作品設計】',
        '物語の核: 朝倉澪は廃部寸前の天文部を、流星群の観測会で立て直そうとするが、部員が足りない。',
        '結末: 観測会の夜、屋上で流星群を見上げながら、ルナが部員の名簿に名前を書く。',
        '人物の変化:',
        '- 朝倉澪',
        '  始まり: 一人で部を背負い込んでいる。',
        '  終わり: 部員に仕事を任せられるようになる。',
        '世界のルール:',
        '- 屋上の鍵は、顧問の許可が無いと借りられない。',
        '用語:',
        '- 観測会: 年に一度、屋上で開く公開の行事。',
        '- 星図盤',
        '時系列:',
        '- 10月上旬: ルナが屋上に現れる。',
        '- 10月21日: 流星群の夜。'
      ].join('\n')
    )
  })

  test('呼称表: 全ての組を「呼ぶ人 → 呼ばれる人: 呼び方」で載せる (章ごとに絞らない)', () => {
    const expected = [
      '【呼称表】',
      '「呼ぶ人 → 呼ばれる人: 呼び方」の表。',
      '- 朝倉澪 → ルナ: ルナ',
      '- ルナ → 朝倉澪: ミオちゃん',
      '- 朝倉澪 → 柊誠: 柊先生',
      '- 柊誠 → 朝倉澪: 朝倉',
      '- ルナ → 柊誠: せんせー',
      '- 柊誠 → ルナ: ルナ君'
    ].join('\n')
    // 柊誠が登場しない第 1 章でも、同じ表を載せる
    expect(section(buildChapterPrompt(planned(1)).user, '呼称表')).toBe(expected)
    expect(section(buildChapterPrompt(planned(3)).user, '呼称表')).toBe(expected)
  })

  test('呼称表: 空の行と、同じ組の 2 行目は載せない', () => {
    const { user } = buildChapterPrompt(
      planned(2, {
        bible: {
          ...bible,
          addresses: [
            { from: '朝倉澪', to: 'ルナ', call: ' ルナ ' },
            { from: '朝倉澪', to: 'ルナ', call: 'ルナさん' },
            { from: 'ルナ', to: '朝倉澪', call: '  ' }
          ]
        }
      })
    )
    expect(section(user, '呼称表')).toBe('【呼称表】\n「呼ぶ人 → 呼ばれる人: 呼び方」の表。\n- 朝倉澪 → ルナ: ルナ')
  })

  test('執筆上の指示: 空行を詰めて載せる。空なら節を出さない', () => {
    expect(section(buildChapterPrompt(planned(2)).user, '執筆上の指示')).toBe(
      '【執筆上の指示】\n- 星の名前は和名で書く。\n- 回想は入れない。'
    )
    for (const empty of [undefined, '', '  \n\n']) {
      const { system, user } = buildChapterPrompt(planned(2, { writingNotes: empty }))
      expect(headings(user)).not.toContain('執筆上の指示')
      expect(system).not.toContain('執筆上の指示')
    }
  })

  test('作品設計が無い、または中身が空なら、節を出さない', () => {
    const emptyBible: StoryBible = {
      premise: '',
      ending: ' ',
      arcs: [],
      world: { rules: [], terms: [] },
      timeline: [],
      addresses: [],
      cast: []
    }
    for (const none of [undefined, null, emptyBible]) {
      const { system, user } = buildChapterPrompt(planned(2, { bible: none }))
      expect(headings(user)).not.toContain('作品設計')
      expect(headings(user)).not.toContain('呼称表')
      expect(system).not.toContain('作品設計')
      expect(system).not.toContain('呼称表')
    }
  })

  test('全体の章立て: 章末の状況を 1 行添える。出来事の一覧は載せない', () => {
    const body = section(buildChapterPrompt(planned(2)).user, '全体の章立て')
    expect(body.split('\n').slice(1)).toEqual([
      '第1章「屋上の少女」: 朝倉澪が屋上でルナと出会う。',
      '  章末の状況: 夜、屋上。朝倉澪とルナが並んで空を見ている。',
      '第2章「入部届」: ルナが天文部に入りたいと言い出す。',
      '  章末の状況: 夕方、部室。ルナが入部届を書きかけている。',
      '第3章「顧問の条件」: 入部の条件が出る。',
      '第4章「準備」: 観測会の準備を進める。',
      '第5章「流星群の夜」: 観測会の夜、約束を果たす。',
      '  章末の状況: 深夜、屋上。朝倉澪とルナが流星群を見上げている。'
    ])
    // 後の章の出来事を先取りさせないよう、出来事は今回の章の分だけを【今回の執筆】に出す
    expect(body).not.toContain('機材を運ぶ')
    expect(buildChapterPrompt(planned(2)).user).not.toContain('機材を運ぶ')
  })

  test('前半の安定性: 作品設計つきでも、前の章の本文の終わりまでが次の章の先頭と一致する', () => {
    for (const n of [2, 3, 4]) {
      const current = buildChapterPrompt(planned(n)).user
      const next = buildChapterPrompt(planned(n + 1)).user
      const lastText = chapterText(n - 1)
      const end = current.indexOf(lastText) + lastText.length
      expect(current.indexOf(lastText)).toBeGreaterThan(0)
      expect(next.startsWith(current.slice(0, end))).toBe(true)
    }
    // 第 1 章の「全体の章立て」までが、第 2 章の先頭と一致する
    const first = buildChapterPrompt(planned(1)).user
    const stable = first.slice(0, first.indexOf('\n\n【この章の登場人物】'))
    expect(stable).toContain('【呼称表】')
    expect(buildChapterPrompt(planned(2)).user.startsWith(`${stable}\n\n【確定済みの本文】\n`)).toBe(true)
  })

  test('system は章が変わっても同じ (出来事の無い章、計画の無い章でも)', () => {
    const second = buildChapterPrompt(planned(2)).system
    for (const n of [1, 3, 4, 5]) {
      expect(buildChapterPrompt(planned(n)).system).toBe(second)
    }
    expect(second).not.toMatch(/第\s*[0-9０-９]+\s*章/)
    expect(second).not.toContain('朝倉澪')
    expect(second).not.toContain('入部届')
  })

  test('保存用にも、作品設計と計画が入る', () => {
    const stored = buildChapterPromptForStorage(planned(2))
    expect(stored).toContain('【作品設計】\n物語の核: ')
    expect(stored).toContain('【呼称表】\n')
    expect(stored).toContain('- 出来事（この順に、すべてを場面として書く）:')
  })
})

describe('buildChapterPrompt: 呼称表があるときの呼び方', () => {
  test('「他者の呼び方」の行と、関係の「呼び方は」を出さない (呼称表に 1 本化)', () => {
    const { system, user } = buildChapterPrompt(planned(3))
    expect(section(user, 'この章の登場人物')).not.toContain('他者の呼び方')
    expect(section(user, 'キャラクター間の関係')).toBe(
      [
        '【キャラクター間の関係】',
        '- 朝倉澪から見たルナ: 友人。屋上で出会った',
        '- ルナから見た朝倉澪: 友人',
        '- 朝倉澪から見た柊誠: 教師。部の顧問',
        '- 柊誠から見たルナ: 教え子'
      ].join('\n')
    )
    expect(system).toContain('相手の呼び方は【呼称表】のとおりにする。表に無い相手は、関係と人物像に合わせて呼ぶ。')
    expect(system).not.toContain('他者の呼び方')
    expect(system).not.toContain('型を表す')
  })

  test('呼称表に無い組が残る人物だけ、「他者の呼び方」の行を残す', () => {
    // 柊誠 ⇔ ルナ の組が無い呼称表 (人物が多い作品では、関係を定義した組と語り手との組だけになる)
    const partial: StoryBible = {
      ...bible,
      addresses: bible.addresses.filter((row) => !(row.from !== '朝倉澪' && row.to !== '朝倉澪'))
    }
    const { system, user } = buildChapterPrompt(planned(3, { bible: partial }))
    const people = section(user, 'この章の登場人物')
    // 朝倉澪は、登場する相手への呼び方が全部表にある
    expect(people).toContain('■ 朝倉澪（17歳・女性・学生）\n  役割: 主人公・語り手\n  一人称: 私\n  外見: ')
    expect(people).toContain('  他者の呼び方: 名前')
    expect(people).toContain('  他者の呼び方: 苗字')
    expect(people).not.toContain('他者の呼び方: 苗字＋さん')
    // 表に無い組の関係は、呼び方の指定を残す
    const relationLines = section(user, 'キャラクター間の関係')
    expect(relationLines).toContain('- 柊誠から見たルナ: 教え子。ルナへの呼び方は「苗字＋さん」')
    expect(relationLines).toContain('- 朝倉澪から見たルナ: 友人。屋上で出会った')
    expect(system).toContain(
      '相手の呼び方は【呼称表】のとおりにする。表に無い相手は、関係に呼び方の指定があればそれを使い、無ければその人物の「他者の呼び方」に従う。'
    )
    expect(system).toContain('呼び方の「名前」「苗字」は型を表す')
    // 表に無い組の人物が登場しない章でも、system は同じ (作品単位で決まる)
    expect(buildChapterPrompt(planned(1, { bible: partial })).system).toBe(system)
    // その章では、登場する二人の組が表にあるので、行は出ない
    expect(section(buildChapterPrompt(planned(1, { bible: partial })).user, 'この章の登場人物')).not.toContain(
      '他者の呼び方'
    )
  })

  test('登場しない人物の呼び方は、呼称表から引く', () => {
    const body = section(buildChapterPrompt(planned(1)).user, 'この章に登場しない人物')
    expect(body).toBe(
      [
        '【この章に登場しない人物】',
        '次の人物は、この章の概要と出来事に出てこないので、場面に登場させない（概要と出来事に出てくる人物がいれば、概要と出来事に従う）。会話で話題に出るときは、下の呼び方（【呼称表】のとおり）で呼ぶ。',
        '- 柊誠（脇役）: 朝倉澪からの呼び方は「柊先生」、ルナからの呼び方は「せんせー」'
      ].join('\n')
    )
  })

  test('登場しない人物: 呼称表に無い組は、関係の呼び方の指定を使う', () => {
    const partial: StoryBible = { ...bible, addresses: bible.addresses.filter((row) => row.to !== '柊誠') }
    const body = section(buildChapterPrompt(planned(1, { bible: partial })).user, 'この章に登場しない人物')
    expect(body.split('\n')[2]).toBe('- 柊誠（脇役）: 朝倉澪からの呼び方は「苗字＋先生」')
  })
})

describe('buildChapterPrompt: 章の計画', () => {
  test('今回の執筆: 時と場所、出来事 (番号つき)、章末の状況、張る伏線、まだ回収しない伏線、分量', () => {
    expect(section(buildChapterPrompt(planned(2)).user, '今回の執筆')).toBe(
      [
        '【今回の執筆】',
        '第2章（全5章）の本文を書く。',
        '- 執筆済み: 第1章（その終わりから続けて書く）',
        '- この後の章: 第3〜5章（この章では書かない。物語は途中なので、章末で締めくくらない）',
        '- 題: 入部届',
        '- 概要: ルナが天文部に入りたいと言い出す。',
        '- 時と場所: 翌日の放課後、部室',
        '- 出来事（この順に、すべてを場面として書く）:',
        '  1. ルナが部室に来て、入部したいと言う。',
        '  2. 柊誠が入部届の用紙を持ってくる。',
        '- 章末の状況: 夕方、部室。ルナが入部届を書きかけている（この状況になったところで章を終える）',
        '- 張る伏線（この章の中で書く。種明かしはしない）:',
        '  - [s2] ルナは入部届の住所の欄を空けたままにする。',
        // 前の章が張り、後の章 (第 3 章) が回収する伏線
        '- まだ回収しない伏線（後の章で回収する。この章では決着させない）:',
        '  - [s1] 屋上の望遠鏡の持ち主が分からない。',
        '- 分量: 約4,000字。出来事1つあたり約2,000字を目安に書く。出来事を端折って短く終えない。'
      ].join('\n')
    )
  })

  test('回収する伏線には、張った章の説明を添える。出来事が無い章の分量は場面数の指示', () => {
    const body = section(buildChapterPrompt(planned(3)).user, '今回の執筆')
    expect(body).toContain('- 回収する伏線（この章で決着させる）:\n  - [s1] 屋上の望遠鏡の持ち主が分からない。')
    // 第 2 章が張り、第 5 章が回収する
    expect(body).toContain(
      '- まだ回収しない伏線（後の章で回収する。この章では決着させない）:\n  - [s2] ルナは入部届の住所の欄を空けたままにする。'
    )
    expect(body).not.toContain('出来事（')
    expect(body).not.toContain('時と場所')
    expect(body).not.toContain('章末の状況')
    expect(body).toContain('- 分量: 約4,000字。概要の範囲を4場面程度に分け、1場面あたり約1,000字を目安に書く。')
  })

  test('計画が無い章は、今までどおり', () => {
    expect(section(buildChapterPrompt(planned(4)).user, '今回の執筆')).toBe(
      [
        '【今回の執筆】',
        '第4章（全5章）の本文を書く。',
        '- 執筆済み: 第1〜3章（第3章の終わりから続けて書く）',
        '- この後の章: 第5章（この章では書かない。物語は途中なので、章末で締めくくらない）',
        '- 題: 準備',
        '- 概要: 観測会の準備を進める。',
        // 第 2 章が張り、第 5 章が回収する
        '- まだ回収しない伏線（後の章で回収する。この章では決着させない）:',
        '  - [s2] ルナは入部届の住所の欄を空けたままにする。',
        '- 分量: 約4,000字。概要の範囲を4場面程度に分け、1場面あたり約1,000字を目安に書く。場面を端折って短く終えない。'
      ].join('\n')
    )
  })

  test('最終章: 結末まで書き切る。章末の状況に「ここで終える」の注記を付けない', () => {
    const body = section(buildChapterPrompt(planned(5)).user, '今回の執筆')
    expect(body).toContain('- この後の章: なし（この章が最終章。結末まで書き切る）')
    expect(body).toContain('- 章末の状況: 深夜、屋上。朝倉澪とルナが流星群を見上げている。\n')
    expect(body).not.toContain('この状況になったところで章を終える')
    // 章立てに無い id は、id だけを出す
    expect(body).toContain(
      '- 回収する伏線（この章で決着させる）:\n  - [s2] ルナは入部届の住所の欄を空けたままにする。\n  - [s9]\n'
    )
    expect(body).not.toContain('まだ回収しない伏線')
    expect(body).toContain('- 分量: 約4,000字。出来事1つあたり約1,300字を目安に書く。')
  })

  test('分量は出来事の数で割り当てる (100 字単位)', () => {
    expect(charsPerEvent(4000, 4)).toBe(1000)
    expect(charsPerEvent(4000, 3)).toBe(1300)
    expect(charsPerEvent(20000, 6)).toBe(3300)
    expect(charsPerEvent(500, 8)).toBe(100)
    expect(charsPerEvent(4000, 0)).toBe(4000)
  })

  test('出来事に名前が出る人物は、characters に無くても登場扱いにする', () => {
    // 第 2 章の characters は「ルナ」だけ。柊誠は出来事に出る。朝倉澪は語り手
    const { user } = buildChapterPrompt(planned(2))
    const people = section(user, 'この章の登場人物')
    expect(people).toContain('■ 柊誠（42歳・男性・教師）')
    expect(people).toContain('■ 朝倉澪')
    expect(headings(user)).not.toContain('この章に登場しない人物')
    // 出来事から名前を消すと、登場しない人物に戻る
    const withoutName: Outline = {
      chapters: plannedOutline.chapters.map((c) =>
        c.chapter_number === 2 ? { ...c, events: ['ルナが部室に来て、入部したいと言う。'] } : c
      )
    }
    expect(section(buildChapterPrompt(planned(2, { outline: withoutName })).user, 'この章に登場しない人物')).toContain(
      '- 柊誠（脇役）'
    )
  })

  test('章末の状況に名前が出る人物も登場扱いにする。伏線の説明は対象にしない', () => {
    const variant = (patch: Partial<OutlineChapter>): string => {
      const changed: Outline = {
        chapters: plannedOutline.chapters.map((c) => (c.chapter_number === 1 ? { ...c, ...patch } : c))
      }
      return section(buildChapterPrompt(planned(1, { outline: changed })).user, 'この章の登場人物')
    }
    expect(variant({ end_state: '夜、屋上。柊誠が鍵を閉めに来る。' })).toContain('■ 柊誠')
    expect(variant({ setups: [{ id: 's1', description: '柊誠が望遠鏡の持ち主を知っている。' }] })).not.toContain(
      '■ 柊誠'
    )
  })

  test('計画の項目そのものが無い章立て (保存済みの旧形式) でも組み立てられる', () => {
    // Zod を通っていない章立て (DO ストレージに残った旧形式の payload) は、計画の項目を持たない。
    // JSON.parse の戻り値として作り、型の上では Outline として渡す。
    const legacy: Outline = JSON.parse(
      JSON.stringify({
        chapters: outline.chapters.map((c) => ({
          chapter_number: c.chapter_number,
          title: c.title,
          summary: c.summary,
          characters: c.characters
        }))
      })
    )
    expect(Object.keys(legacy.chapters[0])).toEqual(['chapter_number', 'title', 'summary', 'characters'])
    for (const n of [1, 2, 3, 4, 5]) {
      expect(buildChapterPrompt(input(n, { outline: legacy }))).toEqual(buildChapterPrompt(input(n)))
    }
  })
})

describe('buildChapterPrompt: 作品設計と計画があるときの system', () => {
  const { system } = buildChapterPrompt(planned(2))
  const plain = buildChapterPrompt(input(2)).system

  test('出来事、章末の状況、伏線の扱い', () => {
    expect(system).toContain(
      '【今回の執筆】に「出来事」があるときは、挙がっている順に、すべてを場面として書く。1つの出来事を数行の説明で済ませず、挙がっていない大きな出来事を足さない。'
    )
    expect(system).toContain(
      '【今回の執筆】に「章末の状況」があればその状況になったところで、無ければ最後の出来事を書いたところで止める'
    )
    expect(system).toContain('「張る伏線」は、この章の出来事の中で読者に見せる。後の章で回収するので、種明かしはしない')
    expect(system).toContain('「回収する伏線」は、この章で読者に分かる形で決着させる')
    expect(system).toContain(
      '「未回収の伏線」のうち、【今回の執筆】の「回収する伏線」はこの章で決着させ、「まだ回収しない伏線」は決着させない'
    )
    expect(system).toContain('新しい出来事を足して埋めない')
  })

  test('作品設計: 全ての章で守る。結末は最終章で至る (途中の章で先取りしない)', () => {
    expect(system).toContain('【作品設計】は作品全体の設計で、全ての章で守る')
    expect(system).toContain('用語は【作品設計】の表記で書く')
    expect(system).toContain('【作品設計】の「結末」と、「人物の変化」の終わりの状態は、最終章で至るものである')
    expect(system).toContain('最終章より前の章では、人物は変化の途中にあり、結末に先に到達させない')
    expect(system).toContain('最終章は、【作品設計】の「結末」まで書き切る。')
    expect(system).toContain(
      '【作品設計】、【全体の章立て】の概要、【確定事項】が確定済みの本文と食い違うときは、本文を正とする'
    )
    expect(system).toContain('【執筆上の指示】は、この作品についての依頼者の指示である。全ての章で守る。')
  })

  test('system が名前で指す小見出しは、user に実際にある', () => {
    const { user } = buildChapterPrompt(planned(2))
    const labels = ['出来事', '章末の状況', '張る伏線', 'まだ回収しない伏線']
    for (const label of labels) {
      expect(system).toContain(`「${label}」`)
      expect(section(user, '今回の執筆')).toContain(`- ${label}`)
    }
    expect(section(buildChapterPrompt(planned(3)).user, '今回の執筆')).toContain('- 回収する伏線')
    for (const label of ['結末', '人物の変化']) {
      expect(system).toContain(`「${label}」`)
      expect(section(user, '作品設計')).toContain(`\n${label}:`)
    }
  })

  test('作品設計も計画も無ければ、これらの規則は出さない', () => {
    for (const word of ['作品設計', '呼称表', '執筆上の指示', '章末の状況', '張る伏線', 'まだ回収しない伏線']) {
      expect(plain).not.toContain(word)
    }
    expect(plain).toContain('最終章は、結末まで書き切る。')
    expect(plain).toContain('「場面」は出来事の一区切りを指す')
  })
})

// 成人指定 (R15 / R18) の読み替えの指示。作品設計の有無に関係なく、プロンプトの全ての資料にかける。
// 成人としての人物設定に差し替わっていても外さない (関係、口調の例、成人指定に変える前に書かれた章、
// 作品設計に書き直しきれずに残った記述など、原文のまま渡る資料があるため)。
const READ_ALL_AS_ADULT =
  'このプロンプトの資料と指示のどこか（作品情報、作品設計、人物の設定、関係、口調の例、章立て、既に書かれた本文とその記録など）に「高校生」「17歳」「女子高生」「十代」「美少女」、学年、制服等、未成年を連想させる記述が含まれていても、本作品においては成人（大学生または社会人）として読み替えて書くこと。学校設定が必要な場合は大学とする。'
const ADULT_CAST_RESOLVED = '登場人物の年齢・職業・外見・背景は、成人として確定したものを載せている。'
// 成人としての人物設定が確定していないとき (作品設計が無い旧データを含む) の、年齢指定の行の全文
const ADULT_RATING_LINES: Record<string, string> = {
  R15: `年齢指定: 物語の登場人物はすべて 18 歳以上の成人とする。${READ_ALL_AS_ADULT}性器を指す放送禁止用語 (露骨な俗語) の使用は禁止。それ以外の性的な描写や行為自体は許容する`,
  R18: `年齢指定: 成人向け。物語の登場人物はすべて 18 歳以上の成人とする。${READ_ALL_AS_ADULT}性的描写・暴力描写・直接的な語彙を含め、必要に応じて踏み込んだ表現を制限なく用いてよい`
}
// 成人としての人物設定を確定した作品設計
const adultBible: StoryBible = {
  ...bible,
  cast: [
    {
      name: '朝倉澪',
      age: '20',
      occupation: '大学生',
      appearance: '肩までの黒髪。',
      background: '天文サークルの代表。'
    }
  ]
}

describe('buildChapterPrompt: 成人指定と作品設計', () => {
  const ratingLineOf = (age_rating: string, bibleValue: StoryBible | null | undefined): string | undefined =>
    section(buildChapterPrompt(planned(2, { style: { ...style, age_rating }, bible: bibleValue })).user, '文体・視点')
      .split('\n')
      .find((line) => line.startsWith('年齢指定: '))

  test('成人としての人物設定があっても、読み替えの指示を全ての資料にかける', () => {
    expect(ratingLineOf('R15', adultBible)).toBe(
      `年齢指定: 物語の登場人物はすべて 18 歳以上の成人とする。${READ_ALL_AS_ADULT}${ADULT_CAST_RESOLVED}性器を指す放送禁止用語 (露骨な俗語) の使用は禁止。それ以外の性的な描写や行為自体は許容する`
    )
    expect(ratingLineOf('R18', adultBible)).toBe(
      `年齢指定: 成人向け。物語の登場人物はすべて 18 歳以上の成人とする。${READ_ALL_AS_ADULT}${ADULT_CAST_RESOLVED}性的描写・暴力描写・直接的な語彙を含め、必要に応じて踏み込んだ表現を制限なく用いてよい`
    )
    // 読み替えの対象に、人物、関係、作品設計、既に書かれた本文を名指しで含める
    for (const material of [
      '作品情報',
      '作品設計',
      '人物の設定',
      '関係',
      '口調の例',
      '章立て',
      '既に書かれた本文とその記録'
    ]) {
      expect(READ_ALL_AS_ADULT).toContain(material)
    }
  })

  test('成人としての人物設定が無い作品設計でも、全ての資料にかける (確定済みの添え書きは付けない)', () => {
    for (const rating of ['R15', 'R18']) {
      expect(ratingLineOf(rating, bible)).toBe(ADULT_RATING_LINES[rating])
      expect(ratingLineOf(rating, bible)).not.toContain(ADULT_CAST_RESOLVED)
    }
  })

  // 以前の旧データの文面は、読み替えの対象が「後述の登場人物詳細」だけだった (関係や確定済みの本文に届かない)。
  test('作品設計が無い旧データでも、全ての資料にかける', () => {
    for (const rating of ['R15', 'R18']) {
      for (const none of [null, undefined]) {
        expect(ratingLineOf(rating, none)).toBe(ADULT_RATING_LINES[rating])
      }
      // 計画も無い、Phase 2 までの入力でも同じ
      const legacy = section(
        buildChapterPrompt(input(2, { style: { ...style, age_rating: rating } })).user,
        '文体・視点'
      )
      expect(legacy.split('\n').at(-1)).toBe(ADULT_RATING_LINES[rating])
      expect(legacy).not.toContain('後述の登場人物詳細に')
      // 確定済みの本文と確定事項があっても、同じ行が入る
      const { user } = buildChapterPrompt(input(3, { style: { ...style, age_rating: rating }, ledgerText }))
      expect(section(user, '文体・視点')).toContain(READ_ALL_AS_ADULT)
    }
  })

  test('全年齢と年齢指定なしは、作品設計の有無に関係なく変わらない', () => {
    for (const bibleValue of [adultBible, bible, null, undefined]) {
      expect(ratingLineOf('全年齢', bibleValue)).toBe(
        '年齢指定: 性的描写・過度な暴力描写を含めず、誰でも読める内容に留めること'
      )
      // 年齢指定なし、知らない値では、行そのものを出さない
      for (const age_rating of [undefined, '', 'PG12']) {
        const body = section(
          buildChapterPrompt(planned(2, { style: { ...style, age_rating }, bible: bibleValue })).user,
          '文体・視点'
        )
        expect(body).not.toContain('年齢指定')
        expect(body).not.toContain('読み替え')
      }
    }
  })

  test('成人指定の行は、章をまたいで変わらない部分にある (全ての章のプロンプトに入る)', () => {
    for (const n of [1, 3, 5]) {
      const { user } = buildChapterPrompt(planned(n, { style: { ...style, age_rating: 'R18' }, bible: adultBible }))
      expect(section(user, '文体・視点')).toContain(READ_ALL_AS_ADULT)
      expect(user.indexOf(READ_ALL_AS_ADULT)).toBeLessThan(user.indexOf('【作品設計】'))
    }
    // 書き直しでも、次の章の冒頭つきでも入る
    const revised = buildChapterPrompt(
      planned(2, {
        style: { ...style, age_rating: 'R15' },
        bible: adultBible,
        revision: { baseContent: chapterText(2), instruction: '口調を直す。' },
        nextChapter: { opening: '　翌朝。', title: '', summary: '' }
      })
    )
    expect(revised.user).toContain(READ_ALL_AS_ADULT)
    expect(
      buildChapterPromptForStorage(planned(2, { style: { ...style, age_rating: 'R15' }, bible: adultBible }))
    ).toContain(READ_ALL_AS_ADULT)
  })

  test('全年齢では、読み替えの指示を入れない', () => {
    for (const bibleValue of [adultBible, bible, null]) {
      const { system, user } = buildChapterPrompt(planned(2, { bible: bibleValue }))
      expect(ratingLineOf('全年齢', bibleValue)).toBe(
        '年齢指定: 性的描写・過度な暴力描写を含めず、誰でも読める内容に留めること'
      )
      for (const text of [system, user]) {
        expect(text).not.toContain('読み替え')
        expect(text).not.toContain('18 歳以上')
        expect(text).not.toContain('成人として確定')
      }
    }
  })
})

// ---------------------- 本文: 途中の章の書き直し (Phase 4) ----------------------

describe('buildChapterPrompt: 次の章の冒頭', () => {
  // 第 3 章が既に書かれている状態で、第 2 章を作り直す。
  const nextChapter = {
    opening: '\n\n　翌朝、部室の鍵は開いていた。\n「遅いよ、ミオちゃん」\n　ルナが窓際で',
    title: '顧問の条件',
    summary: '入部の条件が出る。'
  }
  const rewriting = (overrides: Partial<ChapterPromptInput> = {}): ChapterPromptInput =>
    planned(2, { nextChapter, ...overrides })

  test('【次の章の冒頭】を【今回の執筆】の直前に置く', () => {
    const { user } = buildChapterPrompt(rewriting())
    expect(headings(user).slice(-3)).toEqual(['キャラクター間の関係', '次の章の冒頭', '今回の執筆'])
    expect(section(user, '次の章の冒頭')).toBe(
      [
        '【次の章の冒頭】',
        '第3章「顧問の条件」は既に書かれていて、変更しない。この章は、下の冒頭に自然に繋がる状態（時、場所、その場にいる人物、直前の出来事）で終える。次の章の冒頭の文や出来事を、この章の中に書かない。',
        '次の章の概要: 入部の条件が出る。',
        '▼ 第3章の冒頭',
        // 前後の空行だけ落とし、字下げと途中で切れた文はそのまま
        '　翌朝、部室の鍵は開いていた。',
        '「遅いよ、ミオちゃん」',
        '　ルナが窓際で',
        '（冒頭はここまで。続きは省略）'
      ].join('\n')
    )
    expect(user).not.toContain('\n\n\n')
  })

  test('【今回の執筆】の「この後の章」と「章末の状況」を、次の章が書かれていることに合わせる', () => {
    const body = section(buildChapterPrompt(rewriting()).user, '今回の執筆')
    expect(body).toContain(
      '- この後の章: 第3〜5章（第3章は既に書かれている。この章では書かず、章末は【次の章の冒頭】に繋がるように終える。物語は途中なので、締めくくらない）'
    )
    expect(body).toContain(
      '- 章末の状況: 夕方、部室。ルナが入部届を書きかけている（この状況になったところで章を終える。【次の章の冒頭】と食い違うときは、次の章の冒頭に合わせる）'
    )
    expect(body).not.toContain('この章では書かない。物語は途中なので、章末で締めくくらない')
  })

  test('それ以外の節と system は、通常の生成と同じ (前半が変わらないので、キャッシュに乗る)', () => {
    const normal = buildChapterPrompt(planned(2))
    const rewrite = buildChapterPrompt(rewriting())
    expect(rewrite.system).toBe(normal.system)
    const cut = (user: string): string => user.slice(0, user.indexOf('\n\n【今回の執筆】'))
    expect(cut(rewrite.user)).toBe(`${cut(normal.user)}\n\n${section(rewrite.user, '次の章の冒頭')}`)
    // 計画の無い旧データでも同じ
    const legacyNormal = buildChapterPrompt(input(2))
    const legacyRewrite = buildChapterPrompt(input(2, { nextChapter }))
    expect(legacyRewrite.system).toBe(legacyNormal.system)
    expect(section(legacyRewrite.user, '今回の執筆')).toContain('第3章は既に書かれている。')
  })

  test('渡されないとき、冒頭が空のときは、文面が変わらない', () => {
    const normal = buildChapterPrompt(planned(2))
    for (const none of [undefined, null, { ...nextChapter, opening: '' }, { ...nextChapter, opening: ' \n\n' }]) {
      expect(buildChapterPrompt(planned(2, { nextChapter: none }))).toEqual(normal)
    }
  })

  test('章立ての上で最終章なら、使わない (結末まで書き切る指示とぶつかる)', () => {
    expect(buildChapterPrompt(planned(5, { nextChapter }))).toEqual(buildChapterPrompt(planned(5)))
  })

  test('題と概要が空なら、番号だけで示す', () => {
    const body = section(
      buildChapterPrompt(rewriting({ nextChapter: { opening: '　翌朝。', title: ' ', summary: '' } })).user,
      '次の章の冒頭'
    )
    expect(body.split('\n')).toEqual([
      '【次の章の冒頭】',
      '第3章は既に書かれていて、変更しない。この章は、下の冒頭に自然に繋がる状態（時、場所、その場にいる人物、直前の出来事）で終える。次の章の冒頭の文や出来事を、この章の中に書かない。',
      '▼ 第3章の冒頭',
      '　翌朝。',
      '（冒頭はここまで。続きは省略）'
    ])
  })

  test('保存用にも、冒頭をそのまま入れる (500 字程度なので省略しない)', () => {
    const stored = buildChapterPromptForStorage(rewriting())
    expect(stored).toContain('【次の章の冒頭】\n')
    expect(stored).toContain('　翌朝、部室の鍵は開いていた。')
  })
})

// ---------------------- 本文: 指示つきの書き直し (Phase 5) ----------------------

describe('buildChapterPrompt: 指示つきの書き直し', () => {
  const baseContent = `\n\n${chapterText(2)}\n\n`
  const revision = {
    baseContent,
    instruction: '- 「第2章の台詞」: ルナの口調が硬い。もっと砕けた口調にする。\n\n- 柊誠が部室を出る場面を削る。\n'
  }
  const nextChapter = { opening: '　翌朝、部室の鍵は開いていた。', title: '顧問の条件', summary: '入部の条件が出る。' }
  const revising = (overrides: Partial<ChapterPromptInput> = {}): ChapterPromptInput =>
    planned(2, { revision, ...overrides })

  test('【元の版】と【修正指示】を【今回の執筆】の直前に置く (【次の章の冒頭】があればその後)', () => {
    expect(headings(buildChapterPrompt(revising()).user).slice(-4)).toEqual([
      'キャラクター間の関係',
      '元の版',
      '修正指示',
      '今回の執筆'
    ])
    expect(headings(buildChapterPrompt(revising({ nextChapter })).user).slice(-5)).toEqual([
      'キャラクター間の関係',
      '次の章の冒頭',
      '元の版',
      '修正指示',
      '今回の執筆'
    ])
    expect(buildChapterPrompt(revising({ nextChapter })).user).not.toContain('\n\n\n')
  })

  test('【元の版】は今の本文の全文、【修正指示】は指示をそのまま (空行は詰める)', () => {
    const { user } = buildChapterPrompt(revising())
    expect(section(user, '元の版')).toBe(
      [
        '【元の版】',
        'この章の今の本文である。確定済みの本文ではなく、これを直したものがこの章の新しい本文になる。',
        // 見出しは章立ての題。本文は前後の空行だけ落とし、字下げと本文の中の空行はそのまま
        '▼ 第2章「入部届」',
        chapterText(2)
      ].join('\n')
    )
    expect(section(user, '修正指示')).toBe(
      '【修正指示】\n- 「第2章の台詞」: ルナの口調が硬い。もっと砕けた口調にする。\n- 柊誠が部室を出る場面を削る。'
    )
  })

  test('【今回の執筆】: 修正指示の点だけを直し、全文を出力させる。優先は 修正指示 > 元の版 > 計画', () => {
    const body = section(buildChapterPrompt(revising()).user, '今回の執筆')
    expect(body.split('\n').slice(0, 7)).toEqual([
      '【今回の執筆】',
      '第2章（全5章）の本文を、【元の版】を直して書く。',
      '- 直すのは【修正指示】に書かれた点だけにする。それ以外は【元の版】の文章をそのまま保つ（言い回しを変えない。【修正指示】が求めない限り、場面を足したり削ったりしない）。',
      '- 直した結果、前後の文と辻褄が合わなくなる箇所は、合わせて直す。',
      '- 表記の規則（字下げなど）に合っていない箇所は、規則に合わせて直す。',
      '- 下の題、概要、出来事などは、【元の版】を書いたときの計画である。【元の版】が計画と違っていても、【修正指示】に書かれていなければ直さない。【修正指示】が計画と食い違うときは、【修正指示】に従う。',
      '- 出力は章の全文にする。直していない部分も含めて最初から最後まで書き、どこを直したかの説明は付けない。'
    ])
    // 計画は載せるが、計画どおりに書き直させる文言は付けない
    expect(body).toContain('- 出来事（元の版を書いたときの計画）:\n  1. ルナが部室に来て、入部したいと言う。')
    expect(body).not.toContain('すべてを場面として書く')
    // 章末の状況も計画として載せるだけ (「この状況になったところで章を終える」の注記は付けない)
    expect(body).toContain('- 章末の状況: 夕方、部室。ルナが入部届を書きかけている。\n')
    expect(body).not.toContain('この状況になったところで章を終える')
    expect(section(buildChapterPrompt(revising({ nextChapter })).user, '今回の執筆')).not.toContain(
      'この状況になったところで章を終える'
    )
    expect(body).toContain('- 執筆済み: 第1章（その終わりから続けて書く）')
  })

  test('分量は「元の版と同じ程度」にする (目標字数に合わせて水増し・削減させない)', () => {
    const lengthOf = (content: string, targetChars: number): string | undefined =>
      section(
        buildChapterPrompt(revising({ revision: { ...revision, baseContent: content }, targetChars })).user,
        '今回の執筆'
      )
        .split('\n')
        .at(-1)
    // 元の版の字数を 100 字単位で示す。目標字数 (4,000 / 20,000) は出さない
    for (const targetChars of [4000, 20000]) {
      expect(lengthOf('あ'.repeat(2254), targetChars)).toBe(
        '- 分量: 【元の版】（約2,300字）と同じ程度にする。字数を合わせるために増やしたり削ったりしない。【修正指示】が分量に触れているときは、それに従う。'
      )
    }
    expect(lengthOf('あ'.repeat(30), 4000)).toContain('【元の版】（約100字）と同じ程度')
    const body = section(buildChapterPrompt(revising()).user, '今回の執筆')
    expect(body).not.toContain('約4,000字')
    expect(body).not.toContain('出来事1つあたり')
    expect(body).not.toContain('端折って')
  })

  test('それ以外の節と system は、通常の生成と同じ (整合性の規則はそのまま効く)', () => {
    const normal = buildChapterPrompt(planned(2))
    const revised = buildChapterPrompt(revising())
    expect(revised.system).toBe(normal.system)
    const cut = (user: string, heading: string): string => user.slice(0, user.indexOf(`\n\n【${heading}】`))
    expect(cut(revised.user, '元の版')).toBe(cut(normal.user, '今回の執筆'))
    // 作品設計も計画も執筆上の指示も無い旧データでも、system は変わらない
    expect(buildChapterPrompt(input(2, { revision })).system).toBe(buildChapterPrompt(input(2)).system)
    expect(buildChapterPrompt(input(2, { revision, nextChapter })).system).toBe(buildChapterPrompt(input(2)).system)
    // 確定事項つきでも同じ
    const withLedger = buildChapterPrompt(revising({ ledgerText }))
    expect(withLedger.system).toBe(normal.system)
    expect(headings(withLedger.user)).toContain('確定事項')
  })

  test('保存用では【元の版】の本文を字数の 1 行に置き換え、指示は残す', () => {
    const stored = buildChapterPromptForStorage(revising())
    expect(section(stored, '元の版')).toBe(
      [
        '【元の版】',
        'この章の今の本文である。確定済みの本文ではなく、これを直したものがこの章の新しい本文になる。',
        '▼ 第2章「入部届」',
        `（本文${chapterText(2).length}字。モデルには全文を渡し、保存では省略）`
      ].join('\n')
    )
    expect(stored).not.toContain('第2章の地の文')
    expect(section(stored, '修正指示')).toBe(section(buildChapterPrompt(revising()).user, '修正指示'))
    // 送る側には全文が入る
    expect(buildChapterPrompt(revising()).user).toContain('第2章の地の文、二段落め。')
  })

  test('渡されないとき、本文か指示が空のときは、文面が変わらない', () => {
    const normal = buildChapterPrompt(planned(2))
    const empties = [
      undefined,
      null,
      { baseContent: '', instruction: '口調を直す。' },
      { baseContent: ' \n\n', instruction: '口調を直す。' },
      { baseContent: chapterText(2), instruction: '' },
      { baseContent: chapterText(2), instruction: '  \n' }
    ]
    for (const none of empties) {
      expect(buildChapterPrompt(planned(2, { revision: none }))).toEqual(normal)
      expect(buildChapterPromptForStorage(planned(2, { revision: none }))).toBe(
        buildChapterPromptForStorage(planned(2))
      )
    }
  })

  test('計画の無い旧データ、最終章でも書き直せる', () => {
    const legacy = section(buildChapterPrompt(input(2, { revision })).user, '今回の執筆')
    expect(legacy).toContain('第2章（全5章）の本文を、【元の版】を直して書く。')
    expect(legacy).toContain('- 分量: 【元の版】（約100字）と同じ程度にする。')
    expect(legacy).not.toContain('場面程度に分け')
    const last = section(buildChapterPrompt(planned(5, { revision })).user, '今回の執筆')
    expect(last).toContain('- この後の章: なし（この章が最終章。結末まで書き切る）')
    expect(last).toContain('第5章（全5章）の本文を、【元の版】を直して書く。')
  })
})

// ---------------------- 章立て ----------------------

// 見本 (system の【出力】) のキーの並び。全章用は章 1 件の行、1 章用は見本そのもの。
const outlineSkeleton = (system: string): unknown => {
  const line = system.split('\n').find((candidate) => candidate.trimStart().startsWith('{ "chapter_number"'))
  return JSON.parse(line === undefined ? 'null' : line.trim().replace(/,$/, ''))
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const keysOfRecord = (value: unknown): string[] => (isRecord(value) ? Object.keys(value) : [])

// JSON Schema の中の、キーを辿った先。
const dig = (value: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((current, key) => (isRecord(current) ? current[key] : undefined), value)

describe('buildOutlinePrompt', () => {
  const prompt = buildOutlinePrompt({ novel, style, cast, relations })
  const withBible = buildOutlinePrompt({ novel, style, cast, relations, bible })

  test('名簿の名前と章数が入る', () => {
    expect(prompt.user).toContain('章数: 5')
    expect(prompt.user).toContain('全5章の章立てを作る。chapter_number は1〜5。')
    expect(prompt.user).toContain('名簿（characters に使える名前）: 朝倉澪、ルナ、柊誠')
    expect(prompt.user).toContain('summary は各章300字程度。')
  })

  test('資料の並び。視点と文体の節は渡さない', () => {
    expect(headings(prompt.user)).toEqual([
      '作品情報',
      '登場人物',
      'キャラクター間の関係',
      '物語に取り込みたい要素',
      '今回の依頼'
    ])
    expect(headings(withBible.user)).toEqual([
      '作品情報',
      '作品設計',
      '登場人物',
      'キャラクター間の関係',
      '物語に取り込みたい要素',
      '今回の依頼'
    ])
    // 視点と文体を渡すと、概要が語り手の一人称や本文の文体で書かれる
    for (const text of [prompt.user, prompt.system, withBible.user, withBible.system]) {
      for (const word of ['視点:', '文体:', 'ライトノベル', '一人称視点', '文体・視点']) {
        expect(text).not.toContain(word)
      }
      expect(text).not.toContain('\n\n\n')
    }
    expect(section(prompt.user, '物語に取り込みたい要素')).toContain('- 流星群の夜を入れる')
    // 章立てには全員の詳細を渡す
    expect(section(prompt.user, '登場人物')).toContain('■ 柊誠（42歳・男性・教師）')
  })

  test('作品情報: 年齢指定と結末の方向は残す', () => {
    expect(section(prompt.user, '作品情報')).toBe(
      [
        '【作品情報】',
        'ジャンル: 青春',
        '世界観・設定: 地方の高校の天文部。屋上に古い望遠鏡がある。',
        '章数: 5',
        '年齢指定: 性的描写・過度な暴力描写を含めず、誰でも読める内容に留めること',
        '結末: 主要な葛藤が解決し、登場人物が報われる前向きな結末へ向けて構成すること'
      ].join('\n')
    )
    // 作品設計に結末の具体像があれば、そちらを正とする
    expect(section(withBible.user, '作品情報').split('\n').at(-1)).toBe(
      '結末の方向: 主要な葛藤が解決し、登場人物が報われる前向きな結末へ向けて構成すること（具体的な結末は【作品設計】の「結末」に従う）'
    )
    expect(withBible.system).toContain('最終章の出来事は、【作品設計】の「結末」に至る。')
    expect(prompt.system).toContain('最終章の出来事は、物語の結末に至る。')
  })

  test('結末が未指定なら行を出さない', () => {
    const { user } = buildOutlinePrompt({ novel, style: { ...style, ending: '未指定' }, cast, relations })
    expect(user).not.toContain('結末:')
    expect(user).not.toContain('結末の方向')
  })

  test('作品設計: 本文プロンプトと同じ文面で渡す。呼称表は渡さない', () => {
    expect(section(withBible.user, '作品設計')).toBe(section(buildChapterPrompt(planned(2)).user, '作品設計'))
    expect(withBible.user).not.toContain('呼称表')
    expect(withBible.user).not.toContain('ミオちゃん')
    expect(withBible.system).toContain('【作品設計】に従う。世界のルール、用語、時系列と矛盾させない。')
    expect(withBible.system).toContain(
      'time_place: その章がいつ、どこで起きるか。1文で書く。【作品設計】の時系列と合わせる。'
    )
    // 作品設計が無い旧データでは、節も規則も出さない
    for (const none of [undefined, null]) {
      const plain = buildOutlinePrompt({ novel, style, cast, relations, bible: none })
      expect(plain.user).not.toContain('作品設計')
      expect(plain.system).not.toContain('作品設計')
    }
  })

  test('章の計画を書かせる規則が system にある', () => {
    const { system } = prompt
    expect(system).toContain('章立ては本文を書く前の計画で、各章で何が起きるかを具体的に決める。')
    expect(system).toContain('章数ちょうどの章を作る')
    expect(system).toContain('chapter_number は1から章数までの連番にする')
    expect(system).toContain(
      'どの項目も三人称の常体で、事実として書く。宣伝文のような煽りや問いかけ、語り手の一人称では書かない。'
    )
    expect(system).toContain('title: 章のタイトル。空にしない。')
    expect(system).toContain('名前は名簿の表記と完全に一致させる')
    expect(system).toContain(
      `events: その章で起きる出来事を、起きる順に${OUTLINE_EVENTS_MIN}〜${OUTLINE_EVENTS_MAX}個。1項目に1つの出来事を、誰が何をするかが分かる1文で書く。心情や雰囲気ではなく、起きることを書く。`
    )
    expect(system).toContain('end_state: 章末に、誰がどこにいて、どういう状況か。1〜2文で書く。次の章はここから続く。')
    expect(system).toContain('id は s1、s2…と章立て全体の通し番号にし')
    expect(system).toContain(`1章に${OUTLINE_PLAN_LIMITS.setupsMax}個まで。無ければ空にする。`)
    expect(system).toContain('payoffs: この章で回収する伏線の id。それより前の章の setups の id だけを書く。')
    expect(system).toContain('summary: events をまとめた章の概要。空にしない。')
    expect(system).toContain(
      '隣り合う章で同じ出来事を書かない。各章の end_state と、次の章の time_place・最初の出来事が繋がるようにする。'
    )
    expect(system).toContain('張った伏線（setups）は、張った章より後の、最終章までのどこかの章で回収する（payoffs）。')
    // 出来事の数の目安は、切り詰めの上限を超えない
    expect(OUTLINE_EVENTS_MIN).toBeLessThan(OUTLINE_EVENTS_MAX)
    expect(OUTLINE_EVENTS_MAX).toBeLessThanOrEqual(OUTLINE_PLAN_LIMITS.eventsMax)
  })

  test('出力の見本は、JSON Schema とキーも順序も同じで、OutlineChapterSchema を通る', () => {
    const cases: Array<{ castNames: string[]; system: string }> = [
      { castNames: cast.map((member) => member.name), system: prompt.system },
      { castNames: [], system: buildOutlinePrompt({ novel, style, cast: [], relations: [] }).system }
    ]
    for (const { castNames, system } of cases) {
      const skeleton = outlineSkeleton(system)
      const properties = dig(outlineJsonSchema(castNames), 'properties', 'chapters', 'items', 'properties')
      expect(keysOfRecord(skeleton)).toEqual(keysOfRecord(properties))
      const parsed = OutlineChapterSchema.safeParse(skeleton)
      expect(parsed.success).toBe(true)
      // Zod は知らないキーを黙って捨てる。見本のキーが全部残っていれば、型と食い違っていない
      for (const key of keysOfRecord(skeleton)) {
        expect(keysOfRecord(parsed.data)).toContain(key)
      }
      expect(system).toContain('"chapters": [')
    }
    expect(keysOfRecord(outlineSkeleton(prompt.system))).toEqual([
      'chapter_number',
      'title',
      'characters',
      'time_place',
      'events',
      'end_state',
      'setups',
      'payoffs',
      'summary'
    ])
  })

  test('語り手: 視点の文面は渡さず、誰の視点で書かれるかだけを伝える', () => {
    expect(section(prompt.user, '今回の依頼')).toContain('- 語り手: 朝倉澪（全ての章に登場させる）')
    expect(section(prompt.user, '登場人物')).toContain('  役割: 主人公・語り手')
    expect(prompt.system).toContain(
      '本文は【今回の依頼】に示した語り手（視点人物）の視点で書かれる。その人物を必ず登場させ、その人物が居合わせない出来事を入れない。'
    )
    const focal = buildOutlinePrompt({ novel, style: { ...style, pov: '三人称一元視点' }, cast, relations })
    expect(section(focal.user, '今回の依頼')).toContain('- 視点人物: 朝倉澪（全ての章に登場させる）')
    // 視点人物を持たない視点では出さない
    const omniscient = buildOutlinePrompt({ novel, style: { ...style, pov: '三人称神視点' }, cast, relations })
    expect(omniscient.user).not.toContain('語り手')
    expect(omniscient.user).not.toContain('視点人物')
    expect(omniscient.system).not.toContain('視点人物')
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
    expect(empty.system).not.toContain('名簿')
    expect(empty.user).not.toContain('characters')
    expect(headings(empty.user)).toEqual(['作品情報', '今回の依頼'])
  })

  test('成人指定: 作品設計があれば、読み替えの指示を全ての資料にかける', () => {
    const ratingLineOf = (age_rating: string, bibleValue: StoryBible | null | undefined): string | undefined =>
      section(
        buildOutlinePrompt({ novel, style: { ...style, age_rating }, cast, relations, bible: bibleValue }).user,
        '作品情報'
      )
        .split('\n')
        .find((line) => line.startsWith('年齢指定: '))
    // 成人としての人物設定があっても、読み替えの指示は外さない
    expect(ratingLineOf('R18', adultBible)).toBe(
      `年齢指定: 成人向け。物語の登場人物はすべて 18 歳以上の成人とする。${READ_ALL_AS_ADULT}${ADULT_CAST_RESOLVED}性的描写・暴力描写・直接的な語彙を含め、必要に応じて踏み込んだ表現を制限なく用いてよい`
    )
    expect(ratingLineOf('R15', adultBible)).toContain(`${READ_ALL_AS_ADULT}${ADULT_CAST_RESOLVED}`)
    // 成人としての人物設定が無い作品設計でも、全ての資料にかける
    expect(ratingLineOf('R15', bible)).toContain(READ_ALL_AS_ADULT)
    expect(ratingLineOf('R15', bible)).not.toContain(ADULT_CAST_RESOLVED)
    // 作品設計が無い旧データでも、全ての資料にかける
    for (const rating of ['R15', 'R18']) {
      for (const none of [null, undefined]) {
        expect(ratingLineOf(rating, none)).toBe(ADULT_RATING_LINES[rating])
      }
    }
    // 年齢指定なしでは、行そのものを出さない
    expect(
      buildOutlinePrompt({ novel, style: { ...style, age_rating: undefined }, cast, relations, bible: null }).user
    ).not.toContain('年齢指定')
    // 全年齢では入れない
    const plain = buildOutlinePrompt({ novel, style, cast, relations, bible: adultBible })
    expect(plain.user).not.toContain('読み替え')
    expect(plain.system).not.toContain('読み替え')
  })

  test('成人指定: 1 章の書き直しにも同じ指示が入る', () => {
    const adultStyle = { ...style, age_rating: 'R18' }
    const rewrite = buildOutlineChapterPrompt({
      novel,
      style: adultStyle,
      cast,
      relations,
      bible: adultBible,
      existing: plannedOutline,
      chapterNumber: 2
    })
    expect(section(rewrite.user, '作品情報')).toContain(`${READ_ALL_AS_ADULT}${ADULT_CAST_RESOLVED}`)
    const legacy = buildOutlineChapterPrompt({
      novel,
      style: adultStyle,
      cast,
      relations,
      existing: outline,
      chapterNumber: 2
    })
    expect(section(legacy.user, '作品情報').split('\n').at(-2)).toBe(ADULT_RATING_LINES.R18)
  })

  test('system は作品の内容を含まない', () => {
    for (const system of [prompt.system, withBible.system]) {
      for (const word of ['朝倉澪', '天文部', '観測会', '流星群']) {
        expect(system).not.toContain(word)
      }
    }
  })
})

describe('buildOutlineChapterPrompt', () => {
  const rewrite = (chapterNumber: number, existing: Outline = plannedOutline, bibleValue: StoryBible | null = bible) =>
    buildOutlineChapterPrompt({ novel, style, cast, relations, bible: bibleValue, existing, chapterNumber })
  const prompt = rewrite(2)

  test('資料の並び。視点と文体の節は渡さない', () => {
    expect(headings(prompt.user)).toEqual([
      '作品情報',
      '作品設計',
      '登場人物',
      'キャラクター間の関係',
      '物語に取り込みたい要素',
      '他の章',
      '書き直す章',
      '今回の依頼'
    ])
    for (const word of ['視点:', '文体:', 'ライトノベル', '文体・視点']) {
      expect(prompt.user).not.toContain(word)
      expect(prompt.system).not.toContain(word)
    }
    expect(prompt.user).not.toContain('\n\n\n')
  })

  test('他の章は計画つきで、固定の資料として渡す', () => {
    const others = section(prompt.user, '他の章')
    expect(others).toStartWith(
      [
        '【他の章】',
        '第1章「屋上の少女」: 朝倉澪が屋上でルナと出会う。',
        '  時と場所: 10月上旬の夜、高校の屋上',
        '  出来事:',
        '    1. 朝倉澪が屋上で望遠鏡を調整する。',
        '    2. ルナが望遠鏡の前に現れる。',
        '    3. 朝倉澪がルナに天文部の話をする。',
        '  章末の状況: 夜、屋上。朝倉澪とルナが並んで空を見ている。',
        '  張る伏線:',
        '    - [s1] 屋上の望遠鏡の持ち主が分からない。',
        '第3章「顧問の条件」: 入部の条件が出る。',
        '  回収する伏線: s1',
        '第4章「準備」: 観測会の準備を進める。',
        '第5章「流星群の夜」: 観測会の夜、約束を果たす。'
      ].join('\n')
    )
    expect(others).toContain('  回収する伏線: s2、s9')
    expect(others).not.toContain('入部届')
    expect(prompt.system).toContain('【他の章】は固定で、書き換えない。')
    expect(prompt.system).toContain(
      '前の章の章末の状況から続き、次の章の時と場所・最初の出来事へ繋がるようにする。前後の章と同じ出来事を書かない。'
    )
    expect(prompt.system).toContain('異なる切り口・展開を提案してよい')
  })

  test('書き直す章も、今の計画つきで示す', () => {
    expect(section(prompt.user, '書き直す章')).toBe(
      [
        '【書き直す章】',
        '第2章「入部届」: ルナが天文部に入りたいと言い出す。',
        '  時と場所: 翌日の放課後、部室',
        '  出来事:',
        '    1. ルナが部室に来て、入部したいと言う。',
        '    2. 柊誠が入部届の用紙を持ってくる。',
        '  章末の状況: 夕方、部室。ルナが入部届を書きかけている。',
        '  張る伏線:',
        '    - [s2] ルナは入部届の住所の欄を空けたままにする。'
      ].join('\n')
    )
    // 計画の無い旧データは、題と概要だけ
    expect(section(rewrite(3, outline, null).user, '書き直す章')).toBe(
      '【書き直す章】\n第3章「顧問の条件」: 柊が入部の条件を出す。'
    )
  })

  test('今回の依頼: 章番号、概要の字数、名簿、語り手', () => {
    const request = section(prompt.user, '今回の依頼')
    expect(request).toContain('- 第2章を書き直す。chapter_number は2のまま。')
    expect(request).toContain('- summary は300字程度。')
    expect(request).toContain('- 名簿（characters に使える名前）: 朝倉澪、ルナ、柊誠')
    expect(request).toContain('- 語り手: 朝倉澪（この章に登場させる）')
    expect(request).not.toContain('最終章')
  })

  test('伏線: 後の章が回収する伏線は、同じ id と内容で残させる。新しい id は既存と重ならない番号から', () => {
    const request = section(prompt.user, '今回の依頼')
    // 第 2 章が張る s2 は、第 5 章が回収する
    expect(request).toContain(
      '- 次の伏線は後の章が回収する。この章の出来事の中で張り、setups に同じ id と内容で書く:\n  - [s2] ルナは入部届の住所の欄を空けたままにする。'
    )
    expect(request).toContain('- 新しい伏線を張るときは、id を s3 から付ける。')
    // 第 1 章が張った s1 は第 3 章が回収するので、この章では回収できない
    expect(request).toContain('- payoffs は空にする（前の章が張った、未回収の伏線が無い）。')
    expect(request).not.toContain('[s1]')
  })

  test('伏線: 今この章が回収している伏線は、この章で回収させる (ほかに回収する章が無い)', () => {
    const request = section(rewrite(3).user, '今回の依頼')
    expect(request).toContain(
      '- 次の伏線は、この章で回収する（ほかに回収する章が無い）。payoffs に id を書く:\n  - [s1] 屋上の望遠鏡の持ち主が分からない。'
    )
    // s2 は第 5 章が回収するので挙げない
    expect(request).not.toContain('[s2]')
    expect(request).not.toContain('後の章が回収する。この章の出来事の中で張り')
    expect(request).not.toContain('payoffs は空にする')
  })

  test('伏線: どの章でも回収されていない伏線は、回収してもよいと伝える', () => {
    const unpaid: Outline = {
      chapters: plannedOutline.chapters.map((c) => (c.chapter_number === 3 ? { ...c, payoffs: [] } : c))
    }
    const request = section(rewrite(4, unpaid).user, '今回の依頼')
    expect(request).toContain(
      '- 次の伏線は、この章で回収してもよい（前の章が張り、まだどの章でも回収されていない）:\n  - [s1] 屋上の望遠鏡の持ち主が分からない。'
    )
    expect(request).not.toContain('ほかに回収する章が無い')
  })

  test('最終章: 新しい伏線を張らせず、残っている伏線を回収させる', () => {
    const request = section(rewrite(5).user, '今回の依頼')
    expect(request).toContain('- この章が最終章。出来事は【作品設計】の「結末」に至る。')
    expect(request).toContain('- この章は最終章なので、新しい伏線は張らない。')
    expect(request).toContain(
      '- 次の伏線は、最終章のこの章で回収する。payoffs に id を書く:\n  - [s2] ルナは入部届の住所の欄を空けたままにする。'
    )
    expect(request).not.toContain('id を s3 から付ける')
    // 作品設計が無ければ、物語の結末
    expect(section(rewrite(5, plannedOutline, null).user, '今回の依頼')).toContain(
      '- この章が最終章。出来事は物語の結末に至る。'
    )
  })

  test('出力の見本は、JSON Schema とキーも順序も同じで、OutlineChapterSchema を通る', () => {
    const cases: Array<{ castNames: string[]; system: string }> = [
      { castNames: cast.map((member) => member.name), system: prompt.system },
      {
        castNames: [],
        system: buildOutlineChapterPrompt({
          novel,
          style,
          cast: [],
          relations: [],
          existing: plannedOutline,
          chapterNumber: 2
        }).system
      }
    ]
    for (const { castNames, system } of cases) {
      const skeleton = outlineSkeleton(system)
      expect(keysOfRecord(skeleton)).toEqual(keysOfRecord(dig(outlineChapterJsonSchema(castNames), 'properties')))
      const parsed = OutlineChapterSchema.safeParse(skeleton)
      expect(parsed.success).toBe(true)
      for (const key of keysOfRecord(skeleton)) {
        expect(keysOfRecord(parsed.data)).toContain(key)
      }
      expect(dig(skeleton, 'chapter_number')).toBe(2)
    }
  })

  test('各項目の書き方は全章の生成と同じ。伏線だけ【今回の依頼】に従わせる', () => {
    const { system } = prompt
    expect(system).toContain(
      `events: その章で起きる出来事を、起きる順に${OUTLINE_EVENTS_MIN}〜${OUTLINE_EVENTS_MAX}個。`
    )
    expect(system).toContain('どの項目も三人称の常体で、事実として書く。')
    expect(system).toContain('名前は名簿の表記と完全に一致させる')
    expect(system).toContain('どの伏線を書くかは【今回の依頼】に従う')
    expect(system).toContain('payoffs: この章で回収する伏線の id。【今回の依頼】に挙げた id だけを書く。')
    expect(system).not.toContain('章数ちょうど')
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
    const added = rewrite(6, outline, null)
    expect(section(added.user, '書き直す章')).toBe('【書き直す章】\n第6章（まだ内容が無い。新しく作る）')
    expect(section(added.user, '他の章').split('\n')).toHaveLength(1 + outline.chapters.length)
    // 章数より後ろに足す章は、最終章として扱う
    expect(section(added.user, '今回の依頼')).toContain('- この章が最終章。出来事は物語の結末に至る。')
  })

  test('他の章が無ければ節を出さない', () => {
    const single: Outline = {
      chapters: [ch({ chapter_number: 1, title: '一夜', summary: '一晩の話。', characters: [] })]
    }
    const only = buildOutlineChapterPrompt({
      novel,
      style,
      cast: [],
      relations: [],
      existing: single,
      chapterNumber: 1
    })
    expect(headings(only.user)).toEqual(['作品情報', '物語に取り込みたい要素', '書き直す章', '今回の依頼'])
    expect(only.system).not.toContain('characters')
  })
})
