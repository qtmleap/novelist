// 年齢が数値だけなら「歳」を付ける。すでに「17歳」「不明」等の文字が入っていればそのまま返す。
export function formatAge(age: string): string {
  return /^\d+$/.test(age) ? `${age}歳` : age
}
