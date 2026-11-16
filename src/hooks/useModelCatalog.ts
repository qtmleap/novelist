'use client'

import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api/client'
import { GEMINI_CATALOG } from '@/schemas/novel.dto'
import type { ModelCatalog } from '@/schemas/provider.dto'

const FALLBACK: ModelCatalog = {
  openaiConfigured: false,
  openaiFormat: 'chat',
  openaiError: null,
  models: GEMINI_CATALOG
}

// モデル選択用の一覧。取得中・失敗中は Gemini の固定一覧に倒して、選択肢が空にならないようにする。
// 失敗の理由は catalog.openaiError ではなく query.error で別に扱う (サーバーに届かなかった場合)。
export function useModelCatalog() {
  const query = useQuery({
    queryKey: ['models'],
    queryFn: () => api.listModels(),
    staleTime: 5 * 60 * 1000
  })
  return { catalog: query.data === undefined ? FALLBACK : query.data, isPending: query.isPending, error: query.error }
}
