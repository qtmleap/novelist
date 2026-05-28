import { hc } from 'hono/client'
import type { AppType } from '@/server/app'

// `AppType` は server 側で `.basePath('/api')` してあるので、hc の戻り値は
// `{ api: { novels: ..., characters: ... } }` の形になる。利用側で `api.api.xxx`
// と書くのを避けるため、`.api` を取り出して再 export する。
export const api = hc<AppType>('/').api

// Hono Client returns a stricter ClientResponse type that lacks `webSocket`.
// Accept either a global Response or anything with `.status` + `.json()`.
type ResponseLike = { status: number; json: () => Promise<unknown> }

/**
 * Reads `{ error?: string }` from a non-2xx Hono Client Response.
 * Falls back to `HTTP <status>` when the body cannot be parsed.
 */
export async function readApiError(res: ResponseLike, fallback?: string): Promise<string> {
  try {
    const data = (await res.json()) as { error?: unknown }
    if (typeof data?.error === 'string') return data.error
  } catch {
    // body was not JSON
  }
  return fallback ?? `HTTP ${res.status}`
}
