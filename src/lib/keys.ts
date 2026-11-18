// 一覧の要素に React のキーを付ける。値が重なっても衝突しないよう、値ごとの出現回数を足す。
// 配列の添字そのものはキーにしない (Biome の noArrayIndexKey。並びが変わると状態がずれるため)。
// 並びが変わらない表示専用の一覧や、キーに使う値を編集しない一覧に限って使う。
// index は、編集する一覧で更新対象の行を指すために返す。
export function withKeys<T>(items: T[], keyOf: (item: T) => string): { key: string; item: T; index: number }[] {
  const seen = new Map<string, number>()
  return items.map((item, index) => {
    const base = keyOf(item)
    const count = seen.get(base)
    const nth = count === undefined ? 0 : count + 1
    seen.set(base, nth)
    return { key: `${base}#${nth}`, item, index }
  })
}
