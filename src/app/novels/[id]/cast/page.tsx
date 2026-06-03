'use client'

import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { useParams, useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { CastForm } from '@/components/novel/CastForm'
import { NovelSkeleton } from '@/components/novel/NovelSkeleton'
import { PageHeader } from '@/components/PageHeader'
import { QueryBoundary } from '@/components/QueryBoundary'
import { api, readApiError } from '@/lib/api/client'
import { routes } from '@/lib/routes'
import type { SaveCastInput } from '@/schemas/novel.dto'

function CastContent({ id }: { id: string }) {
  const router = useRouter()
  const queryClient = useQueryClient()

  const { data: novel } = useSuspenseQuery({
    queryKey: ['novel', id],
    queryFn: () => api.getNovel({ params: { id } })
  })

  const saveMutation = useMutation({
    mutationFn: (input: SaveCastInput) => api.saveNovelCast(input, { params: { id } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['novel', id] })
      router.push(routes.novels.detail(id))
    },
    onError: (e) => toast.error(readApiError(e, 'キャストの保存に失敗しました'))
  })

  const defaultValues: SaveCastInput = {
    pov_character_id: novel.pov_character_id,
    character_links: novel.cast.map((c) => ({ character_id: c.character_id, role: c.role, variant_id: c.variant_id })),
    relations: novel.relations.map((r) => ({
      source_character_id: r.source_character_id,
      target_character_id: r.target_character_id,
      relation: r.relation,
      description: r.description,
      address_override: r.address_override
    }))
  }

  return (
    <>
      <div>
        <h1 className='text-xl font-semibold'>{novel.title} の登場人物</h1>
        <p className='mt-0.5 text-sm text-muted-foreground'>
          この小説に登場する人物・関係・語り手を設定します。章立て・本文の両方に反映されます。
        </p>
      </div>
      <CastForm
        novelId={id}
        pov={novel.pov}
        defaultValues={defaultValues}
        isSubmitting={saveMutation.isPending}
        onSubmit={async (input) => {
          await saveMutation.mutateAsync(input)
        }}
      />
    </>
  )
}

export default function NovelCastPage() {
  const { id } = useParams<{ id: string }>()
  return (
    <div className='space-y-6'>
      <PageHeader
        crumbs={[
          { label: '小説一覧', href: routes.novels.list },
          { label: '詳細', href: routes.novels.detail(id) },
          { label: '登場人物' }
        ]}
      />
      <QueryBoundary fallback={<NovelSkeleton />}>
        <CastContent id={id} />
      </QueryBoundary>
    </div>
  )
}
