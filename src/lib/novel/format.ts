// 年齢指定バッジの色。R18 を最も強く、R15 を中間、全年齢は控えめにして
// 制限付きの作品が一覧でひと目で分かるようにする。
export function ageRatingClass(rating: string): string {
  if (rating === 'R18') return 'border-red-500 text-red-600'
  if (rating === 'R15') return 'border-amber-500 text-amber-600'
  return 'text-muted-foreground'
}

// トークン数を人向けに丸める (1000 未満は生値、それ以上は k 表記)。
export function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}
