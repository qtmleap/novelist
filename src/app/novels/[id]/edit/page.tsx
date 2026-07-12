'use client'

import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { Loader2, Trash2 } from 'lucide-react'
import { useParams, useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'
import { NovelSkeleton } from '@/components/novel/NovelSkeleton'
import { PremiseForm } from '@/components/novel/PremiseForm'
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
  AlertDialogTitle,
  AlertDialogTrigger
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { api, readApiError } from '@/lib/api/client'
import { routes } from '@/lib/routes'
import { type CreateNovelInput, GeminiModelSchema, type NovelWithChapters } from '@/schemas/novel.dto'

function toFormValues(novel: NovelWithChapters): CreateNovelInput {
  return {
    title: novel.title,
    genre: novel.genre,
    setting: novel.setting,
    num_chapters: novel.num_chapters,
    target_chars: novel.target_chars,
    outline_summary_chars: novel.outline_summary_chars,
    pov: novel.pov,
    tone: novel.tone,
    age_rating: novel.age_rating,
    ending: novel.ending,
    notes: novel.notes,
    // DB は NOT NULL default で常に有効値だが、型としては string なので parse で narrow する。
    // 無効値が混入したら表示時点で気付かせるため throw する (Surface or throw)。
    editor_model: GeminiModelSchema.parse(novel.editor_model),
    writer_model: GeminiModelSchema.parse(novel.writer_model),
    category_id: novel.category_id
  }
}

function NovelEditContent({ id }: { id: string }) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)

  // queryFn は正規の NovelWithChapters をそのままキャッシュに入れ、フォーム値への変換は
  // select で行う。詳細ページ (同じ ['novel', id] キー) がこのキャッシュを読むため、
  // ここで toFormValues した形を保存すると chapters 等が欠落して詳細ページが壊れる。
  const { data: initialValues } = useSuspenseQuery({
    queryKey: ['novel', id],
    queryFn: () => api.getNovel({ params: { id } }),
    select: toFormValues
  })

  const updateMutation = useMutation({
    mutationFn: (data: CreateNovelInput) => api.updateNovel(data, { params: { id } }),
    onSuccess: () => {
      // 詳細ページへ戻る前に ['novel', id] を無効化し、編集後の最新を再取得させる。
      void queryClient.invalidateQueries({ queryKey: ['novel', id] })
      router.push(routes.novels.detail(id))
    },
    onError: (e) => toast.error(readApiError(e, '小説の更新に失敗しました'))
  })

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteNovel(undefined, { params: { id } }),
    onSuccess: () => router.push(routes.novels.list),
    onError: (e) => {
      toast.error(readApiError(e, '削除に失敗しました'))
      setDeleteDialogOpen(false)
    }
  })

  return (
    <>
      <PremiseForm
        onSubmit={async (data) => {
          await updateMutation.mutateAsync(data)
        }}
        isSubmitting={updateMutation.isPending}
        defaultValues={initialValues}
        mode='edit'
      />

      <div className='border-t pt-6'>
        <div className='mb-2'>
          <h2 className='text-sm font-semibold text-destructive'>危険な操作</h2>
          <p className='mt-0.5 text-sm text-muted-foreground'>
            この小説と紐付く章本文・生成コスト履歴をすべて削除します。元には戻せません。
          </p>
        </div>
        <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
          <AlertDialogTrigger asChild>
            <Button type='button' variant='destructive' size='sm' className='[&_svg]:size-5!'>
              <Trash2 />
              この小説を削除
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>この小説を削除しますか？</AlertDialogTitle>
              <AlertDialogDescription>
                「{initialValues.title}」と紐付く章本文・生成コスト履歴をすべて削除します。元には戻せません。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleteMutation.isPending}>キャンセル</AlertDialogCancel>
              <AlertDialogAction
                variant='destructive'
                disabled={deleteMutation.isPending}
                onClick={(e) => {
                  e.preventDefault()
                  deleteMutation.mutate()
                }}
                className='[&_svg]:size-5!'
              >
                {deleteMutation.isPending ? <Loader2 className='animate-spin' /> : <Trash2 />}
                {deleteMutation.isPending ? '削除中…' : '削除する'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </>
  )
}

export default function NovelEditPage() {
  const { id } = useParams<{ id: string }>()
  return (
    <div className='space-y-6'>
      <PageHeader
        crumbs={[
          { label: '小説一覧', href: routes.novels.list },
          { label: '詳細', href: routes.novels.detail(id) },
          { label: '編集' }
        ]}
      />
      <div>
        <h1 className='text-xl font-semibold'>編集</h1>
        <p className='mt-0.5 text-sm text-muted-foreground'>
          基本情報・文体・登場人物を編集できます。章本文への影響を最小化するため、章数を変えると章立ての再生成が必要になることがあります。
        </p>
      </div>
      <QueryBoundary fallback={<NovelSkeleton />}>
        <NovelEditContent id={id} />
      </QueryBoundary>
    </div>
  )
}
