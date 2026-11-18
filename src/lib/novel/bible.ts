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

// 文字列から年齢の数値を読む。全角数字は半角にする (NFKC)。
// 「代」が付く数字 (「20代」「10代後半」) は幅のある表現で確定した年齢ではないので数えない。
// 数字が 2 つ以上あれば最小値を返す (「17〜18歳」→ 17。成人かどうかの確認なので安全側に倒す)。
// 読める数字が無ければ null (「二十代」「不明」「大人」「」)。
export function parseAge(age: string): number | null {
  const normalized = age.normalize('NFKC').replace(/\d+(?:\.\d+)?\s*代/g, ' ')
  const numbers = Array.from(normalized.matchAll(/\d+(?:\.\d+)?/g), (found) => Math.floor(Number(found[0])))
  return numbers.length === 0 ? null : Math.min(...numbers)
}

// 成人指定のとき、名簿の全員に作品設計の行があり、年齢が数字で読めて 18 以上であることを確かめる。
// 数字で読めない年齢 (「二十歳」「20代」「成人」「」) も問題にする: 未成年でないことをコードで確かめられないため。
// 戻り値は問題を表す文の配列 (空なら問題なし)。
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
    const age = parseAge(row.age)
    if (age === null) {
      return [`${name} の年齢が数字で書かれていません（18 以上の数字にしてください）`]
    }
    return age < 18 ? [`${name} の年齢が ${age} 歳です（18 歳以上にしてください）`] : []
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
