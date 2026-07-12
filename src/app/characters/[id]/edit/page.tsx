'use client'

import { useMutation, useSuspenseQuery } from '@tanstack/react-query'
import { Loader2, Trash2 } from 'lucide-react'
import { useParams, useRouter } from 'next/navigation'
import { useState } from 'react'
import { toast } from 'sonner'
import { CharacterForm } from '@/components/character/CharacterForm'
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
import { Skeleton } from '@/components/ui/skeleton'
import { api, readApiError } from '@/lib/api/client'
import { routes } from '@/lib/routes'
import type { Character, CreateCharacterInput } from '@/schemas/character.dto'

function characterToInput(c: Character): CreateCharacterInput {
  return {
    name: c.name,
    gender: c.gender,
    age: c.age,
    occupation: c.occupation,
    appearance: c.appearance,
    first_person: c.first_person,
    address_others: c.address_others,
    speech_examples: c.speech_examples,
    description: c.description
  }
}

const SKELETON_FIELDS = [
  'name',
  'gender',
  'age',
  'appearance',
  'first_person',
  'address_others',
  'speech_examples',
  'description'
] as const

function EditSkeleton() {
  return (
    <div className='space-y-5'>
      <div className='space-y-4'>
        {SKELETON_FIELDS.map((f) => (
          <div key={f} className='space-y-2'>
            <Skeleton className='h-4 w-20' />
            <Skeleton className='h-9 w-64' />
          </div>
        ))}
      </div>
    </div>
  )
}

function CharacterEditContent({ id }: { id: string }) {
  const router = useRouter()
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)

  const { data: character } = useSuspenseQuery({
    queryKey: ['character', id],
    queryFn: () => api.getCharacter({ params: { id } })
  })

  const updateMutation = useMutation({
    mutationFn: (data: CreateCharacterInput) => api.updateCharacter(data, { params: { id } }),
    onSuccess: () => router.push(routes.characters.detail(id)),
    onError: (e) => toast.error(readApiError(e, '登場人物の更新に失敗しました'))
  })

  const deleteMutation = useMutation({
    mutationFn: () => api.deleteCharacter(undefined, { params: { id } }),
    onSuccess: () => router.push(routes.characters.list),
    onError: (e) => {
      toast.error(readApiError(e, '削除に失敗しました'))
      setDeleteDialogOpen(false)
    }
  })

  return (
    <>
      <CharacterForm
        defaultValues={characterToInput(character)}
        submitLabel='保存する'
        onSubmit={async (data) => {
          await updateMutation.mutateAsync(data)
        }}
        isSubmitting={updateMutation.isPending}
      />

      <div className='border-t pt-6'>
        <div className='mb-2'>
          <h2 className='text-sm font-semibold text-destructive'>危険な操作</h2>
          <p className='mt-0.5 text-sm text-muted-foreground'>
            この登場人物を辞典から削除します。小説への登場リンクや関係も合わせて消えます。元には戻せません。
          </p>
        </div>
        <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
          <AlertDialogTrigger asChild>
            <Button type='button' variant='destructive' size='sm' className='[&_svg]:size-5!'>
              <Trash2 />
              この登場人物を削除
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>この登場人物を削除しますか？</AlertDialogTitle>
              <AlertDialogDescription>
                「{character.name}
                」を辞典から削除します。小説への登場リンクや関係も合わせて消えます。元には戻せません。
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

export default function EditCharacterPage() {
  const params = useParams<{ id: string }>()
  if (!params) return null
  const { id } = params
  return (
    <div className='space-y-6'>
      <PageHeader
        crumbs={[
          { label: '登場人物一覧', href: routes.characters.list },
          { label: '詳細', href: routes.characters.detail(id) },
          { label: '編集' }
        ]}
      />
      <div>
        <h1 className='text-xl font-semibold'>編集</h1>
        <p className='mt-0.5 text-sm text-muted-foreground'>登場人物の情報を編集します。</p>
      </div>
      <QueryBoundary fallback={<EditSkeleton />}>
        <CharacterEditContent id={id} />
      </QueryBoundary>
    </div>
  )
}
