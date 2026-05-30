'use client'

import { useRouter } from 'next/navigation'
import { useEffect } from 'react'
import { PageHeader } from '@/components/PageHeader'
import { useAuth } from '@/hooks/useAuth'

// CF Access の Application で **このページ** (`/login`) だけを gate する。
// 匿名で `/login` にアクセス → CF Access のログイン画面に redirect → 認証 → `/login` に戻ってくる。
// 戻ってきた時点で `CF_Authorization` cookie が host に set されており、
// 以降の API リクエストはその cookie 経由で認証される。
// 認証済みになったら novels 一覧へ遷移する。匿名のままここに居る状況は CF Access の reload 待ち。
export default function LoginPage() {
  const auth = useAuth()
  const router = useRouter()

  useEffect(() => {
    if (auth.status === 'authenticated') {
      router.replace('/novels')
    }
  }, [auth.status, router])

  return (
    <div className='space-y-6'>
      <PageHeader crumbs={[{ label: 'ログイン' }]} />
      <h1 className='text-xl font-semibold'>ログイン</h1>
    </div>
  )
}
