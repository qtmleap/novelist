'use client'

import { useState } from 'react'
import { ErrorAlert } from '@/components/novel/ErrorAlert'
import { PremiseForm } from '@/components/novel/PremiseForm'
import { PageHeader } from '@/components/PageHeader'
import { api, readApiError } from '@/lib/api/client'
import type { CreateNovelInput } from '@/schemas/novel.dto'

export default function NewNovelPage() {
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (data: CreateNovelInput) => {
    setIsSubmitting(true)
    setError(null)
    try {
      const novel = await api.createNovel(data)
      window.location.assign(`/novels/${novel.id}`)
    } catch (e) {
      setError(readApiError(e, '小説の作成に失敗しました'))
      setIsSubmitting(false)
    }
  }

  return (
    <div className='space-y-6'>
      <PageHeader crumbs={[{ label: '小説一覧', href: '/novels' }, { label: '新規作成' }]} />

      <div>
        <h1 className='text-xl font-semibold'>新規作成</h1>
        <p className='mt-0.5 text-sm text-muted-foreground'>
          まずあらすじを登録します。章立てと本文の生成は作成後の詳細画面から実行します。
        </p>
      </div>

      {error && <ErrorAlert message={error} onRetry={() => setError(null)} />}

      <PremiseForm onSubmit={handleSubmit} isSubmitting={isSubmitting} />
    </div>
  )
}
