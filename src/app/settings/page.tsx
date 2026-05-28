'use client'

import { useEffect, useState } from 'react'
import { PageHeader } from '@/components/PageHeader'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { getEditorModel, getWriterModel, setEditorModel, setWriterModel } from '@/lib/settings'
import { GEMINI_MODELS, type GeminiModel, MODEL_META } from '@/schemas/novel.dto'

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

export default function SettingsPage() {
  const [editorModel, setEditorModelState] = useState<GeminiModel | null>(null)
  const [writerModel, setWriterModelState] = useState<GeminiModel | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    setEditorModelState(getEditorModel())
    setWriterModelState(getWriterModel())
  }, [])

  const handleEditorChange = (value: string) => {
    const m = value as GeminiModel
    setEditorModel(m)
    setEditorModelState(m)
    showSaved()
  }

  const handleWriterChange = (value: string) => {
    const m = value as GeminiModel
    setWriterModel(m)
    setWriterModelState(m)
    showSaved()
  }

  const showSaved = () => {
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  if (editorModel === null || writerModel === null) return null

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
      </div>
    </div>
  )
}
