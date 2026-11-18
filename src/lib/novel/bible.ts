import { canonicalJson, stableHash } from '@/lib/novel/hash'
import type { AddressEntry, BibleCast } from '@/schemas/story.dto'

// 作品設計 (story bible) の後処理 (docs/plans/2026-11-18-novel-consistency.md の Phase 3)。
// モデルの出力は名簿に無い名前を含んだり行が欠けたりするので、保存の前にコードで整える・検証する。
// DB・fetch・cloudflare:workers に依存しない純粋関数だけを置く。

// ---------------------- 呼称表 ----------------------

// address_others は人物ごとの既定の呼び方 (定型の記号)。呼称表の整形では使わない (名簿の名前だけを見る)。
export type BibleCastInput = { name: string; address_others: string }
export type BibleRelationInput = { source_name: string; target_name: string; address_override: string }
export type AddressPair = { from: string; to: string }

// 名簿が多いと全ての組 (N×(N-1)) は保存の上限を超える (26 人で 650 組)。これを超える名簿では組を絞る。
export const ADDRESS_ALL_PAIRS_MAX_CAST = 8
// 呼称表の保存の上限 (StoryBibleSchema.addresses の max)。
export const ADDRESS_MAX_ROWS = 600

// 呼び方が「相手の名前に当てはめる型」か。「名前」か「苗字」で始まり、あれば「＋」(全角・半角) で敬称が続く。
// 定型の選択肢 (「名前＋さん」) も、利用者が同じ形で手書きしたもの (「苗字+先生」) も型。
// 「君」「いろP」のように名前を当てはめない呼び方は、本文にそのまま書ける具体的な呼び方であって型ではない。
const ADDRESS_PATTERN = /^(?:名前|苗字)(?:[＋+].+)?$/

export function isAddressPattern(value: string): boolean {
  return ADDRESS_PATTERN.test(value.trim())
}

const pairKey = (from: string, to: string): string => JSON.stringify([from, to])

// 名前を trim し、空と重複を除く (最初の出現順)。
const uniqueNames = (names: string[]): string[] => [
  ...new Set(names.map((name) => name.trim()).filter((name) => name !== ''))
]

// 呼称表に必ず要る組 (from が to を何と呼ぶか決めておく組)。
// 名簿が ADDRESS_ALL_PAIRS_MAX_CAST 人以下なら全ての組。それより多いときは、関係を定義した組 (両方向) と、
// 語り手と各人物の組 (両方向。語り手が '' や名簿に居なければ無し) に絞る。
// 並びは名簿の順 (from、同じ from の中は to)。名簿に無い名前と自分自身への組は含めない。
export function requiredAddressPairs(
  castNames: string[],
  relations: BibleRelationInput[],
  narrator: string
): AddressPair[] {
  const roster = uniqueNames(castNames)
  const members = new Set(roster)
  const everyone = roster.length <= ADDRESS_ALL_PAIRS_MAX_CAST
  const narratorName = narrator.trim()

  const wanted = new Set<string>()
  const addBoth = (a: string, b: string): void => {
    if (members.has(a) && members.has(b) && a !== b) {
      wanted.add(pairKey(a, b))
      wanted.add(pairKey(b, a))
    }
  }
  if (!everyone) {
    for (const name of roster) {
      addBoth(narratorName, name)
    }
    for (const relation of relations) {
      addBoth(relation.source_name.trim(), relation.target_name.trim())
    }
  }

  return roster.flatMap((from) =>
    roster.filter((to) => to !== from && (everyone || wanted.has(pairKey(from, to)))).map((to) => ({ from, to }))
  )
}

