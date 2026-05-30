'use client'

import { BookMarked, Check, ChevronRight, Loader2, Pencil, X } from 'lucide-react'
import Link from 'next/link'
import { type ReactNode, useEffect, useState } from 'react'
import type { ChapterData } from '@/components/novel/ChapterReader'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import type { ChapterCost, Outline } from '@/schemas/novel.dto'

type Props = {
  outline: Outline | null
  isGenerating: boolean
  regenerateSlot?: ReactNode
  isBusy?: boolean
  chapters?: ChapterData[]
  costs?: ChapterCost[]
  streamingIndex?: number | null
  // 生成済みの章を押したときの遷移先 (例: /novels/[id]/chapters/[number])。
  novelId?: string
  // novel.num_chapters。outline がまだ無い章や、outline 枠を上回る章数を持つ novel でも
  // 全章ぶんの枠を表示するため、明示で渡してもらう。
  expectedTotal?: number
  // 手動編集のセーブ。未指定なら編集ボタンは出さない。
  // 既存 chapter_number の集合は維持し、title/summary だけ変更される。
  onSaveOutline?: (outline: Outline) => Promise<void>
  // 編集を許可するか (= 認証済かつ生成中でない)。
  canEdit?: boolean
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

export function OutlineView({
  outline,
  isGenerating,
  regenerateSlot,
  chapters,
  costs,
  streamingIndex = null,
  novelId,
  expectedTotal = 0,
  onSaveOutline,
  canEdit = false
}: Props) {
  // 編集モード中だけ使う一時 outline。読み取り専用ビューと、保存中の loading 状態を別途持つ。
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<Outline['chapters']>([])
  const [saving, setSaving] = useState(false)

  // outline (prop) が外から変わったら draft も追従させる (再生成後など)。
  // 編集中の差分は捨てる: 衝突するくらいなら最新を採用する方針。
  useEffect(() => {
    setDraft(outline?.chapters ?? [])
  }, [outline])

  const chapterByNumber = new Map<number, ChapterData>()
  for (const c of chapters ?? []) chapterByNumber.set(c.number, c)
  const costByNumber = new Map<number, ChapterCost>()
  for (const c of costs ?? []) costByNumber.set(c.chapter_number, c)
  const outlineByNumber = new Map<number, Outline['chapters'][number]>()
  for (const ch of outline?.chapters ?? []) outlineByNumber.set(ch.chapter_number, ch)

  // 表示対象は outline の章番号 + novel.num_chapters まで。
  // どちらも 0 のときは何も出さない。
  const maxNumber = Math.max(expectedTotal, ...Array.from(outlineByNumber.keys()), streamingIndex ?? 0)
  if (maxNumber === 0 && !isGenerating) return null
  const slots = Array.from({ length: maxNumber }, (_, i) => i + 1)

  const editableSaveable = onSaveOutline !== undefined && canEdit && !isGenerating

  const handleStartEdit = () => {
    setDraft(outline?.chapters ?? [])
    setEditing(true)
  }
  const handleCancelEdit = () => {
    setDraft(outline?.chapters ?? [])
    setEditing(false)
  }
  const handleSave = async () => {
    if (onSaveOutline === undefined) return
    setSaving(true)
    try {
      await onSaveOutline({ chapters: draft })
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }
  const updateDraft = (number: number, patch: Partial<Outline['chapters'][number]>) => {
    setDraft((prev) => prev.map((c) => (c.chapter_number === number ? { ...c, ...patch } : c)))
  }

  return (
    <div className='space-y-3'>
      <div className='flex items-center justify-between gap-2'>
        <div className='flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground'>
          <BookMarked className='size-5 text-primary' />
          {isGenerating && !outline ? '章立て生成中...' : '章立て'}
        </div>
        {editing ? (
          <div className='flex items-center gap-2'>
            <Button
              type='button'
              size='sm'
              variant='ghost'
              className='[&_svg]:size-5!'
              disabled={saving}
              onClick={handleCancelEdit}
            >
              <X />
              キャンセル
            </Button>
            <Button
              type='button'
              size='sm'
              className='[&_svg]:size-5!'
              disabled={saving || draft.length === 0}
              onClick={handleSave}
            >
              {saving ? <Loader2 className='animate-spin' /> : <Check />}
              保存
            </Button>
          </div>
        ) : (
          <div className='flex items-center gap-2'>
            {editableSaveable && outline !== null && outline.chapters.length > 0 && (
              <Button type='button' size='sm' variant='outline' className='[&_svg]:size-5!' onClick={handleStartEdit}>
                <Pencil />
                編集
              </Button>
            )}
            {regenerateSlot}
          </div>
        )}
      </div>
      <ol className='divide-y border-y'>
        {slots.map((n) => {
          const ch = outlineByNumber.get(n)
          const chapterData = chapterByNumber.get(n)
          const done = chapterData?.done === true
          const isStreaming = streamingIndex === n
          const linkable = done && novelId !== undefined && !editing
          const cost = costByNumber.get(n)
          const hasOutlineEntry = ch !== undefined
          const draftChapter = draft.find((d) => d.chapter_number === n)
          // 編集モードでは draft のエントリだけを並べる (outline.chapters の中身を直接いじる)。
          // outline 未生成の slot は編集対象に含めない (= 章立て生成側で増やす流れ)。
          if (editing && draftChapter !== undefined) {
            return (
              <li key={n} className='flex items-start gap-3 px-4 py-3'>
                <span className='mt-1 flex size-6 shrink-0 items-center justify-center rounded bg-muted text-xs font-semibold tabular-nums text-muted-foreground'>
                  {n}
                </span>
                <div className='min-w-0 flex-1 space-y-2'>
                  <Input
                    value={draftChapter.title}
                    onChange={(e) => updateDraft(n, { title: e.target.value })}
                    placeholder='章タイトル'
                    className='text-sm'
                  />
                  <Textarea
                    value={draftChapter.summary}
                    onChange={(e) => updateDraft(n, { summary: e.target.value })}
                    placeholder='章の概要'
                    rows={3}
                    className='resize-none text-xs leading-relaxed'
                  />
                </div>
              </li>
            )
          }
          const rowContent = (
            <>
              <span className='flex size-6 shrink-0 items-center justify-center rounded bg-muted text-xs font-semibold tabular-nums text-muted-foreground'>
                {n}
              </span>
              <div className='min-w-0 flex-1'>
                <p className='flex items-center gap-1.5 font-medium text-sm leading-snug'>
                  {hasOutlineEntry ? (
                    ch.title
                  ) : (
                    <span className='font-normal italic text-muted-foreground'>未生成</span>
                  )}
                  {isStreaming ? (
                    <Loader2 className='size-3.5 shrink-0 animate-spin text-primary' />
                  ) : done ? (
                    <Check
                      strokeWidth={3}
                      className='size-4 shrink-0 text-emerald-500 dark:text-emerald-400'
                      aria-label='本文あり'
                    />
                  ) : null}
                </p>
                {hasOutlineEntry ? (
                  <p className='mt-0.5 text-xs leading-relaxed text-muted-foreground'>{ch.summary}</p>
                ) : (
                  <p className='mt-0.5 text-xs italic leading-relaxed text-muted-foreground/60'>
                    章立てがまだ生成されていません
                  </p>
                )}
                {done && chapterData && (
                  <div className='mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground'>
                    <span>{chapterData.content.length.toLocaleString()} 文字</span>
                    {cost && (
                      <>
                        <span className='truncate'>{cost.model}</span>
                        <span>
                          入力{fmtTokens(cost.prompt_tokens)} / 出力{fmtTokens(cost.output_tokens)}
                        </span>
                        <span>${cost.cost_usd.toFixed(4)} USD</span>
                      </>
                    )}
                  </div>
                )}
              </div>
              {linkable && <ChevronRight className='size-5 shrink-0 self-center text-muted-foreground' />}
            </>
          )
          const className = cn(
            'flex items-start gap-3 px-4 py-3 transition-colors',
            linkable && 'hover:bg-muted/40',
            !hasOutlineEntry && 'opacity-70'
          )
          return (
            <li key={n} className='contents'>
              {linkable ? (
                <Link href={`/novels/${novelId}/chapters/${n}`} className={className}>
                  {rowContent}
                </Link>
              ) : (
                <div className={className}>{rowContent}</div>
              )}
            </li>
          )
        })}
      </ol>
    </div>
  )
}
