'use client'

import { useMutation } from '@tanstack/react-query'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { CharacterForm } from '@/components/character/CharacterForm'
import { PageHeader } from '@/components/PageHeader'
import { api, readApiError } from '@/lib/api/client'
import { routes } from '@/lib/routes'
import type { CreateCharacterInput } from '@/schemas/character.dto'

export default function NewCharacterPage() {
  const router = useRouter()

  const createMutation = useMutation({
    mutationFn: (data: CreateCharacterInput) => api.createCharacter(data),
    onSuccess: () => router.push(routes.characters.list),
    onError: (e) => toast.error(readApiError(e, '登場人物の登録に失敗しました'))
  })

  return (
    <div className='space-y-6'>
      <PageHeader crumbs={[{ label: '登場人物一覧', href: routes.characters.list }, { label: '新規登録' }]} />

      <div>
        <h1 className='text-xl font-semibold'>新規登録</h1>
        <p className='mt-0.5 text-sm text-muted-foreground'>新しい登場人物の情報を入力してください。</p>
      </div>

      <CharacterForm
        submitLabel='登録する'
        onSubmit={async (data) => {
          await createMutation.mutateAsync(data)
        }}
        isSubmitting={createMutation.isPending}
      />
    </div>
  )
}
