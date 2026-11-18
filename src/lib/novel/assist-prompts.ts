import { type AddressPair, isAddressPattern, isAdultRating, requiredAddressPairs } from '@/lib/novel/bible'
import { hasAddressPairs, usableValues } from '@/lib/novel/json-schemas'
import { ACTIONS_LIMIT, FACTS_LIMIT, LEARNED_LIMIT } from '@/lib/novel/ledger'
import {
  ADDRESS_PATTERN_RULE,
  addressTableBody,
  bibleBody,
  bullets,
  type CastMember,
  type CastRelation,
  castBody,
  castForAddresses,
  chapterLabel,
  ENDING_LINES,
  inlineJson,
  JSON_ONLY_REQUEST,
  ledgerBody,
  type NovelParams,
  narratorName,
  narratorTag,
  novelInfoBody,
  oneLine,
  outlineChapterBlock,
  type Prompt,
  relationsBody,
  renderSections,
  type Section,
  type SkeletonValue,
  type StyleParams,
  trimChapterText
} from '@/lib/novel/prompts'
import type { OutlineChapter } from '@/schemas/novel.dto'
import {
  type AddressEntry,
  REVIEW_ISSUE_KINDS,
  type ReviewIssueKind,
  type StoryBible,
  type StoryThread
} from '@/schemas/story.dto'

// 補助の呼び出し (章の記録の抽出、作品設計、検査) のプロンプト (純粋関数)。cloudflare:workers、Prisma、fetch に依存させない。
//
// 文面の方針は prompts.ts と同じ (system は規則、user は資料と今回の依頼。常体の箇条書き)。加えて:
// - 項目の出し分け (伏線の id、名簿、成人の人物設定) は json-schemas.ts の schema と同じ条件にする。
//   schema を使えない呼び出し (OpenAI 互換の json_object) でも同じ形が返るよう、出力の見本を system に書く。
// - 規則の例に、入力の人物名や本文の内容を使わない (例をそのまま答えに写されないようにする)。
// - user の【今回の依頼】に「JSON」の語を必ず入れる (JSON_ONLY_REQUEST。理由は prompts.ts の定義にある)。

// 出力の形の見本。キーの有無と順序は json-schemas.ts の schema と同じにする (テストで突き合わせる)。
// 値は項目の意味を表す仮の文字列で、全体は JSON として読める形にしておく。
function jsonSkeleton(entries: Array<[string, SkeletonValue]>): string {
  const lines = entries.map(([key, value]) => `  ${JSON.stringify(key)}: ${inlineJson(value)}`)
  return `{\n${lines.join(',\n')}\n}`
}

// 条件つきの項目。条件を満たさなければ見本に入れない。
function optionalEntry(include: boolean, key: string, value: SkeletonValue): Array<[string, SkeletonValue]> {
  return include ? [[key, value]] : []
}

const OUTPUT_RULE = 'JSON だけを出力する。値は日本語で書く。形式は次のとおり。'

function outputSection(skeleton: string): Section {
  return { heading: '出力', body: `${bullets([OUTPUT_RULE])}\n${skeleton}` }
}

// ---------------------- 章の記録の抽出 (Phase 2) ----------------------

export type RecordPromptInput = {
  chapterNumber: number
  title: string | null
  // この章の本文
  content: string
  // 人物の状態に使ってよい名前 (名簿)
  castNames: string[]
  // この章の前までに未回収の伏線 (id つき)
  openThreads: StoryThread[]
  // 章立てでこの章に張る予定の伏線 (Phase 3 から渡る。それまでは空)
  plannedSetups: StoryThread[]
  // 一人称の本文の語り手の名前 (任意)。名簿にあれば「私」が誰かを資料に書く
  narrator?: string
}

// 要約の長さの目安。
const RECORD_SUMMARY_CHARS = 300
// 項目の数の上限は ledger.ts のもの (FACTS_LIMIT、ACTIONS_LIMIT、LEARNED_LIMIT) をそのまま指示する。
// 超えた分は保存時に後ろから捨てられるので、事実は大事なものから書かせる。
// 人物の状態の長さの目安。ledger.ts は STATE_MAX (300) 字で切る。文の途中で切れないよう、それより短く指示する。
// 別の数字なので定数からは作らない (STATE_MAX より小さいことはテストで確かめる)。
const RECORD_STATE_CHARS = 200

// id が空のものと、id が重複するもの (2 つ目以降) を除く。schema の enum (usableValues) と同じ並びになる。
function usableThreads(threads: StoryThread[]): StoryThread[] {
  return usableValues(threads.map((thread) => thread.id)).flatMap((id) => {
    const thread = threads.find((candidate) => candidate.id === id)
    return thread === undefined ? [] : [thread]
  })
}

