'use client'

import { BookOpen, Calendar, ChevronRight, Layers, Type } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { routes } from '@/lib/routes'
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

// 年齢指定バッジの色。R18 を最も強く、R15 を中間、全年齢は控えめにして
// 制限付きの作品が一覧でひと目で分かるようにする。
function ageRatingClass(rating: string): string {
  if (rating === 'R18') return 'border-red-500 text-red-600'
  if (rating === 'R15') return 'border-amber-500 text-amber-600'
  return 'text-muted-foreground'
}

export function NovelCard({ novel }: Props) {
  const hasOutline = novel.outline !== null
  const status = hasOutline ? '生成済み' : '未生成'

  return (
    <a
      href={routes.novels.detail(novel.id)}
      className='flex items-center gap-2.5 px-3 py-3 transition hover:bg-muted/50 sm:gap-3 sm:px-4'
    >
      <BookOpen className='size-5 shrink-0 text-primary' />
      <div className='min-w-0 flex-1'>
        <div className='flex items-center gap-1.5'>
          <span className='block min-w-0 flex-1 truncate font-medium text-sm'>{novel.title}</span>
          <Badge variant='outline' className={cn('shrink-0 text-xs', ageRatingClass(novel.age_rating))}>
            {novel.age_rating}
          </Badge>
          <Badge
            variant='outline'
            className={cn('shrink-0 text-xs', hasOutline ? 'border-green-500 text-green-600' : 'text-muted-foreground')}
          >
            {status}
          </Badge>
        </div>
        <div className='mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground'>
          <span>{novel.genre}</span>
          <span className='flex items-center gap-1'>
            <Layers className='size-3.5' />
            {novel.num_chapters} 章
          </span>
          {novel.written_chars > 0 && (
            <span className='flex items-center gap-1'>
              <Type className='size-3.5' />
              <span className='tabular-nums'>{novel.written_chars.toLocaleString()}</span> 文字
            </span>
          )}
          <span className='flex items-center gap-1'>
            <Calendar className='size-3.5' />
            {formatDate(novel.created_at)}
          </span>
        </div>
      </div>
      <ChevronRight className='size-5 shrink-0 self-center text-muted-foreground' />
    </a>
  )
}
