import { isMentioned } from '@/lib/novel/checks'
import { FIRST_PERSON_AS_NAME } from '@/schemas/character.dto'
import { FOCAL_POVS, type Outline, type OutlineChapter } from '@/schemas/novel.dto'

// LLM に渡すプロンプトの組み立て (純粋関数)。cloudflare:workers、Prisma、fetch に依存させない。
//
// 文面の方針:
// - 作品を通して変わらない執筆ルールは system、資料と今回の指示は user に置く。
// - 本文プロンプトの user は「章をまたいで変わらない資料 → 確定済みの本文 → この章だけの資料 → 今回の執筆」の順。
//   前半が章ごとに変わらないので、プロンプトキャッシュに乗る。章番号など章ごとに変わる情報は後半にだけ置く。
// - 避けたい言い回しを例として引用しない (モデルが例文を本文に写すため)。

// system = LLM の system 指示 (Gemini の systemInstruction、OpenAI 互換の system ロール)。user = 資料と今回の指示。
export type Prompt = { system: string; user: string }

// 小説に登場するキャラの詳細。辞典 (Character) とその小説での役割 (NovelCharacter.role) を合わせたもの。
export type CastMember = {
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

// source から見た target の関係 (呼び方の上書きを含む)。
export type CastRelation = {
  source_name: string
  target_name: string
  relation: string
  description: string
  address_override: string
}

export type ViewpointChar = { name: string; first_person: string }

export type StyleParams = {
  pov: string
  tone: string
  ending?: string
  age_rating?: string
  viewpointChar?: ViewpointChar
}

export type NovelParams = {
  title: string
  genre: string
  setting: string
  num_chapters: number
  // 章立ての各章 summary の概算文字数。
  outline_summary_chars: number
  // 備考欄の追加指示 (任意)。章立てにだけ渡す。
  notes?: string
}

// 既出の章。呼び出し側が選んで渡す (予算に収まる章は全文、超えた古い章は省略。memory.ts の selectPriorChapters)。
// 今回の章以降の番号と、本文が空の章は渡されても載せない (書き直す章の古い版を確定扱いにしないため)。
// 全文で渡す章。
export type PriorChapterText = { chapter_number: number; title: string | null; content: string }
// 予算を超えて本文を渡せない章。【確定済みの本文】には見出しだけを出す (内容は【確定事項】に入っている)。
export type PriorChapterOmitted = { chapter_number: number; title: string | null; omitted: true }
export type PriorChapterInput = PriorChapterText | PriorChapterOmitted

export type ChapterPromptInput = {
  novel: NovelParams
  outline: Outline
  chapterNumber: number
  priorChapters: PriorChapterInput[]
  // ここまでの章の記録を累積した【確定事項】(ledger.ts の renderLedger の戻り値。見出しつき)。'' や未指定なら出さない。
  ledgerText?: string
  targetChars: number
  style: StyleParams
  cast: CastMember[]
  relations: CastRelation[]
}

// ---------------------- 文面の部品 ----------------------

// 節 1 つ。body が空なら節ごと出さない。
export type Section = { heading: string; body: string }

export function renderSections(sections: Section[]): string {
  return sections
    .filter((s) => s.body.length > 0)
    .map((s) => `【${s.heading}】\n${s.body}`)
    .join('\n\n')
}

// 自由記述の値を詰める。空行を落とすのは、節の区切り (空行 1 つ) と紛れないようにするため。
// 行頭の空白は残す (全角空白の字下げを消さない)。
export function compactText(text: string): string {
  return text
    .split(/\r\n|\r|\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .join('\n')
}

// 複数行の値の 2 行目以降を字下げして、ラベルつきの 1 項目に見えるようにする。
function hang(text: string, indent: string): string {
  return compactText(text).split('\n').join(`\n${indent}`)
}

// 本文は前後の空行だけ落とす。String.prototype.trim は先頭の全角空白 (段落頭の字下げ) も消すので使わない。
export function trimChapterText(content: string): string {
  return content
    .replace(/\r\n|\r/g, '\n')
    .replace(/^(?:[ \t]*\n)+/, '')
    .trimEnd()
}

function formatNumber(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

export function chapterLabel(chapterNumber: number, title: string | null): string {
  const trimmed = title === null ? '' : title.trim()
  return trimmed.length > 0 ? `第${chapterNumber}章「${trimmed}」` : `第${chapterNumber}章`
}

// 「第1章」「第1〜3章」。範囲が空なら ''。
function chapterRange(from: number, to: number): string {
  if (from > to) return ''
  return from === to ? `第${from}章` : `第${from}〜${to}章`
}

function sortedChapters(outline: Outline): OutlineChapter[] {
  return [...outline.chapters].sort((a, b) => a.chapter_number - b.chapter_number)
}

function outlineLine(chapter: OutlineChapter): string {
  const summary = hang(chapter.summary, '  ')
  const label = chapterLabel(chapter.chapter_number, chapter.title)
  return summary.length > 0 ? `${label}: ${summary}` : label
}

// ---------------------- 視点・文体 ----------------------

function povLine(style: StyleParams): string {
  const { pov, viewpointChar: vc } = style
  if (pov === '一人称') {
    if (vc !== undefined && vc.first_person === FIRST_PERSON_AS_NAME) {
      return `『${vc.name}』の一人称視点で、地の文の主語は『${vc.name}』を用いる(一人称代名詞は使わず、自分自身を「${vc.name}」と名前で呼ぶ独特な語り口)`
    }
    if (vc !== undefined) {
      return `『${vc.name}』(一人称「${vc.first_person}」)の一人称視点で、地の文は語り手の主観で執筆`
    }
    return '主人公の一人称視点で執筆'
  }
  if (pov === '三人称一元視点') {
    return vc !== undefined ? `『${vc.name}』に寄り添う三人称一元視点で執筆` : '三人称一元視点で執筆'
  }
  if (pov === '三人称多元視点') return '複数キャラの視点を切り替える三人称多元視点'
  return '全知の三人称(神視点)'
}

const DEFAULT_TONE_LINE = '標準的な一般文芸の文体'

const TONE_LINES: Record<string, string | undefined> = {
  ライトノベル調: '口語的で軽快なライトノベル調の文体',
  一般文芸: DEFAULT_TONE_LINE,
  文学的: '硬質で描写を重視した文学的な文体',
  やさしい文体: '平易でやさしい童話風の文体'
}

// 年齢指定は描写の踏み込み度合いを決める (文体とは独立)。
const RATING_LINES: Record<string, string | undefined> = {
  全年齢: '性的描写・過度な暴力描写を含めず、誰でも読める内容に留めること',
  R15: '物語の登場人物はすべて 18 歳以上の成人とする。たとえ後述の登場人物詳細に「高校生」「17歳」「女子高生」「十代」「美少女」等、未成年を連想させる記述が含まれていても、本作品においては大学生または社会人として読み替えて描写すること。学校設定が必要な場合は大学とする。性器を指す放送禁止用語 (露骨な俗語) の使用は禁止。それ以外の性的な描写や行為自体は許容する',
  R18: '成人向け。物語の登場人物はすべて 18 歳以上の成人とする。たとえ後述の登場人物詳細に「高校生」「17歳」「女子高生」「十代」「美少女」等、未成年を連想させる記述が含まれていても、本作品においては大学生または社会人として読み替えて描写すること。学校設定が必要な場合は大学とする。性的描写・暴力描写・直接的な語彙を含め、必要に応じて踏み込んだ表現を制限なく用いてよい'
}

export const ENDING_LINES: Record<string, string | undefined> = {
  ハッピーエンド: '主要な葛藤が解決し、登場人物が報われる前向きな結末へ向けて構成すること',
  バッドエンド: '救いの少ない悲劇的な結末へ向けて構成し、終章で喪失や敗北を直視すること',
  ビターエンド: '喜びと喪失が混在する苦味のある結末。完全な勝利でも敗北でもなく、余韻を残すこと',
  メリーバッドエンド:
    '表面的にはハッピーエンドに見えるが、実際には何かが歪んでいる/失われていることが読み取れる結末にすること',
  オープンエンド: '物語の結末を断定せず、複数の解釈の余地を残して幕を引くこと'
}

// 結末は章立てにだけ渡す。本文は章立ての概要を通して結末へ向かうので、渡し直さない。
function styleBody(style: StyleParams, includeEnding: boolean): string {
  const tone = TONE_LINES[style.tone]
  const rating = style.age_rating === undefined ? undefined : RATING_LINES[style.age_rating]
  const ending = includeEnding && style.ending !== undefined ? ENDING_LINES[style.ending] : undefined
  return [
    `視点: ${povLine(style)}`,
    `文体: ${tone === undefined ? DEFAULT_TONE_LINE : tone}`,
    rating === undefined ? '' : `年齢指定: ${rating}`,
    ending === undefined ? '' : `結末: ${ending}`
  ]
    .filter((line) => line.length > 0)
    .join('\n')
}

// ---------------------- 登場人物 ----------------------

function firstPersonDisplay(member: CastMember): string {
  return member.first_person === FIRST_PERSON_AS_NAME
    ? `代名詞を使わず、自分を「${member.name}」と名前で呼ぶ`
    : member.first_person
}

function ageDisplay(age: string): string {
  return /^\d+$/.test(age) ? `${age}歳` : age
}

// 人物 1 人ぶんの詳細。tag は語り手などの注記 (無ければ '')。
function castBlock(member: CastMember, tag: string): string {
  const meta = [ageDisplay(member.age), member.gender, member.occupation].filter((v) => v.length > 0).join('・')
  const role = [member.role, tag].filter((v) => v.length > 0).join('・')
  const firstPerson = firstPersonDisplay(member)
  const examples = member.speech_examples.map((ex) => ex.trim()).filter((ex) => ex.length > 0)
  return [
    meta.length > 0 ? `■ ${member.name}（${meta}）` : `■ ${member.name}`,
    role.length > 0 ? `  役割: ${role}` : '',
    firstPerson.length > 0 ? `  一人称: ${firstPerson}` : '',
    member.address_others.length > 0 ? `  他者の呼び方: ${member.address_others}` : '',
    member.appearance.trim().length > 0 ? `  外見: ${hang(member.appearance, '    ')}` : '',
    // 見出しで「見本」と示す。例文を台詞として写させないため (規則は system の【人物】)。
    examples.length > 0 ? ['  口調の例（話し方の見本）:', ...examples.map((ex) => `    「${ex}」`)].join('\n') : '',
    member.description.trim().length > 0 ? `  背景: ${hang(member.description, '    ')}` : ''
  ]
    .filter((line) => line.length > 0)
    .join('\n')
}

export function castBody(cast: CastMember[], tagFor: (member: CastMember) => string): string {
  return cast.map((member) => castBlock(member, tagFor(member))).join('\n\n')
}

// 「A から見た B」と書く。関係は source から見た向き (A→B が「兄」なら B は A の兄) なので、矢印より取り違えにくい。
// 呼び方は「B への呼び方は〜」と書く。値は「名前＋さん」のような型のことがあるので、「〜と呼ぶ」とは書かない
// (型の文字列そのもので呼ばせないため)。
function relationLine(relation: CastRelation): string {
  const { source_name: source, target_name: target } = relation
  const parts = [
    relation.relation.trim(),
    relation.address_override.length > 0 ? `${target}への呼び方は「${relation.address_override}」` : '',
    hang(relation.description, '  ')
  ]
    .map((part) => part.replace(/。+$/, ''))
    .filter((part) => part.length > 0)
  const head = `- ${source}から見た${target}`
  return parts.length > 0 ? `${head}: ${parts.join('。')}` : head
}

export function relationsBody(relations: CastRelation[]): string {
  return relations.map(relationLine).join('\n')
}

// 語り手として扱う人物の名前。視点人物を指定できる視点 (一人称 / 三人称一元視点) で、名簿にいるときだけ。
// 多元視点・神視点では pov_character_id が残っていても語り手ではないので、全章に登場させない。
export function narratorName(style: StyleParams, cast: CastMember[]): string | undefined {
  const vc = style.viewpointChar
  if (vc === undefined || !FOCAL_POVS.includes(style.pov)) return undefined
  return cast.some((member) => member.name === vc.name) ? vc.name : undefined
}

export function narratorTag(style: StyleParams): string {
  return style.pov === '一人称' ? '語り手' : '視点人物'
}

// scoped = 章立ての指定で絞り込めたか。false のときは名簿の全員を載せている。
type ChapterCast = { present: CastMember[]; absent: CastMember[]; scoped: boolean }

const KANJI_ONLY = /^\p{Script=Han}+$/u

// 章の題と概要に人物の名前が出てくるか。見逃しを避ける側に倒す。拾いすぎても人物設定が 1 人ぶん増えるだけだが、
// 漏らすと、概要に出てくる人物を「登場しない人物」として禁じてしまう。
// checks.ts の loose の判定 (名前そのもの、区切りで分けた各部、4 字以上の名前の先頭・末尾の 2 字) に加えて、
// 漢字だけの 3 字の名前は先頭・末尾の 2 字でも拾う (「朝倉澪」を「朝倉」で)。
// かなの名前に広げないのは、「かぐや」が「かぐわしい」に一致するのを避けるため。
// 1 字の姓や名 (「澪」「柊」) は一般の語と見分けられないので拾わない (漏れた分は ABSENT_LEAD の文面で概要を優先させる)。
function mentionedInPlan(planText: string, name: string): boolean {
  if (isMentioned(planText, name, { loose: true })) return true
  const chars = [...name.trim()]
  if (chars.length !== 3 || !KANJI_ONLY.test(chars.join(''))) return false
  return [chars.slice(0, 2).join(''), chars.slice(1).join('')].some((piece) => planText.includes(piece))
}

// その章に登場する人物と、しない人物に分ける。
// - characters が空 (旧データ) なら全員が登場する扱い。
// - 語り手は characters に無くても登場する扱い (章立てから漏れても口調・一人称・関係を渡すため)。
// - 章の題か概要に名前が出てくる人物も、characters に無くても登場する扱い。
//   characters はモデルが取りこぼすことがあり、概要に出てくる人物を禁じると指示どうしがぶつかる。
// - characters が名簿の誰とも一致しないとき (名前を変えた後など) も全員にする。
//   語り手だけを登場させ、残りを「登場しない人物」として締め出してしまうのを避ける。
function splitCast(cast: CastMember[], entry: OutlineChapter, narrator: string | undefined): ChapterCast {
  const listed = new Set(entry.characters)
  if (!cast.some((member) => listed.has(member.name))) return { present: cast, absent: [], scoped: false }
  // Phase 3 で章立てに events (出来事) が増えたら、ここに含める。
  const planText = `${entry.title}\n${entry.summary}`
  const present = cast.filter(
    (member) => listed.has(member.name) || member.name === narrator || mentionedInPlan(planText, member.name)
  )
  const presentNames = new Set(present.map((member) => member.name))
  return { present, absent: cast.filter((member) => !presentNames.has(member.name)), scoped: true }
}

// 絞り込めなかったときに【この章の登場人物】の先頭へ添える。全員の詳細が並ぶので、全員を出す指示と読ませない。
const UNSCOPED_CAST_LEAD =
  '章立てにこの章の登場人物の指定が無いので、名簿の全員を載せる。誰が登場するかは概要から判断し、出番の無い人物を無理に登場させない。'

// 登場しない人物の 1 行。名前、役割、登場する人物からの呼び方の上書き。
function absentLine(member: CastMember, presentNames: Set<string>, relations: CastRelation[]): string {
  const calls = relations
    .filter((r) => r.target_name === member.name && presentNames.has(r.source_name) && r.address_override.length > 0)
    .map((r) => `${r.source_name}からの呼び方は「${r.address_override}」`)
  const head = member.role.length > 0 ? `- ${member.name}（${member.role}）` : `- ${member.name}`
  return calls.length > 0 ? `${head}: ${calls.join('、')}` : head
}

// 設定の詳細は渡さない。名前だけ話題に出る場面で、呼び方を間違えないための節。
// 登場させない理由 (概要に出てこない) を添え、概要と食い違うときは概要を優先させる。
// この一覧は章立ての characters と名前の照合から作るので、概要に出てくる人物が紛れることがあるため。
const ABSENT_LEAD =
  '次の人物は、この章の概要に出てこないので、場面に登場させない（概要に出てくる人物がいれば、概要に従う）。会話で話題に出るときは、下の呼び方（指定が無ければ話し手の「他者の呼び方」）で呼ぶ。'

function absentBody(absent: CastMember[], present: CastMember[], relations: CastRelation[]): string {
  if (absent.length === 0) return ''
  const presentNames = new Set(present.map((member) => member.name))
  return [ABSENT_LEAD, ...absent.map((member) => absentLine(member, presentNames, relations))].join('\n')
}

// ---------------------- 保存用 ----------------------

// system と user を見出しつきで 1 つの文字列にする。Chapter.prompt への保存と、画面のプレビュー用。
export function renderPromptForStorage(prompt: Prompt): string {
  return `===== system =====\n${prompt.system}\n\n===== user =====\n${prompt.user}`
}

// ---------------------- 分量 ----------------------

const MIN_SCENES = 2
const MAX_SCENES = 8
const CHARS_PER_SCENE_BASE = 1000

// 目標字数を場面数に直す。字数だけを指示すると短く切り上げられるので、場面の数と 1 場面の厚みで伝える。
export function sceneGuide(targetChars: number): { scenes: number; charsPerScene: number } {
  const scenes = Math.min(MAX_SCENES, Math.max(MIN_SCENES, Math.round(targetChars / CHARS_PER_SCENE_BASE)))
  const charsPerScene = Math.max(100, Math.round(targetChars / scenes / 100) * 100)
  return { scenes, charsPerScene }
}

// ---------------------- 本文 ----------------------

const CHAPTER_ROLE =
  'あなたはプロの小説家として、1つの小説を1章ずつ書き継いでいる。渡された資料に従って、【今回の執筆】で指定された章の本文を日本語で書く。'

// 各章が完結した短編として書かれ、場面や締めの言い回しが章をまたいで重なるのを防ぐ。
const CHAPTER_SCOPE_RULES = [
  '書くのは【今回の執筆】の概要の範囲。【全体の章立て】で後の章に割り当てられた出来事には入らない。',
  '最初の章でなければ、直前の章が終わったところから続けて書き始める。章の間で時間が進む場合も、前の章の出来事を要約し直さない（読者は続けて読んでいる）。',
  '既に書かれた場面、説明、言い回しを繰り返さない。人物や状況の紹介も、済んでいるものはやり直さない。',
  '最終章以外は物語の途中である。その章の最後の出来事を書いたところで止め、物語全体を総括したり、決意や希望の独白で締めくくったりしない。前の章と同じ言い回しで締めない。',
  '最終章は、結末まで書き切る。'
]

// 【確定事項】が無い章 (第 1 章、記録の無い旧データ) でも同じ文面を使う (system を作品を通して変えないため)。
const CHAPTER_CONSISTENCY_RULES = [
  '【確定済みの本文】は既に書き上がった章で、後から変えられない。そこに書かれた事実（外見、持ち物、場所、日時、約束、誰が何を知っているか）、呼称、時系列は確定している。矛盾させない。',
  '【確定事項】は、ここまでの本文から抜き出した記録である。本文と同じく確定していて、矛盾させない。本文を省略した章については、これが資料になる。',
  // 記録は抽出を誤ることがあるので、全文がある章は全文を正とする。
  '【全体の章立て】の概要や【確定事項】が確定済みの本文と食い違うときは、本文を正とする。概要と【確定事項】が食い違うときは、【確定事項】を正とする。',
  // 人物の設定 (辞典) は章が進んでも同じ文面で渡るので、本文で変わった状態 (変装、関係の進展) を巻き戻させない。
  '人物の設定は物語の始まりの時点のものである。ここまでの章で変わったこと（外見、関係、知っていること）は、変わった後の状態を引き継ぐ。',
  // 「知っていること」は 1 章あたり数項目の抜粋。「一覧に無いことは知らない」とは読ませない
  // (当然知っていることまで知らない扱いになるため)。防ぎたいのは次の 2 つ:
  // 知っているはずのことを忘れている、居合わせていない出来事を知っている。
  '【確定事項】の「知っていること」は、その人物が既に知っていることの抜粋で、全部ではない。挙がっていることは、知っている前提で書く（忘れていたり、初めて知ったように反応したりさせない）。',
  '人物が居合わせていない場面の出来事は、誰かから聞く、自分で気づくといった描写なしに、その人物が知っている前提で書かない。',
  // 伏線の回収の計画は Phase 3 で章立てに入る。それまでは、目に入った伏線を片端から回収させない。
  '【確定事項】の「未回収の伏線」は、【今回の執筆】の概要に関わるものだけを扱う。関わらないものを、この章で無理に回収しない。'
]

const CHAPTER_CHARACTER_RULES = [
  '台詞と行動は、各人物の設定（性格、背景、関係）に沿わせる。',
  '「口調の例」は語尾・調子・口癖の見本である。台詞は見本の話し方で新しく書き、例文そのものは本文に使わない。',
  '一人称は各人物の設定どおりにし、別の一人称に変えない。',
  '相手の呼び方は、関係に呼び方の指定があればそれを使い、無ければその人物の「他者の呼び方」に従う。',
  '呼び方の「名前」「苗字」は型を表す。相手の名や姓に置き換えて呼ぶ（「苗字＋さん」なら、相手の姓に「さん」を付ける）。'
]

// 分量の数字は【今回の執筆】に置く。ここには、分量と章の範囲がぶつかったときの決め方だけを書く。
const CHAPTER_DEPTH_RULES = [
  '出来事をあらすじのように要約して進めない。場面として、会話、動作、情景、心情を具体的に書く。',
  '分量が足りないときは、概要の範囲の中で場面を書き込んで補う。',
  '「場面」は出来事の一区切りを指す。時間や場所が変わらなくても、区切りごとに1場面と数える。'
]

const CHAPTER_NOTATION_RULES = [
  '段落の頭は全角空白1つで字下げする。',
  '「 で始まる会話文の行は字下げしない（『 や （ で始まる行も同じ）。',
  '！や？の後に同じ行で文が続くときは、全角空白を1つ入れる。閉じ括弧の直前と行末には入れない。',
  '三点リーダは「……」、ダッシュは「――」と、2つ重ねて使う。',
  '確定済みの本文がこの表記と違っていても、新しく書く章はこの表記にする。'
]

const CHAPTER_OUTPUT_RULES = [
  '本文だけをプレーンテキストで出力する。章番号、タイトル、場面の見出し、前書き、後書き、注釈は含めない。'
]

export function bullets(lines: string[]): string {
  return lines.map((line) => `- ${line}`).join('\n')
}

// 作品を通して同じ文面にする (章番号など章ごとに変わる情報を入れない)。
// 人物の規則は名簿が空の作品では出さない。
function chapterSystem(hasCast: boolean): string {
  const rules = renderSections([
    { heading: '章の範囲', body: bullets(CHAPTER_SCOPE_RULES) },
    { heading: '整合性', body: bullets(CHAPTER_CONSISTENCY_RULES) },
    { heading: '人物', body: hasCast ? bullets(CHAPTER_CHARACTER_RULES) : '' },
    { heading: '描写と分量', body: bullets(CHAPTER_DEPTH_RULES) },
    { heading: '表記', body: bullets(CHAPTER_NOTATION_RULES) },
    { heading: '出力', body: bullets(CHAPTER_OUTPUT_RULES) }
  ])
  return `${CHAPTER_ROLE}\n\n${rules}`
}

export function novelInfoBody(novel: NovelParams, withChapterCount: boolean): string {
  return [
    novel.genre.trim().length > 0 ? `ジャンル: ${novel.genre.trim()}` : '',
    novel.setting.trim().length > 0 ? `世界観・設定: ${hang(novel.setting, '  ')}` : '',
    withChapterCount ? `章数: ${novel.num_chapters}` : ''
  ]
    .filter((line) => line.length > 0)
    .join('\n')
}

// send = モデルに送る文面。storage = 保存・表示用 (全文の章の本文を字数だけにする)。
type PromptMode = 'send' | 'storage'

// 既出の章 1 つぶん。載せない章 (本文が空) は ''。
// 見出しは「▼」で始める。本文の中の空行と、章の区切りを見分けられるようにするため。
function priorChapterBlock(chapter: PriorChapterInput, hasLedger: boolean, mode: PromptMode): string {
  const heading = `▼ ${chapterLabel(chapter.chapter_number, chapter.title)}`
  if ('content' in chapter) {
    const text = trimChapterText(chapter.content)
    if (text.length === 0) return ''
    if (mode === 'send') return `${heading}\n${text}`
    // 保存用には本文を入れない。全文つきで保存すると 1 版あたり数百 KB になり、D1 を圧迫する。
    // モデルには全文を渡したことが、保存された文面を読む人に分かるように書く。
    return `${heading}\n（本文${formatNumber(text.length)}字。モデルには全文を渡し、保存では省略）`
  }
  // 本文を渡せない章は見出しの 1 行だけ。全文の章とは、この括弧書きで見分けがつく。
  // 内容は【確定事項】に入っている。【確定事項】が無いとき (記録が 1 つも無い) は章立ての概要を指す。
  return `${heading}（本文は省略。内容は${hasLedger ? '【確定事項】' : '【全体の章立て】の概要'}を参照）`
}

function priorChaptersBody(
  priorChapters: PriorChapterInput[],
  chapterNumber: number,
  hasLedger: boolean,
  mode: PromptMode
): string {
  return priorChapters
    .filter((chapter) => chapter.chapter_number < chapterNumber)
    .map((chapter) => ({ number: chapter.chapter_number, block: priorChapterBlock(chapter, hasLedger, mode) }))
    .filter(({ block }) => block.length > 0)
    .sort((a, b) => a.number - b.number)
    .map(({ block }) => block)
    .join('\n\n')
}

// 直前の章を資料としてどう渡しているか。text = 全文、omitted = 本文は省略で【確定事項】がある、none = どちらも無い。
type PreviousChapter = 'text' | 'omitted' | 'none'

function previousChapterOf(
  priorChapters: PriorChapterInput[],
  chapterNumber: number,
  hasLedger: boolean
): PreviousChapter {
  const previous = priorChapters.filter((chapter) => chapter.chapter_number === chapterNumber - 1)
  if (previous.some((chapter) => 'content' in chapter && trimChapterText(chapter.content).length > 0)) return 'text'
  return hasLedger && previous.some((chapter) => !('content' in chapter)) ? 'omitted' : 'none'
}

// 【確定事項】の中身 (見出しを除く)。renderLedger の戻り値は見出しつきなので、見出しを外して節の本文にする。
// 見出しの無い文字列を渡されても、そのまま本文として扱う。どちらでも見出しは 1 つになる。
const LEDGER_HEADING = '確定事項'

function ledgerBody(ledgerText: string | undefined): string {
  if (ledgerText === undefined) return ''
  const text = ledgerText.replace(/\r\n|\r/g, '\n').trim()
  const heading = `【${LEDGER_HEADING}】`
  return text.startsWith(heading) ? text.slice(heading.length).trim() : text
}

type WritingBrief = {
  entry: OutlineChapter
  totalChapters: number
  previous: PreviousChapter
  targetChars: number
}

// 執筆済みの範囲と、書き出しの位置。
function writtenLine(brief: WritingBrief): string {
  const n = brief.entry.chapter_number
  if (n <= 1) return '執筆済み: なし（この章が物語の書き出し）'
  // 執筆済みが 1 章だけのときは、範囲と同じ章番号を繰り返さない。
  const previous = n === 2 ? 'その' : `第${n - 1}章の`
  const starts: Record<PreviousChapter, string> = {
    text: `${previous}終わりから続けて書く`,
    omitted: `${previous}本文は省略している。【確定事項】の内容の続きとして書き始める`,
    none: `${previous}本文は資料に無い。概要の続きとして書き始める`
  }
  return `執筆済み: ${chapterRange(1, n - 1)}（${starts[brief.previous]}）`
}

// これからの範囲と、章末の扱い。最終章かどうかで変わる。
function upcomingLine(brief: WritingBrief): string {
  const n = brief.entry.chapter_number
  if (n >= brief.totalChapters) return 'この後の章: なし（この章が最終章。結末まで書き切る）'
  return `この後の章: ${chapterRange(n + 1, brief.totalChapters)}（この章では書かない。物語は途中なので、章末で締めくくらない）`
}

function lengthLine(targetChars: number): string {
  const { scenes, charsPerScene } = sceneGuide(targetChars)
  return `分量: 約${formatNumber(targetChars)}字。概要の範囲を${scenes}場面程度に分け、1場面あたり約${formatNumber(charsPerScene)}字を目安に書く。場面を端折って短く終えない。`
}

function writingBody(brief: WritingBrief): string {
  const { entry, totalChapters } = brief
  const title = entry.title.trim()
  const summary = hang(entry.summary, '  ')
  const items = [
    writtenLine(brief),
    upcomingLine(brief),
    title.length > 0 ? `題: ${title}` : '',
    summary.length > 0 ? `概要: ${summary}` : '',
    lengthLine(brief.targetChars)
  ].filter((line) => line.length > 0)
  return `第${entry.chapter_number}章（全${totalChapters}章）の本文を書く。\n${bullets(items)}`
}

// 本文 1 章ぶんのプロンプトを組み立てる。章立てに chapterNumber が無ければ throw する。
function assembleChapterPrompt(input: ChapterPromptInput, mode: PromptMode): Prompt {
  const { novel, outline, chapterNumber, priorChapters, targetChars, style, cast, relations } = input
  const chapters = sortedChapters(outline)
  const entry = chapters.find((chapter) => chapter.chapter_number === chapterNumber)
  if (entry === undefined) {
    throw new Error(`Chapter ${chapterNumber} not found in outline`)
  }
  // 全章数は章立ての最後の章番号。最終章かどうかを、本文の計画である章立てで決める。
  const totalChapters = chapters.reduce((max, chapter) => Math.max(max, chapter.chapter_number), chapterNumber)

  const narrator = narratorName(style, cast)
  const { present, absent, scoped } = splitCast(cast, entry, narrator)
  const presentNames = new Set(present.map((member) => member.name))
  const presentRelations = relations.filter((r) => presentNames.has(r.source_name) && presentNames.has(r.target_name))
  const ledger = ledgerBody(input.ledgerText)
  const hasLedger = ledger.length > 0
  const priorBody = priorChaptersBody(priorChapters, chapterNumber, hasLedger, mode)
  const previous = previousChapterOf(priorChapters, chapterNumber, hasLedger)

  // 章をまたいで変わらない部分。章番号や今回の登場人物を入れない (前半を 1 字も変えないため)。
  // 全文の章が増えていく間は、前の章のプロンプトのここまでが、次の章のプロンプトの先頭と一致する
  // (古い章が省略に回ったところでは変わる)。
  // Phase 3 で【作品設計】【呼称表】【執筆上の指示】を【全体の章立て】の前に足す。
  const stable: Section[] = [
    { heading: '作品情報', body: novelInfoBody(novel, false) },
    { heading: '文体・視点', body: styleBody(style, false) },
    { heading: '全体の章立て', body: chapters.map(outlineLine).join('\n') },
    { heading: '確定済みの本文', body: priorBody }
  ]
  // この章だけの部分。【確定事項】は章が進むたびに増えるので、変わらない部分の後に置く。
  // Phase 4 / 5 で【次の章の冒頭】【元の版】【修正指示】を【今回の執筆】の前に足す。
  const perChapter: Section[] = [
    { heading: LEDGER_HEADING, body: ledger },
    {
      heading: 'この章の登場人物',
      body: [
        scoped || present.length === 0 ? '' : UNSCOPED_CAST_LEAD,
        castBody(present, (member) => (member.name === narrator ? narratorTag(style) : ''))
      ]
        .filter((part) => part.length > 0)
        .join('\n')
    },
    { heading: 'キャラクター間の関係', body: relationsBody(presentRelations) },
    { heading: 'この章に登場しない人物', body: absentBody(absent, present, relations) },
    { heading: '今回の執筆', body: writingBody({ entry, totalChapters, previous, targetChars }) }
  ]

  return { system: chapterSystem(cast.length > 0), user: renderSections([...stable, ...perChapter]) }
}

// 本文 1 章ぶんのプロンプト (モデルに送るもの)。章立てに chapterNumber が無ければ throw する。
export function buildChapterPrompt(input: ChapterPromptInput): Prompt {
  return assembleChapterPrompt(input, 'send')
}

// 保存・表示用 (Chapter.prompt)。buildChapterPrompt と同じ内容で、【確定済みの本文】の全文の章だけ、
// 本文を字数の 1 行に置き換える (見出しは残す)。system と user を renderPromptForStorage で 1 つの文字列にして返す。
export function buildChapterPromptForStorage(input: ChapterPromptInput): string {
  return renderPromptForStorage(assembleChapterPrompt(input, 'storage'))
}

// ---------------------- 章立て ----------------------

// JSON を返させるプロンプトは、user の【今回の依頼】にこの 1 行を入れる。
// OpenAI 互換の Responses API の json_object モードは、input に「json」の語が無い要求を 400 で拒否する。
// system は instructions として送るので数えられない。chat 形式でも同じ制約を持つ互換サーバーがある。
export const JSON_ONLY_REQUEST = '出力は JSON だけにする。'

const CHARACTERS_RULE =
  'characters には、その章に実際に登場する人物を入れる。名前は名簿の表記と完全に一致させる。関係に記載があるだけで、その章に登場しない人物は含めない。'

function outlineSystem(hasCast: boolean): string {
  const rules = [
    '【今回の依頼】の章数ちょうどの章を作る。chapter_number は1から章数までの連番にする。',
    '各章に title（章のタイトル）と summary（章の概要）を書く。どちらも空にしない。',
    hasCast ? '登場人物の性格・背景・関係を踏まえた章立てにする。' : '',
    hasCast ? CHARACTERS_RULE : ''
  ].filter((line) => line.length > 0)
  const example = hasCast
    ? '{ "chapter_number": 1, "title": "章のタイトル", "summary": "章の概要", "characters": ["登場する人物の名前"] }'
    : '{ "chapter_number": 1, "title": "章のタイトル", "summary": "章の概要" }'
  const sections = renderSections([
    { heading: '章立ての規則', body: bullets(rules) },
    {
      heading: '出力',
      body: `${bullets(['JSON だけを出力する。形式は次のとおり。'])}\n{\n  "chapters": [\n    ${example},\n    ...\n  ]\n}`
    }
  ])
  return `あなたはプロの小説家として、渡されたあらすじと設定に基づいて、小説の章立てを作る。\n\n${sections}`
}

// 備考欄 (物語に取り込みたい要素)。扱い方は資料のすぐ下に添える。
function notesBody(notes: string | undefined, instruction: string): string {
  if (notes === undefined) return ''
  const body = compactText(notes)
  return body.length > 0 ? `${body}\n${instruction}` : ''
}

function castNamesLine(cast: CastMember[]): string {
  return cast.length > 0 ? `名簿（characters に使える名前）: ${cast.map((member) => member.name).join('、')}` : ''
}

// 章立ての資料 (全体の生成と 1 章の書き直しで共通)。章立てには登場人物を全員渡す。
function outlineMaterials(
  input: { novel: NovelParams; style: StyleParams; cast: CastMember[]; relations: CastRelation[] },
  notesInstruction: string
): Section[] {
  return [
    { heading: '作品情報', body: novelInfoBody(input.novel, true) },
    { heading: '文体・視点', body: styleBody(input.style, true) },
    { heading: '登場人物', body: castBody(input.cast, () => '') },
    { heading: 'キャラクター間の関係', body: relationsBody(input.relations) },
    { heading: '物語に取り込みたい要素', body: notesBody(input.novel.notes, notesInstruction) }
  ]
}

function chapterNumberSpan(numChapters: number): string {
  return numChapters <= 1 ? '1' : `1〜${numChapters}`
}

// 章立て (全章) のプロンプト。
export function buildOutlinePrompt(input: {
  novel: NovelParams
  style: StyleParams
  cast: CastMember[]
  relations: CastRelation[]
}): Prompt {
  const { novel, cast } = input
  const request = [
    `全${novel.num_chapters}章の章立てを作る。chapter_number は${chapterNumberSpan(novel.num_chapters)}。`,
    `summary は各章${novel.outline_summary_chars}字程度。`,
    castNamesLine(cast),
    JSON_ONLY_REQUEST
  ].filter((line) => line.length > 0)
  const sections: Section[] = [
    ...outlineMaterials(
      input,
      '上の各項目を、物語のどこかに自然に組み込み、章立て（各章の概要）に反映する。配置や順序は任せる。'
    ),
    { heading: '今回の依頼', body: bullets(request) }
  ]
  return { system: outlineSystem(cast.length > 0), user: renderSections(sections) }
}

function outlineChapterSystem(hasCast: boolean, chapterNumber: number): string {
  const rules = [
    '物語全体の流れを壊さないように、前後の章と矛盾しない内容にする。【他の章】は固定で、書き換えない。',
    '元のタイトルや概要に固執せず、異なる切り口・展開を提案してよい。',
    'title（章のタイトル）と summary（章の概要）は空にしない。',
    hasCast ? CHARACTERS_RULE : ''
  ].filter((line) => line.length > 0)
  const example = hasCast
    ? `{ "chapter_number": ${chapterNumber}, "title": "章のタイトル", "summary": "章の概要", "characters": ["登場する人物の名前"] }`
    : `{ "chapter_number": ${chapterNumber}, "title": "章のタイトル", "summary": "章の概要" }`
  const sections = renderSections([
    { heading: '書き直しの規則', body: bullets(rules) },
    { heading: '出力', body: `${bullets(['書き直した1章だけを、次の JSON 形式で出力する。'])}\n${example}` }
  ])
  return `あなたはプロの小説家として、既存の章立てのうち、指定された1章だけを書き直す。\n\n${sections}`
}

// 章立てのうち 1 章だけを書き直すプロンプト。他の章は固定の資料として渡す。
// 章立てに chapterNumber が無い場合 (後から章数を増やした) は、新しく作る章として扱う。
export function buildOutlineChapterPrompt(input: {
  novel: NovelParams
  style: StyleParams
  cast: CastMember[]
  relations: CastRelation[]
  existing: Outline
  chapterNumber: number
}): Prompt {
  const { novel, cast, existing, chapterNumber } = input
  const chapters = sortedChapters(existing)
  const target = chapters.find((chapter) => chapter.chapter_number === chapterNumber)
  const others = chapters.filter((chapter) => chapter.chapter_number !== chapterNumber)
  const targetBody =
    target === undefined || (target.title.trim().length === 0 && target.summary.trim().length === 0)
      ? `第${chapterNumber}章（まだ内容が無い。新しく作る）`
      : outlineLine(target)
  const request = [
    `第${chapterNumber}章を書き直す。chapter_number は${chapterNumber}のまま。`,
    `summary は${novel.outline_summary_chars}字程度。`,
    castNamesLine(cast),
    JSON_ONLY_REQUEST
  ].filter((line) => line.length > 0)
  const sections: Section[] = [
    ...outlineMaterials(input, '上の各項目は物語全体で取り込む要素である。この章に合うものを自然に組み込む。'),
    { heading: '他の章', body: others.map(outlineLine).join('\n') },
    { heading: '書き直す章', body: targetBody },
    { heading: '今回の依頼', body: bullets(request) }
  ]
  return { system: outlineChapterSystem(cast.length > 0, chapterNumber), user: renderSections(sections) }
}
