'use client'

import { useMutation, useSuspenseQuery } from '@tanstack/react-query'
import { Copy, Loader2, Pencil } from 'lucide-react'
import { useParams, useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { PageHeader } from '@/components/PageHeader'
import { QueryBoundary } from '@/components/QueryBoundary'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { canEdit, useAuth } from '@/hooks/useAuth'
import { api, readApiError } from '@/lib/api/client'
import { routes } from '@/lib/routes'
import type { Character } from '@/schemas/character.dto'

function DetailSkeleton() {
  return (
    <div className='space-y-4'>
      <Skeleton className='h-5 w-32' />
      <Skeleton className='h-4 w-56' />
      <Skeleton className='h-20 w-full' />
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className='flex gap-4 py-2'>
      <p className='w-28 shrink-0 text-xs font-medium uppercase tracking-wider text-muted-foreground pt-0.5'>{label}</p>
      <div className='min-w-0 flex-1 text-sm whitespace-pre-wrap'>{children}</div>
    </div>
  )
}

function CharacterDetailContent({ id }: { id: string }) {
  const router = useRouter()
  const auth = useAuth()
  const editAllowed = canEdit(auth)
  const { data: character } = useSuspenseQuery({
    queryKey: ['character', id],
    queryFn: () => api.getCharacter({ params: { id } })
  })

  const copyMutation = useMutation({
    mutationFn: (c: Character) =>
      api.createCharacter({
        // name にだけ `(コピー)` を付けて識別。残りはそのまま複製。
        name: `${c.name} (コピー)`,
        gender: c.gender,
        age: c.age,
        occupation: c.occupation,
        appearance: c.appearance,
        first_person: c.first_person,
        address_others: c.address_others,
        speech_examples: c.speech_examples,
        description: c.description,
        variants: c.variants.map((s) => ({
          label: s.label,
          age: s.age,
          occupation: s.occupation,
          appearance: s.appearance,
          first_person: s.first_person,
          address_others: s.address_others,
          speech_examples: s.speech_examples,
          description: s.description
        }))
      }),
    onSuccess: (created) => router.push(routes.characters.edit(created.id)),
    onError: (e) => toast.error(readApiError(e, '登場人物のコピーに失敗しました'))
  })

  return (
    <>
      <div className='flex items-start justify-between gap-3'>
        <div className='min-w-0'>
          <p className='text-xs font-medium uppercase tracking-wider text-muted-foreground'>登場人物</p>
          <h1 className='mt-1 text-xl font-semibold'>{character.name}</h1>
        </div>
        <div className='flex shrink-0 items-center gap-2'>
          <Button
            type='button'
            size='sm'
            variant='outline'
            className='[&_svg]:size-5!'
            disabled={!editAllowed || copyMutation.isPending}
            title={!editAllowed ? 'ログインが必要です' : undefined}
            onClick={() => copyMutation.mutate(character)}
          >
            {copyMutation.isPending ? <Loader2 className='animate-spin' /> : <Copy />}
            コピー
          </Button>
          {editAllowed ? (
            <Button asChild size='sm' className='[&_svg]:size-5!'>
              <a href={routes.characters.edit(id)}>
                <Pencil />
                編集
              </a>
            </Button>
          ) : (
            <Button size='sm' className='[&_svg]:size-5!' disabled title='ログインが必要です'>
              <Pencil />
              編集
            </Button>
          )}
        </div>
      </div>

      <div className='divide-y border-y'>
        {character.gender && <Field label='性別'>{character.gender}</Field>}
        {character.age && <Field label='年齢'>{character.age}</Field>}
        {character.occupation && <Field label='職業'>{character.occupation}</Field>}
        {character.appearance && <Field label='外見'>{character.appearance}</Field>}
        {character.first_person && <Field label='一人称'>{character.first_person}</Field>}
        {character.address_others && <Field label='他者の呼び方'>{character.address_others}</Field>}
        {character.speech_examples.length > 0 && (
          <Field label='口調の例'>
            <ul className='space-y-1'>
              {character.speech_examples.map((s, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: 口調の例は表示専用で順序固定のため index で十分
                <li key={i} className='text-foreground/90'>
                  「{s}」
                </li>
              ))}
            </ul>
          </Field>
        )}
        {character.description && <Field label='説明'>{character.description}</Field>}
      </div>

      {character.variants.length > 0 && (
        <div className='space-y-2'>
          <div>
            <h2 className='text-sm font-semibold'>バリエーション</h2>
            <p className='mt-0.5 text-xs text-muted-foreground'>表示されていない項目はベースの設定を引き継ぎます。</p>
          </div>
          <div className='divide-y border-y'>
            {character.variants.map((s) => (
              <div key={s.id} className='py-3'>
                <p className='text-sm font-medium'>{s.label}</p>
                <div className='mt-1 divide-y'>
                  {s.age && <Field label='年齢'>{s.age}</Field>}
                  {s.occupation && <Field label='職業'>{s.occupation}</Field>}
                  {s.appearance && <Field label='外見'>{s.appearance}</Field>}
                  {s.first_person && <Field label='一人称'>{s.first_person}</Field>}
                  {s.address_others && <Field label='他者の呼び方'>{s.address_others}</Field>}
                  {s.speech_examples.length > 0 && (
                    <Field label='口調の例'>
                      <ul className='space-y-1'>
                        {s.speech_examples.map((ex, i) => (
                          // biome-ignore lint/suspicious/noArrayIndexKey: 表示専用で順序固定
                          <li key={i} className='text-foreground/90'>
                            「{ex}」
                          </li>
                        ))}
                      </ul>
                    </Field>
                  )}
                  {s.description && <Field label='説明'>{s.description}</Field>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  )
}

export default function CharacterDetailPage() {
  const { id } = useParams<{ id: string }>()
  return (
    <div className='space-y-6'>
      <PageHeader crumbs={[{ label: '登場人物一覧', href: routes.characters.list }, { label: '詳細' }]} />
      <QueryBoundary fallback={<DetailSkeleton />}>
        <CharacterDetailContent id={id} />
      </QueryBoundary>
    </div>
  )
}
