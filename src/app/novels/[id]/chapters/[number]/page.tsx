'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'
import { ErrorAlert } from '@/components/novel/ErrorAlert'
import { NovelSkeleton } from '@/components/novel/NovelSkeleton'
import { PageHeader } from '@/components/PageHeader'
import { Button } from '@/components/ui/button'
import { api, readApiError } from '@/lib/api/client'
import { cn } from '@/lib/utils'
import type { ChapterCost, NovelWithChapters } from '@/schemas/novel.dto'

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

function getNovelAndChapter(): { novelId: string; chapterNumber: number } {
  if (typeof window === 'undefined') return { novelId: '', chapterNumber: 0 }
  const parts = window.location.pathname.split('/')
  const novelIdx = parts.indexOf('novels')
  const chapterIdx = parts.indexOf('chapters')
  return {
    novelId: novelIdx !== -1 ? (parts[novelIdx + 1] ?? '') : '',
    chapterNumber: chapterIdx !== -1 ? Number(parts[chapterIdx + 1] ?? '0') : 0
  }
}

function ChapterMeta({ chars, cost }: { chars: number; cost?: ChapterCost }) {
  return (
    <div className='flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground'>
      <span>{chars.toLocaleString()} 文字</span>
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
  )
}

export default function ChapterDetailPage() {
  const [novel, setNovel] = useState<NovelWithChapters | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [novelId, setNovelId] = useState('')
  const [chapterNumber, setChapterNumber] = useState(0)

  useEffect(() => {
    const { novelId: nid, chapterNumber: n } = getNovelAndChapter()
    setNovelId(nid)
    setChapterNumber(n)
    if (!nid || n <= 0) {
      setLoading(false)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const res = await api.novels[':id'].$get({ param: { id: nid } })
        if (!res.ok) {
          if (res.status === 404) throw new Error('小説が見つかりません')
          throw new Error(await readApiError(res))
        }
        const data = (await res.json()) as NovelWithChapters
        if (!cancelled) setNovel(data)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : '章の取得に失敗しました')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const chapter = novel?.chapters.find((c) => c.chapter_number === chapterNumber) ?? null
  const cost = novel?.generation_costs.find((c) => c.chapter_number === chapterNumber)
  const totalChapters = novel?.num_chapters ?? 0

  const prevHref = chapterNumber > 1 && novelId ? `/novels/${novelId}/chapters/${chapterNumber - 1}` : null
  const nextHref = chapterNumber < totalChapters && novelId ? `/novels/${novelId}/chapters/${chapterNumber + 1}` : null

  return (
    <div className='space-y-6'>
      <PageHeader
        crumbs={[
          { label: '小説一覧', href: '/novels' },
          { label: novel?.title ?? '詳細', href: novelId ? `/novels/${novelId}` : undefined },
          { label: `第 ${chapterNumber} 章` }
        ]}
      />

      {loading && <NovelSkeleton />}
      {!loading && error && <ErrorAlert message={error} />}
      {!loading && !error && chapter === null && novel && (
        <ErrorAlert message={`第 ${chapterNumber} 章はまだ生成されていません`} />
      )}
      {!loading && !error && chapter && (
        <>
          <div>
            <p className='text-xs font-medium uppercase tracking-wider text-muted-foreground'>
              第 {chapterNumber} 章{totalChapters > 0 && ` / 全 ${totalChapters} 章`}
            </p>
            {chapter.title && <h1 className='mt-1 text-xl font-semibold'>{chapter.title}</h1>}
            <div className='mt-2'>
              <ChapterMeta chars={chapter.content.length} cost={cost} />
            </div>
          </div>

          <article className='whitespace-pre-wrap text-sm leading-relaxed text-foreground/90'>
            {chapter.content}
          </article>

          <div className='flex items-center justify-between gap-3 border-t pt-4'>
            <Button asChild variant='ghost' size='sm' disabled={!prevHref} className={cn(!prevHref && 'invisible')}>
              {prevHref ? <Link href={prevHref}>← 第 {chapterNumber - 1} 章</Link> : <span />}
            </Button>
            <Button asChild variant='ghost' size='sm' disabled={!nextHref} className={cn(!nextHref && 'invisible')}>
              {nextHref ? <Link href={nextHref}>第 {chapterNumber + 1} 章 →</Link> : <span />}
            </Button>
          </div>
        </>
      )}
    </div>
  )
}
