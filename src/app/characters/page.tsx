'use client'

import { useSuspenseQuery } from '@tanstack/react-query'
import { ChevronRight, Layers, UserPlus, Users } from 'lucide-react'
import { PageHeader } from '@/components/PageHeader'
import { QueryBoundary } from '@/components/QueryBoundary'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { canEdit, useAuth } from '@/hooks/useAuth'
import { api } from '@/lib/api/client'
import { routes } from '@/lib/routes'
import type { Character } from '@/schemas/character.dto'

function CharacterSkeletonRow() {
  return (
    <div className='flex items-center gap-3 px-4 py-3'>
      <Skeleton className='size-5 shrink-0 rounded' />
      <div className='flex-1 space-y-1.5'>
        <Skeleton className='h-4 w-1/4' />
        <Skeleton className='h-3 w-2/5' />
      </div>
      <Skeleton className='ml-auto h-5 w-12 rounded' />
    </div>
  )
}

function CharacterSkeletonList() {
  return (
    <div className='divide-y border-y'>
      {[0, 1, 2].map((i) => (
        <CharacterSkeletonRow key={i} />
      ))}
    </div>
  )
}

function EmptyCharacters() {
  return (
    <div className='flex min-h-[320px] flex-col items-center justify-center gap-4 rounded-md border border-dashed px-6 py-12 text-center'>
      <Users className='size-10 text-muted-foreground' />
      <div className='space-y-1'>
        <p className='font-semibold'>登場人物がまだありません</p>
        <p className='max-w-[28ch] text-sm text-muted-foreground'>登場人物を登録して、小説の生成に活かしましょう。</p>
      </div>
      <Button asChild size='sm' className='[&_svg]:size-5!'>
        <a href={routes.characters.new}>
          <UserPlus />
          登場人物を登録
        </a>
      </Button>
    </div>
  )
}

function CharacterRow({ character }: { character: Character }) {
  return (
    <a
      href={routes.characters.detail(character.id)}
      className='flex items-center gap-3 px-4 py-3 transition hover:bg-muted/50'
    >
      <div className='min-w-0 flex-1'>
        <span className='truncate font-medium text-sm'>{character.name}</span>
        {(character.gender || character.age) && (
          <p className='mt-0.5 text-xs text-muted-foreground'>
            {[character.gender, character.age].filter(Boolean).join('・')}
          </p>
        )}
        {character.description && (
          <p className='mt-0.5 text-xs text-muted-foreground line-clamp-1'>{character.description}</p>
        )}
      </div>
      <div className='ml-auto flex shrink-0 items-center gap-2'>
        {character.variants.length > 0 && (
          <Badge variant='outline' className='text-xs text-muted-foreground'>
            <Layers className='size-3.5' />
            {character.variants.length}
          </Badge>
        )}
        <ChevronRight className='size-5 text-muted-foreground' />
      </div>
    </a>
  )
}

function CharacterListContent() {
  const auth = useAuth()
  const editAllowed = canEdit(auth)
  const { data: characters } = useSuspenseQuery({
    queryKey: ['characters'],
    queryFn: () => api.listCharacters()
  })

  return (
    <>
      <div className='flex items-center justify-between'>
        <div>
          <h1 className='text-xl font-semibold'>登場人物一覧</h1>
          <p className='mt-0.5 text-sm text-muted-foreground'>登場人物の情報を管理します。</p>
        </div>
        {editAllowed ? (
          <Button asChild size='sm' className='[&_svg]:size-5!'>
            <a href={routes.characters.new}>
              <UserPlus />
              新規登録
            </a>
          </Button>
        ) : (
          <Button size='sm' className='[&_svg]:size-5!' disabled title='ログインが必要です'>
            <UserPlus />
            新規登録
          </Button>
        )}
      </div>

      {characters.length === 0 ? (
        <EmptyCharacters />
      ) : (
        <div className='divide-y border-y'>
          {characters.map((c) => (
            <CharacterRow key={c.id} character={c} />
          ))}
        </div>
      )}
    </>
  )
}

export default function CharactersPage() {
  return (
    <div className='space-y-6'>
      <PageHeader crumbs={[{ label: '登場人物一覧' }]} />
      <QueryBoundary fallback={<CharacterSkeletonList />}>
        <CharacterListContent />
      </QueryBoundary>
    </div>
  )
}
