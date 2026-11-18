import { describe, expect, test } from 'bun:test'
import {
  type BiblePromptInput,
  bibleAddressPairs,
  buildBiblePrompt,
  buildRecordPrompt,
  type RecordPromptInput
} from '@/lib/novel/assist-prompts'
import { requiredAddressPairs } from '@/lib/novel/bible'
import { bibleJsonSchema, hasAddressPairs, recordJsonSchema, usableValues } from '@/lib/novel/json-schemas'
import { ACTIONS_LIMIT, FACTS_LIMIT, LEARNED_LIMIT, STATE_MAX } from '@/lib/novel/ledger'
import type { JsonSchema } from '@/lib/novel/outline'
import type { CastMember, CastRelation, NovelParams, StyleParams } from '@/lib/novel/prompts'
import { FIRST_PERSON_AS_NAME } from '@/schemas/character.dto'
import { ChapterRecordDraftSchema, StoryBibleSchema, type StoryThread } from '@/schemas/story.dto'

// ---------------------- 入力の見本 ----------------------

// 他者の呼び方: 朝倉澪は型、ルナは無し、柊誠は自由記述。
const mio: CastMember = {
  name: '朝倉澪',
  role: '主人公',
  gender: '女性',
  age: '17',
  occupation: '学生',
  appearance: '肩までの黒髪。制服の上に紺のカーディガン。',
  first_person: '私',
  address_others: '苗字＋さん',
  speech_examples: ['そういうの、後でまとめて聞くから'],
  description: '高校二年生。天文部の部長。'
}

const runa: CastMember = {
  name: 'ルナ',
  role: 'ヒロイン',
  gender: '女性',
  age: '',
  occupation: '',
  appearance: '銀色の髪。',
  first_person: FIRST_PERSON_AS_NAME,
  address_others: '',
  speech_examples: ['それって、すっごく変だよ'],
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
  address_others: '生徒は苗字で呼び捨て、同僚には「先生」を付ける',
  speech_examples: [],
  description: '天文部の顧問。'
}

const cast: CastMember[] = [mio, runa, hiiragi]
const castNames = cast.map((member) => member.name)

