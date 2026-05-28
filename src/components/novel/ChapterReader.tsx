'use client'

import { RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import type { ChapterCost } from '@/schemas/novel.dto'

export type ChapterData = {
  number: number
  title: string | null
  content: string
  done: boolean
}

type Props = {
  chapters: ChapterData[]
  streamingIndex: number | null
  buffer: string
  autoScroll?: boolean
  costs?: ChapterCost[]
  onRegenerate?: (chapterNumber: number) => void
  isBusy?: boolean
  // 単一章のみ表示する。null なら従来通り全章スタック表示。
  selectedChapter?: number | null
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

function ChapterMeta({ chars, cost }: { chars: number; cost?: ChapterCost }) {
  return (
    <div className='mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground'>
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

function ChapterBlock({
  chapter,
  isStreaming,
  cost,
  onRegenerate,
  canRegenerate,
  regenAllowed,
  registerRef
}: {
  chapter: ChapterData
  isStreaming: boolean
  cost?: ChapterCost
  onRegenerate?: (n: number) => void
  // 一時的な不可 (生成中など)。ボタンは出すが disabled。
  canRegenerate: boolean
  // 構造的な不可 (後続章が生成済み)。ボタン自体を出さない。
  regenAllowed: boolean
  registerRef?: (n: number, el: HTMLDivElement | null) => void
}) {
  const [regenOpen, setRegenOpen] = useState(false)
  const showMeta = chapter.content.length > 0
  const showRegenerate = chapter.done && !isStreaming && onRegenerate !== undefined && regenAllowed

  return (
    <div ref={(el) => registerRef?.(chapter.number, el)}>
      <div className='border-b pb-2 mb-4'>
        <p className='text-xs font-medium uppercase tracking-wider text-muted-foreground'>第 {chapter.number} 章</p>
        <div className='mt-0.5 flex items-start gap-2'>
          {chapter.title && <h2 className='min-w-0 flex-1 text-base font-semibold'>{chapter.title}</h2>}
          {showRegenerate && (
            <AlertDialog open={regenOpen} onOpenChange={setRegenOpen}>
              <Button
                type='button'
                variant='ghost'
                size='icon'
                aria-label={`第 ${chapter.number} 章を再生成`}
                disabled={!canRegenerate}
                onClick={() => setRegenOpen(true)}
                className='size-8 shrink-0 text-muted-foreground hover:text-foreground [&_svg]:size-5!'
              >
                <RefreshCw />
              </Button>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>第 {chapter.number} 章の本文を再生成しますか？</AlertDialogTitle>
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
                      onRegenerate?.(chapter.number)
                    }}
                    className='[&_svg]:size-5!'
                  >
                    <RefreshCw />
                    再生成する
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
        {showMeta && <ChapterMeta chars={chapter.content.length} cost={cost} />}
      </div>
      {!chapter.done && !chapter.content && !isStreaming ? (
        <div className='space-y-2'>
          <Skeleton className='h-4 w-full' />
          <Skeleton className='h-4 w-5/6' />
          <Skeleton className='h-4 w-4/5' />
        </div>
      ) : (
        <p className='text-sm text-foreground/90 leading-relaxed whitespace-pre-wrap'>
          {chapter.content}
          {isStreaming && (
            <span
              aria-hidden='true'
              className='ml-0.5 inline-block h-4 w-0.5 animate-pulse rounded-full bg-primary align-middle'
            />
          )}
        </p>
      )}
    </div>
  )
}

export function ChapterReader({
  chapters,
  streamingIndex,
  buffer,
  autoScroll = true,
  costs,
  onRegenerate,
  isBusy = false,
  selectedChapter = null
}: Props) {
  // 章ごとの DOM 参照を保持。再生成時にその章ヘッダを画面上端付近にスクロールするため。
  const chapterRefs = useRef<Map<number, HTMLDivElement>>(new Map())

  const registerRef = useCallback((n: number, el: HTMLDivElement | null) => {
    if (el) chapterRefs.current.set(n, el)
    else chapterRefs.current.delete(n)
  }, [])

  // 生成中の章に切り替わったタイミングで、その章を画面に入れる。bottom 全体ではなく該当章にフォーカス。
  useEffect(() => {
    if (!autoScroll || streamingIndex === null) return
    const el = chapterRefs.current.get(streamingIndex)
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [streamingIndex, autoScroll])

  if (chapters.length === 0 && streamingIndex === null) return null

  const costByNumber = new Map<number, ChapterCost>()
  for (const c of costs ?? []) costByNumber.set(c.chapter_number, c)

  let displayChapters: ChapterData[] = [...chapters]
  if (streamingIndex !== null) {
    const alreadyIn = displayChapters.some((c) => c.number === streamingIndex)
    if (!alreadyIn) {
      displayChapters.push({ number: streamingIndex, title: null, content: buffer, done: false })
    } else {
      const idx = displayChapters.findIndex((c) => c.number === streamingIndex)
      if (idx !== -1) {
        displayChapters[idx] = { ...displayChapters[idx], content: buffer, done: false }
      }
    }
  }
  if (selectedChapter !== null) {
    displayChapters = displayChapters.filter((c) => c.number === selectedChapter)
  }

  // 後続の章が生成済みなら、その手前の章は再生成不可。
  // ベースは displayChapters ではなく chapters 全体 (selectedChapter 時の不正解判定を避ける) から見る。
  const maxDoneNumber = chapters.reduce((acc, c) => (c.done && c.number > acc ? c.number : acc), 0)

  return (
    <div className='space-y-8'>
      {displayChapters.map((ch) => (
        <ChapterBlock
          key={ch.number}
          chapter={ch}
          isStreaming={streamingIndex === ch.number}
          cost={costByNumber.get(ch.number)}
          onRegenerate={onRegenerate}
          canRegenerate={!isBusy}
          regenAllowed={ch.number >= maxDoneNumber}
          registerRef={registerRef}
        />
      ))}
    </div>
  )
}