// モデルが返した呼称表を、名簿と関係に照らして整える。入力は変更しない。
//   1. 名簿に無い名前、自分自身への行、call が空の行を捨てる (名前と call は trim する)
//   2. 同じ (from, to) は最初の 1 行だけ残す
//   3. 関係の上書きが「型でない具体的な文字列」なら、利用者の指定を正として source → target の call を置き換える
//      (行が無ければ足す。同じ組の関係が複数あれば、具体的な上書きを持つ最初のもの)。
//      型 (「苗字＋先生」など) は無視する。モデルが名前に当てはめた行 (「柊先生」) を型に書き戻さないため
//   4. 並びは名簿の順 (from、同じ from の中は to)。ADDRESS_MAX_ROWS 行で切る
// 欠けた行は作り出さない (相手の名前そのもので埋めると、フルネームで呼び合う不自然な表になる)。
// 欠けているかは missingAddressPairs で調べる。
export function completeAddresses(
  addresses: AddressEntry[],
  cast: BibleCastInput[],
  relations: BibleRelationInput[]
): AddressEntry[] {
  const roster = uniqueNames(cast.map((member) => member.name))
  const members = new Set(roster)
  const isPair = (from: string, to: string): boolean => members.has(from) && members.has(to) && from !== to

  const table = new Map<string, AddressEntry>()
  for (const entry of addresses) {
    const from = entry.from.trim()
    const to = entry.to.trim()
    const call = entry.call.trim()
    const key = pairKey(from, to)
    if (isPair(from, to) && call !== '' && !table.has(key)) {
      table.set(key, { from, to, call })
    }
  }

  const overridden = new Set<string>()
  for (const relation of relations) {
    const from = relation.source_name.trim()
    const to = relation.target_name.trim()
    const call = relation.address_override.trim()
    const key = pairKey(from, to)
    if (isPair(from, to) && call !== '' && !isAddressPattern(call) && !overridden.has(key)) {
      table.set(key, { from, to, call })
      overridden.add(key)
    }
  }

  return roster
    .flatMap((from) =>
      roster.flatMap((to) => {
        const entry = table.get(pairKey(from, to))
        return entry === undefined ? [] : [entry]
      })
    )
    .slice(0, ADDRESS_MAX_ROWS)
}

// required のうち addresses に行が無い組。作品設計の流れが、欠けていたら 1 回やり直すのに使う。
// addresses は completeAddresses を通した (trim 済みの) ものを渡す。required の順序を保つ。
export function missingAddressPairs(addresses: AddressEntry[], required: AddressPair[]): AddressPair[] {
  const present = new Set(addresses.map((entry) => pairKey(entry.from, entry.to)))
  return required.filter((pair) => !present.has(pairKey(pair.from, pair.to)))
}

// その章に登場する人物どうしの呼称だけ (from と to の両方が names に含まれる行)。順序は保つ。
export function addressesFor(addresses: AddressEntry[], names: string[]): AddressEntry[] {
  const present = new Set(names)
  return addresses.filter((entry) => present.has(entry.from) && present.has(entry.to))
}

// 人物名 (to) → その人物が呼ばれる呼び方 (call) の一覧。重複は除き、出てきた順に並べる。
// 本文に名前の代わりに呼び方が出ているかを機械的に見るのに使う。
export function callsByName(addresses: AddressEntry[]): Record<string, string[]> {
  const grouped = new Map<string, string[]>()
  for (const entry of addresses) {
    const calls = grouped.get(entry.to)
    if (calls === undefined) {
      grouped.set(entry.to, [entry.call])
    } else if (!calls.includes(entry.call)) {
      calls.push(entry.call)
    }
  }
  return Object.fromEntries(grouped)
}

// ---------------------- 年齢指定に合わせた人物設定 ----------------------

// 全年齢以外 (R15 / R18) は、登場人物を全員 18 歳以上の成人として扱う。
export function isAdultRating(ageRating: string): boolean {
  return ageRating === 'R15' || ageRating === 'R18'
}

