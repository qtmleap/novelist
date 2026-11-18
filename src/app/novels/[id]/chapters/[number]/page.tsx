'use client'

import { ClipboardList, FileText, History, Loader2, PenLine, RefreshCw, Trash2, TriangleAlert } from 'lucide-react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useEffect, useMemo, useRef, useState } from 'react'
import { STALE_REASON_LABELS } from '@/components/novel/ChapterReader'
import { ChapterRecordView } from '@/components/novel/ChapterRecordView'
import { ChapterReviewView } from '@/components/novel/ChapterReviewView'
import { ErrorAlert } from '@/components/novel/ErrorAlert'
import { CHAPTER_STAGE_LABELS } from '@/components/novel/GenerationStatus'
import { NovelSkeleton } from '@/components/novel/NovelSkeleton'
import { ReviseDialog } from '@/components/novel/ReviseDialog'
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
import { chapterHasReview, startReviewPolling } from '@/lib/review-polling'
import { routes } from '@/lib/routes'
import { subscribeChapterStream } from '@/lib/stream'
import { cn } from '@/lib/utils'
import {
  asModelRef,
  type ChapterCost,
  type ChapterStage,
  type ChapterVersion,
  type NovelWithChapters
} from '@/schemas/novel.dto'
import type { StaleReason } from '@/schemas/story.dto'

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