// ledger.ts の【確定事項】と同じ「[id] 説明」の形。
function threadsBody(threads: StoryThread[]): string {
  return threads.map((thread) => `- [${thread.id}] ${oneLine(thread.description)}`.trimEnd()).join('\n')
}

type RecordFlags = { hasRoster: boolean; hasOpen: boolean; hasPlanned: boolean }

function recordSkeleton(flags: RecordFlags): string {
  return jsonSkeleton([
    ['summary', 'この章で起きたこと'],
    ['facts', ['確定した事実']],
    ['characters', [{ name: '人物の名前', actions: ['したこと'], learned: ['知ったこと'], state: '章末の時点の状態' }]],
    ['new_threads', ['新しく生まれた伏線の説明']],
    ...optionalEntry(flags.hasOpen, 'resolved_thread_ids', ['回収された伏線の id']),
    ...optionalEntry(flags.hasPlanned, 'written_setup_ids', ['書かれた伏線の id']),
    ['end_state', { time: '時', place: '場所', present: ['人物の名前'] }]
  ])
}

const RECORD_ROLE =
  'あなたは小説の編集者として、書き上がった1章の本文から、後の章の執筆に引き継ぐ記録を作る。記録に無い事実は後の章で食い違いやすいので、後の章が守るべきことを落とさずに書く。'

function recordSystem(flags: RecordFlags): string {
  const principles = [
    '本文に書かれていることだけを書く。推測、本文に無い設定、今後の展開の予想は足さない。',
    '後の章を書くときは、本文を読まずにこの記録だけを見ることがある。各項目は、それだけを読んで意味が通る文にする。人物は代名詞ではなく名前で書く。',
    '三人称の常体で書く。本文が一人称でも、語り手を名前で書く。',
    '一覧の項目（facts、actions、learned、new_threads など）は、該当するものが無ければ空にする。数を揃えるために足さない。',
    flags.hasRoster
      ? '人物の名前は【名簿】の表記で書く。name と present に書けるのは名簿の人物だけ。名簿に無い人物について残すことは facts に書く。'
      : '人物の名前は本文の表記で書く。'
  ]
  // 既に渡した伏線を new_threads に重ねて書かせない (同じ伏線に id が 2 つ付くのを防ぐ)。
  const known = [flags.hasOpen ? '【未回収の伏線】' : '', flags.hasPlanned ? '【この章で張る予定の伏線】' : ''].filter(
    (name) => name.length > 0
  )
  const fields = [
    // 各章の summary は、章順に並べて「これまでの流れ」として後の章に渡る (ledger.ts)。
    `summary: この章の流れ。実際に起きた出来事を、起きた順に${RECORD_SUMMARY_CHARS}字程度でまとめる。各章の summary を章順に並べたものが、物語全体の流れとして後の章に渡る。`,
    // facts は全章ぶんが残る。人物の state は次の章の記録で置き換わる (ledger.ts は空でない最新のものだけを持つ)。
    // 続けている変装のように後の章まで守ることを state だけに書くと、数章先で消える。そこで facts に書かせる。
    `facts: この章で確定し、後の章が矛盾させてはいけない事実。1項目に1つの事実を1文で書く。対象は、物や場所のこと、日時・期間・数量、複数の人物に関わる約束や取り決め、誰に何が隠されているか、後の章まで続く外見・服装・持ち物の変化。この章の中で変わったものは、変わった後の状態が分かるように書く。後の章で食い違いやすいものから順に、${FACTS_LIMIT}項目まで。`,
    'facts と characters に同じ内容を重ねて書かない。1人の人物がしたこと・知ったことは characters に書く。物や場所のこと、複数の人物に関わること、後の章までずっと続くことは facts に書く（state は次の章の記録で置き換わるため）。',
    // 人物ごとの記録は、後の章のプロンプトで人物の名前の下に並ぶ (したことは 1 章ぶんを 1 行につなぐ)。
    // 主語を省いた短い文にさせ、全章ぶんが累積しても読める長さに保つ。
    'characters: この章に登場した人物ごとに1項目を作り、name に人物の名前、actions・learned・state に次の内容を書く。どれも name の人物を主語として読む文にする。主語は書かず、相手や物は名前で書く。',
    `actions: その人物がこの章でしたこと。後の章に関わる行動を、起きた順に、1項目に1つの行動を1文で書く。${ACTIONS_LIMIT}項目まで。`,
    // learned は全章ぶんが累積して、後の章で「その人物が知っていること」として渡る。
    // 知らないはずのことを知っている・知っているはずのことを知らない、という食い違いを防ぐための項目。
    `learned: その人物がこの章で新しく知ったこと、気づいたこと。1項目に1つを1文で書き、誰から聞いたか、何を見て知ったかが分かるようにする。${LEARNED_LIMIT}項目まで。`,
    'learned には、その人物が本文の中で実際に見聞きしたことだけを書く。地の文で読者に明かされただけのことや、その人物がいなかった場面の出来事を、知ったことにしない。',
    `state: 章末の時点の状態。居場所、外見や持ち物の変化、他の人物との関係の変化を、${RECORD_STATE_CHARS}字程度までで書く。書くことが無ければ空にする。`,
    [
      'new_threads: この章で生まれ、後の章で回収が必要なものだけを書く。未解決の問い、果たされていない約束、予告が当たる。済んだ出来事や、この章の中で解決したものは入れない。1項目に1つを1文で説明し、id は付けない。',
      known.length > 0 ? `${known.join('や')}に既にあるものは入れない。` : ''
    ].join(''),
    flags.hasOpen
      ? 'resolved_thread_ids: 【未回収の伏線】のうち、この章で明確に解決・回答されたものの id。触れられただけ、進展しただけのものは入れない。'
      : '',
    flags.hasPlanned
      ? 'written_setup_ids: 【この章で張る予定の伏線】のうち、この章の本文に実際に書かれたものの id。'
      : '',
    known.length > 0 ? 'id は渡されたものをそのまま書く。新しい id は作らない。' : '',
    'end_state: 章の最後の場面の状況。time は時（日付、時刻、時間帯）、place は場所、present はその場にいる人物。本文から分からないものは空にする。'
  ].filter((line) => line.length > 0)

  const sections = renderSections([
    { heading: '記録の原則', body: bullets(principles) },
    { heading: '各項目の書き方', body: bullets(fields) },
    outputSection(recordSkeleton(flags))
  ])
  return `${RECORD_ROLE}\n\n${sections}`
}