// 年齢の欄を「数字と、任意の 歳 / 才 だけ」に限って読む。全角数字は半角にする (NFKC)。
// 前後に語がある値 (「18歳未満」「18歳以下」「十四歳（設定上は18）」)、漢数字、範囲 (「17〜18歳」「10代、18歳」)、
// 「20代」、空は null。欄の中の数字だけを拾うと、「18歳未満」が 18 として通ってしまうため。
const EXACT_AGE = /^(\d{1,3})\s*(?:歳|才)?$/

export function parseExactAge(age: string): number | null {
  const found = EXACT_AGE.exec(age.normalize('NFKC').trim())
  return found === null ? null : Number(found[1])
}

// ---------------------- 未成年を指す語 ----------------------

// この検証が守るのは、成人指定 (R15 / R18) の作品で、システムが作る作品設計が未成年の人物を本文に持ち込まないこと。
// 相手にするのは「モデルの出力」「うっかり残った記述」「安く書ける回避 (空白や見えない文字)」で、
// 利用者の意図的な回避を完全に防ぐことは目的にしない。迷ったら不合格の側に倒す (誤検出は作品設計の作り直しで済む)。
//
// 照合は 2 段で行う。
//   1 段目: normalizeForMinorScan した文にそのまま当てる
//   2 段目: 行の中の空白・中点・ハイフンを取り除いた文に当てる (「高 校 生」「高・校・生」)。
//           改行と句読点は取り除かない (「途中。学生は」が「中学生」に当たる誤検出を避ける)
// 英字の語 (JK など) は 1 段目だけ (英単語の一部に当たらないよう、前後が英字でないときだけ見る)。

// 照合を妨げる、見えない文字 (ゼロ幅スペース、ソフトハイフン、WORD JOINER、BOM、異体字セレクタなど) と、
// NFKC のあとに残る結合文字。
const INVISIBLE = /[\p{Default_Ignorable_Code_Point}\p{Mn}]/gu

// 異体字。1 字を 1 字に置き換えるので、位置はずれない。
const VARIANTS = new Map([
  ['髙', '高'],
  ['學', '学'],
  ['兒', '児'],
  ['歲', '歳']
])

// 照合に使う文字列。NFKC (全角の英数字は半角、半角カタカナは全角) → 見えない文字の除去 → 異体字の置き換え。
// 見えない文字を取り除くので、長さは元の文と変わりうる。locateMinorTerms の位置はこの文字列の中の位置。
export function normalizeForMinorScan(text: string): string {
  return Array.from(text.normalize('NFKC').replace(INVISIBLE, ''), (char) => {
    const variant = VARIANTS.get(char)
    return variant === undefined ? char : variant
  }).join('')
}

// 2 段目で取り除く文字: 空白 (NFKC で全角の空白も半角になっている)、中点、ハイフン類。
// 長音 (ー) は「ティーン」に要るので取り除かない。改行も取り除かない。
const SPACING = /[ \t·•‧∙⋅・゠\-‐-―−﹣]/

// 未成年であることを指す語。成人指定の作品設計の人物設定に残っていたら不合格にする。
// 背景の経歴を書くときは「学生時代」「若い頃」のように書かせる (作品設計のプロンプトがそう指示する)。
// 「高校」「中学」単独は入れない (「高校教師」「高校を卒業後」は成人の設定として普通にある)。
// 正規表現の断片で、normalizeForMinorScan した文に当てる (全角の英数字は半角、10代の数字も半角で判定する)。
// 誤検出と見逃しのどちらを取るか迷ったときは、身分・学年を明示する形を確実に拾うほうを優先した。

// 学年の短い書き方 (「高2」「中一」) の前後の境界。
//   直前: 漢字・英数字が続くときは語の一部 (「途中1回」「標高2000m」「最高3」) なので除く。
//         ただし「女子高2」「都立高3」「現役高3」「現在高2」「今年中3」のように、学校の種類や時を表す語のあとは学年なので許す。
//         かなの直後は許す (「彼女は高2」「まだ高2」)。
//   直後: 数字・英字・カタカナ・「つ」、「年」「生」以外の漢字が続くときは数量 (「中1日」「高3度」「小1時間」「中二病」) なので除く。
const GRADE_BEFORE =
  '(?:(?<![\\p{Script=Han}A-Za-z0-9])|(?<=[女男]子|[公私国県都市道府]立|現役|現在|現|今年|当時|来年|去年|昨年))'
