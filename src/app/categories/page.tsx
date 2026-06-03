'use client'

import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { Check, FolderTree, Loader2, Pencil, Plus, Trash2, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { PageHeader } from '@/components/PageHeader'
import { QueryBoundary } from '@/components/QueryBoundary'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { canEdit, useAuth } from '@/hooks/useAuth'
import { api, readApiError } from '@/lib/api/client'
import type { Category } from '@/schemas/novel.dto'

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
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<Category | null>(null)

  const { data: categories } = useSuspenseQuery({
    queryKey: ['categories'],
    queryFn: () => api.listCategories()
  })

  // カテゴリ変更は所属小説の表示 (一覧グループ・作品数) にも効くので novels も無効化する。
  const invalidateAll = () => {
    void queryClient.invalidateQueries({ queryKey: ['categories'] })
    void queryClient.invalidateQueries({ queryKey: ['novels'] })
  }

  const createMutation = useMutation({
    mutationFn: (categoryName: string) => api.createCategory({ name: categoryName }),
    onSuccess: () => {
      setName('')
      invalidateAll()
    },
    onError: (e) => toast.error(readApiError(e, 'カテゴリの作成に失敗しました'))
  })

  const updateMutation = useMutation({
    mutationFn: (vars: { id: string; name: string }) =>
      api.updateCategory({ name: vars.name }, { params: { id: vars.id } }),
    onSuccess: () => {
      setEditingId(null)
      setEditingName('')
      invalidateAll()
    },
    onError: (e) => toast.error(readApiError(e, 'カテゴリ名の変更に失敗しました'))
  })

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteCategory(undefined, { params: { id } }),
    onSuccess: () => {
      setDeleteTarget(null)
      invalidateAll()
    },
    onError: (e) => toast.error(readApiError(e, 'カテゴリの削除に失敗しました'))
  })

  const trimmed = name.trim()
  const canSubmit = editAllowed && trimmed.length > 0 && !createMutation.isPending

  const submit = () => {
    if (!canSubmit) return
    createMutation.mutate(trimmed)
  }

  const startEdit = (cat: Category) => {
    setEditingId(cat.id)
    setEditingName(cat.name)
  }

  const saveEdit = (id: string) => {
    const next = editingName.trim()
    if (next.length === 0 || updateMutation.isPending) return
    updateMutation.mutate({ id, name: next })
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
          {categories.map((cat) => {
            const isEditing = editingId === cat.id
            return (
              <div key={cat.id} className='flex items-center gap-3 px-4 py-3'>
                <FolderTree className='size-5 shrink-0 text-muted-foreground' />
                {isEditing ? (
                  <>
                    <Input
                      autoFocus
                      value={editingName}
                      onChange={(e) => setEditingName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          saveEdit(cat.id)
                        }
                        if (e.key === 'Escape') setEditingId(null)
                      }}
                      maxLength={50}
                      className='h-8 w-60'
                    />
                    <div className='ml-auto flex shrink-0 items-center gap-1'>
                      <Button
                        type='button'
                        size='icon'
                        aria-label='保存'
                        disabled={updateMutation.isPending || editingName.trim().length === 0}
                        onClick={() => saveEdit(cat.id)}
                        className='size-8 [&_svg]:size-5!'
                      >
                        {updateMutation.isPending ? <Loader2 className='animate-spin' /> : <Check />}
                      </Button>
                      <Button
                        type='button'
                        variant='ghost'
                        size='icon'
                        aria-label='キャンセル'
                        onClick={() => setEditingId(null)}
                        className='size-8 [&_svg]:size-5!'
                      >
                        <X />
                      </Button>
                      <Button
                        type='button'
                        variant='ghost'
                        size='icon'
                        aria-label='削除'
                        onClick={() => setDeleteTarget(cat)}
                        className='size-8 text-muted-foreground hover:bg-destructive/10 hover:text-destructive [&_svg]:size-5!'
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </>
                ) : (
                  <>
                    <span className='truncate font-medium text-sm'>{cat.name}</span>
                    <span className='ml-auto shrink-0 text-xs tabular-nums text-muted-foreground'>
                      {cat.novel_count} 作品
                    </span>
                    {editAllowed && (
                      <Button
                        type='button'
                        variant='ghost'
                        size='icon'
                        aria-label='編集'
                        onClick={() => startEdit(cat)}
                        className='size-8 shrink-0 text-muted-foreground [&_svg]:size-5!'
                      >
                        <Pencil />
                      </Button>
                    )}
                  </>
                )}
              </div>
            )
          })}
        </div>
      )}

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>カテゴリ「{deleteTarget?.name}」を削除しますか？</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget !== null && deleteTarget.novel_count > 0
                ? `このカテゴリの小説 ${deleteTarget.novel_count} 件は「未分類」に戻ります。小説自体は削除されません。`
                : 'このカテゴリを削除します。小説自体は削除されません。'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>キャンセル</AlertDialogCancel>
            <AlertDialogAction
              variant='destructive'
              disabled={deleteMutation.isPending}
              onClick={(e) => {
                e.preventDefault()
                if (deleteTarget !== null) deleteMutation.mutate(deleteTarget.id)
              }}
              className='[&_svg]:size-5!'
            >
              {deleteMutation.isPending ? <Loader2 className='animate-spin' /> : <Trash2 />}
              削除する
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