// 章の記録を抽出するプロンプト。返させる形は ChapterRecordDraftSchema。
// 本文が空なら throw する (空の本文から記録を作らせると、作り話の記録が後の章に広がるため)。
export function buildRecordPrompt(input: RecordPromptInput): Prompt {
  const text = trimChapterText(input.content)
  if (text.length === 0) {
    throw new Error(`Chapter ${input.chapterNumber} has no content to record`)
  }
  const label = chapterLabel(input.chapterNumber, input.title)
  const roster = usableValues(input.castNames)
  const openThreads = usableThreads(input.openThreads)
  const plannedSetups = usableThreads(input.plannedSetups)
  const narrator = input.narrator !== undefined && roster.includes(input.narrator) ? input.narrator : undefined

  // 長い本文を先に、照らし合わせる資料と依頼を後に置く (依頼が本文に埋もれないようにする)。
  const sections: Section[] = [
    // 章の見出しは本文プロンプトの【確定済みの本文】と同じ「▼」で始める。
    { heading: 'この章の本文', body: `▼ ${label}\n${text}` },
    {
      heading: '名簿',
      body: [roster.join('、'), narrator === undefined ? '' : `語り手（本文の一人称の人物）: ${narrator}`]
        .filter((line) => line.length > 0)
        .join('\n')
    },
    { heading: '未回収の伏線', body: threadsBody(openThreads) },
    { heading: 'この章で張る予定の伏線', body: threadsBody(plannedSetups) },
    { heading: '今回の依頼', body: bullets([`${label}の記録を作る。`, JSON_ONLY_REQUEST]) }
  ]
  return {
    system: recordSystem({
      hasRoster: roster.length > 0,
      hasOpen: openThreads.length > 0,
      hasPlanned: plannedSetups.length > 0
    }),
    user: renderSections(sections)
  }
}

// ---------------------- 作品設計 (Phase 3) ----------------------

export type BiblePromptInput = {
  novel: NovelParams
  style: StyleParams
  cast: CastMember[]
  relations: CastRelation[]
}

// from が to を呼ぶときの決め方。型かどうかは bible.ts の isAddressPattern で見分ける (後処理の completeAddresses と同じ判定)。
// 優先順位 (関係の指定 > 人物の「他者の呼び方」) をここで確定し、
// モデルには決まった 1 つだけを渡す (組ごとに優先順位を解釈させない)。
//   fixed    関係で指定された具体的な呼び方。そのまま使う
//   pattern  型 (「名前」「苗字＋さん」など)。相手の名前に当てはめる
//   policy   人物の「他者の呼び方」が型でない (具体的な呼び方か、自由記述の方針)。それに沿って決める
//   none     指定なし
type AddressRule =
  | { kind: 'fixed'; value: string }
  | { kind: 'pattern'; value: string }
  | { kind: 'policy' }
  | { kind: 'none' }

function addressRule(from: CastMember, to: string, relations: CastRelation[]): AddressRule {
  const fromName = from.name.trim()
  const overrides = relations
    .filter((relation) => relation.source_name.trim() === fromName && relation.target_name.trim() === to)
    .map((relation) => relation.address_override.trim())
    .filter((override) => override.length > 0)
  // 同じ組に関係が複数あるときは、具体的な呼び方を持つ最初のものを採る (bible.ts の completeAddresses と同じ)。
  const fixed = overrides.find((override) => !isAddressPattern(override))
  if (fixed !== undefined) return { kind: 'fixed', value: fixed }
  if (overrides.length > 0) return { kind: 'pattern', value: overrides[0] }
  const fallback = from.address_others.trim()
  if (fallback.length === 0) return { kind: 'none' }
  return isAddressPattern(fallback) ? { kind: 'pattern', value: fallback } : { kind: 'policy' }
}

