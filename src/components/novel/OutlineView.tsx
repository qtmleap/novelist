'use client'

import { BookMarked, Check, ChevronRight, Loader2 } from 'lucide-react'
import Link from 'next/link'
import type { ReactNode } from 'react'
import type { ChapterData } from '@/components/novel/ChapterReader'
import { Skeleton } from '@/components/ui/skeleton'
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
  novelId
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
          const chapterData = chapterByNumber.get(ch.chapter_number)
          const done = chapterData?.done === true
          const isStreaming = streamingIndex === ch.chapter_number
          const linkable = done && novelId !== undefined
          const cost = costByNumber.get(ch.chapter_number)
          const rowContent = (
            <>
              <span className='flex size-6 shrink-0 items-center justify-center rounded bg-muted text-xs font-semibold tabular-nums text-muted-foreground'>
                {ch.chapter_number}
              </span>
              <div className='min-w-0 flex-1'>
                <p className='flex items-center gap-1.5 font-medium text-sm leading-snug'>
                  {ch.title}
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
              {linkable && <ChevronRight className='size-5 shrink-0 self-center text-muted-foreground' />}
            </>
          )
          const className = cn('flex items-start gap-3 px-4 py-3 transition-colors', linkable && 'hover:bg-muted/40')
          return (
            <li key={ch.chapter_number} className='contents'>
              {linkable ? (
                <Link href={`/novels/${novelId}/chapters/${ch.chapter_number}`} className={className}>
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
