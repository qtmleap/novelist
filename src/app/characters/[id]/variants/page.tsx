'use client'

import { useMutation, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { Loader2, Pencil, Plus, Trash2 } from 'lucide-react'
import { useParams } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'
import { VariantForm } from '@/components/character/VariantForm'
import { NovelSkeleton } from '@/components/novel/NovelSkeleton'
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
import { canEdit, useAuth } from '@/hooks/useAuth'
import { api, readApiError } from '@/lib/api/client'
import { formatAge } from '@/lib/character/format'
import { routes } from '@/lib/routes'
import type { CharacterVariant, CharacterVariantInput } from '@/schemas/character.dto'

function variantToInput(v: CharacterVariant): CharacterVariantInput {
  return {
    label: v.label,
    age: v.age,
    occupation: v.occupation,
    appearance: v.appearance,
    first_person: v.first_person,
    address_others: v.address_others,
    speech_examples: v.speech_examples,
    description: v.description
  }
}

function VariantsContent({ id }: { id: string }) {
  const auth = useAuth()
  const editAllowed = canEdit(auth)
  const queryClient = useQueryClient()
  // editing: null=非表示, 'new'=新規追加, それ以外=その variantId を編集中。
  const [editing, setEditing] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<CharacterVariant | null>(null)

  const { data: character } = useSuspenseQuery({
    queryKey: ['character', id],
    queryFn: () => api.getCharacter({ params: { id } })
  })

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['character', id] })

  const createMutation = useMutation({
    mutationFn: (input: CharacterVariantInput) => api.createVariant(input, { params: { id } }),
    onSuccess: () => {
      setEditing(null)
      void invalidate()
    },
    onError: (e) => toast.error(readApiError(e, 'バリエーションの追加に失敗しました'))
  })

  const updateMutation = useMutation({
    mutationFn: (vars: { variantId: string; input: CharacterVariantInput }) =>
      api.updateVariant(vars.input, { params: { id, variantId: vars.variantId } }),
    onSuccess: () => {
      setEditing(null)
      void invalidate()
    },
    onError: (e) => toast.error(readApiError(e, 'バリエーションの更新に失敗しました'))
  })

  const deleteMutation = useMutation({
    mutationFn: (variantId: string) => api.deleteVariant(undefined, { params: { id, variantId } }),
    onSuccess: () => {
      setDeleteTarget(null)
      void invalidate()
    },
    onError: (e) => toast.error(readApiError(e, 'バリエーションの削除に失敗しました'))
  })

  return (
    <>
      <div className='flex items-start justify-between gap-3'>
        <div className='min-w-0'>
          <h1 className='text-xl font-semibold'>{character.name} のバリエーション</h1>
          <p className='mt-0.5 text-sm text-muted-foreground'>
            別の姿・状態を登録します。空欄の項目はベースの設定を引き継ぎます。
          </p>
        </div>
        {editAllowed && editing !== 'new' && (
          <Button type='button' size='sm' className='shrink-0 [&_svg]:size-5!' onClick={() => setEditing('new')}>
            <Plus />
            追加
          </Button>
        )}
      </div>

      {editing === 'new' && (
        <div className='border-y py-4'>
          <VariantForm
            submitLabel='追加する'
            isSubmitting={createMutation.isPending}
            onSubmit={async (input) => {
              await createMutation.mutateAsync(input)
            }}
            onCancel={() => setEditing(null)}
          />
        </div>
      )}

      {character.variants.length === 0 && editing !== 'new' ? (
        <p className='text-sm text-muted-foreground'>まだバリエーションがありません。</p>
      ) : (
        <div className='divide-y border-y'>
          {character.variants.map((v) =>
            editing === v.id ? (
              <div key={v.id} className='py-4'>
                <VariantForm
                  defaultValues={variantToInput(v)}
                  submitLabel='保存する'
                  isSubmitting={updateMutation.isPending}
                  onSubmit={async (input) => {
                    await updateMutation.mutateAsync({ variantId: v.id, input })
                  }}
                  onCancel={() => setEditing(null)}
                />
              </div>
            ) : (
              <div key={v.id} className='flex items-start gap-3 px-1 py-3'>
                <div className='min-w-0 flex-1'>
                  <p className='text-sm font-medium'>{v.label}</p>
                  <div className='mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground'>
                    {v.age.length > 0 && <span>年齢 {formatAge(v.age)}</span>}
                    {v.occupation.length > 0 && <span>職業 {v.occupation}</span>}
                    {v.first_person.length > 0 && <span>一人称「{v.first_person}」</span>}
                    {v.address_others.length > 0 && <span>呼び方「{v.address_others}」</span>}
                    {v.appearance.length > 0 && <span className='max-w-[24ch] truncate'>外見 {v.appearance}</span>}
                    {v.speech_examples.length > 0 && <span>口調 {v.speech_examples.length}例</span>}
                    {v.description.length > 0 && <span>説明あり</span>}
                  </div>
                  {v.age.length === 0 &&
                    v.occupation.length === 0 &&
                    v.first_person.length === 0 &&
                    v.address_others.length === 0 &&
                    v.appearance.length === 0 &&
                    v.speech_examples.length === 0 &&
                    v.description.length === 0 && (
                      <p className='mt-0.5 text-xs text-muted-foreground'>上書き項目なし（すべてベース継承）</p>
                    )}
                </div>
                {editAllowed && (
                  <div className='flex shrink-0 items-center gap-1'>
                    <Button
                      type='button'
                      variant='ghost'
                      size='icon'
                      aria-label='編集'
                      onClick={() => setEditing(v.id)}
                      className='size-8 text-muted-foreground [&_svg]:size-5!'
                    >
                      <Pencil />
                    </Button>
                    <Button
                      type='button'
                      variant='ghost'
                      size='icon'
                      aria-label='削除'
                      onClick={() => setDeleteTarget(v)}
                      className='size-8 text-muted-foreground hover:bg-destructive/10 hover:text-destructive [&_svg]:size-5!'
                    >
                      <Trash2 />
                    </Button>
                  </div>
                )}
              </div>
            )
          )}
        </div>
      )}

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>バリエーション「{deleteTarget?.label}」を削除しますか？</AlertDialogTitle>
            <AlertDialogDescription>このバリエーションを削除します。元には戻せません。</AlertDialogDescription>
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

export default function CharacterVariantsPage() {
  const { id } = useParams<{ id: string }>()
  return (
    <div className='space-y-6'>
      <PageHeader
        crumbs={[
          { label: '登場人物一覧', href: routes.characters.list },
          { label: '詳細', href: routes.characters.detail(id) },
          { label: 'バリエーション' }
        ]}
      />
      <QueryBoundary fallback={<NovelSkeleton />}>
        <VariantsContent id={id} />
      </QueryBoundary>
    </div>
  )
}
