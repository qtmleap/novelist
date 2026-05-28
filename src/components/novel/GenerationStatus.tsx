'use client'

import { Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'

type Props = {
  currentChapter: number
  totalChapters: number
  onCancel: () => void
}

export function GenerationStatus({ currentChapter, totalChapters, onCancel }: Props) {
  const progressValue = totalChapters > 0 ? Math.round(((currentChapter - 1) / totalChapters) * 100) : 0

  return (
    <div className='sticky top-0 z-10 border-b bg-background px-4 py-3'>
      <div className='flex items-center justify-between gap-4'>
        <div className='flex flex-1 flex-col gap-1.5'>
          <div className='flex items-center justify-between text-xs text-muted-foreground'>
            <span>
              第 <span className='font-semibold tabular-nums text-foreground'>{currentChapter}</span> 章 /{' '}
              <span className='tabular-nums'>{totalChapters}</span> 章を生成中
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