function addressRuleText(rule: AddressRule, from: string): string {
  if (rule.kind === 'fixed') return `指定「${oneLine(rule.value)}」`
  if (rule.kind === 'pattern') return `型「${rule.value}」`
  if (rule.kind === 'policy') return `方針（${from}の「他者の呼び方」）`
  return 'なし'
}

// 呼称表に書かせる組ごとの、呼び方の決め方。同じ名前の人物が複数いても、名前ごとに 1 人として扱う。
function addressWorklist(pairs: AddressPair[], cast: CastMember[], relations: CastRelation[]): string[] {
  return pairs.flatMap((pair) => {
    const from = cast.find((member) => member.name.trim() === pair.from)
    if (from === undefined) return []
    return [`- ${pair.from} → ${pair.to}: ${addressRuleText(addressRule(from, pair.to, relations), pair.from)}`]
  })
}

// 一覧の組は bible.ts の requiredAddressPairs が決める (名簿が多いときは、関係を定義した組と語り手との組に絞られる)。
// 生成の後、この組が揃っているかを同じ関数で確かめる (missingAddressPairs)。一覧に無い組は書かせない。
const ADDRESS_WORKLIST_LEAD =
  '「呼ぶ人 → 呼ばれる人: 決め方」の一覧。呼称表（addresses）には、この一覧の組を全て書く。一覧に無い組は書かない。'

// 型の当てはめ方を示す例に使う、架空の人物。入力の人物名と重ならないものを選ぶ
// (例の名前が入力にあると、その人物の呼び方として写されるため)。
const EXAMPLE_NAMES = [
  { family: '高橋', given: '美咲' },
  { family: '森川', given: '遥' },
  { family: '藤堂', given: '千尋' },
  { family: '早瀬', given: '圭吾' }
] as const

function exampleName(castNames: string[]): { family: string; given: string } {
  const free = EXAMPLE_NAMES.find(
    (example) => !castNames.some((name) => name.includes(example.family) || name.includes(example.given))
  )
  return free === undefined ? EXAMPLE_NAMES[0] : free
}

type BibleFlags = {
  hasRoster: boolean
  // 成人指定 (R15 / R18) か
  adult: boolean
  // 成人としての人物設定 (cast) を書かせるか (成人指定で、名簿があるとき)
  adultCast: boolean
  // 出力に addresses の項目があるか (名簿が 2 人以上。json-schemas.ts の schema と同じ条件)
  hasAddresses: boolean
  // 呼称表に書かせる組があるか。hasAddresses で組が無いとき (名簿が多く、関係も語り手も無い) は空の配列を返させる
  hasPairs: boolean
  // 結末の方向の指定があるか
  hasEnding: boolean
  example: { family: string; given: string }
}

function bibleSkeleton(flags: BibleFlags): string {
  return jsonSkeleton([
    ...optionalEntry(flags.adultCast, 'cast', [
      { name: '人物の名前', age: '年齢の数字', occupation: '職業', appearance: '外見', background: '背景' }
    ]),
    ['premise', '物語の核'],
    ['ending', '結末の具体像'],
    ['arcs', [{ name: '人物の名前', start: '始まりの状態', end: '終わりの状態' }]],
    ['world', { rules: ['ルール'], terms: [{ term: '用語', note: '説明' }] }],
    ['timeline', ['時系列の項目']],
    ...optionalEntry(
      flags.hasAddresses,
      'addresses',
      flags.hasPairs ? [{ from: '呼ぶ人の名前', to: '呼ばれる人の名前', call: '呼び方' }] : []
    )
  ])
}

const BIBLE_ROLE =
  'あなたは小説の編集者として、執筆の前に作品全体の設計を作る。この設計は章立てと全ての章の執筆に同じものが渡され、設定・呼称・時系列を章をまたいで揃える基準になる。'

// 成人指定 (R15 / R18) の作品の原則。名簿が無くても出す。
const BIBLE_ADULT_PRINCIPLE =
  'この作品の登場人物は全員18歳以上の成人である。設計のどの項目にも未成年の人物を置かない。設定に高校以下の学校や学年が出てくる場合は大学か職場に置き換え、premise、world、timeline もそれに合わせて書く。'