const GRADE_AFTER = '(?![\\dA-Za-z\\u30A1-\\u30F6つ]|(?![年生])\\p{Script=Han})'

const MINOR_TERM_SOURCES = [
  // 身分の語。「高校生活」は学校生活のことなので除く
  '女子高校生',
  '男子高校生',
  '女子高生',
  '男子高生',
  '女子中学生',
  '男子中学生',
  '女子生徒',
  '男子生徒',
  '女生徒',
  '男生徒',
  '生徒会',
  '高校生(?!活)',
  '中学生(?!活)',
  '小学生(?!活)',
  '未成年',
  '園児',
  '幼女',
  '女児',
  '男児',
  '美少女',
  '美少年',
  '高等部',
  '中等部',
  '初等部',
  '低学年',
  '高学年',
  '未就学',
  '学童',
  // 「児童文学作家」「幼児教育」「児童福祉士」のような職業・分野の語は成人の設定として普通にあるので除く
  '(?:児童|幼児)(?!文学|書|館|福祉|養護|相談|心理|指導|発達|向け|文庫|図書|手当|劇|雑誌|教育|教室|クラブ|デイ|ケア|施設|保育|精神|支援|自立|番組|用品)',
  // かな書き
  'こうこうせい',
  'コウコウセイ',
  'ちゅうがくせい',
  'チュウガクセイ',
  'しょうがくせい',
  'ショウガクセイ',
  'じょしこうせい',
  'ジョシコウセイ',
  'みせいねん',
  'ミセイネン',
  // 「カロリー」などカタカナ語の一部に当たらないよう、直前がカタカナでないときだけ
  '(?<![\\u30A1-\\u30F6ー])(?:ロリ|ショタ)',
  // 学年: 学校名を明示する形は前後を問わない (「年間」は期間なので除く)。「高校の2年」のように「の」を挟む形も
  '高(?:校|等学校)の?[1-3一二三]年(?!間)',
  '中学校?の?[1-3一二三]年(?!間)',
  '小学校?の?[1-6一二三四五六]年(?!間)',
  // 学年: 短い書き方
  `${GRADE_BEFORE}(?:高[1-3一二三]|中[1-3一二三]|小[1-6一二三四五六])${GRADE_AFTER}`,
  // 年代の語。「二十代」「三十代」「第10代」「十代目」は十代ではない
  '(?<![\\d二三四五六七八九〇零第])(?:10|十)代(?!目)',
  'ティーン'
]

// 外見の欄だけで見る語。職業や背景では「少女漫画家」「少年野球のコーチ」「幼い頃」のような語があるため。
// 「制服」単独は入れない (成人の職業の制服がある)。長い語を先に並べる (「幼児体型」を「幼児」より先に当てる)。
const MINOR_APPEARANCE_SOURCES = [
  '幼児体型',
  '少女',
  '少年',
  '幼い',
  '幼げ',
  '幼さ',
  'あどけな',
  '童顔',
  '子供っぽ',
  '子どもっぽ',
  'こどもっぽ',
  '子供のよう',
  '子どものよう',
  'こどものよう',
  '子供みたい',
  '子どもみたい',
  'こどもみたい',
  'セーラー服',
  '学ラン',
  '学生服',
  'ランドセル',
  'スクール水着',
  'ブルマ(?!ン)',
  '体操服',
  '通学帽'
]

