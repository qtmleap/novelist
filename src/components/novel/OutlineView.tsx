'use client'

import { BookMarked, Check, ChevronRight, Loader2 } from 'lucide-react'
import Link from 'next/link'
import type { ReactNode } from 'react'
import type { ChapterData } from '@/components/novel/ChapterReader'
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
  expectedTotal = 0
}: Props) {
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

  return (
    <div className='space-y-3'>
      <div className='flex items-center justify-between gap-2'>
        <div className='flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground'>
          <BookMarked className='size-5 text-primary' />
          {isGenerating && !outline ? '章立て生成中...' : '章立て'}
        </div>
        {regenerateSlot}
      </div>
      <ol className='divide-y border-y'>
        {slots.map((n) => {
          const ch = outlineByNumber.get(n)
          const chapterData = chapterByNumber.get(n)
          const done = chapterData?.done === true
          const isStreaming = streamingIndex === n
          const linkable = done && novelId !== undefined
          const cost = costByNumber.get(n)
          const hasOutlineEntry = ch !== undefined
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
