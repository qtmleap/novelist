'use client'

import { Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'
import type { ChapterStage } from '@/schemas/novel.dto'

// 章の生成の段階の表示名。本文が流れるのは writing の間だけなので、他の段階では画面が止まって見えないよう
// これを出す。小説ページ (GenerationStatus) と章ページ (再生成) の両方で使う。
export const CHAPTER_STAGE_LABELS: Record<ChapterStage, string> = {
  context: '資料を準備中',
  writing: '本文を執筆中',
  recording: '記録を作成中',
  reviewing: '検査中'
}

type Props = {
  currentChapter: number
  totalChapters: number
  // 今の段階。まだ分からない (サーバーが送らない) 間は null / 未指定で、文言は出さない。
  stage?: ChapterStage | null
  onCancel: () => void
}

export function GenerationStatus({ currentChapter, totalChapters, stage = null, onCancel }: Props) {
  const progressValue = totalChapters > 0 ? Math.round(((currentChapter - 1) / totalChapters) * 100) : 0

  return (
    <div className='sticky top-0 z-10 border-b bg-background px-4 py-3'>
      <div className='flex items-center justify-between gap-4'>
        <div className='flex flex-1 flex-col gap-1.5'>
          <div className='flex items-center justify-between text-xs text-muted-foreground'>
            <span>
              第 <span className='font-semibold tabular-nums text-foreground'>{currentChapter}</span> 章 /{' '}
              <span className='tabular-nums'>{totalChapters}</span> 章を生成中
              {/* live region は常に描画する (中身と同時に差し込むと読み上げられないことがあるため)。 */}
              <span aria-live='polite' className={cn(stage !== null && 'ml-2 font-medium text-foreground')}>
                {stage !== null && CHAPTER_STAGE_LABELS[stage]}
              </span>
            </span>
            <span className='tabular-nums'>{progressValue}%</span>
          </div>
          <Progress value={progressValue} className='h-1.5' />
        </div>
        <Button
          type='button'
          variant='outline'
          size='sm'
          onClick={onCancel}
          className='shrink-0 gap-1.5 border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive [&_svg]:size-5!'
        >
          <Square className='fill-current' />
          中断
        </Button>
      </div>
    </div>
  )
}
