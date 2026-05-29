'use client'

import { SquarePen } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { EmptyNovels } from '@/components/novel/EmptyNovels'
import { ErrorAlert } from '@/components/novel/ErrorAlert'
import { NovelCard } from '@/components/novel/NovelCard'
import { NovelSkeletonList } from '@/components/novel/NovelSkeleton'
import { PageHeader } from '@/components/PageHeader'
import { Button } from '@/components/ui/button'
import { api, readApiError } from '@/lib/api/client'
import type { Novel } from '@/schemas/novel.dto'

export default function NovelsPage() {
  const [novels, setNovels] = useState<Novel[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchNovels = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await api.listNovels()
      setNovels(data)
    } catch (e) {
      setError(readApiError(e, '小説一覧の取得に失敗しました'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchNovels()
  }, [fetchNovels])

  return (
    <div className='space-y-6'>
      <PageHeader crumbs={[{ label: '小説一覧' }]} />

      <div className='flex items-center justify-between'>
        <div>
          <h1 className='text-xl font-semibold'>小説一覧</h1>
          <p className='mt-0.5 text-sm text-muted-foreground'>AI が自動生成した小説の一覧です。</p>
        </div>
        <Button asChild size='sm' className='[&_svg]:size-5!'>
          <a href='/novels/new'>
            <SquarePen />
            新規作成
          </a>
        </Button>
      </div>

      {loading && <NovelSkeletonList />}
      {!loading && error && <ErrorAlert message={error} onRetry={fetchNovels} />}
      {!loading && !error && novels.length === 0 && <EmptyNovels />}
      {!loading && !error && novels.length > 0 && (
        <div className='divide-y border-y'>
          {novels.map((novel) => (
            <NovelCard key={novel.id} novel={novel} />
          ))}
        </div>
      )}
    </div>
  )
}
