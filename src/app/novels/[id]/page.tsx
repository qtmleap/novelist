'use client'

import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { Copy, Loader2, Pencil, RefreshCw, ScrollText, Sparkles, Users } from 'lucide-react'
import { useParams, useRouter } from 'next/navigation'
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { toast } from 'sonner'
import { BibleEditor } from '@/components/novel/BibleEditor'
import { BibleOutdatedNotice, BibleView } from '@/components/novel/BibleView'
import type { ChapterData } from '@/components/novel/ChapterReader'
import { ChapterSelectionDialog } from '@/components/novel/ChapterSelectionDialog'
import { ErrorAlert } from '@/components/novel/ErrorAlert'
import { GenerationStatus } from '@/components/novel/GenerationStatus'
import { NovelSkeleton } from '@/components/novel/NovelSkeleton'
import { OutlineSelectionDialog } from '@/components/novel/OutlineSelectionDialog'
import { OutlineView } from '@/components/novel/OutlineView'
import { OutlineWarnings } from '@/components/novel/OutlineWarnings'
import { PageHeader } from '@/components/PageHeader'
import { QueryBoundary } from '@/components/QueryBoundary'
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
import {
  asModelRef,
  type Chapter,
  type ChapterCost,
  type ChapterStage,
  type ModelRef,
  type Outline
} from '@/schemas/novel.dto'
import type { OutlineWarning, StoryBible } from '@/schemas/story.dto'

function chaptersFromApi(apiChapters: Chapter[]): ChapterData[] {
  return apiChapters.map((c) => ({
    number: c.chapter_number,
    title: c.title,
    content: c.content,
    done: true
  }))
}

type GenStatus = 'idle' | 'generatingOutline' | 'generatingChapter' | 'cancelled' | 'error'

type GenState = {
  outline: Outline | null
  // 直近の章立て操作 (生成・再生成・手動保存) で返った警告。次の操作が成功したら置き換える。
  outlineWarnings: OutlineWarning[]
  chapters: ChapterData[]
  streamingIndex: number | null
  // 生成中の章の今の段階。サーバーが送るまで (または送らない間) は null。
  stage: ChapterStage | null
  buffer: string
  genStatus: GenStatus
  genError: string | null
}

type GenAction =
  | { type: 'OUTLINE_START' }
  | { type: 'OUTLINE_OK'; outline: Outline; warnings: OutlineWarning[] }
  | { type: 'OUTLINE_WARNINGS_DISMISS' }
  | { type: 'OUTLINE_ERR'; error: string }
  | { type: 'CHAPTERS_REFRESHED'; chapters: ChapterData[] }
  | { type: 'CHAPTER_START'; chapterNumber: number }
  | { type: 'CHAPTER_STAGE'; stage: ChapterStage }
  | { type: 'CHAPTER_RESET' }
  | { type: 'CHAPTER_DELTA'; text: string }
  | { type: 'CHAPTER_DONE'; chapterNumber: number; chapterId: string; title: string }
  | { type: 'CHAPTER_ERR'; error: string }
  | { type: 'CANCEL' }

function genReducer(state: GenState, action: GenAction): GenState {
  switch (action.type) {
    case 'OUTLINE_START':
      return { ...state, genStatus: 'generatingOutline', genError: null }
    case 'OUTLINE_OK':
      return { ...state, genStatus: 'idle', outline: action.outline, outlineWarnings: action.warnings }
    case 'OUTLINE_WARNINGS_DISMISS':
      return { ...state, outlineWarnings: [] }
    case 'OUTLINE_ERR':
      return { ...state, genStatus: 'error', genError: action.error }
    case 'CHAPTERS_REFRESHED':
      return { ...state, chapters: action.chapters }
    case 'CHAPTER_START':
      return {
        ...state,
        genStatus: 'generatingChapter',
        streamingIndex: action.chapterNumber,
        stage: null,
        buffer: '',
        genError: null
      }
    case 'CHAPTER_STAGE':
      return { ...state, stage: action.stage }
    case 'CHAPTER_RESET':
      // 再接続でサーバーが本文を全文送り直してくるので、足し込む前に空にする。段階はそのまま。
      return { ...state, buffer: '' }
    case 'CHAPTER_DELTA':
      return { ...state, buffer: state.buffer + action.text }
    case 'CHAPTER_DONE': {
      const committed: ChapterData = {
        number: action.chapterNumber,
        title: action.title,
        content: state.buffer,
        done: true
      }
      const existing = state.chapters.findIndex((c) => c.number === action.chapterNumber)
      const next =
        existing !== -1
          ? state.chapters.map((c) => (c.number === action.chapterNumber ? committed : c))
          : [...state.chapters, committed]
      return { ...state, chapters: next, streamingIndex: null, stage: null, buffer: '', genStatus: 'idle' }
    }
    case 'CHAPTER_ERR':
      return { ...state, genStatus: 'error', genError: action.error, streamingIndex: null, stage: null, buffer: '' }
    case 'CANCEL':
      return { ...state, genStatus: 'cancelled', streamingIndex: null, stage: null, buffer: '' }
    default:
      return state
  }
}

