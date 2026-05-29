'use client'

import { ArrowRight, CircleCheck, Loader2 } from 'lucide-react'
import { useEffect } from 'react'
import { PageHeader } from '@/components/PageHeader'
import { Button } from '@/components/ui/button'
import { useAuth } from '@/hooks/useAuth'

// CF Access の Application で **このページ** (`/login`) だけを gate する。
// 匿名で `/login` にアクセス → CF Access のログイン画面に redirect → 認証 → `/login` に戻ってくる。
// 戻ってきた時点で `CF_Authorization` cookie が host に set されており、
// 以降の API リクエストはその cookie 経由で認証される。
//
// ページ自体は「ログインに成功したのが見える」だけのシンプル UI にする (3 秒後に /novels へ自動遷移)。
export default function LoginPage() {
  const auth = useAuth()

  useEffect(() => {
    if (auth.status !== 'authenticated') return
    // 認証済みなら novels 一覧へ自動遷移。location.assign で history に積む (戻るボタンで戻れる)。
    const timer = setTimeout(() => {
      window.location.assign('/novels')
    }, 1500)
    return () => {
      clearTimeout(timer)
    }
  }, [auth.status])

  return (
    <div className='space-y-6'>
      <PageHeader crumbs={[{ label: 'ログイン' }]} />

      <div className='flex flex-col items-center justify-center gap-4 py-12 text-center'>
        {auth.status === 'loading' && (
          <>
            <Loader2 className='size-10 animate-spin text-muted-foreground' />
            <p className='text-sm text-muted-foreground'>認証情報を確認中…</p>
          </>
        )}

        {auth.status === 'authenticated' && (
          <>
            <CircleCheck className='size-10 text-emerald-600' />
            <div>
              <p className='font-semibold'>ログインしました</p>
              <p className='mt-1 text-sm text-muted-foreground'>{auth.email}</p>
            </div>
            <Button asChild size='sm' variant='outline' className='[&_svg]:size-5!'>
              <a href='/novels'>
                小説一覧へ
                <ArrowRight />
              </a>
            </Button>
          </>
        )}

        {auth.status === 'anonymous' && (
          <>
            <p className='font-semibold'>ログインが必要です</p>
            <p className='max-w-[36ch] text-sm text-muted-foreground'>
              このページは Cloudflare Access でガードされています。再読み込みでログイン画面に進めない場合は、
              ブラウザのキャッシュをクリアするか、運営者にお問い合わせください。
            </p>
            <Button asChild size='sm' className='[&_svg]:size-5!'>
              <a href='/login'>もう一度試す</a>
            </Button>
          </>
        )}
      </div>
    </div>
  )
}
