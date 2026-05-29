'use client'

import { Loader2, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ErrorAlert } from '@/components/novel/ErrorAlert'
import { NovelSkeleton } from '@/components/novel/NovelSkeleton'
import { PremiseForm } from '@/components/novel/PremiseForm'
import { PageHeader } from '@/components/PageHeader'
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
import type { CreateNovelInput, NovelWithChapters } from '@/schemas/novel.dto'

function getNovelId(): string {
  if (typeof window === 'undefined') return ''
  const parts = window.location.pathname.split('/')
  const idx = parts.indexOf('novels')
  return idx !== -1 ? (parts[idx + 1] ?? '') : ''
}

function toFormValues(novel: NovelWithChapters): CreateNovelInput {
  return {
    title: novel.title,
    genre: novel.genre,
    characters: novel.characters,
    setting: novel.setting,
    num_chapters: novel.num_chapters,
    target_chars: novel.target_chars,
    pov: novel.pov,
    tone: novel.tone,
    age_rating: novel.age_rating,
    pov_character_id: novel.pov_character_id,
    ending: novel.ending,
    character_links: novel.cast.map((c) => ({ character_id: c.character_id, role: c.role })),
    relations: novel.relations.map((r) => ({
      source_character_id: r.source_character_id,
      target_character_id: r.target_character_id,
      relation: r.relation,
      description: r.description,
      address_override: r.address_override
    }))
  }
}

export default function NovelEditPage() {
  const [novelId, setNovelId] = useState<string | null>(null)
  const [initialValues, setInitialValues] = useState<CreateNovelInput | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)

  useEffect(() => {
    const id = getNovelId()
    if (!id) return
    setNovelId(id)

    let cancelled = false
    ;(async () => {
      try {
        const res = await api.novels[':id'].$get({ param: { id } })
        if (!res.ok) throw new Error(await readApiError(res))
        const novel = (await res.json()) as NovelWithChapters
        if (!cancelled) setInitialValues(toFormValues(novel))
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : '小説の取得に失敗しました')
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  const handleSubmit = async (data: CreateNovelInput) => {
    if (!novelId) return
    setIsSubmitting(true)
    setError(null)
    try {
      const res = await api.novels[':id'].$put({ param: { id: novelId }, json: data })
      if (!res.ok) throw new Error(await readApiError(res))
      window.location.assign(`/novels/${novelId}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : '小説の更新に失敗しました')
      setIsSubmitting(false)
    }
  }

  const handleDelete = async () => {
    if (!novelId) return
    setIsDeleting(true)
    setError(null)
    try {
      const res = await api.novels[':id'].$delete({ param: { id: novelId } })
      if (res.status !== 204 && !res.ok) {
        throw new Error(await readApiError(res))
      }
      window.location.assign('/novels')
    } catch (e) {
      setError(e instanceof Error ? e.message : '削除に失敗しました')
      setIsDeleting(false)
      setDeleteDialogOpen(false)
    }
  }

  return (
    <div className='space-y-6'>
      <PageHeader
        crumbs={[
          { label: '小説一覧', href: '/novels' },
          { label: initialValues?.title ?? '詳細', href: novelId ? `/novels/${novelId}` : undefined },
          { label: '編集' }
        ]}
      />

      <div>
        <h1 className='text-xl font-semibold'>編集</h1>
        <p className='mt-0.5 text-sm text-muted-foreground'>
          基本情報・文体・登場人物を編集できます。章本文への影響を最小化するため、章数を変えると章立ての再生成が必要になることがあります。
        </p>
      </div>

      {error && <ErrorAlert message={error} onRetry={() => setError(null)} />}

      {!initialValues && !error && <NovelSkeleton />}

      {initialValues && (
        <>
          <PremiseForm onSubmit={handleSubmit} isSubmitting={isSubmitting} defaultValues={initialValues} mode='edit' />

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
                  <AlertDialogCancel disabled={isDeleting}>キャンセル</AlertDialogCancel>
                  <AlertDialogAction
                    variant='destructive'
                    disabled={isDeleting}
                    onClick={(e) => {
                      e.preventDefault()
                      handleDelete()
                    }}
                    className='[&_svg]:size-5!'
                  >
                    {isDeleting ? <Loader2 className='animate-spin' /> : <Trash2 />}
                    {isDeleting ? '削除中…' : '削除する'}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </>
      )}
    </div>
  )
}
