'use client'

import { useAtom } from 'jotai'
import { useEffect, useState } from 'react'
import { PageHeader } from '@/components/PageHeader'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { GEMINI_MODELS, type GeminiModel, GeminiModelSchema, MODEL_META } from '@/schemas/novel.dto'
import { editorModelAtom, writerModelAtom } from '@/store/atoms'

function Stars({ n }: { n: number }) {
  return (
    <span>
      {'★'.repeat(n)}
      {'☆'.repeat(5 - n)}
    </span>
  )
}

function ModelMeta({ model }: { model: GeminiModel }) {
  const meta = MODEL_META[model]
  if (!meta) return null
  return (
    <div className='mt-0.5 flex gap-3 text-xs text-muted-foreground'>
      <span>
        性能 <Stars n={meta.quality} />
      </span>
      <span>
        速度 <Stars n={meta.speed} />
      </span>
      <span>
        価格 <Stars n={meta.price} />
      </span>
    </div>
  )
}

function ModelSelectSkeleton() {
  return (
    <div className='space-y-4'>
      {[0, 1].map((i) => (
        <div key={i} className='space-y-1.5'>
          <Skeleton className='h-4 w-40' />
          <Skeleton className='h-9 w-72' />
          <Skeleton className='h-3 w-48' />
        </div>
      ))}
    </div>
  )
}

function ModelSettings() {
  const [editorModel, setEditorModel] = useAtom(editorModelAtom)
  const [writerModel, setWriterModel] = useAtom(writerModelAtom)
  const [saved, setSaved] = useState(false)

  const showSaved = () => {
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const handleEditorChange = (value: string) => {
    const result = GeminiModelSchema.safeParse(value)
    if (result.success) setEditorModel(result.data)
    showSaved()
  }

  const handleWriterChange = (value: string) => {
    const result = GeminiModelSchema.safeParse(value)
    if (result.success) setWriterModel(result.data)
    showSaved()
  }

  return (
    <>
      <div className='space-y-4'>
        <div className='space-y-1.5'>
          <Label htmlFor='editor-model'>Editor モデル（章立ての生成）</Label>
          <Select value={editorModel} onValueChange={handleEditorChange}>
            <SelectTrigger id='editor-model' className='w-72'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GEMINI_MODELS.map((m) => (
                <SelectItem key={m} value={m}>
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <ModelMeta model={editorModel} />
        </div>

        <div className='space-y-1.5'>
          <Label htmlFor='writer-model'>Writer モデル（本文の生成）</Label>
          <Select value={writerModel} onValueChange={handleWriterChange}>
            <SelectTrigger id='writer-model' className='w-72'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {GEMINI_MODELS.map((m) => (
                <SelectItem key={m} value={m}>
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <ModelMeta model={writerModel} />
        </div>
      </div>

      {saved && <p className='text-sm text-muted-foreground'>保存しました</p>}
    </>
  )
}

export default function SettingsPage() {
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  return (
    <div className='space-y-6'>
      <PageHeader crumbs={[{ label: '設定' }]} />

      <div>
        <h1 className='text-xl font-semibold'>設定</h1>
        <p className='mt-0.5 text-sm text-muted-foreground'>
          章立て・本文の生成に使用する AI モデルを選択してください。設定はこのブラウザに保存されます。
        </p>
      </div>

      <div className='space-y-6'>
        <div>
          <h2 className='text-sm font-semibold'>AI モデル</h2>
          <p className='mt-0.5 text-sm text-muted-foreground'>用途ごとに使用するモデルを選択します。</p>
        </div>

        {mounted ? <ModelSettings /> : <ModelSelectSkeleton />}
      </div>
    </div>
  )
}
