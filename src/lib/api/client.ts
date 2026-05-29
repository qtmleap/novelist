import { hc } from 'hono/client'
import type { AppType } from '@/server/app'

// `AppType` は server 側で `.basePath('/api')` してあるので、hc の戻り値は
// `{ api: { novels: ..., characters: ... } }` の形になる。利用側で `api.api.xxx`
// と書くのを避けるため、`.api` を取り出して再 export する。
export const api = hc<AppType>('/').api

// Hono Client returns a stricter ClientResponse type that lacks `webSocket`.
// Accept either a global Response or anything with `.status` + `.json()`.
type ResponseLike = { status: number; json: () => Promise<unknown> }

// サーバーが返すエラーコードを日本語ラベルに変換する。マッピング外はコードをそのまま使う。
const ERROR_MESSAGES: Record<string, string> = {
  generation_failed: '生成に失敗しました',
  not_found: '見つかりませんでした',
  num_chapters_cannot_decrease: '章数は減らせません',
  outline_not_generated: '章立てがまだ生成されていません',
  invalid_outline: '章立てのデータが壊れています',
  invalid_chapter_number: '章番号が不正です',
  chapter_not_in_outline: 'この章は章立てに含まれていません',
  not_latest_chapter: '最新の生成済み章でのみ操作できます',
  no_chapters: 'まだ章本文が生成されていません',
  db_error: 'データベースエラーが発生しました'
}

// Gemini の detail から既知のブロック種別を見つけて、人向けの説明文を返す。
function translateGeminiDetail(detail: string): string | null {
  if (detail.includes('PROHIBITED_CONTENT')) {
    return 'Gemini のポリシーで拒否されました。登場人物の年齢設定 (18 歳未満) と性的描写の組み合わせなど、Google が一律で禁じている内容に該当している可能性があります。年齢を 18 歳以上にするか、R15/全年齢 に変更してから再試行してください。'
  }
  if (detail.includes('SAFETY')) {
    return 'Gemini のセーフティ判定で拒否されました。プロンプトや設定をやや穏当な内容に調整して再試行してください。'
  }
  if (detail.includes('MAX_TOKENS')) {
    return 'Gemini の出力上限に達しました。目標文字数を下げるか、章を分けてください。'
  }
  if (detail.includes('RECITATION')) {
    return 'Gemini が引用拒否で停止しました。具体的な固有名詞や台詞をプロンプトから減らして再試行してください。'
  }
  return null
}

/**
 * Reads `{ error?: string; detail?: string }` from a non-2xx Hono Client Response.
 * `error` の既知コードを日本語に変換し、Gemini の detail がブロック理由を含めば
 * 利用者向けのガイドに置き換える。Falls back to `HTTP <status>`.
 */
export async function readApiError(res: ResponseLike, fallback?: string): Promise<string> {
  try {
    const data = (await res.json()) as { error?: unknown; detail?: unknown }
    const code = typeof data?.error === 'string' ? data.error : undefined
    const detail = typeof data?.detail === 'string' ? data.detail : undefined
    if (detail) {
      const gemini = translateGeminiDetail(detail)
      if (gemini) return gemini
    }
    const label = code ? (ERROR_MESSAGES[code] ?? code) : undefined
    if (label && detail) return `${label}: ${detail}`
    if (label) return label
  } catch {
    // body was not JSON
  }
  return fallback ?? `HTTP ${res.status}`
}
