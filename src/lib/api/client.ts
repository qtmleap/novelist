import { createApiClient } from './zodios'

// Zodios クライアント。アクセスは `api.<alias>(...)` の形 (詳細は ./zodios.ts)。
// 既存の readApiError 経由でエラー文を出す。
// baseURL は SSR でモジュールロード時にも constructor を通すため非空が必須。
// 実呼び出しはすべて 'use client' のイベントハンドラ内 (ブラウザ) で、
// `/` を起点に同一オリジンの API に解決する。
const baseURL = typeof window === 'undefined' ? 'http://localhost' : window.location.origin
export const api = createApiClient(baseURL)

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
  db_error: 'データベースエラーが発生しました',
  // 認証ミドルウェア由来。401 ステータスとセットで返る。
  unauthenticated: 'ログインが必要です',
  invalid_token: 'ログイン情報が無効です。ログインし直してください'
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
    return 'Gemini の出力トークン上限に達しました。もう一度再生成するか、章を分割してから生成してください。'
  }
  if (detail.includes('RECITATION')) {
    return 'Gemini が引用拒否で停止しました。具体的な固有名詞や台詞をプロンプトから減らして再試行してください。'
  }
  return null
}

// Zodios エラーから response.data の中身を取り出す (as 不要のナローイング)。
function extractErrorBody(error: unknown): { error?: string; detail?: string } | null {
  if (typeof error !== 'object' || error === null) return null
  if (!('response' in error)) return null
  const response = error.response
  if (typeof response !== 'object' || response === null) return null
  if (!('data' in response)) return null
  const data = response.data
  if (typeof data !== 'object' || data === null) return null
  const body: { error?: string; detail?: string } = {}
  if ('error' in data && typeof data.error === 'string') body.error = data.error
  if ('detail' in data && typeof data.detail === 'string') body.detail = data.detail
  return body
}

/**
 * Zodios のエラー (HTTP 失敗 / Zod parse 失敗) を人向け文字列に変換する。
 * 既知の error コードを日本語に置換し、Gemini の block 理由は専用ガイドへ。
 */
export function readApiError(error: unknown, fallback?: string): string {
  const body = extractErrorBody(error)
  if (body?.detail) {
    const gemini = translateGeminiDetail(body.detail)
    if (gemini) return gemini
  }
  const code = body?.error
  const label = code ? (ERROR_MESSAGES[code] ?? code) : undefined
  if (label && body?.detail) return `${label}: ${body.detail}`
  if (label) return label
  if (error instanceof Error) return error.message
  return fallback ?? '通信に失敗しました'
}
