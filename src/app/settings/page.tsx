'use client'

import { useAtom } from 'jotai'
import { useEffect, useState } from 'react'
import { ModelSelectItems } from '@/components/novel/ModelSelectItems'
import { PageHeader } from '@/components/PageHeader'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { useModelCatalog } from '@/hooks/useModelCatalog'
import { formatPrice, GeminiModelSchema, MODEL_META, ModelRefSchema, parseModelRef } from '@/schemas/novel.dto'
import type { AvailableModel, ModelCatalog } from '@/schemas/provider.dto'
import { editorModelAtom, writerModelAtom } from '@/store/atoms'

function Stars({ n }: { n: number }) {
  return (
    <span>
      {'★'.repeat(n)}
      {'☆'.repeat(5 - n)}
    </span>
  )
}

function ModelMeta({ model, catalog }: { model: string; catalog: ModelCatalog }) {
  const entry: AvailableModel | undefined = catalog.models.find((m) => m.ref === model)
  const parsed = parseModelRef(model)
  const geminiId = GeminiModelSchema.safeParse(parsed.id)
  const meta = parsed.provider === 'gemini' && geminiId.success ? MODEL_META[geminiId.data] : undefined
  return (
    <div className='mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted-foreground'>
      {meta !== undefined && (
        <>
          <span>
            性能 <Stars n={meta.quality} />
          </span>
          <span>
            速度 <Stars n={meta.speed} />
          </span>
          <span>
            価格 <Stars n={meta.price} />
          </span>
        </>
      )}
      {entry === undefined ? (
        <span>このモデルは一覧にありません (サーバーの設定が変わった可能性があります)</span>
      ) : (
        <span className='tabular-nums'>
          {entry.price === null ? (
            '単価不明 (コストは 0 として記録されます)'
          ) : (
            <>
              入力 / 出力 {formatPrice(entry.price)} (1M トークン)
              {entry.price.longPromptSurcharge ? ' ※20万トークン超は割増' : ''}
            </>
          )}
          {entry.contextWindow === null ? '' : ` / コンテキスト ${entry.contextWindow.toLocaleString()}`}
        </span>
      )}
    </div>
  )
}

// サーバーが OpenAI 互換 API を使えるか。URL とキーは表示せず、設定済みかどうかだけを出す。
function ProviderStatus({ catalog, loadFailed }: { catalog: ModelCatalog; loadFailed: boolean }) {
  if (loadFailed) {
    return (
      <p className='text-sm text-destructive'>
        モデル一覧を取得できませんでした。Gemini の固定一覧だけを表示しています。
      </p>
    )
  }
  const openaiCount = catalog.models.filter((m) => m.provider === 'openai').length
  return (
    <ul className='space-y-1 text-sm text-muted-foreground'>
      <li>Gemini: 利用できます (サーバーの GEMINI_API_KEY)</li>
      <li>
        OpenAI 互換 API:{' '}
        {catalog.openaiConfigured ? (
          <>
            設定済み ({catalog.openaiFormat === 'responses' ? 'responses' : 'chat completions'}、{openaiCount} モデル)
          </>
        ) : (
          '未設定 (サーバーの OPENAI_BASE_URL と OPENAI_API_KEY を設定すると、モデルが選べるようになります)'
        )}
      </li>
      {catalog.openaiError !== null && <li className='text-destructive'>{catalog.openaiError}</li>}
    </ul>
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
  const { catalog, error } = useModelCatalog()

  const showSaved = () => {
    setSaved(true)
    setTimeout(() => setSaved(false), 2000)
  }

  const handleEditorChange = (value: string) => {
    const result = ModelRefSchema.safeParse(value)
    if (result.success) setEditorModel(result.data)
    showSaved()
  }

  const handleWriterChange = (value: string) => {
    const result = ModelRefSchema.safeParse(value)
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
              <ModelSelectItems current={editorModel} />
            </SelectContent>
          </Select>
          <ModelMeta model={editorModel} catalog={catalog} />
        </div>

        <div className='space-y-1.5'>
          <Label htmlFor='writer-model'>Writer モデル（本文の生成）</Label>
          <Select value={writerModel} onValueChange={handleWriterChange}>
            <SelectTrigger id='writer-model' className='w-72'>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <ModelSelectItems current={writerModel} />
            </SelectContent>
          </Select>
          <ModelMeta model={writerModel} catalog={catalog} />
        </div>
      </div>

      <ProviderStatus catalog={catalog} loadFailed={error !== null} />

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
