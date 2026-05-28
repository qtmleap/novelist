'use client'

import { Sparkles } from 'lucide-react'
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
  chaptersDone: Set<number>
  onConfirm: (selectedChapters: number[]) => void
}

export function ChapterSelectionDialog({ open, onOpenChange, outline, chaptersDone, onConfirm }: Props) {
  // ダイアログ open のたびに「未生成のみ」を既定にする。再生成したい章はチェックを足すだけで済む。
  const [selected, setSelected] = useState<Set<number>>(new Set())
  useEffect(() => {
    if (!open) return
    const undone = outline.chapters.map((c) => c.chapter_number).filter((n) => !chaptersDone.has(n))
    setSelected(new Set(undone))
  }, [open, outline.chapters, chaptersDone])

  const toggle = (n: number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(n)) next.delete(n)
      else next.add(n)
      return next
    })
  }

  const selectAll = () => setSelected(new Set(outline.chapters.map((c) => c.chapter_number)))
  const clearAll = () => setSelected(new Set())
  const selectUndone = () =>
    setSelected(new Set(outline.chapters.map((c) => c.chapter_number).filter((n) => !chaptersDone.has(n))))

  const handleConfirm = () => {
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
          </DialogDescription>
        </DialogHeader>

        <div className='flex flex-wrap items-center gap-2 border-b pb-2 text-xs'>
          <Button type='button' variant='ghost' size='xs' onClick={selectUndone}>
            未生成のみ
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
            const checked = selected.has(ch.chapter_number)
            const id = `chapter-select-${ch.chapter_number}`
            return (
              <li key={ch.chapter_number} className='flex items-start gap-3 py-2'>
                <Checkbox
                  id={id}
                  checked={checked}
                  onCheckedChange={() => toggle(ch.chapter_number)}
                  className='mt-0.5'
                />
                <label htmlFor={id} className='min-w-0 flex-1 cursor-pointer'>
                  <p className='font-medium text-sm leading-snug'>
                    第 {ch.chapter_number} 章: {ch.title}
                  </p>
                  <p className='mt-0.5 text-xs leading-relaxed text-muted-foreground line-clamp-2'>{ch.summary}</p>
                </label>
              </li>
            )
          })}
        </ol>

        <DialogFooter>
          <DialogClose asChild>
            <Button type='button' variant='ghost'>
              キャンセル
            </Button>
          </DialogClose>
          <Button type='button' disabled={selected.size === 0} onClick={handleConfirm} className='[&_svg]:size-5!'>
            <Sparkles />
            選択した {selected.size} 章を生成
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