// 関係の呼び方: 朝倉澪→ルナは型、ルナ→朝倉澪は具体的な呼び方、朝倉澪→柊誠は指定なし。
const relations: CastRelation[] = [
  {
    source_name: '朝倉澪',
    target_name: 'ルナ',
    relation: '友人',
    description: '屋上で出会った',
    address_override: '名前'
  },
  { source_name: 'ルナ', target_name: '朝倉澪', relation: '友人', description: '', address_override: 'ミオっち' },
  { source_name: '朝倉澪', target_name: '柊誠', relation: '教師', description: '部の顧問', address_override: '' }
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

const openThreads: StoryThread[] = [
  { id: 's1', description: '屋上の望遠鏡の持ち主が\n分からない' },
  { id: 'c1-1', description: '澪はルナに、流星群の夜に屋上へ連れて行くと約束した' }
]
const plannedSetups: StoryThread[] = [{ id: 's2', description: 'ルナの銀色の髪を校内でどう隠すか' }]

const chapterText =
  '　屋上の鍵は私が預かることになった。\n\n「ルナも行く！」\n\n　先生は溜め息をついて、鍵を机に置いた。'

const recordInput = (overrides: Partial<RecordPromptInput> = {}): RecordPromptInput => ({
  chapterNumber: 3,
  title: '顧問の条件',
  content: chapterText,
  castNames,
  openThreads,
  plannedSetups,
  ...overrides
})

const bibleInput = (overrides: Partial<BiblePromptInput> = {}): BiblePromptInput => ({
  novel,
  style,
  cast,
  relations,
  ...overrides
})

// ---------------------- 読み取りの部品 ----------------------

const headings = (text: string): string[] => [...text.matchAll(/^【(.+?)】$/gm)].map((m) => m[1])

// 見出しから次の見出しの直前まで。無ければ ''。
const section = (text: string, heading: string): string => {
  const start = text.indexOf(`【${heading}】\n`)
  if (start < 0) return ''
  const rest = text.slice(start)
  const next = rest.indexOf('\n\n【')
  return next < 0 ? rest : rest.slice(0, next)
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

// 入れ子の値を辿る。途中が無ければ undefined。
const at = (value: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((current, key) => (isRecord(current) ? current[key] : undefined), value)

const keysOf = (value: unknown): string[] => (isRecord(value) ? Object.keys(value) : [])

// schema の中の全てのオブジェクト (schema そのものと、入れ子の schema)。
const nodes = (value: unknown): Array<Record<string, unknown>> => {
  if (Array.isArray(value)) return value.flatMap(nodes)
  if (!isRecord(value)) return []
  return [value, ...Object.values(value).flatMap(nodes)]
}

// 値の中のキーの経路。配列は先頭の要素で代表する ('characters[].name' の形)。
const keyPaths = (value: unknown, prefix = ''): string[] => {
  if (Array.isArray(value)) return value.length === 0 ? [] : keyPaths(value[0], `${prefix}[]`)
  if (!isRecord(value)) return []
  return Object.entries(value).flatMap(([key, member]) => {
    const path = prefix === '' ? key : `${prefix}.${key}`
    return [path, ...keyPaths(member, path)]
  })
}

// schema どおりの応答を 1 つ作る (object は全項目、array は 1 要素、string は enum の先頭か仮の文字列)。
const sampleOf = (schema: unknown): unknown => {
  if (!isRecord(schema)) return null
  if (schema.type === 'object') {
    return Object.fromEntries(
      Object.entries(isRecord(schema.properties) ? schema.properties : {}).map(([key, member]) => [
        key,
        sampleOf(member)
      ])
    )
  }
  if (schema.type === 'array') return [sampleOf(schema.items)]
  return Array.isArray(schema.enum) ? schema.enum[0] : '仮の値'
}

// Zod は知らないキーを黙って捨てる。応答のキーが検証の後も全部残っていれば、Zod の形 (story.dto.ts) と食い違っていない。
// 項目の名前が変わったのに schema や見本が古いままだと、その項目が丸ごと既定値になるのを検出する。
const expectKeysKept = (parsed: unknown, response: unknown): void => {
  const kept = keyPaths(parsed)
  for (const path of keyPaths(response)) {
    expect(kept).toContain(path)
  }
}

// system の【出力】に書いた見本の JSON。
const skeletonOf = (system: string): unknown => JSON.parse(system.slice(system.indexOf('形式は次のとおり。\n') + 10))

// どの schema でも守る書き方 (Gemini の構造化出力の制約)。
const expectWellFormed = (schema: JsonSchema): void => {
  for (const node of nodes(schema)) {
    if (typeof node.type === 'string') {
      expect(['object', 'array', 'string', 'integer']).toContain(node.type)
    }
    if (node.type === 'object') {
      // 項目はすべて required
      expect(node.required).toEqual(keysOf(node.properties))
    }
    if ('enum' in node) {
      // enum は空にしない
      expect(Array.isArray(node.enum) && node.enum.length > 0).toBe(true)
    }
    // 長さの制約は入れない
    for (const key of ['minLength', 'maxLength', 'minItems', 'maxItems', 'minimum', 'maximum']) {
      expect(key in node).toBe(false)
    }
  }
}

// ---------------------- schema の部品 ----------------------

describe('usableValues / hasAddressPairs', () => {
  test('空文字と重複を除き、順序を保つ', () => {
    expect(usableValues(['b', '', 'a', 'b'])).toEqual(['b', 'a'])
    expect(usableValues([])).toEqual([])
  })

  test('呼称表の組は 2 人以上で初めてできる', () => {
    expect(hasAddressPairs([])).toBe(false)
    expect(hasAddressPairs(['朝倉澪'])).toBe(false)
    expect(hasAddressPairs(['朝倉澪', '朝倉澪', ''])).toBe(false)
    expect(hasAddressPairs(['朝倉澪', 'ルナ'])).toBe(true)
  })
})

// ---------------------- 章の記録: schema ----------------------

describe('recordJsonSchema', () => {
  const schema = recordJsonSchema({ castNames, openThreadIds: ['s1', 'c1-1'], plannedSetupIds: ['s2'] })

  test('ChapterRecordDraftSchema の項目を、書かせる順に並べる', () => {
    expect(keysOf(schema.properties)).toEqual([
      'summary',
      'facts',
      'characters',
      'new_threads',
      'resolved_thread_ids',
      'written_setup_ids',
      'end_state'
    ])
    expect(keysOf(at(schema, 'properties', 'characters', 'items', 'properties'))).toEqual([
      'name',
      'actions',
      'learned',
      'state'
    ])
    expect(keysOf(at(schema, 'properties', 'end_state', 'properties'))).toEqual(['time', 'place', 'present'])
    expectWellFormed(schema)
  })

  test('人物の名前は名簿の enum', () => {
    expect(at(schema, 'properties', 'characters', 'items', 'properties', 'name', 'enum')).toEqual(castNames)
    expect(at(schema, 'properties', 'end_state', 'properties', 'present', 'items', 'enum')).toEqual(castNames)
  })

  test('伏線の id は渡したものの enum', () => {
    expect(at(schema, 'properties', 'resolved_thread_ids', 'items', 'enum')).toEqual(['s1', 'c1-1'])
    expect(at(schema, 'properties', 'written_setup_ids', 'items', 'enum')).toEqual(['s2'])
  })

  test('id が 1 つも無い項目は schema から外す', () => {
    const bare = recordJsonSchema({ castNames, openThreadIds: [], plannedSetupIds: [''] })
    expect(keysOf(bare.properties)).toEqual(['summary', 'facts', 'characters', 'new_threads', 'end_state'])
    expect(bare.required).toEqual(['summary', 'facts', 'characters', 'new_threads', 'end_state'])
    expectWellFormed(bare)
  })

  test('名簿が空なら名前を縛らない', () => {
    const open = recordJsonSchema({ castNames: [], openThreadIds: ['s1'], plannedSetupIds: [] })
    expect(at(open, 'properties', 'characters', 'items', 'properties', 'name')).toEqual({ type: 'string' })
    expect(at(open, 'properties', 'end_state', 'properties', 'present', 'items')).toEqual({ type: 'string' })
    expectWellFormed(open)
  })

  test('重複と空文字は enum に入れない', () => {
    const deduped = recordJsonSchema({
      castNames: ['ルナ', '', 'ルナ'],
      openThreadIds: ['s1', 's1'],
      plannedSetupIds: []
    })
    expect(at(deduped, 'properties', 'characters', 'items', 'properties', 'name', 'enum')).toEqual(['ルナ'])
    expect(at(deduped, 'properties', 'resolved_thread_ids', 'items', 'enum')).toEqual(['s1'])
  })

  test('schema どおりの応答は ChapterRecordDraftSchema を通り、どの項目も捨てられない', () => {
    const variants = [
      schema,
      recordJsonSchema({ castNames, openThreadIds: [], plannedSetupIds: [] }),
      recordJsonSchema({ castNames: [], openThreadIds: ['s1'], plannedSetupIds: ['s2'] })
    ]
    for (const variant of variants) {
      const response = sampleOf(variant)
      const parsed = ChapterRecordDraftSchema.safeParse(response)
      expect(parsed.success).toBe(true)
      expectKeysKept(parsed.data, response)
    }
    // 全項目を出す schema は、Zod の形と項目が過不足なく一致する
    const full = ChapterRecordDraftSchema.safeParse(sampleOf(schema))
    expect(keyPaths(full.data).sort()).toEqual(keyPaths(sampleOf(schema)).sort())
  })
})

// ---------------------- 章の記録: プロンプト ----------------------

describe('buildRecordPrompt: 資料', () => {
  test('本文 → 名簿 → 未回収の伏線 → この章で張る予定の伏線 → 今回の依頼', () => {
    const { user } = buildRecordPrompt(recordInput())
    expect(headings(user)).toEqual(['この章の本文', '名簿', '未回収の伏線', 'この章で張る予定の伏線', '今回の依頼'])
    expect(user).not.toContain('\n\n\n')
    expect(section(user, '今回の依頼')).toBe(
      '【今回の依頼】\n- 第3章「顧問の条件」の記録を作る。\n- 出力は JSON だけにする。'
    )
  })

  test('本文は字下げを保ち、前後の空行と CRLF だけ直す', () => {
    const { user } = buildRecordPrompt(
      recordInput({ content: `\r\n\r\n${chapterText.replace(/\n/g, '\r\n')}\r\n\r\n` })
    )
    expect(section(user, 'この章の本文')).toBe(`【この章の本文】\n▼ 第3章「顧問の条件」\n${chapterText}`)
    expect(user).not.toContain('\r')
  })

  test('題が無ければ章番号だけ', () => {
    const { user } = buildRecordPrompt(recordInput({ title: null }))
    expect(section(user, 'この章の本文')).toStartWith('【この章の本文】\n▼ 第3章\n')
    expect(section(user, '今回の依頼')).toContain('第3章の記録を作る。')
  })

  test('伏線は id つきの 1 行ずつ', () => {
    const { user } = buildRecordPrompt(recordInput())
    expect(section(user, '未回収の伏線')).toBe(
      [
        '【未回収の伏線】',
        '- [s1] 屋上の望遠鏡の持ち主が 分からない',
        '- [c1-1] 澪はルナに、流星群の夜に屋上へ連れて行くと約束した'
      ].join('\n')
    )
    expect(section(user, 'この章で張る予定の伏線')).toBe(
      '【この章で張る予定の伏線】\n- [s2] ルナの銀色の髪を校内でどう隠すか'
    )
  })

  test('名簿は名前の並び。語り手は名簿にいるときだけ添える', () => {
    expect(section(buildRecordPrompt(recordInput()).user, '名簿')).toBe('【名簿】\n朝倉澪、ルナ、柊誠')
    expect(section(buildRecordPrompt(recordInput({ narrator: '朝倉澪' })).user, '名簿')).toBe(
      '【名簿】\n朝倉澪、ルナ、柊誠\n語り手（本文の一人称の人物）: 朝倉澪'
    )
    expect(section(buildRecordPrompt(recordInput({ narrator: '名簿にいない人' })).user, '名簿')).toBe(
      '【名簿】\n朝倉澪、ルナ、柊誠'
    )
  })

  // OpenAI 互換の json_object モードは、入力 (user) に「json」の語が無い要求を拒否する。system は数えられない。
  test('user に「JSON」の語がある', () => {
    expect(buildRecordPrompt(recordInput()).user).toMatch(/json/i)
    const bare = buildRecordPrompt(recordInput({ title: null, castNames: [], openThreads: [], plannedSetups: [] }))
    expect(bare.user).toMatch(/json/i)
    expect(section(bare.user, '今回の依頼')).toBe('【今回の依頼】\n- 第3章の記録を作る。\n- 出力は JSON だけにする。')
  })

  test('本文が空なら throw する', () => {
    expect(() => buildRecordPrompt(recordInput({ content: ' \n\n' }))).toThrow('Chapter 3 has no content to record')
  })
})

describe('buildRecordPrompt: 節と項目の出し分け', () => {
  test('未回収の伏線が無ければ、節も resolved_thread_ids の指示も出さない', () => {
    const { system, user } = buildRecordPrompt(recordInput({ openThreads: [] }))
    expect(headings(user)).toEqual(['この章の本文', '名簿', 'この章で張る予定の伏線', '今回の依頼'])
    expect(system).not.toContain('resolved_thread_ids')
    expect(system).not.toContain('【未回収の伏線】')
    expect(system).toContain('written_setup_ids')
  })

  test('張る予定の伏線が無ければ、節も written_setup_ids の指示も出さない', () => {
    const { system, user } = buildRecordPrompt(recordInput({ plannedSetups: [] }))
    expect(headings(user)).toEqual(['この章の本文', '名簿', '未回収の伏線', '今回の依頼'])
    expect(system).not.toContain('written_setup_ids')
    expect(system).not.toContain('【この章で張る予定の伏線】')
    expect(system).toContain('resolved_thread_ids')
  })

  test('伏線が 1 つも無ければ、id の規則も出さない', () => {
    const { system, user } = buildRecordPrompt(recordInput({ openThreads: [], plannedSetups: [] }))
    expect(headings(user)).toEqual(['この章の本文', '名簿', '今回の依頼'])
    expect(system).not.toContain('新しい id は作らない')
    expect(system).not.toContain('既にあるものは入れない')
    // 新しい伏線に id を付けさせない指示は残す
    expect(system).toContain('id は付けない')
  })

  test('名簿が空なら節を出さず、名前は本文の表記で書かせる', () => {
    const { system, user } = buildRecordPrompt(recordInput({ castNames: [], narrator: '朝倉澪' }))
    expect(headings(user)).not.toContain('名簿')
    expect(system).toContain('人物の名前は本文の表記で書く')
    expect(system).not.toContain('【名簿】')
  })

  test('id が空・重複の伏線は、schema の enum と同じ並びに揃える', () => {
    const threads: StoryThread[] = [
      { id: 's1', description: '一つ目' },
      { id: '', description: 'id の無い伏線' },
      { id: 's1', description: '同じ id の二つ目' },
      { id: 's3', description: '三つ目' }
    ]
    const { user } = buildRecordPrompt(recordInput({ openThreads: threads }))
    expect(section(user, '未回収の伏線')).toBe('【未回収の伏線】\n- [s1] 一つ目\n- [s3] 三つ目')
    const schema = recordJsonSchema({
      castNames,
      openThreadIds: threads.map((thread) => thread.id),
      plannedSetupIds: []
    })
    expect(at(schema, 'properties', 'resolved_thread_ids', 'items', 'enum')).toEqual(['s1', 's3'])
  })

  test('出力の見本は schema と同じ項目・同じ順で、ChapterRecordDraftSchema を通る', () => {
    const variants: Array<Partial<RecordPromptInput>> = [
      {},
      { openThreads: [] },
      { plannedSetups: [] },
      { openThreads: [], plannedSetups: [], castNames: [] }
    ]
    for (const overrides of variants) {
      const input = recordInput(overrides)
      const skeleton = skeletonOf(buildRecordPrompt(input).system)
      const schema = recordJsonSchema({
        castNames: input.castNames,
        openThreadIds: input.openThreads.map((thread) => thread.id),
        plannedSetupIds: input.plannedSetups.map((thread) => thread.id)
      })
      // 入れ子の項目まで、schema どおりの応答と同じ並び
      expect(keyPaths(skeleton)).toEqual(keyPaths(sampleOf(schema)))
      const parsed = ChapterRecordDraftSchema.safeParse(skeleton)
      expect(parsed.success).toBe(true)
      expectKeysKept(parsed.data, skeleton)
    }
  })
})

describe('buildRecordPrompt: system の規則', () => {
  const { system } = buildRecordPrompt(recordInput({ narrator: '朝倉澪' }))

  test('本文に書かれていることだけを、後の章がそれだけ読んで分かる文で書かせる', () => {
    expect(system).toContain('本文に書かれていることだけを書く')
    expect(system).toContain('それだけを読んで意味が通る文にする')
    expect(system).toContain('代名詞ではなく名前で書く')
    expect(system).toContain('三人称の常体で書く')
    expect(system).toContain('summary: この章の流れ。実際に起きた出来事を、起きた順に300字程度でまとめる。')
    expect(system).toContain('物語全体の流れとして後の章に渡る')
    expect(system).toContain('1項目に1つの事実を1文で書く')
    expect(system).toContain('章末の時点の状態')
  })

  test('人物ごとに、したこと・知ったこと・章末の状態を分けて書かせる', () => {
    expect(system).toContain('characters: この章に登場した人物ごとに1項目を作り')
    expect(system).toContain('name の人物を主語として読む文にする。主語は書かず、相手や物は名前で書く')
    expect(system).toContain('actions: その人物がこの章でしたこと。後の章に関わる行動を、起きた順に')
    expect(system).toContain('learned: その人物がこの章で新しく知ったこと、気づいたこと')
    expect(system).toContain('誰から聞いたか、何を見て知ったかが分かるようにする')
    // 要点: 知り得ないことを知ったことにしない (後の章で、知らないはずのことを知っている食い違いを防ぐ)
    expect(system).toContain('その人物が本文の中で実際に見聞きしたことだけを書く')
    expect(system).toContain(
      '地の文で読者に明かされただけのことや、その人物がいなかった場面の出来事を、知ったことにしない'
    )
    expect(system).toContain('state: 章末の時点の状態')
    expect(system).toContain('書くことが無ければ空にする')
    expect(system).not.toContain('character_states')
  })

  test('事実と人物ごとの記録を重ねて書かせない。後の章まで続くことは facts に書かせる', () => {
    expect(system).toContain('facts と characters に同じ内容を重ねて書かない')
    expect(system).toContain('1人の人物がしたこと・知ったことは characters に書く')
    // state は累積されず、次の章の記録で置き換わる。続く変化を state だけに書くと数章先で消える
    expect(system).toContain('後の章まで続く外見・服装・持ち物の変化')
    expect(system).toContain('後の章までずっと続くことは facts に書く（state は次の章の記録で置き換わるため）')
  })

  test('数の上限と長さの目安は、保存時の切り詰め (ledger.ts) に収まる', () => {
    expect(system).toContain(`食い違いやすいものから順に、${FACTS_LIMIT}項目まで。`)
    expect(system).toContain(`1項目に1つの行動を1文で書く。${ACTIONS_LIMIT}項目まで。`)
    expect(system).toContain(`何を見て知ったかが分かるようにする。${LEARNED_LIMIT}項目まで。`)
    const stateChars = Number(/変化を、(\d+)字程度までで書く/.exec(system)?.[1])
    expect(stateChars).toBeGreaterThan(0)
    expect(stateChars).toBeLessThan(STATE_MAX)
  })

  test('伏線: 回収は明確に解決したものだけ、新しい伏線は説明だけ', () => {
    expect(system).toContain('この章で明確に解決・回答されたものの id')
    expect(system).toContain('後の章で回収が必要なものだけを書く')
    expect(system).toContain('済んだ出来事や、この章の中で解決したものは入れない')
    expect(system).toContain('id は渡されたものをそのまま書く。新しい id は作らない。')
    expect(system).toContain('【未回収の伏線】や【この章で張る予定の伏線】に既にあるものは入れない')
  })

  test('名簿の人物だけを name と present に書かせる', () => {
    expect(system).toContain('name と present に書けるのは名簿の人物だけ')
  })

  test('規則に、入力の人物名や本文の内容を使わない', () => {
    for (const word of ['朝倉澪', 'ルナ', '柊誠', '澪', '屋上', '望遠鏡', '顧問', '鍵', 's1', 'c1-1', 's2']) {
      expect(system).not.toContain(word)
    }
    expect(system).not.toMatch(/第\s*[0-9０-９]+\s*章/)
  })

  test('同じ条件なら、章や本文が変わっても同じ文面', () => {
    const other = buildRecordPrompt(
      recordInput({
        chapterNumber: 7,
        title: null,
        content: '　別の章の本文。',
        castNames: ['別の人'],
        openThreads: [{ id: 'c5-2', description: '別の伏線' }],
        plannedSetups: [{ id: 's9', description: '別の予定' }]
      })
    )
    expect(other.system).toBe(system)
    expect(system).not.toContain('\n\n\n')
  })
})

// ---------------------- 作品設計: schema ----------------------

describe('bibleJsonSchema', () => {
  test('全年齢: StoryBibleSchema の項目から cast を除く', () => {
    const schema = bibleJsonSchema({ castNames, adult: false })
    expect(keysOf(schema.properties)).toEqual(['premise', 'ending', 'arcs', 'world', 'timeline', 'addresses'])
    expect(keysOf(at(schema, 'properties', 'world', 'properties'))).toEqual(['rules', 'terms'])
    expect(keysOf(at(schema, 'properties', 'world', 'properties', 'terms', 'items', 'properties'))).toEqual([
      'term',
      'note'
    ])
    expectWellFormed(schema)
  })

  test('成人指定: cast を先頭に置き、必須にする', () => {
    const schema = bibleJsonSchema({ castNames, adult: true })
    expect(keysOf(schema.properties)).toEqual(['cast', 'premise', 'ending', 'arcs', 'world', 'timeline', 'addresses'])
    expect(schema.required).toContain('cast')
    expect(keysOf(at(schema, 'properties', 'cast', 'items', 'properties'))).toEqual([
      'name',
      'age',
      'occupation',
      'appearance',
      'background'
    ])
    expectWellFormed(schema)
  })

  test('人物の名前は名簿の enum', () => {
    const schema = bibleJsonSchema({ castNames, adult: true })
    expect(at(schema, 'properties', 'arcs', 'items', 'properties', 'name', 'enum')).toEqual(castNames)
    expect(at(schema, 'properties', 'addresses', 'items', 'properties', 'from', 'enum')).toEqual(castNames)
    expect(at(schema, 'properties', 'addresses', 'items', 'properties', 'to', 'enum')).toEqual(castNames)
    expect(at(schema, 'properties', 'cast', 'items', 'properties', 'name', 'enum')).toEqual(castNames)
    // call は自由な文字列
    expect(at(schema, 'properties', 'addresses', 'items', 'properties', 'call')).toEqual({ type: 'string' })
  })

  test('名簿が空なら addresses と cast を外し、arcs の名前を縛らない', () => {
    const schema = bibleJsonSchema({ castNames: [], adult: true })
    expect(keysOf(schema.properties)).toEqual(['premise', 'ending', 'arcs', 'world', 'timeline'])
    expect(at(schema, 'properties', 'arcs', 'items', 'properties', 'name')).toEqual({ type: 'string' })
    expectWellFormed(schema)
  })

  test('名簿が 1 人なら、組ができないので addresses を外す', () => {
    const schema = bibleJsonSchema({ castNames: ['朝倉澪'], adult: true })
    expect(keysOf(schema.properties)).toEqual(['cast', 'premise', 'ending', 'arcs', 'world', 'timeline'])
  })

  test('schema どおりの応答は StoryBibleSchema を通り、どの項目も捨てられない', () => {
    const variants = [
      bibleJsonSchema({ castNames, adult: true }),
      bibleJsonSchema({ castNames, adult: false }),
      bibleJsonSchema({ castNames: ['朝倉澪'], adult: true }),
      bibleJsonSchema({ castNames: [], adult: false })
    ]
    for (const variant of variants) {
      const response = sampleOf(variant)
      const parsed = StoryBibleSchema.safeParse(response)
      expect(parsed.success).toBe(true)
      expectKeysKept(parsed.data, response)
    }
    // 全項目を出す schema は、Zod の形と項目が過不足なく一致する
    const full = sampleOf(bibleJsonSchema({ castNames, adult: true }))
    expect(keyPaths(StoryBibleSchema.safeParse(full).data).sort()).toEqual(keyPaths(full).sort())
  })

  test('schema の部品を共有しない (書き換えが他の場所に及ばない)', () => {
    const schema = bibleJsonSchema({ castNames, adult: true })
    const from = at(schema, 'properties', 'addresses', 'items', 'properties', 'from')
    const to = at(schema, 'properties', 'addresses', 'items', 'properties', 'to')
    expect(from).toEqual(to)
    expect(from).not.toBe(to)
    expect(at(from, 'enum')).not.toBe(castNames)
  })
})

// ---------------------- 作品設計: プロンプト ----------------------

describe('buildBiblePrompt: 資料', () => {
  test('作品情報 → 登場人物 → キャラクター間の関係 → 呼び方の指定 → 今回の依頼', () => {
    const { system, user } = buildBiblePrompt(bibleInput())
    expect(headings(user)).toEqual(['作品情報', '登場人物', 'キャラクター間の関係', '呼び方の指定', '今回の依頼'])
    expect(user).not.toContain('\n\n\n')
    expect(system).not.toContain('\n\n\n')
  })

  test('結末の方向と年齢指定を渡し、視点・文体・章数・備考・題は渡さない', () => {
    const { system, user } = buildBiblePrompt(bibleInput())
    expect(section(user, '作品情報')).toBe(
      [
        '【作品情報】',
        'ジャンル: 青春',
        '世界観・設定: 地方の高校の天文部。屋上に古い望遠鏡がある。',
        '年齢指定: 全年齢（性的な内容や過度な暴力を前提にした設計にしない）',
        '結末の方向: ハッピーエンド。主要な葛藤が解決し、登場人物が報われる前向きな結末へ向けて構成すること'
      ].join('\n')
    )
    const all = `${system}\n${user}`
    for (const word of ['視点:', '文体:', 'ライトノベル', '章数', '流星群の夜を入れる', '屋上の観測記録']) {
      expect(all).not.toContain(word)
    }
    expect(system).toContain('【作品情報】の「結末の方向」に沿って')
  })

  test('結末が未指定なら行を出さず、結末を 1 つ決めさせる', () => {
    for (const ending of ['未指定', undefined]) {
      const { system, user } = buildBiblePrompt(bibleInput({ style: { ...style, ending } }))
      expect(user).not.toContain('結末の方向')
      expect(system).not.toContain('結末の方向')
      expect(system).toContain('設定と人物から自然に導かれる結末を1つ決め')
    }
  })

  // OpenAI 互換の json_object モードは、入力 (user) に「json」の語が無い要求を拒否する。system は数えられない。
  test('user に「JSON」の語がある', () => {
    const variants: BiblePromptInput[] = [
      bibleInput(),
      bibleInput({ style: { ...style, age_rating: 'R18' } }),
      bibleInput({ cast: [mio], relations: [] }),
      bibleInput({ cast: [], relations: [], style: { pov: '三人称神視点', tone: '一般文芸' } })
    ]
    for (const input of variants) {
      expect(buildBiblePrompt(input).user).toMatch(/json/i)
    }
  })

  test('語り手に注記を付ける', () => {
    const { user } = buildBiblePrompt(bibleInput())
    expect(section(user, '登場人物')).toContain('■ 朝倉澪（17歳・女性・学生）\n  役割: 主人公・語り手')
  })

  test('今回の依頼に名簿と、書く数を示す', () => {
    expect(section(buildBiblePrompt(bibleInput()).user, '今回の依頼')).toBe(
      [
        '【今回の依頼】',
        '- この作品の設計を作る。',
        '- 名簿（人物の名前に使う表記）: 朝倉澪、ルナ、柊誠',
        '- addresses は【呼び方の指定】の6組ぶんを書く。',
        '- 出力は JSON だけにする。'
      ].join('\n')
    )
  })
})

describe('buildBiblePrompt: 呼び方の指定', () => {
  test('名簿の全ての組 (A→B と B→A) について、決め方を 1 つに確定して渡す', () => {
    const { user } = buildBiblePrompt(bibleInput())
    expect(section(user, '呼び方の指定').split('\n').slice(2)).toEqual([
      // 関係の指定が型
      '- 朝倉澪 → ルナ: 型「名前」',
      // 関係の指定が無いので、本人の「他者の呼び方」(型)
      '- 朝倉澪 → 柊誠: 型「苗字＋さん」',
      // 関係の指定が具体的な呼び方
      '- ルナ → 朝倉澪: 指定「ミオっち」',
      // 関係の指定も「他者の呼び方」も無い
      '- ルナ → 柊誠: なし',
      // 「他者の呼び方」が自由記述
      '- 柊誠 → 朝倉澪: 方針（柊誠の「他者の呼び方」）',
      '- 柊誠 → ルナ: 方針（柊誠の「他者の呼び方」）'
    ])
  })

  test('一覧の組を全て書き、一覧に無い組は書かないと伝える', () => {
    const { user } = buildBiblePrompt(bibleInput())
    expect(section(user, '呼び方の指定').split('\n')[1]).toBe(
      '「呼ぶ人 → 呼ばれる人: 決め方」の一覧。呼称表（addresses）には、この一覧の組を全て書く。一覧に無い組は書かない。'
    )
  })

  // 全ての組は人数の 2 乗で増える。名簿が多いときは bible.ts の requiredAddressPairs が組を絞る。
  describe('名簿が多いとき', () => {
    const extras: CastMember[] = ['夏目悠', '氷室蓮', '真壁涼', '久遠司', '伊吹楓', '鳴海渚'].map((name) => ({
      ...hiiragi,
      name,
      address_others: '',
      description: ''
    }))
    const bigCast: CastMember[] = [...cast, ...extras]
    const bigNames = bigCast.map((member) => member.name)
    const bigRelations: CastRelation[] = [
      ...relations,
      { source_name: '夏目悠', target_name: '氷室蓮', relation: '幼なじみ', description: '', address_override: 'レン' }
    ]
    // 一覧の行から「呼ぶ人 → 呼ばれる人」を取り出す
    const pairsOf = (user: string): string[] =>
      section(user, '呼び方の指定')
        .split('\n')
        .slice(2)
        .map((line) => line.slice(2, line.indexOf(':')))

    test('関係を定義した組と、語り手との組だけを並べる (requiredAddressPairs と同じ組・同じ順)', () => {
      const { user } = buildBiblePrompt(bibleInput({ cast: bigCast, relations: bigRelations }))
      const required = requiredAddressPairs(bigNames, bigRelations, '朝倉澪')
      expect(bigCast.length).toBe(9)
      expect(required.length).toBe(18)
      expect(pairsOf(user)).toEqual(required.map((pair) => `${pair.from} → ${pair.to}`))
      const body = section(user, '呼び方の指定')
      // 語り手との組 (両方向)
      expect(body).toContain('- 朝倉澪 → 鳴海渚: 型「苗字＋さん」')
      expect(body).toContain('- 鳴海渚 → 朝倉澪: なし')
      // 関係を定義した組 (両方向)
      expect(body).toContain('- 夏目悠 → 氷室蓮: 指定「レン」')
      expect(body).toContain('- 氷室蓮 → 夏目悠: なし')
      // それ以外の組は並べない
      expect(body).not.toContain('- ルナ → 柊誠')
      expect(section(user, '今回の依頼')).toContain('- addresses は【呼び方の指定】の18組ぶんを書く。')
    })

    test('bibleAddressPairs は一覧と同じ組を返す (生成の後に欠けた組を調べるのに使う)', () => {
      const variants: BiblePromptInput[] = [
        bibleInput(),
        bibleInput({ cast: bigCast, relations: bigRelations }),
        // 視点人物を持たない視点では、viewpointChar が残っていても語り手との組を足さない
        bibleInput({ cast: bigCast, relations: bigRelations, style: { ...style, pov: '三人称多元視点' } }),
        bibleInput({ cast: [mio], relations: [] })
      ]
      for (const input of variants) {
        const { user } = buildBiblePrompt(input)
        expect(bibleAddressPairs(input).map((pair) => `${pair.from} → ${pair.to}`)).toEqual(pairsOf(user))
      }
      expect(bibleAddressPairs(bibleInput({ cast: bigCast, relations: bigRelations }))).toHaveLength(18)
      expect(
        bibleAddressPairs(
          bibleInput({ cast: bigCast, relations: bigRelations, style: { ...style, pov: '三人称多元視点' } })
        )
      ).toHaveLength(6)
    })

    test('語り手がいなければ、関係を定義した組だけ', () => {
      const { user } = buildBiblePrompt(
        bibleInput({ cast: bigCast, relations: bigRelations, style: { ...style, pov: '三人称神視点' } })
      )
      expect(pairsOf(user)).toEqual(
        requiredAddressPairs(bigNames, bigRelations, '').map((pair) => `${pair.from} → ${pair.to}`)
      )
      expect(pairsOf(user)).toHaveLength(6)
    })

    test('書かせる組が無ければ、addresses を空の配列で返させる (schema には項目がある)', () => {
      const input = bibleInput({ cast: bigCast, relations: [], style: { ...style, pov: '三人称神視点' } })
      const { system, user } = buildBiblePrompt(input)
      expect(headings(user)).toEqual(['作品情報', '登場人物', '今回の依頼'])
      expect(headings(system)).not.toContain('呼称表（addresses）')
      expect(section(user, '今回の依頼')).toContain('- addresses は空の配列にする。')
      const skeleton = skeletonOf(system)
      expect(at(skeleton, 'addresses')).toEqual([])
      expect(keysOf(skeleton)).toEqual(keysOf(bibleJsonSchema({ castNames: bigNames, adult: false }).properties))
    })

    test('8 人までは全ての組を並べる', () => {
      const eight = bigCast.slice(0, 8)
      const { user } = buildBiblePrompt(
        bibleInput({ cast: eight, relations: [], style: { ...style, pov: '三人称神視点' } })
      )
      expect(pairsOf(user)).toHaveLength(8 * 7)
    })
  })

  test('呼び方は 1 か所にまとめる: 型の「他者の呼び方」と関係の呼び方は、人物と関係の節に出さない', () => {
    const { user } = buildBiblePrompt(bibleInput())
    const people = section(user, '登場人物')
    expect(people).not.toContain('他者の呼び方: 苗字＋さん')
    // 自由記述は人物の節に残す (一覧の「方針」が指す先)
    expect(people).toContain('  他者の呼び方: 生徒は苗字で呼び捨て、同僚には「先生」を付ける')
    expect(section(user, 'キャラクター間の関係')).toBe(
      [
        '【キャラクター間の関係】',
        '- 朝倉澪から見たルナ: 友人。屋上で出会った',
        '- ルナから見た朝倉澪: 友人',
        '- 朝倉澪から見た柊誠: 教師。部の顧問'
      ].join('\n')
    )
  })

  test('同じ組に関係が複数あれば、具体的な呼び方を持つ最初のものを採る', () => {
    const { user } = buildBiblePrompt(
      bibleInput({
        relations: [
          { source_name: '朝倉澪', target_name: 'ルナ', relation: '友人', description: '', address_override: '名前' },
          {
            source_name: '朝倉澪',
            target_name: 'ルナ',
            relation: '同居人',
            description: '',
            address_override: 'ルナ坊'
          },
          { source_name: '朝倉澪', target_name: 'ルナ', relation: '相棒', description: '', address_override: '相棒' }
        ]
      })
    )
    expect(section(user, '呼び方の指定')).toContain('- 朝倉澪 → ルナ: 指定「ルナ坊」')
  })

  test('利用者が手で書いた型 (「苗字＋先生」) も型として扱い、名前を当てはめない呼び方は指定として扱う', () => {
    const { user } = buildBiblePrompt(
      bibleInput({
        relations: [
          {
            source_name: '朝倉澪',
            target_name: '柊誠',
            relation: '教師',
            description: '',
            address_override: '苗字＋先生'
          },
          { source_name: '柊誠', target_name: '朝倉澪', relation: '教え子', description: '', address_override: '君' }
        ]
      })
    )
    const body = section(user, '呼び方の指定')
    expect(body).toContain('- 朝倉澪 → 柊誠: 型「苗字＋先生」')
    expect(body).toContain('- 柊誠 → 朝倉澪: 指定「君」')
  })

  test('型の当てはめ方の例は架空の名前で示し、入力の人物名を使わない', () => {
    const { system } = buildBiblePrompt(bibleInput())
    expect(system).toContain(
      '相手が「高橋美咲」（姓が高橋、名が美咲）なら、型「名前＋さん」は「美咲さん」、型「苗字」は「高橋」'
    )
    for (const word of ['朝倉', '澪', 'ルナ', '柊', '誠', 'ミオっち', '天文部', '屋上']) {
      expect(system).not.toContain(word)
    }
  })

  test('例の名前が入力の人物名と重なるときは、別の例に替える', () => {
    const takahashi: CastMember = { ...hiiragi, name: '高橋涼' }
    const { system } = buildBiblePrompt(bibleInput({ cast: [mio, takahashi], relations: [] }))
    expect(system).not.toContain('高橋')
    expect(system).toContain(
      '相手が「森川遥」（姓が森川、名が遥）なら、型「名前＋さん」は「遥さん」、型「苗字」は「森川」'
    )
    const misaki: CastMember = { ...runa, name: '美咲' }
    expect(buildBiblePrompt(bibleInput({ cast: [mio, misaki], relations: [] })).system).toContain('森川遥')
  })

  test('名簿が 1 人なら、呼称表を作らせない', () => {
    const { system, user } = buildBiblePrompt(bibleInput({ cast: [mio], relations: [] }))
    expect(headings(user)).toEqual(['作品情報', '登場人物', '今回の依頼'])
    expect(system).not.toContain('addresses')
    expect(system).not.toContain('呼称表')
    expect(user).not.toContain('addresses')
    // 一覧が無いので、「他者の呼び方」は人物の節にも出さない (型のまま渡しても使い道が無い)
    expect(user).not.toContain('他者の呼び方')
  })

  test('名簿が空なら、人物に関わる節と規則を出さない', () => {
    const { system, user } = buildBiblePrompt(bibleInput({ cast: [], relations: [] }))
    expect(headings(user)).toEqual(['作品情報', '今回の依頼'])
    expect(section(user, '今回の依頼')).toBe('【今回の依頼】\n- この作品の設計を作る。\n- 出力は JSON だけにする。')
    expect(system).not.toContain('名簿')
    expect(system).not.toContain('addresses')
  })
})

describe('buildBiblePrompt: 成人指定', () => {
  const adultStyle = (age_rating: string): StyleParams => ({ ...style, age_rating })

  test('全年齢では cast を求めない', () => {
    const { system, user } = buildBiblePrompt(bibleInput())
    expect(system).not.toContain('cast')
    expect(system).not.toContain('成人')
    expect(user).not.toContain('cast')
    expect(keysOf(skeletonOf(system))).toEqual(['premise', 'ending', 'arcs', 'world', 'timeline', 'addresses'])
  })

  test('R15 / R18 では、全員を 18 歳以上の成人として書き直させる', () => {
    for (const rating of ['R15', 'R18']) {
      const { system, user } = buildBiblePrompt(bibleInput({ style: adultStyle(rating) }))
      expect(headings(system)).toContain('成人の人物設定（cast）')
      expect(system).toContain('この作品の登場人物は全員18歳以上の成人である')
      expect(system).toContain('【登場人物】の全員について')
      expect(system).toContain('age は18以上の年齢を、算用数字だけで書く')
      expect(system).toContain('「歳」などの単位や説明を付けず、漢数字や「成人」のような言葉でも書かない')
      expect(system).toContain('未成年を連想させる記述')
      expect(system).toContain('口調と一人称は元の設定をそのまま使うので、ここには書かない')
      expect(keysOf(skeletonOf(system))[0]).toBe('cast')
      expect(section(user, '作品情報')).toContain(`年齢指定: ${rating}（`)
      expect(section(user, '作品情報')).toContain('登場人物は全員18歳以上の成人）')
      expect(section(user, '今回の依頼')).toContain('- cast は名簿の3人ぶんを書く。')
    }
  })

  test('成人指定で名簿が空なら、cast は求めず、成人の原則だけ残す', () => {
    const { system, user } = buildBiblePrompt(bibleInput({ style: adultStyle('R18'), cast: [], relations: [] }))
    expect(headings(system)).not.toContain('成人の人物設定（cast）')
    expect(system).toContain('この作品の登場人物は全員18歳以上の成人である')
    expect(keysOf(skeletonOf(system))).toEqual(['premise', 'ending', 'arcs', 'world', 'timeline'])
    expect(user).not.toContain('cast')
  })

  test('年齢指定が無い・知らない値なら、行を出さず cast も求めない', () => {
    for (const age_rating of [undefined, '', 'PG12']) {
      const { system, user } = buildBiblePrompt(bibleInput({ style: { ...style, age_rating } }))
      expect(user).not.toContain('年齢指定')
      expect(system).not.toContain('cast')
    }
  })

  test('出力の見本は schema と同じ項目・同じ順で、StoryBibleSchema を通る', () => {
    const variants: BiblePromptInput[] = [
      bibleInput(),
      bibleInput({ style: adultStyle('R15') }),
      bibleInput({ style: adultStyle('R18'), cast: [mio], relations: [] }),
      bibleInput({ style: adultStyle('R18'), cast: [], relations: [] }),
      bibleInput({ cast: [], relations: [] })
    ]
    for (const input of variants) {
      const skeleton = skeletonOf(buildBiblePrompt(input).system)
      const schema = bibleJsonSchema({
        castNames: input.cast.map((member) => member.name),
        adult: input.style.age_rating === 'R15' || input.style.age_rating === 'R18'
      })
      // 入れ子の項目まで、schema どおりの応答と同じ並び
      expect(keyPaths(skeleton)).toEqual(keyPaths(sampleOf(schema)))
      const parsed = StoryBibleSchema.safeParse(skeleton)
      expect(parsed.success).toBe(true)
      expectKeysKept(parsed.data, skeleton)
    }
  })
})

describe('buildBiblePrompt: system の規則', () => {
  const { system } = buildBiblePrompt(bibleInput())

  test('各項目の書き方', () => {
    expect(system).toContain('premise: 物語の核。誰が何を求め、何がそれを妨げるか')
    expect(system).toContain('最終章で誰に何が起きるか')
    expect(system).toContain('物語の始まりの状態（start）と終わりの状態（end）')
    expect(system).toContain('world.rules: 後の章が守るべきルール')
    expect(system).toContain('world.terms: 表記を固定する固有名詞や用語')
    expect(system).toContain('日付や曜日を決めるなら、ここで決める')
  })

  test('入力に無い設定を増やしすぎない', () => {
    expect(system).toContain('入力に無い固有名詞や設定は、物語に欠かせないものだけを最小限決める')
  })

  test('呼称表: 一覧の組ごとに、台詞にそのまま書ける呼び方を 1 つ', () => {
    expect(system).toContain('【呼び方の指定】の組ごとに')
    expect(system).toContain('call は台詞にそのまま書ける文字列にする')
    expect(system).toContain('姓と名の区切りが分からない名前は、もっとも自然な読みで分ける')
    expect(system).toContain('「指定」はそのまま call にする')
  })
})