// 英字の語。英単語の一部 (jacket、fourteen) や拡張子 (.js) に当たらないよう、前後が英字でないときだけ。大文字・小文字は区別しない。
// 「high school」単独は入れない (日本語の「高校」単独と同じ扱い)。
const MINOR_LATIN_SOURCES = [
  '(?<![A-Za-z.])(?:JK|JC|JS)(?![A-Za-z])',
  '(?<![A-Za-z])teen(?:s|age|agers?)?(?![A-Za-z])',
  '(?<![A-Za-z])school(?:girl|boy)s?(?![A-Za-z])',
  '(?<![A-Za-z])(?:high|middle)[ \\t]+school(?:er|[ \\t]+student)s?(?![A-Za-z])',
  '(?<![A-Za-z])(?:underage|minors?)(?![A-Za-z])',
  '(?<![A-Za-z])(?:loli(?:ta)?|shota)s?(?![A-Za-z])'
]

const MINOR_TERMS = new RegExp(MINOR_TERM_SOURCES.join('|'), 'gu')
const MINOR_TERMS_WITH_APPEARANCE = new RegExp([...MINOR_APPEARANCE_SOURCES, ...MINOR_TERM_SOURCES].join('|'), 'gu')
const MINOR_LATIN_TERMS = new RegExp(MINOR_LATIN_SOURCES.join('|'), 'giu')

// 年齢の表現: 「数字か漢数字 + 任意の空白 + 歳 / 才 / さい」。どの欄でも見る (年齢の欄そのものは parseExactAge で見る)。
//   数字は最長で読む (「118歳」は 118、「二十歳」は 20。「十歳」とは読まない)。
//   数字の途中に空白がある (「十 四 歳」) と「四 歳」だけを読むが、18 未満として拾う側に倒れるので許す。
//   空白を直前の数字とつなげて読むと、番号つきの一覧 (「1 14歳の春」) の 14 歳を読み落とす。範囲や並び (「17〜18歳」「14、15歳」) は最小値で見る。
//   18 未満なら未成年を指す表現。「18歳未満」「20歳以下」のように未満・以下が付く 18〜20 も (未成年を含むので) 拾う。
//   年齢そのものではない表現は除く: 年齢差 (「3歳年上」「5歳年下」「2歳上」「10歳差」「3歳違い」「5歳離れた」「3歳若い」)。
const AGE_NUMBER = '(?:\\d+(?:\\.\\d+)?|[〇零一二三四五六七八九十百千万]+)'
const AGE_JOINER = '(?:[〜~\\-–−]|から|か|、|,|または|もしくは)'
const AGE_EXPRESSION = new RegExp(
  `(?<![\\d.〇零一二三四五六七八九十百千万])(${AGE_NUMBER}(?:[ \\t]*${AGE_JOINER}[ \\t]*${AGE_NUMBER})*)[ \\t]*(?:歳|才|さい)` +
    '(未満|以下|に満たない)?' +
    '(?!(?:ほど|くらい|ぐらい|程度)?(?:年上|年下|年長|年少|上|下|差|の差|違|離れ|若|老))',
  'gu'
)
const AGE_NUMBER_ONLY = new RegExp(AGE_NUMBER, 'gu')

const KANJI_DIGITS = new Map([
  ['〇', 0],
  ['零', 0],
  ['一', 1],
  ['二', 2],
  ['三', 3],
  ['四', 4],
  ['五', 5],
  ['六', 6],
  ['七', 7],
  ['八', 8],
  ['九', 9]
])
const kanjiDigit = (char: string): number => {
  const digit = KANJI_DIGITS.get(char)
  return digit === undefined ? 0 : digit
}

// 数字・漢数字を整数で読む (小数は切り捨て)。百以上や「万」のように読まない表記は null。
function parseCount(token: string): number | null {
  if (/^\d/.test(token)) {
    return Math.floor(Number(token))
  }
  const tens = /^([一二三四五六七八九])?十([一二三四五六七八九])?$/.exec(token)
  if (tens !== null) {
    return (tens[1] === undefined ? 1 : kanjiDigit(tens[1])) * 10 + (tens[2] === undefined ? 0 : kanjiDigit(tens[2]))
  }
  return /^[〇零一二三四五六七八九]+$/.test(token) ? Number(Array.from(token, kanjiDigit).join('')) : null
}

