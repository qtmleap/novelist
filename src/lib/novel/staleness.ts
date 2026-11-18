import { stableHash } from '@/lib/novel/hash'
import type { ChapterStaleness, StaleReason } from '@/schemas/story.dto'

// 下流の追従 (docs/plans/2026-11-18-novel-consistency.md の Phase 4)。
// 章の本文に「どの章立てと、どの前章の版から作ったか」を記録しておき、ずれた章を「要再生成」と判定する。
// DB・fetch・cloudflare:workers に依存しない純粋関数だけを置く。

// ---------------------- 章立て項目のハッシュ ----------------------

export type OutlineEntryForHash = {
  title: string
  summary: string
  characters: string[]
  events?: string[]
  time_place?: string
  end_state?: string
  setups?: Array<{ id: string; description: string }>
  payoffs?: string[]
}

// 値が型どおりでなくても (DB の null など) 既定値に倒す。項目の有無でハッシュが変わらないようにするため。
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')

const textList = (value: unknown): string[] => (Array.isArray(value) ? value.map((item) => text(item)) : [])

// 順序に意味がない一覧 (登場人物・回収する伏線の id) は整列して、並びの違いを変更とみなさない。
const sortedTextList = (value: unknown): string[] => textList(value).sort()

const setupList = (value: unknown): Array<{ id: string; description: string }> =>
  Array.isArray(value) ? value.map((item) => ({ id: text(item?.id), description: text(item?.description) })) : []

// 章立て 1 章ぶんのハッシュ。対象は OutlineEntryForHash の 8 項目だけで、chapter_number などほかのキーは見ない。
// 章立てに項目が増えても、既存の章の値は項目の既定値を足した形で計算するので、一斉に「変わった」にならない。
export function outlineEntryHash(entry: OutlineEntryForHash): string {
  return stableHash({
    title: text(entry.title),
    summary: text(entry.summary),
    characters: sortedTextList(entry.characters),
    events: textList(entry.events),
    time_place: text(entry.time_place),
    end_state: text(entry.end_state),
    setups: setupList(entry.setups),
    payoffs: sortedTextList(entry.payoffs)
  })
}

// ---------------------- 鮮度の判定 ----------------------

// 各章の最新 version だけを渡す。null は「この機能より前に作られた章」で判定しない。
export type StalenessChapter = {
  number: number
  id: string
  outlineHash: string | null
  prevChapterId: string | null
}

// 番号の昇順に判定する (入力の並びには依らない)。戻り値は渡した全章ぶん。
// reasons の順序は outline_changed、previous_regenerated、previous_stale で固定。
export function computeStaleness(
  chapters: StalenessChapter[],
  currentOutlineHashes: Map<number, string>
): Map<number, ChapterStaleness> {
  const byNumber = new Map(chapters.map((chapter) => [chapter.number, chapter]))
  const result = new Map<number, ChapterStaleness>()

  const sorted = [...chapters].sort((a, b) => a.number - b.number)
  for (const chapter of sorted) {
    const previous = chapter.number >= 2 ? byNumber.get(chapter.number - 1) : undefined
    const reasons: StaleReason[] = []

    // 章立てにその章の項目が無いとき (get が undefined) も、記録したハッシュとは一致しない。
    if (chapter.outlineHash !== null && currentOutlineHashes.get(chapter.number) !== chapter.outlineHash) {
      reasons.push('outline_changed')
    }
    // 直前の章が無いとき (previous が undefined) も、記録した id とは一致しない。
    if (chapter.number >= 2 && chapter.prevChapterId !== null && previous?.id !== chapter.prevChapterId) {
      reasons.push('previous_regenerated')
    }
    if (previous !== undefined && result.get(previous.number)?.stale === true) {
      reasons.push('previous_stale')
    }

    result.set(chapter.number, { stale: reasons.length > 0, reasons })
  }
  return result
}

// ---------------------- 生成対象の章 ----------------------

// 1 以上の整数だけを残し、重複を除いて昇順に並べる。
export function normalizeTargets(targets: number[]): number[] {
  const valid = targets.filter((target) => Number.isInteger(target) && target >= 1)
  return [...new Set(valid)].sort((a, b) => a - b)
}

// 生成を始める前に「前の章が欠けていないか」を確かめる。
// 1 〜 max(targets)-1 のうち、本文が無く (existing に無く)、同じ生成の対象 (targets) にも無い章番号を昇順で返す。
export function missingPredecessors(targets: number[], existing: Set<number>): number[] {
  const normalized = normalizeTargets(targets)
  const last = normalized.at(-1)
  if (last === undefined) return []
  const requested = new Set(normalized)
  return Array.from({ length: last - 1 }, (_, index) => index + 1).filter(
    (chapterNumber) => !existing.has(chapterNumber) && !requested.has(chapterNumber)
  )
}
