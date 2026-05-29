'use client'

import { Loader2, Pencil, RefreshCw, Sparkles } from 'lucide-react'
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { ChapterData } from '@/components/novel/ChapterReader'
import { ChapterSelectionDialog } from '@/components/novel/ChapterSelectionDialog'
import { ErrorAlert } from '@/components/novel/ErrorAlert'
import { GenerationStatus } from '@/components/novel/GenerationStatus'
import { NovelSkeleton } from '@/components/novel/NovelSkeleton'
import { OutlineSelectionDialog } from '@/components/novel/OutlineSelectionDialog'
import { OutlineView } from '@/components/novel/OutlineView'
import { PageHeader } from '@/components/PageHeader'
import { Button } from '@/components/ui/button'
import { api, readApiError } from '@/lib/api/client'
import { getEditorModel, getWriterModel } from '@/lib/settings'
import { readChapterStream } from '@/lib/stream'
import {
  type Chapter,
  type ChapterCost,
  type NovelWithChapters,
  type Outline,
  OutlineSchema
} from '@/schemas/novel.dto'

// Module-level helpers (never recreated, safe as effect deps)

function getNovelId(): string {
  if (typeof window === 'undefined') return ''
  const parts = window.location.pathname.split('/')
  const idx = parts.indexOf('novels')
  return idx !== -1 ? (parts[idx + 1] ?? '') : ''
}

function parseOutline(raw: string | null): Outline | null {
  if (!raw) return null
  try {
    const parsed = OutlineSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function chaptersFromApi(apiChapters: Chapter[]): ChapterData[] {
  return apiChapters.map((c) => ({
    number: c.chapter_number,
    title: c.title,
    content: c.content,
    done: true
  }))
}

type Status = 'idle' | 'loading' | 'generatingOutline' | 'generatingChapter' | 'cancelled' | 'error'

type State = {
  novel: NovelWithChapters | null
  outline: Outline | null
  chapters: ChapterData[]
  streamingIndex: number | null
  buffer: string
  status: Status
  error: string | null
}

type Action =
  | { type: 'LOAD_START' }
  | { type: 'LOAD_OK'; novel: NovelWithChapters; outline: Outline | null }
  | { type: 'LOAD_ERR'; error: string }
  | { type: 'OUTLINE_START' }
  | { type: 'OUTLINE_OK'; outline: Outline }
  | { type: 'OUTLINE_ERR'; error: string }
  | { type: 'CHAPTER_START'; chapterNumber: number }
  | { type: 'CHAPTER_DELTA'; text: string }
  | { type: 'CHAPTER_DONE'; chapterNumber: number; chapterId: string; title: string }
  | { type: 'CHAPTER_ERR'; error: string }
  | { type: 'CANCEL' }
  | { type: 'RETRY_CLEAR' }

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'LOAD_START':
      return { ...state, status: 'loading', error: null }
    case 'LOAD_OK':
      return {
        ...state,
        status: 'idle',
        novel: action.novel,
        outline: action.outline,
        chapters: chaptersFromApi(action.novel.chapters)
      }
    case 'LOAD_ERR':
      return { ...state, status: 'error', error: action.error }
    case 'OUTLINE_START':
      return { ...state, status: 'generatingOutline', error: null }
    case 'OUTLINE_OK':
      return { ...state, status: 'idle', outline: action.outline }
    case 'OUTLINE_ERR':
      return { ...state, status: 'error', error: action.error }
    case 'CHAPTER_START':
      return { ...state, status: 'generatingChapter', streamingIndex: action.chapterNumber, buffer: '', error: null }
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
      return { ...state, chapters: next, streamingIndex: null, buffer: '', status: 'idle' }
    }
    case 'CHAPTER_ERR':
      return { ...state, status: 'error', error: action.error, streamingIndex: null, buffer: '' }
    case 'CANCEL':
      return { ...state, status: 'cancelled', streamingIndex: null, buffer: '' }
    case 'RETRY_CLEAR':
      return { ...state, status: 'idle', error: null }
    default:
      return state
  }
}

const INITIAL: State = {
  novel: null,
  outline: null,
  chapters: [],
  streamingIndex: null,
  buffer: '',
  status: 'loading',
  error: null
}

function GenerateChaptersButton({
  hasUndoneChapter,
  onOpen
}: {
  // 章立てが完成済み (全章ぶんある) かつ未生成の本文が残っているときだけ出す。
  hasUndoneChapter: boolean
  onOpen: () => void
}) {
  if (!hasUndoneChapter) return null
  return (
    <Button type='button' size='sm' className='[&_svg]:size-5!' onClick={onOpen}>
      <Sparkles />
      本文を生成
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
    <div className='border-t pt-3'>
      <p className='text-xs font-medium uppercase tracking-wider text-muted-foreground'>全体の合計</p>
      <div className='mt-1 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm'>
        <span>
          <span className='text-muted-foreground'>文字数 </span>
          <span className='font-medium tabular-nums'>{totalChars.toLocaleString()}</span>
        </span>
        {costs.length > 0 && (
          <span>
            <span className='text-muted-foreground'>コスト </span>
            <span className='font-medium tabular-nums'>${totalCostUsd.toFixed(4)} USD</span>
          </span>
        )}
      </div>
    </div>
  )
}