function GenerateChaptersButton({
  hasUndoneChapter,
  disabled,
  onOpen
}: {
  hasUndoneChapter: boolean
  disabled: boolean
  onOpen: () => void
}) {
  return (
    <Button
      type='button'
      size='sm'
      className='[&_svg]:size-5!'
      onClick={onOpen}
      disabled={disabled}
      title={disabled ? 'ログインが必要です' : undefined}
    >
      {hasUndoneChapter ? <Sparkles /> : <RefreshCw />}
      {hasUndoneChapter ? '本文を生成' : '本文を再生成'}
    </Button>
  )
}

function NovelTotals({
  chapters,
  costs,
  totalCostUsd,
  auxCostUsd
}: {
  chapters: ChapterData[]
  costs: ChapterCost[]
  totalCostUsd: number
  // 本文以外 (章立てなど) の生成コスト。本文がまだ無い段階でも出すため、本文の有無とは別に扱う。
  auxCostUsd: number
}) {
  const totalChars = chapters.reduce((sum, c) => sum + (c.done ? c.content.length : 0), 0)
  const hasBody = totalChars > 0 || costs.length > 0
  const hasAux = auxCostUsd > 0
  if (!hasBody && !hasAux) return null
  return (
    <p className='mt-0.5 flex flex-wrap items-baseline gap-x-4 gap-y-0.5 text-sm text-muted-foreground'>
      {hasBody && (
        <span>
          {'文字数 '}
          <span className='tabular-nums'>{totalChars.toLocaleString()}</span>
        </span>
      )}
      {costs.length > 0 && (
        <span>
          {'コスト '}
          <span className='tabular-nums'>${totalCostUsd.toFixed(4)} USD</span>
        </span>
      )}
      {hasAux && (
        <span>
          {'章立てなど '}
          <span className='tabular-nums'>${auxCostUsd.toFixed(4)} USD</span>
        </span>
      )}
    </p>
  )
}

