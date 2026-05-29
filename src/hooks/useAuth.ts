'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/api/client'

// /api/auth/me の結果。
// - loading: 取得中 (mount 直後)。disabled 判定で UI が一瞬「未認証」に倒れるのを防ぐため明示の loading 状態を持つ
// - 'anonymous': 未認証 (email=null)
// - 'authenticated': 認証済み (email あり)
export type AuthState = { status: 'loading' } | { status: 'anonymous' } | { status: 'authenticated'; email: string }

/**
 * `/api/auth/me` を mount 時に 1 回 fetch して認証状態を返す。
 * 401 では返らない (バックエンドは常に 200) ので例外は通信エラーとして扱う。
 */
export function useAuth(): AuthState {
  const [state, setState] = useState<AuthState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    api
      .getAuthState()
      .then((data) => {
        if (cancelled) return
        if (data.email === null) {
          setState({ status: 'anonymous' })
        } else {
          setState({ status: 'authenticated', email: data.email })
        }
      })
      .catch(() => {
        // 通信エラー時は anonymous 扱い (= 編集ボタン disabled)。401 はサーバが返さない設計なのでここに来るのはネットワーク異常のみ。
        if (cancelled) return
        setState({ status: 'anonymous' })
      })
    return () => {
      cancelled = true
    }
  }, [])

  return state
}

// 編集権限判定。loading 中は disabled に倒す (false 扱い) ことで未認証ユーザーに一瞬編集 UI を見せる事故を避ける。
export function canEdit(state: AuthState): boolean {
  return state.status === 'authenticated'
}
