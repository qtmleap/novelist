'use client'

import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { FolderTree, Loader2, Plus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/PageHeader'
import { QueryBoundary } from '@/components/QueryBoundary'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { canEdit, useAuth } from '@/hooks/useAuth'
import { api, readApiError } from '@/lib/api/client'

function CategorySkeletonList() {
  return (
    <div className='divide-y border-y'>
      {[0, 1, 2].map((i) => (
        <div key={i} className='flex items-center gap-3 px-4 py-3'>
          <Skeleton className='size-5 shrink-0 rounded' />
          <Skeleton className='h-4 w-1/3' />
          <Skeleton className='ml-auto h-4 w-12 rounded' />
        </div>
      ))}
    </div>
  )
}

function EmptyCategories() {
  return (
    <div className='flex min-h-[240px] flex-col items-center justify-center gap-3 rounded-md border border-dashed px-6 py-12 text-center'>
      <FolderTree className='size-10 text-muted-foreground' />
      <div className='space-y-1'>
        <p className='font-semibold'>カテゴリがまだありません</p>
        <p className='max-w-[32ch] text-sm text-muted-foreground'>
          カテゴリを作成すると、小説をフォルダのように分けて管理できます。
        </p>
      </div>
    </div>
  )
}

function CategoryListContent() {
  const auth = useAuth()
  const editAllowed = canEdit(auth)
  const queryClient = useQueryClient()
  const [name, setName] = useState('')

  const { data: categories } = useSuspenseQuery({
    queryKey: ['categories'],
    queryFn: () => api.listCategories()
  })

  const createMutation = useMutation({
    mutationFn: (categoryName: string) => api.createCategory({ name: categoryName }),
    onSuccess: () => {
      setName('')
      void queryClient.invalidateQueries({ queryKey: ['categories'] })
      // 一覧の作品数表示にも効くので novels も無効化しておく。
      void queryClient.invalidateQueries({ queryKey: ['novels'] })
    },
    onError: (e) => toast.error(readApiError(e, 'カテゴリの作成に失敗しました'))
  })

  const trimmed = name.trim()
  const canSubmit = editAllowed && trimmed.length > 0 && !createMutation.isPending

  const submit = () => {
    if (!canSubmit) return
    createMutation.mutate(trimmed)
  }

  return (
    <>
      <div>
        <h1 className='text-xl font-semibold'>カテゴリ</h1>
        <p className='mt-0.5 text-sm text-muted-foreground'>
          小説を分類するカテゴリを管理します。割り当ては各小説の作成・編集画面で行います。
        </p>
      </div>

      <div className='flex flex-wrap items-center gap-2'>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              submit()
            }
          }}
          placeholder='新しいカテゴリ名'
          maxLength={50}
          disabled={!editAllowed}
          className='w-60'
        />
        <Button
          type='button'
          size='sm'
          disabled={!canSubmit}
          onClick={submit}
          title={editAllowed ? undefined : 'ログインが必要です'}
          className='[&_svg]:size-5!'
        >
          {createMutation.isPending ? <Loader2 className='animate-spin' /> : <Plus />}
          作成
        </Button>
      </div>

      {categories.length === 0 ? (
        <EmptyCategories />
      ) : (
        <div className='divide-y border-y'>
          {categories.map((cat) => (
            <div key={cat.id} className='flex items-center gap-3 px-4 py-3'>
              <FolderTree className='size-5 shrink-0 text-muted-foreground' />
              <span className='truncate font-medium text-sm'>{cat.name}</span>
              <span className='ml-auto shrink-0 text-xs tabular-nums text-muted-foreground'>
                {cat.novel_count} 作品
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

export default function CategoriesPage() {
  return (
    <div className='space-y-6'>
      <PageHeader crumbs={[{ label: 'カテゴリ' }]} />
      <QueryBoundary fallback={<CategorySkeletonList />}>
        <CategoryListContent />
      </QueryBoundary>
    </div>
  )
}