function NovelDetailContent({ id }: { id: string }) {
  const router = useRouter()
  const auth = useAuth()
  const editAllowed = canEdit(auth)
  const queryClient = useQueryClient()

  const { data: novel, refetch } = useSuspenseQuery({
    queryKey: ['novel', id],
    queryFn: () => api.getNovel({ params: { id } })
  })

  const [state, dispatch] = useReducer(
    genReducer,
    novel,
    (n): GenState => ({
      outline: n.outline,
      outlineWarnings: [],
      chapters: chaptersFromApi(n.chapters),
      streamingIndex: null,
      stage: null,
      buffer: '',
      genStatus: 'idle',
      genError: null
    })
  )

  const abortRef = useRef<AbortController | null>(null)

  const genJob = novel.gen_job
  const genJobCurrentKey =
    genJob !== null && genJob !== undefined && genJob.status === 'running' ? genJob.current : null

  useEffect(() => {
    if (genJobCurrentKey === null) return

    const chapterNum = genJobCurrentKey
    dispatch({ type: 'CHAPTER_START', chapterNumber: chapterNum })

    const abort = new AbortController()
    abortRef.current = abort

    const sub = subscribeChapterStream(`/api/novels/${id}/chapters/${chapterNum}/stream`, {
      onStage: (stage) => dispatch({ type: 'CHAPTER_STAGE', stage }),
      onReset: () => dispatch({ type: 'CHAPTER_RESET' }),
      onDelta: (text) => dispatch({ type: 'CHAPTER_DELTA', text }),
      onDone: ({ chapterId, title }) => {
        dispatch({ type: 'CHAPTER_DONE', chapterNumber: chapterNum, chapterId, title })
        void refetch()
      },
      onError: (msg) => dispatch({ type: 'CHAPTER_ERR', error: msg })
    })

    abort.signal.addEventListener('abort', () => {
      sub.close()
      dispatch({ type: 'CANCEL' })
    })

    return () => {
      sub.close()
      abort.abort()
    }
  }, [genJobCurrentKey, id, refetch])

  const [outlineDialogOpen, setOutlineDialogOpen] = useState(false)
  const [chapterDialogOpen, setChapterDialogOpen] = useState(false)
  const [promptPreviewOpen, setPromptPreviewOpen] = useState(false)
  const [promptPreview, setPromptPreview] = useState<string | null>(null)
  const [promptPreviewLoading, setPromptPreviewLoading] = useState(false)
  const [isCopying, setIsCopying] = useState(false)
  // 作品設計のダイアログ。busy は生成中 / 保存中 (どちらの間もボタンを止めてスピナーを出す)。
  const [bibleOpen, setBibleOpen] = useState(false)
  const [bibleMode, setBibleMode] = useState<'view' | 'edit'>('view')
  const [bibleBusy, setBibleBusy] = useState<'generating' | 'saving' | null>(null)
  const [bibleError, setBibleError] = useState<string | null>(null)
  const [bibleRegenOpen, setBibleRegenOpen] = useState(false)

  const handleBibleOpenChange = (open: boolean) => {
    setBibleOpen(open)
    if (!open) {
      setBibleMode('view')
      setBibleError(null)
    }
  }

  // 作品設計の生成 (未作成からの生成も、作り直しも同じ API)。成功したら novel を取り直して表示を更新する。
  const handleGenerateBible = async () => {
    setBibleBusy('generating')
    setBibleError(null)
    try {
      await api.generateBible({ model: asModelRef(novel.editor_model) }, { params: { id } })
      await refetch()
    } catch (e) {
      setBibleError(readApiError(e, '作品設計の生成に失敗しました'))
    } finally {
      setBibleBusy(null)
    }
  }

  // 失敗したら編集モードのまま理由を出す (成人指定の検証で 400 invalid_bible が返ることがある)。
  const handleSaveBible = async (bible: StoryBible) => {
    setBibleBusy('saving')
    setBibleError(null)
    try {
      await api.updateBible({ bible }, { params: { id } })
      await refetch()
      setBibleMode('view')
    } catch (e) {
      setBibleError(readApiError(e, '作品設計の保存に失敗しました'))
    } finally {
      setBibleBusy(null)
    }
  }

  const handleCopy = async () => {
    setIsCopying(true)
    try {
      const created = await api.createNovel({
        title: `${novel.title} (コピー)`,
        genre: novel.genre,
        setting: novel.setting,
        num_chapters: novel.num_chapters,
        target_chars: novel.target_chars,
        outline_summary_chars: novel.outline_summary_chars,
        pov: novel.pov,
        tone: novel.tone,
        age_rating: novel.age_rating,
        ending: novel.ending,
        notes: novel.notes,
        writing_notes: novel.writing_notes,
        editor_model: asModelRef(novel.editor_model),
        writer_model: asModelRef(novel.writer_model),
        category_id: novel.category_id
      })
      // キャスト・関係・語り手は別エンドポイントで複製する。
      await api.saveNovelCast(
        {
          pov_character_id: novel.pov_character_id,
          character_links: novel.cast.map((c) => ({ character_id: c.character_id, role: c.role })),
          relations: novel.relations.map((r) => ({
            source_character_id: r.source_character_id,
            target_character_id: r.target_character_id,
            relation: r.relation,
            description: r.description,
            address_override: r.address_override
          }))
        },
        { params: { id: created.id } }
      )
      router.push(routes.novels.edit(created.id))
    } catch (e) {
      toast.error(readApiError(e, '小説のコピーに失敗しました'))
      setIsCopying(false)
    }
  }

  const doGenerateOutline = useCallback(
    async (editorModel: ModelRef, chapters?: number[]): Promise<Outline | null> => {
      dispatch({ type: 'OUTLINE_START' })
      try {
        const body = await api.generateOutline(
          { model: editorModel, chapters: chapters !== undefined ? chapters : [] },
          { params: { id } }
        )
        dispatch({ type: 'OUTLINE_OK', outline: body.outline, warnings: body.warnings })
        // chapters[] 指定の部分再生成では対象章の本文も server 側で消えるので novel を取り直す。
        const { data: freshNovel } = await refetch()
        if (freshNovel) {
          dispatch({ type: 'CHAPTERS_REFRESHED', chapters: chaptersFromApi(freshNovel.chapters) })
        }
        return body.outline
      } catch (e) {
        dispatch({ type: 'OUTLINE_ERR', error: readApiError(e, '章立て生成に失敗しました') })
        return null
      }
    },
    [id, refetch]
  )

  const handleStartGeneration = useCallback(
    async (chapters: number[], model: ModelRef) => {
      try {
        await api.startBatchGeneration({ chapters, model }, { params: { id } })
        await refetch()
      } catch (e) {
        dispatch({ type: 'CHAPTER_ERR', error: readApiError(e, '生成の開始に失敗しました') })
      }
    },
    [id, refetch]
  )

  const handleStop = useCallback(async () => {
    try {
      await api.stopGeneration(undefined, { params: { id } })
    } catch {
      // best-effort
    }
    abortRef.current?.abort()
    await refetch()
  }, [id, refetch])

  const handleRetryChapter = async (num: number) => {
    dispatch({ type: 'CANCEL' })
    await handleStartGeneration([num], asModelRef(novel.writer_model))
  }

  const { outline, outlineWarnings, chapters, streamingIndex, stage, genStatus, genError } = state
  const isGenerating = genStatus === 'generatingOutline' || genStatus === 'generatingChapter'
  const totalChapters = outline !== null ? outline.chapters.length : novel.num_chapters
  const currentChapter = streamingIndex !== null ? streamingIndex : chapters.filter((c) => c.done).length + 1

  useEffect(() => {
    return () => {
      abortRef.current?.abort()
    }
  }, [])

  return (
    <div className='space-y-6'>
      <PageHeader crumbs={[{ label: '小説一覧', href: routes.novels.list }, { label: novel.title }]} />

      <div className='flex flex-col gap-3'>
        <div className='min-w-0'>
          <p className='text-xs font-medium uppercase tracking-wider text-muted-foreground'>{novel.genre}</p>
          <h1 className='mt-1 text-xl font-semibold'>{novel.title}</h1>
          <p className='mt-0.5 text-sm text-muted-foreground'>
            <span className='tabular-nums'>{chapters.filter((c) => c.done).length}</span>
            {' / '}
            <span className='tabular-nums'>{novel.num_chapters}</span>
            {' 章 生成済み'}
          </p>
          {!isGenerating && (
            <NovelTotals
              chapters={chapters}
              costs={novel.generation_costs}
              totalCostUsd={novel.total_cost_usd}
              auxCostUsd={novel.aux_cost_usd}
            />
          )}
        </div>
        <div className='flex flex-wrap items-center justify-end gap-2'>
          <Button
            type='button'
            size='sm'
            variant='outline'
            disabled={isGenerating}
            onClick={async () => {
              setPromptPreviewLoading(true)
              setPromptPreviewOpen(true)
              try {
                const data = await api.previewOutlinePrompt({ params: { id } })
                setPromptPreview(data.prompt)
              } catch (e) {
                setPromptPreview(`プレビュー取得に失敗しました: ${readApiError(e)}`)
              } finally {
                setPromptPreviewLoading(false)
              }
            }}
          >
            プロンプト確認
          </Button>
          <Button
            type='button'
            size='sm'
            variant='outline'
            className='[&_svg]:size-5!'
            onClick={() => setBibleOpen(true)}
          >
            <ScrollText />
            作品設計
          </Button>
          <Button
            type='button'
            size='sm'
            variant={outline !== null && outline.chapters.length >= novel.num_chapters ? 'outline' : 'default'}
            disabled={isGenerating || !editAllowed}
            title={!editAllowed ? 'ログインが必要です' : undefined}
            className='[&_svg]:size-5!'
            onClick={() => setOutlineDialogOpen(true)}
          >
            {genStatus === 'generatingOutline' ? (
              <Loader2 className='animate-spin' />
            ) : outline !== null && outline.chapters.length >= novel.num_chapters ? (
              <RefreshCw />
            ) : (
              <Sparkles />
            )}
            {outline !== null && outline.chapters.length >= novel.num_chapters ? '章立てを再生成' : '章立てを生成'}
          </Button>
          <Button
            type='button'
            size='sm'
            variant='outline'
            className='[&_svg]:size-5!'
            disabled={!editAllowed || isCopying || isGenerating}
            title={!editAllowed ? 'ログインが必要です' : undefined}
            onClick={handleCopy}
          >
            {isCopying ? <Loader2 className='animate-spin' /> : <Copy />}
            コピー
          </Button>
          <Button asChild size='sm' variant='outline' className='[&_svg]:size-5!'>
            <a href={routes.novels.cast(novel.id)}>
              <Users />
              登場人物
            </a>
          </Button>
          {editAllowed ? (
            <Button asChild size='sm' variant='outline' className='[&_svg]:size-5!'>
              <a href={routes.novels.edit(novel.id)}>
                <Pencil />
                編集
              </a>
            </Button>
          ) : (
            <Button size='sm' variant='outline' className='[&_svg]:size-5!' disabled title='ログインが必要です'>
              <Pencil />
              編集
            </Button>
          )}
        </div>
        {novel.bible !== null && novel.bible_outdated && <BibleOutdatedNotice onOpen={() => setBibleOpen(true)} />}
      </div>

      {genStatus === 'error' && genError && (
        <ErrorAlert
          message={genError}
          onRetry={() => {
            queryClient.invalidateQueries({ queryKey: ['novel', id] })
            dispatch({ type: 'CANCEL' })
          }}
        />
      )}

      {isGenerating && (
        <GenerationStatus
          currentChapter={currentChapter}
          totalChapters={totalChapters}
          stage={stage}
          onCancel={handleStop}
        />
      )}

      <OutlineWarnings warnings={outlineWarnings} onDismiss={() => dispatch({ type: 'OUTLINE_WARNINGS_DISMISS' })} />

      <OutlineView
        outline={outline}
        isGenerating={genStatus === 'generatingOutline'}
        isBusy={isGenerating}
        chapters={chapters}
        costs={novel.generation_costs}
        streamingIndex={streamingIndex}
        novelId={novel.id}
        expectedTotal={novel.num_chapters}
        canEdit={editAllowed}
        castNames={novel.cast.map((c) => c.name)}
        onSaveOutline={async (next) => {
          try {
            const res = await api.updateOutline({ outline: next }, { params: { id } })
            dispatch({ type: 'OUTLINE_OK', outline: res.outline, warnings: res.warnings })
          } catch (e) {
            dispatch({ type: 'OUTLINE_ERR', error: readApiError(e, '章立ての保存に失敗しました') })
            throw e
          }
        }}
      />

      {genStatus === 'error' && streamingIndex !== null && (
        <Button
          type='button'
          variant='outline'
          size='sm'
          onClick={() => handleRetryChapter(streamingIndex)}
          className='[&_svg]:size-5!'
        >
          <RefreshCw />第 {streamingIndex} 章を再試行
        </Button>
      )}

      {!isGenerating && genStatus !== 'error' && outline !== null && outline.chapters.length >= novel.num_chapters && (
        <GenerateChaptersButton
          hasUndoneChapter={chapters.filter((c) => c.done).length < novel.num_chapters}
          disabled={!editAllowed}
          onOpen={() => setChapterDialogOpen(true)}
        />
      )}

      <OutlineSelectionDialog
        open={outlineDialogOpen}
        onOpenChange={setOutlineDialogOpen}
        totalChapters={novel.num_chapters}
        outline={outline}
        onConfirm={(targets) => {
          if (targets.length > 0) doGenerateOutline(asModelRef(novel.editor_model), targets)
        }}
      />

      <Dialog open={bibleOpen} onOpenChange={handleBibleOpenChange}>
        <DialogContent className='sm:max-w-3xl'>
          <DialogHeader>
            <DialogTitle>作品設計</DialogTitle>
            <DialogDescription>章立てと全章の本文に、同じ作品設計が渡されます。</DialogDescription>
          </DialogHeader>
          {bibleError !== null && <ErrorAlert message={bibleError} />}
          {novel.bible !== null && novel.bible_outdated && <BibleOutdatedNotice />}
          {novel.bible === null ? (
            <div className='space-y-3'>
              <p className='text-sm text-muted-foreground'>
                作品設計はまだありません。章立てを生成すると自動で作られます。
              </p>
              <Button
                type='button'
                size='sm'
                className='[&_svg]:size-5!'
                disabled={bibleBusy !== null || isGenerating || !editAllowed}
                title={!editAllowed ? 'ログインが必要です' : undefined}
                onClick={handleGenerateBible}
              >
                {bibleBusy === 'generating' ? <Loader2 className='animate-spin' /> : <Sparkles />}
                作品設計を生成
              </Button>
            </div>
          ) : bibleMode === 'edit' ? (
            <BibleEditor
              bible={novel.bible}
              saving={bibleBusy === 'saving'}
              onSave={handleSaveBible}
              onCancel={() => {
                setBibleMode('view')
                setBibleError(null)
              }}
            />
          ) : (
            <>
              <div className='max-h-[60vh] overflow-auto pr-1'>
                <BibleView bible={novel.bible} />
              </div>
              <div className='flex flex-wrap justify-end gap-2'>
                <Button
                  type='button'
                  size='sm'
                  variant='outline'
                  className='[&_svg]:size-5!'
                  disabled={bibleBusy !== null || isGenerating || !editAllowed}
                  title={!editAllowed ? 'ログインが必要です' : undefined}
                  onClick={() => {
                    setBibleError(null)
                    setBibleMode('edit')
                  }}
                >
                  <Pencil />
                  編集
                </Button>
                <AlertDialog open={bibleRegenOpen} onOpenChange={setBibleRegenOpen}>
                  <AlertDialogTrigger asChild>
                    <Button
                      type='button'
                      size='sm'
                      variant='outline'
                      className='[&_svg]:size-5!'
                      disabled={bibleBusy !== null || isGenerating || !editAllowed}
                      title={!editAllowed ? 'ログインが必要です' : undefined}
                    >
                      {bibleBusy === 'generating' ? <Loader2 className='animate-spin' /> : <RefreshCw />}
                      作り直す
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>作品設計を作り直しますか？</AlertDialogTitle>
                      <AlertDialogDescription>
                        今の作品設計を破棄して作り直します。章立てと本文は変わりません。
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>キャンセル</AlertDialogCancel>
                      <AlertDialogAction
                        className='[&_svg]:size-5!'
                        onClick={(e) => {
                          e.preventDefault()
                          setBibleRegenOpen(false)
                          handleGenerateBible()
                        }}
                      >
                        <RefreshCw />
                        作り直す
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={promptPreviewOpen} onOpenChange={setPromptPreviewOpen}>
        <DialogContent className='sm:max-w-3xl'>
          <DialogHeader>
            <DialogTitle>章立てを生成するときに Gemini に送るプロンプト</DialogTitle>
            <DialogDescription>そのまま送信しても block されないかを確認するためのプレビューです。</DialogDescription>
          </DialogHeader>
          {promptPreviewLoading && <p className='text-sm text-muted-foreground'>取得中…</p>}
          {!promptPreviewLoading && promptPreview !== null && (
            <pre className='max-h-[60vh] overflow-auto rounded-md border bg-muted/40 p-3 text-xs leading-relaxed whitespace-pre-wrap'>
              {promptPreview}
            </pre>
          )}
        </DialogContent>
      </Dialog>

      {outline !== null && (
        <ChapterSelectionDialog
          open={chapterDialogOpen}
          onOpenChange={setChapterDialogOpen}
          outline={outline}
          chaptersDone={new Set(chapters.filter((c) => c.done).map((c) => c.number))}
          onConfirm={(targets) => {
            if (targets.length > 0) handleStartGeneration(targets, asModelRef(novel.writer_model))
          }}
        />
      )}
    </div>
  )
}

export default function NovelDetailPage() {
  const params = useParams<{ id: string }>()
  if (!params) return null
  const { id } = params
  return (
    <QueryBoundary fallback={<NovelSkeleton />}>
      <NovelDetailContent id={id} />
    </QueryBoundary>
  )
}