// 成人としての人物設定の書き方。cast は出力の先頭に置く (成人としての年齢と職業を先に決めさせ、後の項目をそれに合わせさせる)。
// ここで書かせた文面は、章立てと本文のプロンプトで辞典の原文の代わりに使われる (bible.ts の applyBibleCast)。
const BIBLE_ADULT_CAST_RULES = [
  '【登場人物】の全員について、年齢（age）、職業（occupation）、外見（appearance）、背景（background）を、18歳以上の成人として書き直す。',
  // bible.ts の validateAdultCast は、年齢が数字で読めて 18 以上でなければ作品設計を保存しない。
  'age は18以上の年齢を、算用数字だけで書く。「歳」などの単位や説明を付けず、漢数字や「成人」のような言葉でも書かない。',
  '未成年を連想させる記述（学年、制服、「少女」「少年」のように十代以下を指す語、幼さを強調する描写）を残さない。年齢相応の大人として書く。',
  'appearance と background は、本文を書くときに元の設定の代わりに使われる。未成年を連想させる部分だけを直し、性格、能力、経歴、他の人物との関わりは元の内容を落とさずに書く。',
  '口調と一人称は元の設定をそのまま使うので、ここには書かない。'
]

function bibleSystem(flags: BibleFlags): string {
  const principles = [
    '渡された設定と人物設定に基づいて決める。それらと矛盾させない。',
    '入力に無い固有名詞や設定は、物語に欠かせないものだけを最小限決める。',
    '曖昧な書き方で残さず、1つに決めて書く。後の章はここに書かれたとおりに書く。',
    '三人称の常体で、事実として書く。宣伝文のような煽りや、語り手の一人称では書かない。',
    flags.hasRoster ? '人物の名前は名簿の表記で書く。' : '',
    flags.adult ? BIBLE_ADULT_PRINCIPLE : ''
  ].filter((line) => line.length > 0)
  const fields = [
    'premise: 物語の核。誰が何を求め、何がそれを妨げるかを書く。',
    flags.hasEnding
      ? 'ending: 結末の具体像。【作品情報】の「結末の方向」に沿って、最終章で誰に何が起きるかを書く。'
      : 'ending: 結末の具体像。設定と人物から自然に導かれる結末を1つ決め、最終章で誰に何が起きるかを書く。',
    'arcs: 主要な人物ごとに、物語の始まりの状態（start）と終わりの状態（end）を書く。',
    'world.rules: 後の章が守るべきルール。できること・できないこと、制度、技術や魔法の制約を、1項目に1つ書く。',
    'world.terms: 表記を固定する固有名詞や用語（term）と、その説明（note）。',
    'timeline: 物語内の期間、季節、主な出来事の順序を、起きる順に1項目ずつ書く。日付や曜日を決めるなら、ここで決める。'
  ]
  const { family, given } = flags.example
  const addresses = [
    '【呼び方の指定】の組ごとに、from（呼ぶ人）が to（呼ばれる人）を呼ぶときの呼び方（call）を1つ決める。',
    'call は台詞にそのまま書ける文字列にする。型や説明のままにしない。',
    `「型」は相手の名前に当てはめる。たとえば相手が「${family}${given}」（姓が${family}、名が${given}）なら、型「名前＋さん」は「${given}さん」、型「苗字」は「${family}」になる。`,
    '姓と名の区切りが分からない名前は、もっとも自然な読みで分ける。姓と名に分かれない名前は、その名前をそのまま当てはめる。',
    '「指定」はそのまま call にする。「方針」はその人物の「他者の呼び方」に沿って、「なし」は関係と人物像に合わせて、呼び方を決める。'
  ]
  const sections = renderSections([
    { heading: '設計の原則', body: bullets(principles) },
    { heading: '成人の人物設定（cast）', body: flags.adultCast ? bullets(BIBLE_ADULT_CAST_RULES) : '' },
    { heading: '各項目の書き方', body: bullets(fields) },
    { heading: '呼称表（addresses）', body: flags.hasPairs ? bullets(addresses) : '' },
    outputSection(bibleSkeleton(flags))
  ])
  return `${BIBLE_ROLE}\n\n${sections}`
}

// 年齢指定の行。本文プロンプトの文面 (prompts.ts の RATING_LINES) は描写の踏み込み方の指示で、設計には要らない。
// 設計に関わること (内容の範囲、全員が成人であること) だけを書く。成人としての書き直し方は system の規則にある。
const BIBLE_RATING_LINES: Record<string, string | undefined> = {
  全年齢: '全年齢（性的な内容や過度な暴力を前提にした設計にしない）',
  R15: 'R15（登場人物は全員18歳以上の成人）',
  R18: 'R18（成人向け。登場人物は全員18歳以上の成人）'
}

