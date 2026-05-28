'use client'

import { Loader2, Trash2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { CharacterForm } from '@/components/character/CharacterForm'
import { ErrorAlert } from '@/components/novel/ErrorAlert'
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
import { Skeleton } from '@/components/ui/skeleton'
import { api, readApiError } from '@/lib/api/client'
import type { Character, CreateCharacterInput } from '@/schemas/character.dto'

function getCharacterId(): string {
  if (typeof window === 'undefined') return ''
  const parts = window.location.pathname.split('/')
  const idx = parts.indexOf('characters')
  return idx !== -1 ? (parts[idx + 1] ?? '') : ''
}

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

export default function EditCharacterPage() {
  const [characterId, setCharacterId] = useState<string>('')
  const [character, setCharacter] = useState<Character | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [isDeleting, setIsDeleting] = useState(false)
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)

  useEffect(() => {
    const id = getCharacterId()
    if (!id) return
    setCharacterId(id)

    const load = async () => {
      try {
        const res = await api.characters[':id'].$get({ param: { id } })
        if (!res.ok) {
          if (res.status === 404) throw new Error('登場人物が見つかりません')
          throw new Error(await readApiError(res))
        }
        const data = (await res.json()) as Character
        setCharacter(data)
      } catch (e) {
        setError(e instanceof Error ? e.message : '登場人物の取得に失敗しました')
      } finally {
        setLoading(false)
      }
    }

    load()
  }, [])

  const handleSubmit = async (data: CreateCharacterInput) => {
    if (!characterId) return
    setIsSubmitting(true)
    setSubmitError(null)
    try {
      const res = await api.characters[':id'].$put({ param: { id: characterId }, json: data })
      if (!res.ok) throw new Error(await readApiError(res))
      window.location.assign(`/characters/${characterId}`)
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : '登場人物の更新に失敗しました')
      setIsSubmitting(false)
    }
  }

  const handleDelete = async () => {
    if (!characterId) return
    setIsDeleting(true)
    setSubmitError(null)
    try {
      const res = await api.characters[':id'].$delete({ param: { id: characterId } })
      if (res.status !== 204 && !res.ok) {
        throw new Error(await readApiError(res))
      }
      window.location.assign('/characters')
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : '削除に失敗しました')
      setIsDeleting(false)
      setDeleteDialogOpen(false)
    }
  }

  return (
    <div className='space-y-6'>
      <PageHeader
        crumbs={[
          { label: '登場人物一覧', href: '/characters' },
          { label: character?.name ?? '詳細', href: characterId ? `/characters/${characterId}` : undefined },
          { label: '編集' }
        ]}
      />

      <div>
        <h1 className='text-xl font-semibold'>登場人物編集</h1>
        <p className='mt-0.5 text-sm text-muted-foreground'>登場人物の情報を編集します。</p>
      </div>

      {loading && <EditSkeleton />}
      {!loading && error && <ErrorAlert message={error} />}
      {!loading && !error && character && (
        <>
          {submitError && <ErrorAlert message={submitError} onRetry={() => setSubmitError(null)} />}
          <CharacterForm
            defaultValues={characterToInput(character)}
            submitLabel='保存する'
            onSubmit={handleSubmit}
            isSubmitting={isSubmitting}
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
