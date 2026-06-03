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
import type { Novel } from '@/schemas/novel.dto'

const UNCATEGORIZED_LABEL = '未分類'

// カテゴリ名でグループ化する。未分類 (category_name === null) は常に最後。
// それ以外はカテゴリ名の昇順で並べ、各グループ内は元の順序 (API の created_at desc) を保つ。
function groupByCategory(novels: Novel[]): Array<{ label: string; items: Novel[] }> {
  const named = new Map<string, Novel[]>()
  const uncategorized: Novel[] = []
  for (const novel of novels) {
    if (novel.category_name === null) {
      uncategorized.push(novel)
      continue
    }
    const existing = named.get(novel.category_name)
    if (existing) existing.push(novel)
    else named.set(novel.category_name, [novel])
  }
  const groups = Array.from(named.entries())
    .sort(([a], [b]) => a.localeCompare(b, 'ja'))
    .map(([label, items]) => ({ label, items }))
  if (uncategorized.length > 0) groups.push({ label: UNCATEGORIZED_LABEL, items: uncategorized })
  return groups
}

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
        <div className='space-y-6'>
          {groupByCategory(novels).map((group) => (
            <section key={group.label}>
              <h2 className='mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground'>
                {group.label} <span className='tabular-nums'>({group.items.length})</span>
              </h2>
              <div className='divide-y border-y'>
                {group.items.map((novel) => (
                  <NovelCard key={novel.id} novel={novel} />
                ))}
              </div>
            </section>
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