// 年齢指定と結末の方向。視点と文体は渡さない (設計は文体に依らない。視点の文面を渡すと設計が一人称で書かれる)。
function bibleInfoBody(novel: NovelParams, style: StyleParams): string {
  const rating = style.age_rating === undefined ? undefined : BIBLE_RATING_LINES[style.age_rating]
  const ending = style.ending === undefined ? undefined : ENDING_LINES[style.ending]
  return [
    // 章数は渡さない (作品設計は章立ての前に作り、章数を変えても作り直さない)。
    novelInfoBody(novel, false),
    rating === undefined ? '' : `年齢指定: ${rating}`,
    ending === undefined ? '' : `結末の方向: ${style.ending}。${ending}`
  ]
    .filter((line) => line.length > 0)
    .join('\n')
}

// 呼称表に書かせる組 (【呼び方の指定】に並べる組と同じもの、同じ順)。
// 生成の後に欠けた組を調べるとき (bible.ts の missingAddressPairs) は、この関数の戻り値を required に渡す。
// 語り手の決め方 (視点人物を持つ視点で、名簿にいるときだけ) をプロンプトと揃えるため。
export function bibleAddressPairs(input: BiblePromptInput): AddressPair[] {
  const roster = usableValues(input.cast.map((member) => member.name))
  const narrator = narratorName(input.style, input.cast)
  return requiredAddressPairs(roster, input.relations, narrator === undefined ? '' : narrator)
}

// 作品設計のプロンプト。返させる形は StoryBibleSchema (成人指定でなければ cast は出させない)。
export function buildBiblePrompt(input: BiblePromptInput): Prompt {
  const { novel, style, cast, relations } = input
  const roster = usableValues(cast.map((member) => member.name))
  const adult = style.age_rating !== undefined && isAdultRating(style.age_rating)
  const adultCast = adult && roster.length > 0
  const narrator = narratorName(style, cast)
  // 出力に addresses の項目があるかは、schema (bibleJsonSchema) と同じく名簿の人数だけで決める。
  // schema は関係と語り手を受け取らないので、組の有無で項目を出し分けると、schema とプロンプトが食い違う。
  const hasAddresses = hasAddressPairs(roster)
  const worklist = hasAddresses ? addressWorklist(bibleAddressPairs(input), cast, relations) : []
  const hasPairs = worklist.length > 0

  // 呼び方は【呼び方の指定】の 1 か所にまとめる。型の「他者の呼び方」と関係の呼び方の指定は、
  // 人物と関係の節からは外す (同じ情報が 2 か所にあると、どちらに従うかを解釈させることになる)。
  // 自由記述の「他者の呼び方」は人物の節に残し、一覧からは「方針」として指す。
  const castForBody = cast.map((member) =>
    isAddressPattern(member.address_others) ? { ...member, address_others: '' } : member
  )
  const relationsForBody = relations.map((relation) => ({ ...relation, address_override: '' }))

  const request = [
    'この作品の設計を作る。',
    roster.length > 0 ? `名簿（人物の名前に使う表記）: ${roster.join('、')}` : '',
    adultCast ? `cast は名簿の${roster.length}人ぶんを書く。` : '',
    hasPairs ? `addresses は【呼び方の指定】の${worklist.length}組ぶんを書く。` : '',
    // 名簿が多く、関係も語り手も無いと、書かせる組が無い。schema には addresses があるので、空で返させる。
    hasAddresses && !hasPairs ? 'addresses は空の配列にする。' : '',
    JSON_ONLY_REQUEST
  ].filter((line) => line.length > 0)

  const sections: Section[] = [
    { heading: '作品情報', body: bibleInfoBody(novel, style) },
    {
      heading: '登場人物',
      body: castBody(castForBody, (member) => (member.name === narrator ? narratorTag(style) : ''))
    },
    { heading: 'キャラクター間の関係', body: relationsBody(relationsForBody) },
    { heading: '呼び方の指定', body: hasPairs ? [ADDRESS_WORKLIST_LEAD, ...worklist].join('\n') : '' },
    { heading: '今回の依頼', body: bullets(request) }
  ]
  return {
    system: bibleSystem({
      hasRoster: roster.length > 0,
      adult,
      adultCast,
      hasAddresses,
      hasPairs,
      hasEnding: style.ending !== undefined && ENDING_LINES[style.ending] !== undefined,
      example: exampleName(roster)
    }),
    user: renderSections(sections)
  }
}

// ---------------------- 検査 (Phase 5) ----------------------

export type ReviewPromptInput = {
  chapterNumber: number
  title: string | null
  // 検査する章の本文
  content: string
  // この章の計画 (概要、出来事、章末の状況、伏線)
  entry: OutlineChapter
  bible: StoryBible | null
  // この章より前の章までの確定事項 (ledger.ts の renderLedger の出力。無ければ '')
  ledgerText: string
  // この章に登場する人物 (成人指定なら差し替え済み)
  cast: CastMember[]
  // 登場人物どうしの呼称 (呼称表があるとき)
  addresses: AddressEntry[]
  style: StyleParams
}

