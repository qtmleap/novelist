'use client'

import { useMutation } from '@tanstack/react-query'
import { useAtomValue } from 'jotai'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { NovelSkeleton } from '@/components/novel/NovelSkeleton'
import { EMPTY_DEFAULTS, PremiseForm } from '@/components/novel/PremiseForm'
import { PageHeader } from '@/components/PageHeader'
import { QueryBoundary } from '@/components/QueryBoundary'
import { api, readApiError } from '@/lib/api/client'
import { routes } from '@/lib/routes'
import type { CreateNovelInput } from '@/schemas/novel.dto'
import { editorModelAtom, writerModelAtom } from '@/store/atoms'

export default function NewNovelPage() {
  const router = useRouter()
  const editorModel = useAtomValue(editorModelAtom)
  const writerModel = useAtomValue(writerModelAtom)

  const defaults: CreateNovelInput = {
    ...EMPTY_DEFAULTS,
    editor_model: editorModel,
    writer_model: writerModel
  }

  const createMutation = useMutation({
    mutationFn: (data: CreateNovelInput) => api.createNovel(data),
    onSuccess: (novel) => router.push(routes.novels.detail(novel.id)),
    onError: (e) => toast.error(readApiError(e, '小説の作成に失敗しました'))
  })

  return (
    <div className='space-y-6'>
      <PageHeader crumbs={[{ label: '小説一覧', href: routes.novels.list }, { label: '新規作成' }]} />

      <div>
        <h1 className='text-xl font-semibold'>新規作成</h1>
        <p className='mt-0.5 text-sm text-muted-foreground'>
          まずあらすじを登録します。章立てと本文の生成は作成後の詳細画面から実行します。
        </p>
      </div>

      <QueryBoundary fallback={<NovelSkeleton />}>
        <PremiseForm
          onSubmit={async (data) => {
            await createMutation.mutateAsync(data)
          }}
          isSubmitting={createMutation.isPending}
          defaultValues={defaults}
        />
      </QueryBoundary>
    </div>
  )
}
