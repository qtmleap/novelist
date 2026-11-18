import type { JsonSchema } from '@/lib/novel/outline'

// 補助の呼び出し (章の記録の抽出、作品設計) が返す JSON の形 (純粋関数)。
// Gemini の generationConfig.responseFormat.text.schema に渡す。書き方は outline.ts の章立ての schema に合わせる:
// - 型名は小文字。長さの制約 (minLength、maxItems など) はサーバーが無視するか、複雑すぎるとして拒否するので入れない。
// - 項目はすべて required にする。出力は schema のキーの順に生成されるので、キーの順序 = 書かせる順序。
// - enum は空にしない。候補が 1 つも無い項目は schema から外す (Zod 側は既定値で受ける)。
// プロンプト (assist-prompts.ts) も同じ条件で項目を出し分ける。条件はこのファイルの関数を共有する。

// enum に使える値。空文字と重複を除き、元の順序を保つ。
export function usableValues(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))]
}

// 呼称表は 2 人以上いて初めて組ができる。
export function hasAddressPairs(castNames: string[]): boolean {
  return usableValues(castNames).length >= 2
}

// 部品は呼ぶたびに新しいオブジェクトを作る (同じオブジェクトを schema の複数の場所で共有しない)。
function text(): JsonSchema {
  return { type: 'string' }
}

// 候補があれば enum で縛る。無ければ自由な文字列。
function oneOf(values: string[]): JsonSchema {
  return values.length > 0 ? { type: 'string', enum: [...values] } : text()
}

function arrayOf(items: JsonSchema): JsonSchema {
  return { type: 'array', items }
}

// 項目を足すときは properties に 1 行足す (required は全項目から作る)。
function objectOf(properties: Record<string, JsonSchema>): JsonSchema {
  return { type: 'object', properties, required: Object.keys(properties) }
}

// ---------------------- 章の記録 (ChapterRecordDraftSchema) ----------------------

// castNames: 人物ごとの記録と、章末にその場にいる人物に使える名前 (名簿)。空なら名前を縛らない。
// openThreadIds: この章の前までに未回収の伏線の id。空なら resolved_thread_ids を出させない。
// plannedSetupIds: 章立てでこの章に張る予定の伏線の id。空なら written_setup_ids を出させない。
export function recordJsonSchema(input: {
  castNames: string[]
  openThreadIds: string[]
  plannedSetupIds: string[]
}): JsonSchema {
  const names = usableValues(input.castNames)
  const openIds = usableValues(input.openThreadIds)
  const plannedIds = usableValues(input.plannedSetupIds)
  return objectOf({
    summary: text(),
    facts: arrayOf(text()),
    characters: arrayOf(
      objectOf({ name: oneOf(names), actions: arrayOf(text()), learned: arrayOf(text()), state: text() })
    ),
    new_threads: arrayOf(text()),
    ...(openIds.length > 0 ? { resolved_thread_ids: arrayOf(oneOf(openIds)) } : {}),
    ...(plannedIds.length > 0 ? { written_setup_ids: arrayOf(oneOf(plannedIds)) } : {}),
    end_state: objectOf({ time: text(), place: text(), present: arrayOf(oneOf(names)) })
  })
}

// ---------------------- 作品設計 (StoryBibleSchema) ----------------------

// castNames: 名簿。arcs の name、addresses の from / to、cast の name を縛る。
// adult: 成人指定 (R15 / R18)。名簿があれば、成人としての人物設定 (cast) を出させる。
// cast は先頭に置く。成人としての年齢と職業を先に決めさせ、後に続く premise や timeline をそれに合わせさせるため。
// addresses は名簿が 2 人以上のときだけ、cast は成人指定で名簿があるときだけ入れる。
export function bibleJsonSchema(input: { castNames: string[]; adult: boolean }): JsonSchema {
  const names = usableValues(input.castNames)
  const adultCast = objectOf({
    name: oneOf(names),
    age: text(),
    occupation: text(),
    appearance: text(),
    background: text()
  })
  return objectOf({
    ...(input.adult && names.length > 0 ? { cast: arrayOf(adultCast) } : {}),
    premise: text(),
    ending: text(),
    arcs: arrayOf(objectOf({ name: oneOf(names), start: text(), end: text() })),
    world: objectOf({ rules: arrayOf(text()), terms: arrayOf(objectOf({ term: text(), note: text() })) }),
    timeline: arrayOf(text()),
    ...(hasAddressPairs(names)
      ? { addresses: arrayOf(objectOf({ from: oneOf(names), to: oneOf(names), call: text() })) }
      : {})
  })
}