// ISO 文字列を Date を経由せず "YYYY/MM/DD HH:mm" に整形 (no-new-date 方針)。
function formatDateTime(iso: string): string {
  const date = iso.slice(0, 10).replace(/-/g, '/')
  const time = iso.slice(11, 16)
  return `${date} ${time}`
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

type GenerationRun = {
  instruction: string
  baseVersionId: string
  failureMessage: string
  onStarted?: () => void
  onStartFailed?: (message: string) => void
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

// 生成した後に上流 (章立て、前の章) が変わった章への注意。失敗ではなく「作り直したほうがよい」ので、
// ErrorAlert (destructive) とは別に注意の色にし、色だけに頼らずアイコンと文言でも伝える。
// 再生成は、下の「危険な操作」と同じ確認ダイアログ (regenOpen) を開く。
function StaleNotice({
  reasons,
  disabled,
  onRegenerate
}: {
  reasons: StaleReason[]
  disabled: boolean
  onRegenerate: () => void
}) {
  return (
    <div className='flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200'>
      <TriangleAlert className='mt-0.5 size-5 shrink-0' aria-hidden='true' />
      <div className='flex min-w-0 flex-1 flex-col gap-2'>
        <p className='font-medium'>この章は要再生成です</p>
        {reasons.length > 0 && (
          <ul className='list-disc space-y-0.5 pl-5'>
            {reasons.map((r) => (
              <li key={r}>{STALE_REASON_LABELS[r]}</li>
            ))}
          </ul>
        )}
        <Button
          type='button'
          variant='outline'
          size='sm'
          disabled={disabled}
          onClick={onRegenerate}
          className='w-fit border-amber-500/40 bg-transparent text-amber-800 hover:bg-amber-500/20 hover:text-amber-800 dark:text-amber-200 dark:hover:text-amber-200 [&_svg]:size-4!'
        >
          <RefreshCw />
          この章を再生成
        </Button>
      </div>
    </div>
  )
}

export default function ChapterDetailPage() {
  const rawPathname = usePathname()
  const pathname = rawPathname === null ? '' : rawPathname
  const router = useRouter()
  const { novelId, chapterNumber } = useMemo(() => parseRoute(pathname), [pathname])
  const [novel, setNovel] = useState<NovelWithChapters | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // 生成の開始を依頼している間 (本文はまだ流れない)。始められなかったときに画面を元に戻せるよう、
  // 本文の表示を切り替える isRegenerating とは分ける。
  const [starting, setStarting] = useState(false)
  const [isRegenerating, setIsRegenerating] = useState(false)
  const [buffer, setBuffer] = useState('')
  // 再生成中の今の段階。本文が流れるのは writing の間だけなので、他の段階で止まって見えないよう表示する。
  const [stage, setStage] = useState<ChapterStage | null>(null)
  const [regenOpen, setRegenOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)
  // 生成プロンプト表示。loaded.text が null = この機能より前に生成された章 (プロンプト未保存)。
  const [promptOpen, setPromptOpen] = useState(false)
  const [promptView, setPromptView] = useState<
    { status: 'loading' } | { status: 'loaded'; text: string | null } | { status: 'error'; message: string }
  >({ status: 'loading' })
  // 生成履歴 (過去 version) の表示。
  const [historyOpen, setHistoryOpen] = useState(false)
  const [historyView, setHistoryView] = useState<
    { status: 'loading' } | { status: 'loaded'; versions: ChapterVersion[] } | { status: 'error'; message: string }
  >({ status: 'loading' })
  const [selectedVersionId, setSelectedVersionId] = useState<string | null>(null)
  // 履歴ダイアログで、選んだ版の何を表示するか。
  const [versionView, setVersionView] = useState<'content' | 'prompt' | 'record' | 'review'>('content')
  // 章の記録 (本文から抽出した確定事項) の表示。
  const [recordOpen, setRecordOpen] = useState(false)
  // 指示つきの書き直し。選んだ検査の指摘 (review.issues の添字) は、どの版のものかを覚えておく。
  // 再生成で版が替わると chapterId が合わなくなり、添字が別の版の指摘を指さずに自然に空になる。
  const [reviseOpen, setReviseOpen] = useState(false)
  // 書き直しの開始に失敗した理由。ダイアログを開いたまま、指示の下書きを残して出す。
  const [reviseError, setReviseError] = useState<string | null>(null)
  // 完了した章の検査の結果を待っている間 (サーバーは done の後に検査を走らせる)。どの小説のどの章かを覚えておく。
  const [reviewPending, setReviewPending] = useState<{ novelId: string; chapterNumber: number } | null>(null)
  const stopReviewPollRef = useRef<(() => void) | null>(null)
  const [issueSelection, setIssueSelection] = useState<{ chapterId: string; indexes: ReadonlySet<number> }>({
    chapterId: '',
    indexes: new Set()
  })
  // いま購読している再生成・書き直しを止める合図。生成の終わり (done、error、abort) で片付ける。
  // 止めるのは画面側の購読と更新だけで、サーバー側の生成 (DO) は続く。
  const abortRef = useRef<AbortController | null>(null)
  // その再生成が対象にしている「小説 id/章番号」。別の章へ移ったかの判定に使う。
  const runRouteRef = useRef('')
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
      // ページを離れたら検査の結果の取り直しも止める。
      stopReviewPollRef.current?.()
    }
  }, [])

  // 別の章 (別の小説) へ移ったら、再生成の購読を止めて、この画面の生成中の表示を戻す。
  // 止めた生成は画面を更新しない (runGeneration)。戻すのはここで行う。
  useEffect(() => {
    const running = abortRef.current
    if (running === null || runRouteRef.current === `${novelId}/${chapterNumber}`) return
    running.abort()
    abortRef.current = null
    setStarting(false)
    setIsRegenerating(false)
    setBuffer('')
    setStage(null)
  }, [novelId, chapterNumber])

  const chapter = novel?.chapters.find((c) => c.chapter_number === chapterNumber) ?? null
  const cost = novel?.generation_costs.find((c) => c.chapter_number === chapterNumber)
  const totalChapters = novel?.num_chapters ?? 0
  // 最新生成済み章 = この novel の chapters の最大 chapter_number。
  // 削除は後続を巻き込むので最新章のみ許可。再生成は、後ろの章が「要再生成」になるだけで本文は残るので、
  // 本文がある章ならどれでも許可する。
  const latestDoneNumber = novel?.chapters.reduce((acc, c) => Math.max(acc, c.chapter_number), 0) ?? 0
  const isLatest = chapter !== null && chapterNumber === latestDoneNumber
  const canRegenerate = chapter !== null

  // 書き直しの下書きに使う検査の指摘。選択は今の版のものだけを有効にする。
  const selectedIssueIndexes =
    chapter !== null && issueSelection.chapterId === chapter.id ? issueSelection.indexes : null
  const selectedIssues =
    chapter !== null && chapter.review !== null && selectedIssueIndexes !== null
      ? chapter.review.issues.filter((_, i) => selectedIssueIndexes.has(i))
      : []
  const toggleIssue = (index: number) => {
    if (chapter === null) return
    setIssueSelection((prev) => {
      const next = new Set(prev.chapterId === chapter.id ? prev.indexes : [])
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return { chapterId: chapter.id, indexes: next }
    })
  }

  const prevHref = chapterNumber > 1 && novelId ? routes.novels.chapter(novelId, chapterNumber - 1) : null
  const nextHref = chapterNumber < totalChapters && novelId ? routes.novels.chapter(novelId, chapterNumber + 1) : null

  // 検査の結果が入るまで、限られた回数だけ取り直す。別の小説の取り直しで画面を上書きしないよう、同じ小説のときだけ反映する。
  const beginReviewPolling = (targetNovelId: string, targetChapter: number) => {
    stopReviewPollRef.current?.()
    setReviewPending({ novelId: targetNovelId, chapterNumber: targetChapter })
    stopReviewPollRef.current = startReviewPolling({
      check: async () => {
        const refreshed = await api.getNovel({ params: { id: targetNovelId } })
        setNovel((prev) => (prev !== null && prev.id === refreshed.id ? refreshed : prev))
        return chapterHasReview(refreshed.chapters, targetChapter)
      },
      onSettled: () => {
        stopReviewPollRef.current = null
        setReviewPending(null)
      }
    })
  }

  // 本文の再生成。instruction が空なら同じ資料で書き直し、あれば base_version_id の版を元に指示した点だけを直す。
  // 開始の依頼が断られたとき (成人指定の検証の 400 など) は、onStartFailed があればそちらに理由を渡し、
  // 無ければ画面のエラーとして出す。onStarted は開始の依頼が通った時点で呼ぶ。
  const runGeneration = async (run: GenerationRun) => {
    if (!novelId || chapterNumber <= 0 || !novel) return
    // 前の版の検査の結果を待っていたら止める。新しい版が完了したら、そのとき改めて待つ。
    stopReviewPollRef.current?.()
    stopReviewPollRef.current = null
    setReviewPending(null)
    // 前の購読が残っていれば止めて、この生成の合図に替える。止められた後は、画面の state を更新しない。
    const abort = new AbortController()
    abortRef.current?.abort()
    abortRef.current = abort
    runRouteRef.current = `${novelId}/${chapterNumber}`
    const stopped = () => abort.signal.aborted
    setStarting(true)
    setError(null)
    try {
      await api.startChapterGeneration(
        { model: asModelRef(novel.writer_model), instruction: run.instruction, base_version_id: run.baseVersionId },
        { params: { id: novelId, number: String(chapterNumber) } }
      )
    } catch (e) {
      if (abortRef.current === abort) abortRef.current = null
      if (stopped()) return
      setStarting(false)
      const message = readApiError(e, run.failureMessage)
      if (run.onStartFailed !== undefined) run.onStartFailed(message)
      else setError(message)
      return
    }
    if (stopped()) return
    setStarting(false)
    setIsRegenerating(true)
    setBuffer('')
    setStage(null)
    run.onStarted?.()
    try {
      const outcome = await new Promise<{ done: boolean; hasReview: boolean }>((resolve) => {
        const sub = subscribeChapterStream(`/api/novels/${novelId}/chapters/${chapterNumber}/stream`, {
          onStage: (next) => {
            if (!stopped()) setStage(next)
          },
          // 再接続でサーバーが本文を全文送り直してくるので、足し込む前に空にする。
          onReset: () => {
            if (!stopped()) setBuffer('')
          },
          onDelta: (text) => {
            if (!stopped()) setBuffer((b) => b + text)
          },
          onDone: async () => {
            try {
              const refreshed = await api.getNovel({ params: { id: novelId } })
              // 取り直している間に止められたら、画面を更新せず、abort の側で終わらせる。
              if (stopped()) return
              setNovel(refreshed)
              resolve({ done: true, hasReview: chapterHasReview(refreshed.chapters, chapterNumber) })
            } catch {
              // 再取得に失敗しても streaming buffer 自体は描画済み。結果は取り直しの側で拾う。
              if (!stopped()) resolve({ done: true, hasReview: false })
            }
          },
          onError: (msg) => {
            if (stopped()) return
            setError(msg)
            resolve({ done: false, hasReview: false })
          }
        })
        // ページを離れる・別の章へ移る・次の生成が始まるときは、ローカルの購読だけ止める (DO 側の生成は続く)。
        abort.signal.addEventListener(
          'abort',
          () => {
            sub.close()
            resolve({ done: false, hasReview: false })
          },
          { once: true }
        )
      })
      if (stopped()) return
      // 検査は done の後に走るので、この時点ではまだ無いことが多い。入るまで取り直す。
      if (outcome.done && !outcome.hasReview) beginReviewPolling(novelId, chapterNumber)
    } catch (e) {
      if (!stopped()) setError(readApiError(e, run.failureMessage))
    } finally {
      // 自分の合図が最新のままなら片付ける。止められていたら、画面の state は触らない。
      if (abortRef.current === abort) abortRef.current = null
      if (!stopped()) {
        setIsRegenerating(false)
        setBuffer('')
        setStage(null)
      }
    }
  }

  const handleRegenerate = () =>
    runGeneration({ instruction: '', baseVersionId: '', failureMessage: '再生成に失敗しました' })

  // 今表示している版 (最新の版) を元に、指示した点だけを直した新しい版を作る。
  // 開始が断られたらダイアログを開いたままにして理由を出す (閉じると指示の下書きが消えるため)。通ったら閉じる。
  const handleRevise = (instruction: string) => {
    if (chapter === null) return
    setReviseError(null)
    void runGeneration({
      instruction,
      baseVersionId: chapter.id,
      failureMessage: '書き直しを始められませんでした',
      onStarted: () => setReviseOpen(false),
      onStartFailed: setReviseError
    })
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

  const handleViewHistory = async () => {
    if (!novelId || chapterNumber <= 0) return
    setHistoryOpen(true)
    setHistoryView({ status: 'loading' })
    setVersionView('content')
    try {
      const data = await api.getChapterVersions({ params: { id: novelId, number: String(chapterNumber) } })
      setHistoryView({ status: 'loaded', versions: data })
      setSelectedVersionId(data.length > 0 ? data[0].id : null)
    } catch (e) {
      setHistoryView({ status: 'error', message: readApiError(e, '生成履歴の取得に失敗しました') })
    }
  }

  // 検査の結果を待っている章か (この小説のこの章で、まだ結果が入っていない間)。
  const showReviewPending =
    !isRegenerating &&
    chapter !== null &&
    chapter.review === null &&
    reviewPending !== null &&
    reviewPending.novelId === novelId &&
    reviewPending.chapterNumber === chapterNumber

  const displayContent = isRegenerating ? buffer : (chapter?.content ?? '')
  const busy = isRegenerating || starting || isDeleting

  // 履歴ダイアログで選択中の version (未選択なら先頭=最新)。
  const historyVersions = historyView.status === 'loaded' ? historyView.versions : []
  const foundVersion = historyVersions.find((v) => v.id === selectedVersionId)
  const selectedVersion =
    foundVersion !== undefined ? foundVersion : historyVersions.length > 0 ? historyVersions[0] : undefined

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
            {/* live region は常に描画する (中身と同時に差し込むと読み上げられないことがあるため)。
                空のときは余白を持たせず、レイアウトに影響させない。 */}
            <p
              aria-live='polite'
              className={cn(
                isRegenerating && stage !== null && 'mt-2 flex items-center gap-1.5 text-xs text-muted-foreground'
              )}
            >
              {isRegenerating && stage !== null && (
                <>
                  <Loader2 aria-hidden='true' className='size-3.5 shrink-0 animate-spin' />
                  {CHAPTER_STAGE_LABELS[stage]}
                </>
              )}
            </p>
          </div>

          {!isRegenerating && chapter.staleness.stale && (
            <StaleNotice
              reasons={chapter.staleness.reasons}
              disabled={busy || !canRegenerate || !editAllowed}
              onRegenerate={() => setRegenOpen(true)}
            />
          )}

          {/* live region は常に描画する (中身と同時に差し込むと読み上げられないことがあるため)。
              待っていないときは sr-only (position: absolute) にして、親の space-y の余白を増やさない。 */}
          <p
            aria-live='polite'
            className={cn(showReviewPending ? 'flex items-center gap-1.5 text-xs text-muted-foreground' : 'sr-only')}
          >
            {showReviewPending && (
              <>
                <Loader2 aria-hidden='true' className='size-3.5 shrink-0 animate-spin' />
                検査中…
              </>
            )}
          </p>

          {!isRegenerating && chapter.review !== null && (
            <ChapterReviewView
              review={chapter.review}
              selectedIssues={selectedIssueIndexes !== null ? selectedIssueIndexes : undefined}
              onToggleIssue={editAllowed ? toggleIssue : undefined}
              disabled={busy}
            />
          )}

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

          <div className='flex flex-wrap items-center gap-2 border-t pt-6'>
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
            <Button
              type='button'
              variant='outline'
              size='sm'
              disabled={busy}
              onClick={handleViewHistory}
              className='[&_svg]:size-4!'
            >
              <History />
              生成履歴
            </Button>
            <Button
              type='button'
              variant='outline'
              size='sm'
              disabled={busy}
              onClick={() => setRecordOpen(true)}
              className='[&_svg]:size-4!'
            >
              <ClipboardList />
              この章の記録
            </Button>
          </div>

          <div className='border-t pt-6'>
            <div className='mb-3'>
              <h2 className='text-sm font-semibold'>書き直し</h2>
              <p className='mt-0.5 text-sm text-muted-foreground'>
                指示した点だけを直した新しい版を作ります。元の版は履歴に残ります。
              </p>
            </div>
            <Button
              type='button'
              variant='outline'
              size='sm'
              disabled={busy || !canRegenerate || !editAllowed}
              title={!editAllowed ? 'ログインが必要です' : undefined}
              onClick={() => {
                setReviseError(null)
                setReviseOpen(true)
              }}
              className='[&_svg]:size-5!'
            >
              <PenLine />
              指示して書き直す
              {selectedIssues.length > 0 && <span className='tabular-nums'>（指摘 {selectedIssues.length} 件）</span>}
            </Button>
          </div>

          <div className='border-t pt-6'>
            <div className='mb-3'>
              <h2 className='text-sm font-semibold text-destructive'>危険な操作</h2>
              <p className='mt-0.5 text-sm text-muted-foreground'>
                {isLatest
                  ? '再生成と削除は元に戻せません。'
                  : '再生成は元に戻せません。後ろの章は要再生成になります。削除は最新章のみ可能です。'}
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
                    {isRegenerating || starting ? <Loader2 className='animate-spin' /> : <RefreshCw />}
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

          <ReviseDialog
            open={reviseOpen}
            // 開始を依頼している間は閉じさせない (失敗の理由を、下書きを残したまま見せるため)。
            onOpenChange={(next) => {
              if (!starting) setReviseOpen(next)
            }}
            chapterNumber={chapterNumber}
            issues={selectedIssues}
            disabled={busy || !editAllowed}
            submitting={starting}
            error={reviseError}
            onSubmit={handleRevise}
          />

          <Dialog open={recordOpen} onOpenChange={setRecordOpen}>
            <DialogContent className='sm:max-w-3xl'>
              <DialogHeader>
                <DialogTitle>第 {chapterNumber} 章の記録</DialogTitle>
                <DialogDescription>次の章以降を書くときに、確定した事実として渡されます。</DialogDescription>
              </DialogHeader>
              {chapter.record === null ? (
                <p className='text-sm text-muted-foreground'>
                  この章の記録はまだありません（抽出に失敗したか、この機能より前に生成された章です）
                </p>
              ) : (
                <div className='max-h-[60vh] overflow-auto pr-1'>
                  <ChapterRecordView record={chapter.record} />
                </div>
              )}
            </DialogContent>
          </Dialog>

          <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
            <DialogContent className='sm:max-w-3xl'>
              <DialogHeader>
                <DialogTitle>第 {chapterNumber} 章の生成履歴</DialogTitle>
                <DialogDescription>
                  再生成しても過去の生成は残ります。版を選んで本文・プロンプト・記録・検査の結果を確認できます。
                </DialogDescription>
              </DialogHeader>
              {historyView.status === 'loading' && <p className='text-sm text-muted-foreground'>取得中…</p>}
              {historyView.status === 'error' && <p className='text-sm text-destructive'>{historyView.message}</p>}
              {historyView.status === 'loaded' && historyVersions.length === 0 && (
                <p className='text-sm text-muted-foreground'>履歴がありません。</p>
              )}
              {selectedVersion !== undefined && (
                <div className='space-y-3'>
                  <div className='flex flex-wrap gap-1.5'>
                    {historyVersions.map((v, idx) => (
                      <Button
                        key={v.id}
                        type='button'
                        size='sm'
                        variant={v.id === selectedVersion.id ? 'default' : 'outline'}
                        onClick={() => {
                          setSelectedVersionId(v.id)
                          setVersionView('content')
                        }}
                      >
                        v{v.version}
                        {idx === 0 && ' (現在)'}
                      </Button>
                    ))}
                  </div>
                  <div className='flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground'>
                    {selectedVersion.title !== null && <span className='font-medium'>{selectedVersion.title}</span>}
                    <span>{formatDateTime(selectedVersion.created_at)}</span>
                    <span className='tabular-nums'>{selectedVersion.content.length.toLocaleString()} 文字</span>
                    {versionView !== 'content' && (
                      <button
                        type='button'
                        onClick={() => setVersionView('content')}
                        className='underline underline-offset-2 hover:text-foreground'
                      >
                        本文を表示
                      </button>
                    )}
                    {selectedVersion.prompt !== null && versionView !== 'prompt' && (
                      <button
                        type='button'
                        onClick={() => setVersionView('prompt')}
                        className='underline underline-offset-2 hover:text-foreground'
                      >
                        この版のプロンプトを表示
                      </button>
                    )}
                    {selectedVersion.record !== null && versionView !== 'record' && (
                      <button
                        type='button'
                        onClick={() => setVersionView('record')}
                        className='underline underline-offset-2 hover:text-foreground'
                      >
                        この版の記録を表示
                      </button>
                    )}
                    {selectedVersion.review !== null && versionView !== 'review' && (
                      <button
                        type='button'
                        onClick={() => setVersionView('review')}
                        className='underline underline-offset-2 hover:text-foreground'
                      >
                        この版の検査の結果を表示
                      </button>
                    )}
                  </div>
                  {versionView === 'record' && selectedVersion.record !== null ? (
                    <div className='max-h-[55vh] overflow-auto rounded-md border p-3'>
                      <ChapterRecordView record={selectedVersion.record} />
                    </div>
                  ) : versionView === 'review' && selectedVersion.review !== null ? (
                    <div className='max-h-[55vh] overflow-auto'>
                      <ChapterReviewView review={selectedVersion.review} />
                    </div>
                  ) : (
                    <pre className='max-h-[55vh] overflow-auto rounded-md border bg-muted/40 p-3 text-xs leading-relaxed whitespace-pre-wrap'>
                      {versionView === 'prompt' && selectedVersion.prompt !== null
                        ? selectedVersion.prompt
                        : selectedVersion.content}
                    </pre>
                  )}
                </div>
              )}
            </DialogContent>
          </Dialog>
        </>
      )}
    </div>
  )
}
