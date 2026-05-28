'use client'

import { Loader2, RefreshCw, Trash2 } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ErrorAlert } from '@/components/novel/ErrorAlert'
import { NovelSkeleton } from '@/components/novel/NovelSkeleton'
import { PageHeader } from '@/components/PageHeader'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { api, readApiError } from '@/lib/api/client'
import { getWriterModel } from '@/lib/settings'
import { readChapterStream } from '@/lib/stream'
import { cn } from '@/lib/utils'
import type { ChapterCost, NovelWithChapters } from '@/schemas/novel.dto'

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

function parseRoute(pathname: string): { novelId: string; chapterNumber: number } {
  const parts = pathname.split('/')
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
  const pathname = usePathname()
  const { novelId, chapterNumber } = useMemo(() => parseRoute(pathname), [pathname])
  const [novel, setNovel] = useState<NovelWithChapters | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isRegenerating, setIsRegenerating] = useState(false)
  const [buffer, setBuffer] = useState('')
  const [regenOpen, setRegenOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!novelId) {
      setLoading(false)
      return
    }
    if (novel?.id === novelId) return
    let cancelled = false
    setLoading(true)
    setError(null)
    ;(async () => {
      try {
        const res = await api.novels[':id'].$get({ param: { id: novelId } })
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
  }, [novelId, novel?.id])

  useEffect(() => {
    return () => {
      abortRef.current?.abort()
    }
  }, [])

  const chapter = novel?.chapters.find((c) => c.chapter_number === chapterNumber) ?? null
  const cost = novel?.generation_costs.find((c) => c.chapter_number === chapterNumber)
  const totalChapters = novel?.num_chapters ?? 0
  // 最新生成済み章 = この novel の chapters の最大 chapter_number。
  // 整合性のため、最新章でしか再生成・削除はできない。
  const latestDoneNumber = novel?.chapters.reduce((acc, c) => Math.max(acc, c.chapter_number), 0) ?? 0
  const isLatest = chapter !== null && chapterNumber === latestDoneNumber

  const prevHref = chapterNumber > 1 && novelId ? `/novels/${novelId}/chapters/${chapterNumber - 1}` : null
  const nextHref = chapterNumber < totalChapters && novelId ? `/novels/${novelId}/chapters/${chapterNumber + 1}` : null

  const handleRegenerate = async () => {
    if (!novelId || chapterNumber <= 0) return
    setIsRegenerating(true)
    setBuffer('')
    setError(null)
    const abort = new AbortController()
    abortRef.current = abort
    try {
      const res = await api.novels[':id'].chapters[':number'].generate.$post(
        {
          param: { id: novelId, number: String(chapterNumber) },
          json: { model: getWriterModel() }
        },
        { init: { signal: abort.signal } }
      )
      if (!res.ok) throw new Error(await readApiError(res))
      await readChapterStream(res, {
        onDelta: (text) => setBuffer((b) => b + text),
        onDone: async () => {
          try {
            const refreshed = await api.novels[':id'].$get({ param: { id: novelId } })
            if (refreshed.ok) setNovel((await refreshed.json()) as NovelWithChapters)
          } catch {
            // 再取得に失敗しても streaming buffer 自体は描画済み
          }
        },
        onError: (msg) => setError(msg)
      })
    } catch (e) {
      if ((e as { name?: string }).name !== 'AbortError') {
        setError(e instanceof Error ? e.message : '再生成に失敗しました')
      }
    } finally {
      setIsRegenerating(false)
      setBuffer('')
    }
  }

  const handleDelete = async () => {
    if (!novelId || chapterNumber <= 0) return
    setIsDeleting(true)
    try {
      const res = await api.novels[':id'].chapters[':number'].$delete({
        param: { id: novelId, number: String(chapterNumber) }
      })
      if (res.status !== 204 && !res.ok) throw new Error(await readApiError(res))
      window.location.assign(`/novels/${novelId}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : '削除に失敗しました')
      setIsDeleting(false)
      setDeleteOpen(false)
    }
  }

  const displayContent = isRegenerating ? buffer : (chapter?.content ?? '')
  const busy = isRegenerating || isDeleting

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
      {!loading && error && <ErrorAlert message={error} onRetry={() => setError(null)} />}
      {!loading && !error && chapter === null && novel && !isRegenerating && (
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
              <ChapterMeta chars={displayContent.length} cost={cost} />
            </div>
          </div>

          <article className='whitespace-pre-wrap text-sm leading-relaxed text-foreground/90'>
            {displayContent}
            {isRegenerating && (
              <span
                aria-hidden='true'
                className='ml-0.5 inline-block h-4 w-0.5 animate-pulse rounded-full bg-primary align-middle'
              />
            )}
          </article>

          <div className='flex items-center justify-between gap-3 border-t pt-4'>
            <Button
              asChild
              variant='ghost'
              size='sm'
              disabled={!prevHref || busy}
              className={cn(!prevHref && 'invisible')}
            >
              {prevHref ? <Link href={prevHref}>← 第 {chapterNumber - 1} 章</Link> : <span />}
            </Button>
            <Button
              asChild
              variant='ghost'
              size='sm'
              disabled={!nextHref || busy}
              className={cn(!nextHref && 'invisible')}
            >
              {nextHref ? <Link href={nextHref}>第 {chapterNumber + 1} 章 →</Link> : <span />}
            </Button>
          </div>

          {isLatest && (
            <div className='border-t pt-6'>
              <div className='mb-3'>
                <h2 className='text-sm font-semibold text-destructive'>危険な操作</h2>
                <p className='mt-0.5 text-sm text-muted-foreground'>
                  整合性のため、再生成と削除は最新の生成済み章 (この章) でのみ可能です。
                </p>
              </div>
              <div className='flex flex-wrap items-center gap-2'>
                <AlertDialog open={regenOpen} onOpenChange={setRegenOpen}>
                  <AlertDialogTrigger asChild>
                    <Button type='button' variant='outline' size='sm' disabled={busy} className='[&_svg]:size-5!'>
                      {isRegenerating ? <Loader2 className='animate-spin' /> : <RefreshCw />}
                      本文を再生成
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>第 {chapterNumber} 章の本文を再生成しますか？</AlertDialogTitle>
                      <AlertDialogDescription>
                        既存の本文を破棄して上書きします。元には戻せません。Gemini API
                        を呼び出すので追加コストが発生します。
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>キャンセル</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={(e) => {
                          e.preventDefault()
                          setRegenOpen(false)
                          handleRegenerate()
                        }}
                        className='[&_svg]:size-5!'
                      >
                        <RefreshCw />
                        再生成する
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>

                <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
                  <AlertDialogTrigger asChild>
                    <Button type='button' variant='destructive' size='sm' disabled={busy} className='[&_svg]:size-5!'>
                      {isDeleting ? <Loader2 className='animate-spin' /> : <Trash2 />}
                      本文を削除
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>第 {chapterNumber} 章の本文を削除しますか？</AlertDialogTitle>
                      <AlertDialogDescription>
                        本文と章タイトルを削除します
                        (章立てとコスト履歴は残ります)。削除後は小説一覧の詳細画面に戻ります。元には戻せません。
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel disabled={isDeleting}>キャンセル</AlertDialogCancel>
                      <AlertDialogAction
                        variant='destructive'
                        disabled={isDeleting}
                        onClick={(e) => {
                          e.preventDefault()
                          handleDelete()
                        }}
                        className='[&_svg]:size-5!'
                      >
                        {isDeleting ? <Loader2 className='animate-spin' /> : <Trash2 />}
                        {isDeleting ? '削除中…' : '削除する'}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