// 1 回の検査で挙げさせる数の上限。警告が多いと読まれなくなるので、はっきりしたものに絞らせる。
export const REVIEW_ISSUES_MAX = 10
// 引用の長さ (字)。短すぎると本文のどこか分からず、長すぎると一字一句の一致が崩れやすい。
export const REVIEW_QUOTE_MIN_CHARS = 10
export const REVIEW_QUOTE_MAX_CHARS = 80

type ReviewFlags = {
  hasBible: boolean
  hasLedger: boolean
  hasCast: boolean
  // 【呼称】の節がある
  hasAddresses: boolean
  // 人物の「他者の呼び方」の行が残っている (呼称が無いか、呼称に無い組がある)
  hasAddressPatterns: boolean
  // この章の計画に「張る伏線」がある
  hasSetups: boolean
}

const REVIEW_ROLE =
  'あなたは小説の校閲者として、書き上がった1章の本文を資料と突き合わせ、資料と食い違う箇所を挙げる。指摘は作者にそのまま見せ、書き直しの指示にも使う。誤った指摘が混ざると指摘が読まれなくなるので、はっきり食い違う箇所だけを挙げる。'

// 何を挙げ、何を挙げないか。誤検出を減らす向きの規則を先に置く。
function reviewPrinciples(flags: ReviewFlags): string[] {
  return [
    '挙げるのは、本文が資料の記述と食い違う箇所だけにする。文章の好み、表現の改善案、構成の提案は挙げない。',
    '資料に書かれていないことは、食い違いではない。本文が新しく決めたこと（資料に無い人物、物、出来事、細部）は新しい事実であって、指摘しない。',
    '確信が持てないものは挙げない。資料のどの記述と食い違うかを示せないもの、読み方によっては両立するものは挙げない。',
    '挙げるのは、本文に書かれている箇所だけにする。書かれていないこと（計画にある出来事が抜けている、など）は挙げない。',
    `同じ食い違いが何度も出てくるときは、最初の1箇所だけを挙げる。はっきりしたものから順に、${REVIEW_ISSUES_MAX}件まで。`,
    '食い違いが無ければ、issues は空の配列にする。数を揃えるために挙げない。',
    // 作品設計の結末と、人物の変化の終わりの状態は、最終章で至るもの。途中の章が達していないことを指摘させない。
    flags.hasBible
      ? '【作品設計】の「結末」と、「人物の変化」の終わりの状態は、物語の最後に至るものである。この章がまだそこに達していないことは、食い違いではない。'
      : '',
    // 人物の設定 (辞典) は章が進んでも同じ文面で渡る。変装や関係の進展を、設定との食い違いとして挙げさせない。
    flags.hasCast
      ? `【登場人物】の設定は、物語の始まりの時点のものである。${flags.hasLedger ? '前の章までに変わったこと（【確定事項】にある）や、' : ''}この章の中で変わること（外見、持ち物、関係）は、食い違いではない。`
      : '',
    // 確定事項の「知っていること」は 1 章あたり数項目の抜粋。一覧に無いことを知っているだけでは指摘させない。
    flags.hasLedger
      ? '【確定事項】は、この章より前の章までの本文から抜き出した記録である。「知っていること」は抜粋で、全部ではない。一覧に無いことを人物が知っているだけでは挙げない。'
      : '',
    flags.hasLedger
      ? '【確定事項】の「直前の章の終わり」から時間や場所が移っていること自体は、食い違いではない（章の間で時間は進む）。'
      : '',
    '【この章の計画】は、この章で書く予定だった内容である。本文に計画に無い細部があることは、食い違いではない。'
  ].filter((rule) => rule.length > 0)
}

// 種別ごとの、挙げる対象。画面の種別のラベル (設定、既出の事実、呼び方、時系列、伏線、人物の居場所・知識、その他) と対応する。
function reviewKindRules(flags: ReviewFlags): Record<ReviewIssueKind, string> {
  const settingSource = [flags.hasBible ? '【作品設計】' : '', flags.hasCast ? '人物の設定' : '']
    .filter((source) => source.length > 0)
    .join('や')
  const addressSource = flags.hasAddresses
    ? flags.hasAddressPatterns
      ? '【呼称】や人物の「他者の呼び方」'
      : '【呼称】'
    : '人物の「他者の呼び方」'
  return {
    setting: `${settingSource.length > 0 ? settingSource : '資料の設定'}との食い違い（外見、性格、能力、世界のルール、用語の表記）。`,
    fact: flags.hasLedger
      ? '【確定事項】の「事実」や「これまでの流れ」との食い違い。'
      : '前の章までに確定した事実との食い違い。',
    address: flags.hasCast
      ? `台詞の中での相手の呼び方が、${addressSource}と違う。または、一人称が人物の設定と違う。地の文での人物の書き方は対象にしない。`
      : '呼び方や一人称が、資料と違う。',
    timeline: '時系列の食い違い（日付、時間帯、季節、経過時間）。',
    thread: flags.hasSetups
      ? '伏線の扱いの誤り。【この章の計画】の「張る伏線」の種明かしをしている、前の章までに決着したことを未解決として扱っている、など。'
      : '伏線の扱いの誤り。前の章までに決着したことを未解決として扱っている、など。',
    presence: flags.hasLedger
      ? 'その場にいない人物が発言・行動している。人物が、居合わせていない場面の出来事を、誰かから聞く・自分で気づくといった描写なしに知っている。【確定事項】の「知っていること」に挙がっていることを、初めて知ったように扱っている。'
      : 'その場にいない人物が発言・行動している。人物が、居合わせていない場面の出来事を、誰かから聞く・自分で気づくといった描写なしに知っている。',
    other: '上のどれにも当たらない、資料との食い違い。'
  }
}

