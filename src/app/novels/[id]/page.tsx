'use client'

import { useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { Copy, Loader2, Pencil, RefreshCw, Sparkles, Users } from 'lucide-react'
import { useParams, useRouter } from 'next/navigation'
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ChapterSelectionDialog } from '@/components/novel/ChapterSelectionDialog'
import { ErrorAlert } from '@/components/novel/ErrorAlert'
import { GenerationStatus } from '@/components/novel/GenerationStatus'
import { NovelSkeleton } from '@/components/novel/NovelSkeleton'
import { OutlineSelectionDialog } from '@/components/novel/OutlineSelectionDialog'
import { OutlineView } from '@/components/novel/OutlineView'
import { PageHeader } from '@/components/PageHeader'
import { QueryBoundary } from '@/components/QueryBoundary'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { canEdit, useAuth } from '@/hooks/useAuth'
import { api, readApiError } from '@/lib/api/client'
import { routes } from '@/lib/routes'
import { subscribeChapterStream } from '@/lib/stream'
import type { ChapterData } from '@/schemas/novel.dto'
import { type Chapter, type ChapterCost, type GeminiModel, GeminiModelSchema, type Outline } from '@/schemas/novel.dto'

function asGeminiModel(model: string): GeminiModel {
  const result = GeminiModelSchema.safeParse(model)
  if (!result.success) throw new Error(`Invalid model: ${model}`)
  return result.data
}

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
  chapters: ChapterData[]
  streamingIndex: number | null
  buffer: string
  genStatus: GenStatus
  genError: string | null
}

type GenAction =
  | { type: 'OUTLINE_START' }
  | { type: 'OUTLINE_OK'; outline: Outline }
  | { type: 'OUTLINE_ERR'; error: string }
  | { type: 'CHAPTERS_REFRESHED'; chapters: ChapterData[] }
  | { type: 'CHAPTER_START'; chapterNumber: number }
  | { type: 'CHAPTER_DELTA'; text: string }
  | { type: 'CHAPTER_DONE'; chapterNumber: number; chapterId: string; title: string }
  | { type: 'CHAPTER_ERR'; error: string }
  | { type: 'CANCEL' }

function genReducer(state: GenState, action: GenAction): GenState {
  switch (action.type) {
    case 'OUTLINE_START':
      return { ...state, genStatus: 'generatingOutline', genError: null }
    case 'OUTLINE_OK':
      return { ...state, genStatus: 'idle', outline: action.outline }
    case 'OUTLINE_ERR':
      return { ...state, genStatus: 'error', genError: action.error }
    case 'CHAPTERS_REFRESHED':
      return { ...state, chapters: action.chapters }
    case 'CHAPTER_START':
      return {
        ...state,
        genStatus: 'generatingChapter',
        streamingIndex: action.chapterNumber,
        buffer: '',
        genError: null
      }
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
      return { ...state, chapters: next, streamingIndex: null, buffer: '', genStatus: 'idle' }
    }
    case 'CHAPTER_ERR':
      return { ...state, genStatus: 'error', genError: action.error, streamingIndex: null, buffer: '' }
    case 'CANCEL':
      return { ...state, genStatus: 'cancelled', streamingIndex: null, buffer: '' }
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
  totalCostUsd
}: {
  chapters: ChapterData[]
  costs: ChapterCost[]
  totalCostUsd: number
}) {
  const totalChars = chapters.reduce((sum, c) => sum + (c.done ? c.content.length : 0), 0)
  if (totalChars === 0 && costs.length === 0) return null
  return (
    <p className='mt-0.5 flex flex-wrap items-baseline gap-x-4 gap-y-0.5 text-sm text-muted-foreground'>
      <span>
        {'文字数 '}
        <span className='tabular-nums'>{totalChars.toLocaleString()}</span>
      </span>
      {costs.length > 0 && (
        <span>
          {'コスト '}
          <span className='tabular-nums'>${totalCostUsd.toFixed(4)} USD</span>
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
      chapters: chaptersFromApi(n.chapters),
      streamingIndex: null,
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
        editor_model: asGeminiModel(novel.editor_model),
        writer_model: asGeminiModel(novel.writer_model),
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
    async (editorModel: GeminiModel, chapters?: number[]): Promise<Outline | null> => {
      dispatch({ type: 'OUTLINE_START' })
      try {
        const body = await api.generateOutline(
          { model: editorModel, chapters: chapters !== undefined ? chapters : [] },
          { params: { id } }
        )
        dispatch({ type: 'OUTLINE_OK', outline: body.outline })
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
    async (chapters: number[], model: GeminiModel) => {
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
    await handleStartGeneration([num], asGeminiModel(novel.writer_model))
  }

  const { outline, chapters, streamingIndex, genStatus, genError } = state
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
            <NovelTotals chapters={chapters} costs={novel.generation_costs} totalCostUsd={novel.total_cost_usd} />
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
        <GenerationStatus currentChapter={currentChapter} totalChapters={totalChapters} onCancel={handleStop} />
      )}

      <OutlineView
        outline={outline}
        isGenerating={genStatus === 'generatingOutline'}
        chapters={chapters}
        costs={novel.generation_costs}
        streamingIndex={streamingIndex}
        novelId={novel.id}
        expectedTotal={novel.num_chapters}
        canEdit={editAllowed}
        onSaveOutline={async (next) => {
          try {
            const res = await api.updateOutline({ outline: next }, { params: { id } })
            dispatch({ type: 'OUTLINE_OK', outline: res.outline })
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
          if (targets.length > 0) doGenerateOutline(asGeminiModel(novel.editor_model), targets)
        }}
      />

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
            if (targets.length > 0) handleStartGeneration(targets, asGeminiModel(novel.writer_model))
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