export type MinorMatch = { term: string; start: number; end: number }

const MINOR_AGE_LIMIT = 18
const MINOR_QUALIFIED_AGE_LIMIT = 20

function scanAges(text: string): MinorMatch[] {
  return Array.from(text.matchAll(AGE_EXPRESSION)).flatMap((match) => {
    const ages = Array.from(match[1].matchAll(AGE_NUMBER_ONLY), (found) => parseCount(found[0])).filter(
      (age): age is number => age !== null
    )
    if (ages.length === 0) {
      return []
    }
    const age = Math.min(...ages)
    const qualifier = match[2] === undefined ? '' : match[2]
    const minor = age < MINOR_AGE_LIMIT || (qualifier !== '' && age <= MINOR_QUALIFIED_AGE_LIMIT)
    return minor ? [{ term: `${age}歳${qualifier}`, start: match.index, end: match.index + match[0].length }] : []
  })
}

const scanPattern = (text: string, pattern: RegExp, format: (matched: string) => string): MinorMatch[] =>
  Array.from(text.matchAll(pattern), (match) => ({
    term: format(match[0]),
    start: match.index,
    end: match.index + match[0].length
  }))

// 英字の語は大文字にそろえる (JK、TEENAGER。空白は 1 つにする)。
const formatLatin = (matched: string): string => matched.toUpperCase().replace(/[ \t]+/g, ' ')

const byStart = (a: MinorMatch, b: MinorMatch): number => a.start - b.start

// normalized (normalizeForMinorScan 済み) の中の語と年齢の表現。latin が false なら英字の語は見ない。
function scanMinor(normalized: string, appearance: boolean, latin: boolean): MinorMatch[] {
  const terms = scanPattern(normalized, appearance ? MINOR_TERMS_WITH_APPEARANCE : MINOR_TERMS, (matched) => matched)
  const latinTerms = latin ? scanPattern(normalized, MINOR_LATIN_TERMS, formatLatin) : []
  return [...terms, ...latinTerms, ...scanAges(normalized)].sort(byStart)
}

const overlaps = (a: MinorMatch, b: MinorMatch): boolean => a.start < b.end && b.start < a.end

// 文の中の未成年を指す語と、18 歳未満の年齢の表現を、出てきた順に位置つきで返す。
// 位置 (start / end) は normalizeForMinorScan(text) の中のもの。空白などを取り除いた 2 段目で見つかったものは、
// 取り除く前 (1 段目の文字列) での範囲に直して返す (term は取り除いたあとの形: 「高 校 生」の term は「高校生」)。
// 年齢の表現の term は「14歳」のように数字にそろえた形 (「十四歳」「14 才」→「14歳」。未満・以下が付けば「18歳未満」)。
// options.appearance が true のときは外見の欄用の語 (少女、幼い、セーラー服など) も探す。
export function locateMinorTerms(text: string, options?: { appearance?: boolean }): MinorMatch[] {
  const appearance = options?.appearance === true
  const normalized = normalizeForMinorScan(text)
  const direct = scanMinor(normalized, appearance, true)
  const kept = Array.from({ length: normalized.length }, (_, index) => index).filter(
    (index) => !SPACING.test(normalized[index])
  )
  if (kept.length === normalized.length) {
    return direct
  }
  const squeezed = kept.map((index) => normalized[index]).join('')
  const joined = scanMinor(squeezed, appearance, false)
    .map((found) => ({ term: found.term, start: kept[found.start], end: kept[found.end - 1] + 1 }))
    .filter((found) => !direct.some((other) => overlaps(found, other)))
  return [...direct, ...joined].sort(byStart)
}

