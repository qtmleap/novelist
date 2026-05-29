'use client'

import { BookOpen, Calendar, ChevronRight, Layers } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { Novel } from '@/schemas/novel.dto'

type Props = {
  novel: Novel
}

function formatDate(iso: string): string {
  // ISO 8601 文字列を直接 parse して "YYYY年M月D日" を組み立てる (Date を経由しないので
  // タイムゾーン揺れも無く、no-new-date の運用方針 (dayjs か文字列処理) に沿う)。
  const [datePart] = iso.split('T')
  const [y, m, d] = datePart.split('-')
  return `${Number(y)}年${Number(m)}月${Number(d)}日`
}

export function NovelCard({ novel }: Props) {
  const hasOutline = novel.outline !== null
  const status = hasOutline ? '生成済み' : '未生成'

  return (
    <a href={`/novels/${novel.id}`} className='flex items-center gap-3 px-4 py-3 transition hover:bg-muted/50'>
      <BookOpen className='size-5 shrink-0 text-primary' />
      <div className='min-w-0 flex-1'>
        <span className='truncate font-medium text-sm'>{novel.title}</span>
        <div className='mt-0.5 flex items-center gap-3 text-xs text-muted-foreground'>
          <span>{novel.genre}</span>
          <span className='flex items-center gap-1'>
            <Layers className='size-3.5' />
            {novel.num_chapters} 章
          </span>
          <span className='flex items-center gap-1'>
            <Calendar className='size-3.5' />
            {formatDate(novel.created_at)}
          </span>
        </div>
      </div>
      <div className='ml-auto flex items-center gap-1 shrink-0'>
        <Badge
          variant='outline'
          className={cn('text-xs', hasOutline ? 'border-green-500 text-green-600' : 'text-muted-foreground')}
        >
          {status}
        </Badge>
        <ChevronRight className='size-5 text-muted-foreground' />
      </div>
    </a>
  )
}