export default function NovelDetailPage() {
  const [state, dispatch] = useReducer(reducer, INITIAL)
  const abortRef = useRef<AbortController | null>(null)
  const novelIdRef = useRef<string | null>(null)
  const [outlineDialogOpen, setOutlineDialogOpen] = useState(false)
  const [chapterDialogOpen, setChapterDialogOpen] = useState(false)
  const loadNovel = useCallback(async (id: string) => {
    dispatch({ type: 'LOAD_START' })
    try {
      const res = await api.novels[':id'].$get({ param: { id } })
      if (!res.ok) throw new Error(await readApiError(res))
      const novel = (await res.json()) as NovelWithChapters
      const outline = parseOutline(novel.outline)
      dispatch({ type: 'LOAD_OK', novel, outline })
      return { novel, outline }
    } catch (e) {
      dispatch({ type: 'LOAD_ERR', error: e instanceof Error ? e.message : '小説の取得に失敗しました' })
      return null
    }
  }, [])

  const doGenerateOutline = useCallback(
    async (id: string, chapters?: number[]): Promise<Outline | null> => {
      dispatch({ type: 'OUTLINE_START' })
      try {
        const res = await api.novels[':id'].outline.$post({
          param: { id },
          json: { model: getEditorModel(), ...(chapters ? { chapters } : {}) }
        })
        if (!res.ok) throw new Error(await readApiError(res))
        const body = (await res.json()) as { outline: Outline }
        dispatch({ type: 'OUTLINE_OK', outline: body.outline })
        // chapters[] 指定の部分再生成では、対象章の本文も server 側で消えるので novel 全体を取り直す。
        await loadNovel(id)
        return body.outline
      } catch (e) {
        dispatch({ type: 'OUTLINE_ERR', error: e instanceof Error ? e.message : '章立て生成に失敗しました' })
        return null
      }
    },
    [loadNovel]
  )

  const doGenerateChapter = useCallback(async (id: string, num: number, abort: AbortController): Promise<boolean> => {
    dispatch({ type: 'CHAPTER_START', chapterNumber: num })
    try {
      // SSE エンドポイントは Response を直接読むので、hc にはオプション形だけ渡す。
      const res = await api.novels[':id'].chapters[':number'].generate.$post(
        {
          param: { id, number: String(num) },
          json: { model: getWriterModel() }
        },
        { init: { signal: abort.signal } }
      )
      if (!res.ok) throw new Error(await readApiError(res))
      let ok = false
      await readChapterStream(res, {
        onDelta: (text) => dispatch({ type: 'CHAPTER_DELTA', text }),
        onDone: ({ chapterId, title }) => {
          dispatch({ type: 'CHAPTER_DONE', chapterNumber: num, chapterId, title })
          ok = true
        },
        onError: (msg) => dispatch({ type: 'CHAPTER_ERR', error: msg })
      })
      return ok
    } catch (e) {
      if ((e as { name?: string }).name === 'AbortError') {
        dispatch({ type: 'CANCEL' })
        return false
      }
      dispatch({ type: 'CHAPTER_ERR', error: e instanceof Error ? e.message : `第 ${num} 章の生成に失敗しました` })
      return false
    }
  }, [])

  // 章リストを順番に流す。章立て生成は別フロー (doGenerateOutline) なのでここでは扱わない —
  // 章立て生成直後の自動本文生成を避けるため、ボタン側で 2 段階に分けている。
  const runGeneration = useCallback(
    async (id: string, chapterNumbers: number[]) => {
      if (chapterNumbers.length === 0) return
      const abort = new AbortController()
      abortRef.current = abort

      for (const n of chapterNumbers) {
        if (abort.signal.aborted) break
        const succeeded = await doGenerateChapter(id, n, abort)
        if (!succeeded || abort.signal.aborted) break
      }

      if (!abort.signal.aborted) dispatch({ type: 'CANCEL' })
    },
    [doGenerateChapter]
  )

  // Mount effect — runs once. 生成は明示的なボタン操作からのみ開始する (新規作成直後の自動実行は無し)。
  useEffect(() => {
    const id = getNovelId()
    if (!id) return
    novelIdRef.current = id
    loadNovel(id)

    return () => {
      abortRef.current?.abort()
    }
  }, [loadNovel])

  const handleCancel = () => {
    abortRef.current?.abort()
    dispatch({ type: 'CANCEL' })
  }

  const handleRetryChapter = async (num: number) => {
    const id = novelIdRef.current
    if (!id) return
    dispatch({ type: 'RETRY_CLEAR' })
    const abort = new AbortController()
    abortRef.current = abort
    await doGenerateChapter(id, num, abort)
  }

  const isGenerating = state.status === 'generatingOutline' || state.status === 'generatingChapter'
  const { novel, outline, chapters, streamingIndex, status, error } = state
  const totalChapters = outline ? outline.chapters.length : (novel?.num_chapters ?? 0)
  const currentChapter = streamingIndex ?? chapters.filter((c) => c.done).length + 1

  return (
    <div className='space-y-6'>
      <PageHeader crumbs={[{ label: '小説一覧', href: '/novels' }, { label: novel?.title ?? '詳細' }]} />

      {novel && (
        <div className='flex items-start justify-between gap-3'>
          <div className='min-w-0'>
            <p className='text-xs font-medium uppercase tracking-wider text-muted-foreground'>{novel.genre}</p>
            <h1 className='mt-1 text-xl font-semibold'>{novel.title}</h1>
            <p className='mt-0.5 text-sm text-muted-foreground'>
              <span className='tabular-nums'>{chapters.filter((c) => c.done).length}</span>
              {' / '}
              <span className='tabular-nums'>{novel.num_chapters}</span>
              {' 章 生成済み'}
            </p>
          </div>
          <div className='flex shrink-0 items-center gap-2'>
            {status !== 'loading' && (
              <Button
                type='button'
                size='sm'
                variant={outline && outline.chapters.length >= novel.num_chapters ? 'outline' : 'default'}
                disabled={isGenerating}
                className='[&_svg]:size-5!'
                onClick={() => setOutlineDialogOpen(true)}
              >
                {status === 'generatingOutline' ? (
                  <Loader2 className='animate-spin' />
                ) : outline && outline.chapters.length >= novel.num_chapters ? (
                  <RefreshCw />
                ) : (
                  <Sparkles />
                )}
                {outline && outline.chapters.length >= novel.num_chapters ? '章立てを再生成' : '章立てを生成'}
              </Button>
            )}
            <Button asChild size='sm' variant='outline' className='[&_svg]:size-5!'>
              <a href={`/novels/${novel.id}/edit`}>
                <Pencil />
                編集
              </a>
            </Button>
          </div>
        </div>
      )}

      {status === 'loading' && <NovelSkeleton />}

      {status === 'error' && error && (
        <ErrorAlert
          message={error}
          onRetry={() => {
            const id = novelIdRef.current
            if (id) loadNovel(id)
          }}
        />
      )}

      {isGenerating && (
        <GenerationStatus
          currentChapter={streamingIndex ?? currentChapter}
          totalChapters={totalChapters}
          onCancel={handleCancel}
        />
      )}

      {novel && (
        <OutlineView
          outline={outline}
          isGenerating={status === 'generatingOutline'}
          isBusy={isGenerating}
          chapters={chapters}
          costs={novel.generation_costs ?? []}
          streamingIndex={streamingIndex}
          novelId={novel.id}
          expectedTotal={novel.num_chapters}
        />
      )}

      {status === 'error' && streamingIndex !== null && (
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

      {novel &&
        !isGenerating &&
        status !== 'loading' &&
        status !== 'error' &&
        outline &&
        outline.chapters.length >= novel.num_chapters && (
          <GenerateChaptersButton
            hasUndoneChapter={chapters.filter((c) => c.done).length < novel.num_chapters}
            onOpen={() => setChapterDialogOpen(true)}
          />
        )}

      {novel && (
        <OutlineSelectionDialog
          open={outlineDialogOpen}
          onOpenChange={setOutlineDialogOpen}
          totalChapters={novel.num_chapters}
          outline={outline}
          onConfirm={(targets) => {
            const id = novelIdRef.current
            if (id && targets.length > 0) doGenerateOutline(id, targets)
          }}
        />
      )}

      {novel && outline && (
        <ChapterSelectionDialog
          open={chapterDialogOpen}
          onOpenChange={setChapterDialogOpen}
          outline={outline}
          chaptersDone={new Set(chapters.filter((c) => c.done).map((c) => c.number))}
          onConfirm={(targets) => {
            const id = novelIdRef.current
            if (id && targets.length > 0) runGeneration(id, targets)
          }}
        />
      )}

      {novel && !isGenerating && (
        <NovelTotals
          chapters={chapters}
          costs={novel.generation_costs ?? []}
          totalCostUsd={novel.total_cost_usd ?? 0}
        />
      )}
    </div>
  )
}
