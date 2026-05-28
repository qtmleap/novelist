'use client'

import { useState } from 'react'
import { CharacterForm } from '@/components/character/CharacterForm'
import { ErrorAlert } from '@/components/novel/ErrorAlert'
import { PageHeader } from '@/components/PageHeader'
import { api, readApiError } from '@/lib/api/client'
import type { CreateCharacterInput } from '@/schemas/character.dto'

export default function NewCharacterPage() {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (data: CreateCharacterInput) => {
    setIsSubmitting(true)
    setError(null)
    try {
      const res = await api.characters.$post({ json: data })
      if (!res.ok) throw new Error(await readApiError(res))
      window.location.assign('/characters')
    } catch (e) {
      setError(e instanceof Error ? e.message : '登場人物の登録に失敗しました')
      setIsSubmitting(false)
    }
  }

  return (
    <div className='space-y-6'>
      <PageHeader crumbs={[{ label: '登場人物', href: '/characters' }, { label: '新規登録' }]} />

      <div>
        <h1 className='text-xl font-semibold'>登場人物登録</h1>
        <p className='mt-0.5 text-sm text-muted-foreground'>新しい登場人物の情報を入力してください。</p>
      </div>

      {error && <ErrorAlert message={error} onRetry={() => setError(null)} />}

      <CharacterForm submitLabel='登録する' onSubmit={handleSubmit} isSubmitting={isSubmitting} />
    </div>
  )
}
