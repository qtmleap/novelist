'use client'

import { BookMarked, BookOpen, Check, Loader2, RefreshCw } from 'lucide-react'
import type { ReactNode } from 'react'
import type { ChapterData } from '@/components/novel/ChapterReader'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import type { ChapterCost, Outline } from '@/schemas/novel.dto'

type Props = {
  outline: Outline | null
  isGenerating: boolean
  regenerateSlot?: ReactNode
  onRegenerateChapter?: (chapterNumber: number) => void
  regeneratingChapter?: number | null
  isBusy?: boolean
  chapters?: ChapterData[]
  costs?: ChapterCost[]
  streamingIndex?: number | null
  selectedChapter?: number | null
  onSelectChapter?: (chapterNumber: number) => void
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

export function OutlineView({
  outline,
  isGenerating,
  regenerateSlot,
  onRegenerateChapter,
  regeneratingChapter,
  isBusy = false,
  chapters,
  costs,
  streamingIndex = null,
  selectedChapter = null,
  onSelectChapter
}: Props) {
  const chapterByNumber = new Map<number, ChapterData>()
  for (const c of chapters ?? []) chapterByNumber.set(c.number, c)
  const costByNumber = new Map<number, ChapterCost>()
  for (const c of costs ?? []) costByNumber.set(c.chapter_number, c)
  if (isGenerating && !outline) {
    return (
      <div className='space-y-3'>
        <div className='flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground'>
          <BookMarked className='size-5 text-primary' />
          章立て生成中...
        </div>
        <div className='divide-y border-y'>
          {[0, 1, 2].map((i) => (
            <div key={i} className='flex items-start gap-3 px-4 py-3'>
              <Skeleton className='size-6 shrink-0 rounded' />
              <div className='flex-1 space-y-1.5'>
                <Skeleton className='h-4 w-1/2' />
                <Skeleton className='h-3 w-full' />
                <Skeleton className='h-3 w-4/5' />
              </div>
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (!outline) return null

  return (
    <div className='space-y-3'>
      <div className='flex items-center justify-between gap-2'>
        <div className='flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground'>
          <BookMarked className='size-5 text-primary' />
          章立て
        </div>
        {regenerateSlot}
      </div>
      <ol className='divide-y border-y'>
        {outline.chapters.map((ch) => {
          const regenerating = regeneratingChapter === ch.chapter_number
          const showButton = onRegenerateChapter !== undefined
          const chapterData = chapterByNumber.get(ch.chapter_number)
          const done = chapterData?.done === true
          const isStreaming = streamingIndex === ch.chapter_number
          const isSelected = selectedChapter === ch.chapter_number
          const selectable = onSelectChapter !== undefined && (done || isStreaming)
          const cost = costByNumber.get(ch.chapter_number)
          return (
            <li
              key={ch.chapter_number}
              className={cn('flex items-start gap-3 px-4 py-3 transition-colors', isSelected && 'bg-muted/60')}
            >
              <span className='flex size-6 shrink-0 items-center justify-center rounded bg-muted text-xs font-semibold tabular-nums text-muted-foreground'>
                {ch.chapter_number}
              </span>
              <div className='min-w-0 flex-1'>
                <p className='flex items-center gap-1.5 font-medium text-sm leading-snug'>
                  {ch.title}
                  {isStreaming ? (
                    <Loader2 className='size-3.5 shrink-0 animate-spin text-primary' />
                  ) : done ? (
                    <Check className='size-3.5 shrink-0 text-primary' aria-label='本文あり' />
                  ) : null}
                </p>
                <p className='mt-0.5 text-xs leading-relaxed text-muted-foreground'>{ch.summary}</p>
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
              {selectable && (
                <Button
                  type='button'
                  variant={isSelected ? 'secondary' : 'ghost'}
                  size='icon'
                  aria-label={`第 ${ch.chapter_number} 章の本文を表示`}
                  onClick={(e) => {
                    e.stopPropagation()
                    onSelectChapter?.(ch.chapter_number)
                  }}
                  className='size-8 shrink-0 text-muted-foreground hover:text-foreground [&_svg]:size-5!'
                >
                  <BookOpen />
                </Button>
              )}
              {showButton && (
                <Button
                  type='button'
                  variant='ghost'
                  size='icon'
                  aria-label={`第 ${ch.chapter_number} 章の章立てを再生成`}
                  disabled={isBusy || regenerating}
                  onClick={(e) => {
                    e.stopPropagation()
                    onRegenerateChapter?.(ch.chapter_number)
                  }}
                  className='size-8 shrink-0 text-muted-foreground hover:text-foreground [&_svg]:size-5!'
                >
                  {regenerating ? <Loader2 className='animate-spin' /> : <RefreshCw />}
                </Button>
              )}
            </li>
          )
        })}
      </ol>
    </div>
  )
}
