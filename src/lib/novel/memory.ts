// 既出の章を本文プロンプトへどう入れるかを決める純粋関数。
// 予算に収まる間は全章を全文で渡し、超えたら古い章から「記録」に置き換える。

// 日本語 1 字あたりのトークン数の見積もり。Gemini はシードの実測、OpenAI 互換は未実測なので安全側に 1.0。
export const TOKENS_PER_CHAR = { gemini: 0.65, openai: 1.0 } as const

// 既出の章に使う入力トークン数の上限 (contextWindow が分からないとき、または十分大きいとき)。
export const DEFAULT_CONTEXT_BUDGET_TOKENS = 120_000

// 予算を超えていても必ず全文で渡す直近の章数。直前の場面の文体と流れを切らさないため。
export const KEEP_RECENT_FULL = 2

// 記録に置き換えた章の大きさとみなす文字数。【確定済みの本文】に残るのは見出し 1 行だけ。
// 流れ・事実・人物ごとの記録は【確定事項】に入る。その大きさは呼び出し側が reservedChars に含めて渡す。
export const RECORDED_CHAPTER_CHARS = 80

// 浮動小数点の誤差 (0.65 * 20 が 13.000000000000002 になるなど) で、ちょうどの値が 1 つ繰り上がるのを防ぐ。
const CEIL_EPSILON = 1e-9

// モデルの contextWindow の半分と既定の上限の小さい方。残りの半分は設定、確定事項、出力に使う。
// 0 以下や有限でない値は「分からない」と同じに扱う (予算 0 で全章が記録になるのを避ける)。
export const contextBudgetTokens = (contextWindow: number | null): number =>
  contextWindow !== null && Number.isFinite(contextWindow) && contextWindow > 0
    ? Math.min(DEFAULT_CONTEXT_BUDGET_TOKENS, Math.floor(contextWindow / 2))
    : DEFAULT_CONTEXT_BUDGET_TOKENS

// 文字数からトークン数の見積もり (切り上げ)。
export const estimateTokens = (chars: number, tokensPerChar: number): number =>
  Math.max(0, Math.ceil(chars * tokensPerChar - CEIL_EPSILON))

export type PriorChapter = {
  number: number
  title: string
  content: string
}

export type PriorSelection = {
  // 全文で渡す章の番号 (昇順)
  full: number[]
  // 記録に置き換える章の番号 (昇順)
  recorded: number[]
}

export type SelectPriorOptions = {
  budgetTokens: number
  tokensPerChar: number
  // 既出の本文以外の資料 (設定、章立て、人物など) の文字数。呼び出し側が数えて渡す。
  // 【確定事項】(renderLedger の出力) もここに含める。全章ぶんが入るので、記録に置き換える章を決める前から場所を取る
  reservedChars: number
  keepRecent?: number
}

const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0)

// 全章を全文とし、予算を超える間、全文の章のうち最も古い章を記録に回す。
// 直近 keepRecent 章は予算を超えても全文のまま。入力は変更しない。
export const selectPriorChapters = (prior: PriorChapter[], options: SelectPriorOptions): PriorSelection => {
  const sorted = [...prior].sort((a, b) => a.number - b.number)
  const keepRecent = options.keepRecent === undefined ? KEEP_RECENT_FULL : Math.max(0, Math.floor(options.keepRecent))
  // 記録に回せる章の最大数。直近 keepRecent 章は対象にしない
  const limit = Math.max(0, sorted.length - keepRecent)

  const sizes = sorted.map((chapter) => chapter.content.length)
  const initial = options.reservedChars + sum(sizes)
  // totals[k] = 古い順に k 章を記録に置き換えたときの文字数の合計
  const totals = sizes.slice(0, limit).reduce<number[]>(
    (acc, size, index) => {
      acc.push(acc[index] - size + RECORDED_CHAPTER_CHARS)
      return acc
    },
    [initial]
  )
  // 予算に収まる最小の k。どれも収まらなければ記録に回せる限界まで回す
  const fitting = totals.findIndex((total) => estimateTokens(total, options.tokensPerChar) <= options.budgetTokens)
  const cut = fitting === -1 ? limit : fitting

  return {
    full: sorted.slice(cut).map((chapter) => chapter.number),
    recorded: sorted.slice(0, cut).map((chapter) => chapter.number)
  }
}
