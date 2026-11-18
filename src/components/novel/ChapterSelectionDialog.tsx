'use client'

import { Sparkles, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import type { Outline } from '@/schemas/novel.dto'

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  outline: Outline
  // 本文がある章の番号。
  chaptersDone: Set<number>
  // 本文はあるが「要再生成」の章の番号。chaptersDone の部分集合。
  chaptersStale: Set<number>
  onConfirm: (selectedChapters: number[]) => void
}

export function ChapterSelectionDialog({ open, onOpenChange, outline, chaptersDone, chaptersStale, onConfirm }: Props) {
  const numbers = outline.chapters.map((c) => c.chapter_number)

  // ダイアログを開くたびに「未生成 + 要再生成」を既定にする。上書きしたい章はチェックを足すだけで済む。
  const [selected, setSelected] = useState<Set<number>>(new Set())
  useEffect(() => {
    if (!open) return
    const todo = outline.chapters
      .map((c) => c.chapter_number)
      .filter((n) => !chaptersDone.has(n) || chaptersStale.has(n))
    setSelected(new Set(todo))
  }, [open, outline.chapters, chaptersDone, chaptersStale])

  const toggle = (n: number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(n)) next.delete(n)
      else next.add(n)
      return next
    })
  }

  const selectAll = () => setSelected(new Set(numbers))
  const clearAll = () => setSelected(new Set())
  const selectUndone = () => setSelected(new Set(numbers.filter((n) => !chaptersDone.has(n))))
  const selectStale = () => setSelected(new Set(numbers.filter((n) => chaptersStale.has(n))))
  // その章から最後までを、今の選択に加える。
  const selectFrom = (from: number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      for (const n of numbers) if (n >= from) next.add(n)
      return next
    })
  }

  // 前の章が欠けた選択は、サーバーが 409 で断る。選んだ最大の章より前に、本文が無く選択にも入っていない章があるとき。
  // 先に気づけるよう、確定を止めて理由を出す。
  const maxSelected = selected.size > 0 ? Math.max(...selected) : 0
  const missingBefore = Array.from({ length: Math.max(maxSelected - 1, 0) }, (_, i) => i + 1).filter(
    (n) => !chaptersDone.has(n) && !selected.has(n)
  )
  const hasMissing = missingBefore.length > 0

  const handleConfirm = () => {
    if (hasMissing) return
    const sorted = Array.from(selected).sort((a, b) => a - b)
    onConfirm(sorted)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-2xl'>
        <DialogHeader>
          <DialogTitle>生成する章を選択</DialogTitle>
          <DialogDescription>
            チェックを入れた章だけ生成・再生成します。既に本文がある章にチェックを入れると上書きされます。
            途中の章を再生成すると、それより後ろの章は要再生成になります。
          </DialogDescription>
        </DialogHeader>

        <div className='flex flex-wrap items-center gap-2 border-b pb-2 text-xs'>
          <Button type='button' variant='ghost' size='xs' onClick={selectUndone}>
            未生成のみ
          </Button>
          <Button type='button' variant='ghost' size='xs' disabled={chaptersStale.size === 0} onClick={selectStale}>
            要再生成のみ
          </Button>
          <Button type='button' variant='ghost' size='xs' onClick={selectAll}>
            全選択
          </Button>
          <Button type='button' variant='ghost' size='xs' onClick={clearAll}>
            全解除
          </Button>
          <span className='ml-auto tabular-nums text-muted-foreground'>
            {selected.size} / {outline.chapters.length} 章
          </span>
        </div>

        <ol className='max-h-80 divide-y overflow-y-auto'>
          {outline.chapters.map((ch) => {
            const n = ch.chapter_number
            const checked = selected.has(n)
            const done = chaptersDone.has(n)
            const stale = done && chaptersStale.has(n)
            const id = `chapter-select-${n}`
            return (
              <li key={n} className='flex items-start gap-3 py-2'>
                <Checkbox id={id} checked={checked} onCheckedChange={() => toggle(n)} className='mt-0.5' />
                <label htmlFor={id} className='min-w-0 flex-1 cursor-pointer'>
                  <p className='flex flex-wrap items-center gap-x-2 gap-y-0.5 font-medium text-sm leading-snug'>
                    <span>
                      第 {n} 章: {ch.title}
                    </span>
                    <span className='text-xs font-normal text-muted-foreground'>{done ? '本文あり' : '未生成'}</span>
                    {stale && (
                      <span className='inline-flex items-center gap-1 text-xs font-normal text-amber-800 dark:text-amber-200'>
                        <TriangleAlert className='size-3.5 shrink-0' aria-hidden='true' />
                        要再生成
                      </span>
                    )}
                  </p>
                  <p className='mt-0.5 text-xs leading-relaxed text-muted-foreground line-clamp-2'>{ch.summary}</p>
                </label>
                <Button
                  type='button'
                  variant='ghost'
                  size='xs'
                  aria-label={`この章以降を選択（第 ${n} 章から最後まで）`}
                  onClick={() => selectFrom(n)}
                  className='shrink-0 text-muted-foreground'
                >
                  この章以降を選択
                </Button>
              </li>
            )
          })}
        </ol>

        {/* live region は常に描画する (中身と同時に差し込むと読み上げられないことがあるため)。 */}
        <div aria-live='polite'>
          {hasMissing && (
            <p className='flex items-start gap-2 text-sm text-amber-800 dark:text-amber-200'>
              <TriangleAlert className='mt-0.5 size-4 shrink-0' aria-hidden='true' />
              <span>
                {missingBefore.map((n) => `第 ${n} 章`).join('、')}の本文がありません。前の章から順に生成してください
              </span>
            </p>
          )}
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button type='button' variant='ghost'>
              キャンセル
            </Button>
          </DialogClose>
          <Button
            type='button'
            disabled={selected.size === 0 || hasMissing}
            onClick={handleConfirm}
            className='[&_svg]:size-5!'
          >
            <Sparkles />
            選択した {selected.size} 章を生成
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
