'use client'

import { FileText, Loader2, RefreshCw, Trash2 } from 'lucide-react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
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
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { canEdit, useAuth } from '@/hooks/useAuth'
import { api, readApiError } from '@/lib/api/client'
import { routes } from '@/lib/routes'
import { subscribeChapterStream } from '@/lib/stream'
import { cn } from '@/lib/utils'
import { type ChapterCost, GeminiModelSchema, type NovelWithChapters } from '@/schemas/novel.dto'

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
  const router = useRouter()
  const { novelId, chapterNumber } = useMemo(() => parseRoute(pathname), [pathname])
  const [novel, setNovel] = useState<NovelWithChapters | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [isRegenerating, setIsRegenerating] = useState(false)
  const [buffer, setBuffer] = useState('')
  const [regenOpen, setRegenOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  // 生成プロンプト表示。loaded.text が null = この機能より前に生成された章 (プロンプト未保存)。
  const [promptOpen, setPromptOpen] = useState(false)
  const [promptView, setPromptView] = useState<
    { status: 'loading' } | { status: 'loaded'; text: string | null } | { status: 'error'; message: string }
  >({ status: 'loading' })
  const abortRef = useRef<AbortController | null>(null)
  const auth = useAuth()
  const editAllowed = canEdit(auth)

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
        const data = await api.getNovel({ params: { id: novelId } })
        if (!cancelled) setNovel(data)
      } catch (e) {
        if (!cancelled) setError(readApiError(e, '章の取得に失敗しました'))
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
  // 削除は後続を巻き込むので最新章のみ許可。再生成は本人だけ書き換わるので、
  // 全章生成済み (= 後続も既にある) なら任意章でも許可する。
  const latestDoneNumber = novel?.chapters.reduce((acc, c) => Math.max(acc, c.chapter_number), 0) ?? 0
  const isLatest = chapter !== null && chapterNumber === latestDoneNumber
  const allChaptersDone = !!novel && novel.chapters.length >= novel.num_chapters
  const canRegenerate = chapter !== null && (isLatest || allChaptersDone)

  const prevHref = chapterNumber > 1 && novelId ? routes.novels.chapter(novelId, chapterNumber - 1) : null
  const nextHref = chapterNumber < totalChapters && novelId ? routes.novels.chapter(novelId, chapterNumber + 1) : null

  const handleRegenerate = async () => {
    if (!novelId || chapterNumber <= 0 || !novel) return
    setIsRegenerating(true)
    setBuffer('')
    setError(null)
    try {
      await api.startChapterGeneration(
        { model: GeminiModelSchema.parse(novel.writer_model) },
        { params: { id: novelId, number: String(chapterNumber) } }
      )

      await new Promise<void>((resolve) => {
        const sub = subscribeChapterStream(`/api/novels/${novelId}/chapters/${chapterNumber}/stream`, {
          onDelta: (text) => setBuffer((b) => b + text),
          onDone: async () => {
            try {
              const refreshed = await api.getNovel({ params: { id: novelId } })
              setNovel(refreshed)
            } catch {
              // 再取得に失敗しても streaming buffer 自体は描画済み
            }
            resolve()
          },
          onError: (msg) => {
            setError(msg)
            resolve()
          }
        })
        // 再生成中にコンポーネントが unmount されても DO 側は続行するが、ローカルの購読は止める。
        abortRef.current?.signal.addEventListener('abort', () => {
          sub.close()
          resolve()
        })
      })
    } catch (e) {
      setError(readApiError(e, '再生成に失敗しました'))
    } finally {
      setIsRegenerating(false)
      setBuffer('')
    }
  }

  const handleDelete = async () => {
    if (!novelId || chapterNumber <= 0) return
    setIsDeleting(true)
    try {
      await api.deleteChapter(undefined, { params: { id: novelId, number: String(chapterNumber) } })
      router.push(routes.novels.detail(novelId))
    } catch (e) {
      setError(readApiError(e, '削除に失敗しました'))
      setIsDeleting(false)
      setDeleteOpen(false)
    }
  }

  const handleViewPrompt = async () => {
    if (!novelId || chapterNumber <= 0) return
    setPromptOpen(true)
    setPromptView({ status: 'loading' })
    try {
      const data = await api.getChapterPrompt({ params: { id: novelId, number: String(chapterNumber) } })
      setPromptView({ status: 'loaded', text: data.prompt })
    } catch (e) {
      setPromptView({ status: 'error', message: readApiError(e, 'プロンプトの取得に失敗しました') })
    }
  }

  const displayContent = isRegenerating ? buffer : (chapter?.content ?? '')
  const busy = isRegenerating || isDeleting

  return (
    <div className='space-y-6'>
      <PageHeader
        crumbs={[
          { label: '小説一覧', href: routes.novels.list },
          { label: novel?.title ?? '詳細', href: novelId ? routes.novels.detail(novelId) : undefined },
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

          <div className='border-t pt-6'>
            <Button
              type='button'
              variant='outline'
              size='sm'
              disabled={busy}
              onClick={handleViewPrompt}
              className='[&_svg]:size-4!'
            >
              <FileText />
              生成プロンプトを見る
            </Button>
          </div>

          <div className='border-t pt-6'>
            <div className='mb-3'>
              <h2 className='text-sm font-semibold text-destructive'>危険な操作</h2>
              <p className='mt-0.5 text-sm text-muted-foreground'>
                {isLatest
                  ? '再生成と削除は元に戻せません。'
                  : allChaptersDone
                    ? '再生成は元に戻せません。後続の章との整合性は保たれない場合があります。削除は最新章のみ可能です。'
                    : '整合性のため、再生成と削除は最新の生成済み章でのみ可能です。'}
              </p>
            </div>
            <div className='flex flex-wrap items-center gap-2'>
              <AlertDialog open={regenOpen} onOpenChange={setRegenOpen}>
                <AlertDialogTrigger asChild>
                  <Button
                    type='button'
                    variant='outline'
                    size='sm'
                    disabled={busy || !canRegenerate || !editAllowed}
                    title={!editAllowed ? 'ログインが必要です' : undefined}
                    className='[&_svg]:size-5!'
                  >
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
                  <Button
                    type='button'
                    variant='destructive'
                    size='sm'
                    disabled={busy || !isLatest || !editAllowed}
                    title={!editAllowed ? 'ログインが必要です' : undefined}
                    className='[&_svg]:size-5!'
                  >
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

          <Dialog open={promptOpen} onOpenChange={setPromptOpen}>
            <DialogContent className='sm:max-w-3xl'>
              <DialogHeader>
                <DialogTitle>第 {chapterNumber} 章を生成したときのプロンプト</DialogTitle>
                <DialogDescription>本文生成時に実際に Gemini へ送ったプロンプト全文です。</DialogDescription>
              </DialogHeader>
              {promptView.status === 'loading' && <p className='text-sm text-muted-foreground'>取得中…</p>}
              {promptView.status === 'error' && <p className='text-sm text-destructive'>{promptView.message}</p>}
              {promptView.status === 'loaded' && promptView.text === null && (
                <p className='text-sm text-muted-foreground'>
                  この章はプロンプトが保存されていません
                  (プロンプト保存機能より前に生成された章です)。再生成すると保存されます。
                </p>
              )}
              {promptView.status === 'loaded' && promptView.text !== null && (
                <pre className='max-h-[60vh] overflow-auto rounded-md border bg-muted/40 p-3 text-xs leading-relaxed whitespace-pre-wrap'>
                  {promptView.text}
                </pre>
              )}
            </DialogContent>
          </Dialog>
        </>
      )}
    </div>
  )
}