function reviewSkeleton(): string {
  return jsonSkeleton([
    ['issues', [{ quote: '本文からそのまま抜き出した箇所', reason: 'どの資料とどう食い違うか', kind: '種別' }]]
  ])
}

function reviewSystem(flags: ReviewFlags): string {
  const kinds = reviewKindRules(flags)
  const fields = [
    `quote: 本文の該当箇所を、一字一句そのまま抜き出す。${REVIEW_QUOTE_MIN_CHARS}〜${REVIEW_QUOTE_MAX_CHARS}字。言い換えたり、要約したり、途中を省いてつないだりしない。食い違いがいちばんはっきり分かる1箇所を選ぶ。本文に無い文字列を書いた指摘は捨てられる。`,
    // reason は「「引用」: 理由」の形で、そのまま書き直しの指示の下書きになる。
    'reason: どの資料のどの記述と、どう食い違うかを書く。資料の名前と、その記述の内容を示し、どう直せばよいかを添える。1〜2文で、この文だけを読んで何をどう直すかが分かるようにする。',
    'kind: 下の【種別】のどれか1つ。',
    flags.hasAddressPatterns ? ADDRESS_PATTERN_RULE : ''
  ].filter((line) => line.length > 0)
  const sections = renderSections([
    { heading: '検査の原則', body: bullets(reviewPrinciples(flags)) },
    { heading: '各項目の書き方', body: bullets(fields) },
    { heading: '種別', body: bullets(REVIEW_ISSUE_KINDS.map((kind) => `${kind}: ${kinds[kind]}`)) },
    outputSection(reviewSkeleton())
  ])
  return `${REVIEW_ROLE}\n\n${sections}`
}

// 書き上がった章を資料と突き合わせて、食い違いを挙げさせるプロンプト。返させる形は { issues: ReviewIssue[] }。
// 本文が空なら throw する (記録の抽出と同じ扱い)。
export function buildReviewPrompt(input: ReviewPromptInput): Prompt {
  const text = trimChapterText(input.content)
  if (text.length === 0) {
    throw new Error(`Chapter ${input.chapterNumber} has no content to review`)
  }
  const label = chapterLabel(input.chapterNumber, input.title)
  const design = bibleBody(input.bible)
  const ledger = ledgerBody(input.ledgerText)
  const addresses = addressTableBody(input.addresses)
  const plan = outlineChapterBlock(input.entry)
  const narrator = narratorName(input.style, input.cast)
  // 口調の例は渡さない (口調の評価は好みの指摘になりやすい)。呼び方は【呼称】に 1 本化し、
  // 呼称に無い相手が残る人物だけ「他者の呼び方」の行を残す (本文プロンプトと同じ)。
  const cast = castForAddresses(input.cast, input.addresses).map((member) => ({ ...member, speech_examples: [] }))

  // 資料を先に、長い本文をその後に、依頼を最後に置く (依頼が本文に埋もれないようにする)。
  const sections: Section[] = [
    { heading: '作品設計', body: design },
    { heading: '確定事項', body: ledger },
    { heading: 'この章の計画', body: plan },
    {
      heading: '登場人物',
      body: castBody(cast, (member) => (member.name === narrator ? narratorTag(input.style) : ''))
    },
    { heading: '呼称', body: addresses },
    { heading: '検査する本文', body: `▼ ${label}\n${text}` },
    {
      heading: '今回の依頼',
      body: bullets([`${label}の本文を検査し、資料と食い違う箇所を挙げる。`, JSON_ONLY_REQUEST])
    }
  ]
  return {
    system: reviewSystem({
      hasBible: design.length > 0,
      hasLedger: ledger.length > 0,
      hasCast: cast.length > 0,
      hasAddresses: addresses.length > 0,
      hasAddressPatterns: cast.some((member) => member.address_others.length > 0),
      // 計画の節に実際に「張る伏線」の行が出ているか (種別の説明が指す小見出しと揃える)
      hasSetups: plan.includes('\n  張る伏線:\n')
    }),
    user: renderSections(sections)
  }
}
