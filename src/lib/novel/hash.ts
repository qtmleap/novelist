// 内容の変更を検出するためのハッシュ (暗号用途ではない)。
// Workers・ブラウザ・Bun のどれでも同期で同じ値になるよう、crypto には依存させない。

// 比較・ハッシュの対象は JSON で表せる値 (文字列・数値・真偽値・null・配列・プレーンなオブジェクト) に限る。
// Date や Map のような値は中身を持たない `{}` として扱われるので、呼び出し側で文字列などに直してから渡す。
const compareKeys = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

// キーを再帰的に整列した JSON。値が undefined のキーは落とし、配列の順序は保つ。
// 配列の要素が undefined のとき、トップレベルの値が undefined のとき、関数などのときは JSON.stringify に合わせて null になる。
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`
  }
  if (typeof value === 'object' && value !== null) {
    const members = Object.entries(value)
      .filter(([, member]) => member !== undefined)
      .sort(([a], [b]) => compareKeys(a, b))
      .map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`)
    return `{${members.join(',')}}`
  }
  const json = JSON.stringify(value)
  return json === undefined ? 'null' : json
}

// FNV-1a (64 ビット)。UTF-8 のバイト列に対して計算するので、日本語を含んでも実行環境に依らず同じ値になる。
const FNV_OFFSET_BASIS = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n
const MASK_64 = 0xffffffffffffffffn
const encoder = new TextEncoder()

// canonicalJson の文字列から作る 16 桁の小文字 16 進数。
export function stableHash(value: unknown): string {
  const bytes = encoder.encode(canonicalJson(value))
  const hash = bytes.reduce((acc, byte) => ((acc ^ BigInt(byte)) * FNV_PRIME) & MASK_64, FNV_OFFSET_BASIS)
  return hash.toString(16).padStart(16, '0')
}