// 文の中の未成年を指す語と年齢の表現を、重複なしで見つかった順に返す (locateMinorTerms の term)。
export function findMinorTerms(text: string, options?: { appearance?: boolean }): string[] {
  return [...new Set(locateMinorTerms(text, options).map((found) => found.term))]
}

const quoteTerms = (terms: string[]): string => terms.map((term) => `「${term}」`).join('')

// 問題の文に載せる年齢の欄の値。改行と連続する空白は 1 つの空白にし、30 字を超えたら切る。
const shownValue = (value: string): string => {
  const chars = Array.from(value.trim().replace(/\s+/g, ' '))
  return chars.length > 30 ? `${chars.slice(0, 30).join('')}…` : chars.join('')
}

// ---------------------- 成人指定の検証 ----------------------

// 成人指定のとき、名簿の全員に作品設計の行があり、次を満たすことを確かめる。
//   ・年齢が「数字だけ (歳 / 才 は可)」で書かれていて 18 以上 (parseExactAge)。書き方が違えば未成年でないことを
//     コードで確かめられないので、「二十歳」「20代」「成人」「18歳未満」「」も問題にする
//   ・職業・外見・背景に、未成年を指す語や 18 歳未満の年齢の表現が残っていない (findMinorTerms。外見の欄だけ「少女」「幼い」なども見る)
// 戻り値は問題を表す文の配列 (空なら問題なし)。全年齢なら常に空。
export function validateAdultCast(ageRating: string, bibleCast: BibleCast[], castNames: string[]): string[] {
  if (!isAdultRating(ageRating)) {
    return []
  }
  const rows = new Map<string, BibleCast>()
  for (const row of bibleCast) {
    const name = row.name.trim()
    if (!rows.has(name)) {
      rows.set(name, row)
    }
  }
  return uniqueNames(castNames).flatMap((name) => {
    const row = rows.get(name)
    if (row === undefined) {
      return [`${name} の成人としての設定がありません`]
    }
    const age = parseExactAge(row.age)
    const ageProblems =
      age === null
        ? [`${name} の年齢は、18 以上の数字だけで書いてください（今の値:「${shownValue(row.age)}」）`]
        : age < 18
          ? [`${name} の年齢が ${age} 歳です（18 歳以上にしてください）`]
          : []
    const fields: Array<{ label: string; terms: string[] }> = [
      { label: '職業', terms: findMinorTerms(row.occupation) },
      { label: '外見', terms: findMinorTerms(row.appearance, { appearance: true }) },
      { label: '背景', terms: findMinorTerms(row.background) }
    ]
    const termProblems = fields
      .filter((field) => field.terms.length > 0)
      .map((field) => `${name} の${field.label}に、未成年を指す語（${quoteTerms(field.terms)}）が残っています`)
    return [...ageProblems, ...termProblems]
  })
}

// 成人指定のとき、作品設計の人物設定以外の文面 (物語の核、結末、人物の変化、世界のルール、用語、時系列) に
// 未成年を指す語が残っていないことを確かめる (渡されれば呼称表の呼び方も見る)。人物設定は validateAdultCast が見る。全年齢なら常に空。
export type AdultBibleText = {
  premise: string
  ending: string
  arcs: Array<{ name: string; start: string; end: string }>
  world: { rules: string[]; terms: Array<{ term: string; note: string }> }
  timeline: string[]
  // 呼称表。渡されたときだけ、呼び方 (call) を見る (StoryBible をそのまま渡せる)
  addresses?: Array<{ call: string }>
}

