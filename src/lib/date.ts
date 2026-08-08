// ISO 8601 文字列を直接 parse して日付表示用の文字列を組み立てる。
// Date を経由しないのでタイムゾーン揺れがなく、no-new-date の方針にも沿う。

export function formatDate(iso: string): string {
  const [datePart] = iso.split('T')
  const [y, m, d] = datePart.split('-')
  return `${Number(y)}年${Number(m)}月${Number(d)}日`
}

export function formatDateTime(iso: string): string {
  const [datePart, timePart = ''] = iso.split('T')
  const [y, m, d] = datePart.split('-')
  const [hh = '00', mm = '00'] = timePart.split(':')
  return `${Number(y)}年${Number(m)}月${Number(d)}日 ${hh}:${mm}`
}
