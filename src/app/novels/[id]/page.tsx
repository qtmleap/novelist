'use client'

import { Pencil, RefreshCw, Sparkles } from 'lucide-react'
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { ChapterData } from '@/components/novel/ChapterReader'
import { ChapterReader } from '@/components/novel/ChapterReader'
import { ChapterSelectionDialog } from '@/components/novel/ChapterSelectionDialog'
import { ErrorAlert } from '@/components/novel/ErrorAlert'
import { GenerationStatus } from '@/components/novel/GenerationStatus'
import { NovelSkeleton } from '@/components/novel/NovelSkeleton'
import { OutlineView } from '@/components/novel/OutlineView'
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

function StartGenerationButton({
  hasOutline,
  chaptersDone,
  totalChapters,
  status,
  onStart
}: {
  hasOutline: boolean
  chaptersDone: number
  totalChapters: number
  status: Status
  onStart: () => void
}) {
  // 章数 0 (= novel ロード未完) や 全章生成済み のときは何も出さない。
  const allDone = hasOutline && totalChapters > 0 && chaptersDone >= totalChapters
  if (allDone) return null

  let label: string
  let Icon: typeof Sparkles
  if (!hasOutline) {
    label = '章立てを生成'
    Icon = Sparkles
  } else if (status === 'cancelled') {
    label = '続きから再開'
    Icon = RefreshCw
  } else {
    label = '本文を生成'
    Icon = Sparkles
  }

  return (
    <Button type='button' size='sm' className='[&_svg]:size-5!' onClick={onStart}>
      <Icon />
      {label}
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
  const [outlineRegenOpen, setOutlineRegenOpen] = useState(false)
  const [chapterPickerOpen, setChapterPickerOpen] = useState(false)
  const [regeneratingOutlineChapter, setRegeneratingOutlineChapter] = useState<number | null>(null)
  // 章リストから「読みたい章」を選んで本文を表示する。デフォルトは未選択 (本文非表示)。
  const [selectedChapter, setSelectedChapter] = useState<number | null>(null)

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

  const doGenerateOutline = useCallback(async (id: string): Promise<Outline | null> => {
    dispatch({ type: 'OUTLINE_START' })
    try {
      const res = await api.novels[':id'].outline.$post({
        param: { id },
        json: { model: getEditorModel() }
      })
      if (!res.ok) throw new Error(await readApiError(res))
      const body = (await res.json()) as { outline: Outline }
      dispatch({ type: 'OUTLINE_OK', outline: body.outline })
      return body.outline
    } catch (e) {
      dispatch({ type: 'OUTLINE_ERR', error: e instanceof Error ? e.message : '章立て生成に失敗しました' })
      return null
    }
  }, [])

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

  const handleRegenerateOutline = async () => {
    const id = novelIdRef.current
    if (!id) return
    setOutlineRegenOpen(false)
    await doGenerateOutline(id)
  }

  const handleRegenerateOutlineChapter = async (num: number) => {
    const id = novelIdRef.current
    if (!id) return
    setRegeneratingOutlineChapter(num)
    try {
      const res = await api.novels[':id'].outline[':number'].$post({
        param: { id, number: String(num) },
        json: { model: getEditorModel() }
      })
      if (!res.ok) throw new Error(await readApiError(res))
      const body = (await res.json()) as { outline: Outline }
      dispatch({ type: 'OUTLINE_OK', outline: body.outline })
    } catch (e) {
      dispatch({ type: 'OUTLINE_ERR', error: e instanceof Error ? e.message : '章立ての再生成に失敗しました' })
    } finally {
      setRegeneratingOutlineChapter(null)
    }
  }

  const isGenerating = state.status === 'generatingOutline' || state.status === 'generatingChapter'
  const { novel, outline, chapters, streamingIndex, buffer, status, error } = state

  // 生成中の章は強制的に表示対象にする (見えないところで進捗が走るのを避ける)。
  useEffect(() => {
    if (streamingIndex !== null) setSelectedChapter(streamingIndex)
  }, [streamingIndex])
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
          </div>
          <Button asChild size='sm' variant='outline' className='[&_svg]:size-5!'>
            <a href={`/novels/${novel.id}/edit`}>
              <Pencil />
              編集
            </a>
          </Button>
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

      {(outline || status === 'generatingOutline') && (
        <OutlineView
          outline={outline}
          isGenerating={status === 'generatingOutline'}
          onRegenerateChapter={handleRegenerateOutlineChapter}
          regeneratingChapter={regeneratingOutlineChapter}
          isBusy={isGenerating || regeneratingOutlineChapter !== null}
          chapters={chapters}
          costs={novel?.generation_costs ?? []}
          streamingIndex={streamingIndex}
          selectedChapter={selectedChapter}
          onSelectChapter={setSelectedChapter}
          regenerateSlot={
            outline && !isGenerating ? (
              <AlertDialog open={outlineRegenOpen} onOpenChange={setOutlineRegenOpen}>
                <AlertDialogTrigger asChild>
                  <Button type='button' variant='ghost' size='sm' className='[&_svg]:size-5!'>
                    <RefreshCw />
                    章立てを再生成
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>章立てを再生成しますか？</AlertDialogTitle>
                    <AlertDialogDescription>
                      章立てを上書きします。既存の本文はそのまま残りますが、新しい章立てとタイトル・要約がずれる可能性があります。
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>キャンセル</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={(e) => {
                        e.preventDefault()
                        handleRegenerateOutline()
                      }}
                      className='[&_svg]:size-5!'
                    >
                      <RefreshCw />
                      再生成する
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            ) : null
          }
        />
      )}

      {selectedChapter !== null &&
        (chapters.some((c) => c.number === selectedChapter) || streamingIndex === selectedChapter) && (
          <div className='space-y-3'>
            <p className='text-xs font-medium uppercase tracking-wider text-muted-foreground'>本文</p>
            <ChapterReader
              chapters={chapters}
              streamingIndex={streamingIndex}
              buffer={buffer}
              costs={novel?.generation_costs ?? []}
              onRegenerate={handleRetryChapter}
              isBusy={isGenerating}
              selectedChapter={selectedChapter}
            />
          </div>
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

      {novel && !isGenerating && status !== 'loading' && status !== 'error' && (
        <StartGenerationButton
          hasOutline={outline !== null}
          chaptersDone={chapters.filter((c) => c.done).length}
          totalChapters={totalChapters}
          status={status}
          onStart={() => {
            const id = novelIdRef.current
            if (!id) return
            if (!outline) {
              // 章立て生成だけ走らせて止める。本文生成は別ボタンで明示的に開始する。
              doGenerateOutline(id)
            } else {
              setChapterPickerOpen(true)
            }
          }}
        />
      )}

      {outline && (
        <ChapterSelectionDialog
          open={chapterPickerOpen}
          onOpenChange={setChapterPickerOpen}
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