export function validateAdultBibleText(ageRating: string, bible: AdultBibleText): string[] {
  if (!isAdultRating(ageRating)) {
    return []
  }
  const items: Array<{ label: string; lines: string[] }> = [
    { label: '物語の核', lines: [bible.premise] },
    { label: '結末', lines: [bible.ending] },
    { label: '人物の変化', lines: bible.arcs.flatMap((arc) => [arc.name, arc.start, arc.end]) },
    { label: '世界のルール', lines: bible.world.rules },
    { label: '用語', lines: bible.world.terms.flatMap((term) => [term.term, term.note]) },
    { label: '時系列', lines: bible.timeline },
    { label: '呼称表', lines: bible.addresses === undefined ? [] : bible.addresses.map((entry) => entry.call) }
  ]
  return items.flatMap((item) => {
    const terms = findMinorTerms(item.lines.join('\n'))
    return terms.length > 0 ? [`作品設計の${item.label}に、未成年を指す語（${quoteTerms(terms)}）が残っています`] : []
  })
}

type CastFields = { name: string; age: string; occupation: string; appearance: string; description: string }

// 作品設計で確定した年齢・職業・外見・背景に差し替える (背景は description に入れる)。
// 辞典の原文には未成年を連想させる記述が残りうるので、行がある人物は空欄も含めて作品設計の文面だけを使う。
// 行が無い人物と、口調の例・一人称・役割などほかのフィールドはそのまま。入力は変更しない。
export function applyBibleCast<T extends CastFields>(cast: T[], bibleCast: BibleCast[]): T[] {
  const rows = new Map<string, BibleCast>()
  for (const row of bibleCast) {
    const name = row.name.trim()
    if (!rows.has(name)) {
      rows.set(name, row)
    }
  }
  return cast.map((member) => {
    const row = rows.get(member.name.trim())
    return row === undefined
      ? member
      : {
          ...member,
          age: row.age,
          occupation: row.occupation,
          appearance: row.appearance,
          description: row.background
        }
  })
}

// ---------------------- 作品設計の入力のハッシュ ----------------------

export type BibleSourceInput = {
  genre: string
  setting: string
  ending: string
  age_rating: string
  pov: string
  // 語り手の名前。居なければ ''
  narrator: string
  cast: Array<{
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
  }>
  relations: Array<{
    source_name: string
    target_name: string
    relation: string
    description: string
    address_override: string
  }>
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

// 主キー (1 つ目の文字列の並び) が同じ行どうしは、内容全体の JSON で並べて入力の順序に依らないようにする。
const sortRows = <T>(rows: T[], primary: (row: T) => string): T[] =>
  [...rows].sort((a, b) => {
    const byPrimary = compareText(primary(a), primary(b))
    return byPrimary !== 0 ? byPrimary : compareText(canonicalJson(a), canonicalJson(b))
  })

// 作品設計の入力が変わったかを検出するためのハッシュ。
// cast は name、relations は source_name と target_name で整列するので、並び順の違いでは変わらない。
// speech_examples は順序に意味があるので並べ替えない。文字列は前後の空白を落とす。
export function bibleSourceHash(input: BibleSourceInput): string {
  const cast = input.cast.map((member) => ({
    name: member.name.trim(),
    role: member.role.trim(),
    gender: member.gender.trim(),
    age: member.age.trim(),
    occupation: member.occupation.trim(),
    appearance: member.appearance.trim(),
    first_person: member.first_person.trim(),
    address_others: member.address_others.trim(),
    speech_examples: member.speech_examples.map((example) => example.trim()),
    description: member.description.trim()
  }))
  const relations = input.relations.map((relation) => ({
    source_name: relation.source_name.trim(),
    target_name: relation.target_name.trim(),
    relation: relation.relation.trim(),
    description: relation.description.trim(),
    address_override: relation.address_override.trim()
  }))
  return stableHash({
    genre: input.genre.trim(),
    setting: input.setting.trim(),
    ending: input.ending.trim(),
    age_rating: input.age_rating.trim(),
    pov: input.pov.trim(),
    narrator: input.narrator.trim(),
    cast: sortRows(cast, (member) => member.name),
    relations: sortRows(relations, (relation) => `${relation.source_name}\u0000${relation.target_name}`)
  })
}
