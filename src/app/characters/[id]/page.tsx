'use client'

import { Pencil } from 'lucide-react'
import { useEffect, useState } from 'react'
import { ErrorAlert } from '@/components/novel/ErrorAlert'
import { PageHeader } from '@/components/PageHeader'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { api, readApiError } from '@/lib/api/client'
import type { Character } from '@/schemas/character.dto'

function getCharacterId(): string {
  if (typeof window === 'undefined') return ''
  const parts = window.location.pathname.split('/')
  const idx = parts.indexOf('characters')
  return idx !== -1 ? (parts[idx + 1] ?? '') : ''
}

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

export default function CharacterDetailPage() {
  const [character, setCharacter] = useState<Character | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [id, setId] = useState<string>('')

  useEffect(() => {
    const cid = getCharacterId()
    setId(cid)
    if (!cid) return

    let cancelled = false
    ;(async () => {
      try {
        const data = await api.getCharacter({ params: { id: cid } })
        if (!cancelled) setCharacter(data)
      } catch (e) {
        if (!cancelled) setError(readApiError(e, '登場人物の取得に失敗しました'))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className='space-y-6'>
      <PageHeader crumbs={[{ label: '登場人物一覧', href: '/characters' }, { label: character?.name ?? '詳細' }]} />

      {loading && <DetailSkeleton />}
      {!loading && error && <ErrorAlert message={error} />}
      {!loading && !error && character && (
        <>
          <div className='flex items-start justify-between gap-3'>
            <div className='min-w-0'>
              <p className='text-xs font-medium uppercase tracking-wider text-muted-foreground'>登場人物</p>
              <h1 className='mt-1 text-xl font-semibold'>{character.name}</h1>
            </div>
            <Button asChild size='sm' className='[&_svg]:size-5!'>
              <a href={`/characters/${id}/edit`}>
                <Pencil />
                編集
              </a>
            </Button>
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
        </>
      )}
    </div>
  )
}
