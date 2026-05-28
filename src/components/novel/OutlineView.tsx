'use client'

import { BookMarked, Loader2, PenLine, RefreshCw } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import type { Outline } from '@/schemas/novel.dto'

type Props = {
  outline: Outline | null
  isGenerating: boolean
  regenerateSlot?: ReactNode
  onRegenerateChapter?: (chapterNumber: number) => void
  regeneratingChapter?: number | null
  isBusy?: boolean
  // 章本文の生成ボタン用。done に含まれる章は「本文あり」、streamingIndex の章は spinner。
  chaptersDone?: Set<number>
  streamingIndex?: number | null
  onGenerateChapter?: (chapterNumber: number) => void
}

export function OutlineView({
  outline,
  isGenerating,
  regenerateSlot,
  onRegenerateChapter,
  regeneratingChapter,
  isBusy = false,
  chaptersDone,
  streamingIndex = null,
  onGenerateChapter
}: Props) {
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
          const showOutlineRegen = onRegenerateChapter !== undefined
          const isDone = chaptersDone?.has(ch.chapter_number) ?? false
          const isStreaming = streamingIndex === ch.chapter_number
          const showGenerate = onGenerateChapter !== undefined && !isDone
          return (
            <li key={ch.chapter_number} className='flex items-start gap-3 px-4 py-3'>
              <span className='flex size-6 shrink-0 items-center justify-center rounded bg-muted text-xs font-semibold tabular-nums text-muted-foreground'>
                {ch.chapter_number}
              </span>
              <div className='min-w-0 flex-1'>
                <p className='font-medium text-sm leading-snug'>{ch.title}</p>
                <p className='mt-0.5 text-xs leading-relaxed text-muted-foreground'>{ch.summary}</p>
              </div>
              {showGenerate && (
                <Button
                  type='button'
                  variant='outline'
                  size='sm'
                  disabled={isBusy && !isStreaming}
                  onClick={() => onGenerateChapter?.(ch.chapter_number)}
                  className='shrink-0 [&_svg]:size-5!'
                >
                  {isStreaming ? <Loader2 className='animate-spin' /> : <PenLine />}
                  {isStreaming ? '生成中…' : '本文を生成'}
                </Button>
              )}
              {showOutlineRegen && (
                <Button
                  type='button'
                  variant='ghost'
                  size='icon'
                  aria-label={`第 ${ch.chapter_number} 章の章立てを再生成`}
                  disabled={isBusy || regenerating}
                  onClick={() => onRegenerateChapter?.(ch.chapter_number)}
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
