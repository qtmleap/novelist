'use client'

import { useSuspenseQuery } from '@tanstack/react-query'
import { SquarePen } from 'lucide-react'
import { EmptyNovels } from '@/components/novel/EmptyNovels'
import { NovelCard } from '@/components/novel/NovelCard'
import { NovelSkeletonList } from '@/components/novel/NovelSkeleton'
import { PageHeader } from '@/components/PageHeader'
import { QueryBoundary } from '@/components/QueryBoundary'
import { Button } from '@/components/ui/button'
import { canEdit, useAuth } from '@/hooks/useAuth'
import { api } from '@/lib/api/client'
import { routes } from '@/lib/routes'

function NovelListContent() {
  const auth = useAuth()
  const editAllowed = canEdit(auth)
  const { data: novels } = useSuspenseQuery({
    queryKey: ['novels'],
    queryFn: () => api.listNovels()
  })

  return (
    <>
      <div className='flex items-center justify-between'>
        <div>
          <h1 className='text-xl font-semibold'>小説一覧</h1>
          <p className='mt-0.5 text-sm text-muted-foreground'>AI が自動生成した小説の一覧です。</p>
        </div>
        {editAllowed ? (
          <Button asChild size='sm' className='[&_svg]:size-5!'>
            <a href={routes.novels.new}>
              <SquarePen />
              新規作成
            </a>
          </Button>
        ) : (
          <Button size='sm' className='[&_svg]:size-5!' disabled title='ログインが必要です'>
            <SquarePen />
            新規作成
          </Button>
        )}
      </div>

      {novels.length === 0 ? (
        <EmptyNovels />
      ) : (
        <div className='divide-y border-y'>
          {novels.map((novel) => (
            <NovelCard key={novel.id} novel={novel} />
          ))}
        </div>
      )}
    </>
  )
}

export default function NovelsPage() {
  return (
    <div className='space-y-6'>
      <PageHeader crumbs={[{ label: '小説一覧' }]} />
      <QueryBoundary fallback={<NovelSkeletonList />}>
        <NovelListContent />
      </QueryBoundary>
    </div>
  )
}
