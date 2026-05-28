'use client'

import { BookMarked } from 'lucide-react'
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
  // novel.num_chapters。1..totalChapters の各枠を出す。
  totalChapters: number
  outline: Outline | null
  onConfirm: (selectedChapters: number[]) => void
}

export function OutlineSelectionDialog({ open, onOpenChange, totalChapters, outline, onConfirm }: Props) {
  const [selected, setSelected] = useState<Set<number>>(new Set())

  useEffect(() => {
    if (!open) return
    const has = new Set((outline?.chapters ?? []).map((c) => c.chapter_number))
    // 既定: outline 未生成の章だけチェック (= 不足ぶんを補う)。
    const missing = Array.from({ length: totalChapters }, (_, i) => i + 1).filter((n) => !has.has(n))
    setSelected(new Set(missing.length > 0 ? missing : Array.from({ length: totalChapters }, (_, i) => i + 1)))
  }, [open, outline, totalChapters])

  const slots = Array.from({ length: totalChapters }, (_, i) => i + 1)
  const outlineByNumber = new Map<number, Outline['chapters'][number]>()
  for (const ch of outline?.chapters ?? []) outlineByNumber.set(ch.chapter_number, ch)

  const toggle = (n: number) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(n)) next.delete(n)
      else next.add(n)
      return next
    })
  }

  const selectAll = () => setSelected(new Set(slots))
  const clearAll = () => setSelected(new Set())
  const selectMissing = () => setSelected(new Set(slots.filter((n) => !outlineByNumber.has(n))))

  const handleConfirm = () => {
    const sorted = Array.from(selected).sort((a, b) => a - b)
    onConfirm(sorted)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>章立てを生成する章を選択</DialogTitle>
          <DialogDescription>
            チェックを入れた章の章立て (タイトル・要約)
            を生成します。既に章立てがある章にチェックを入れると上書きされ、その章の本文も削除されます。
          </DialogDescription>
        </DialogHeader>

        <div className='flex flex-wrap items-center gap-2 border-b pb-2 text-xs'>
          <Button type='button' variant='ghost' size='xs' onClick={selectMissing}>
            未生成のみ
          </Button>
          <Button type='button' variant='ghost' size='xs' onClick={selectAll}>
            全選択
          </Button>
          <Button type='button' variant='ghost' size='xs' onClick={clearAll}>
            全解除
          </Button>
          <span className='ml-auto tabular-nums text-muted-foreground'>
            {selected.size} / {totalChapters} 章
          </span>
        </div>

        <ol className='max-h-80 divide-y overflow-y-auto'>
          {slots.map((n) => {
            const ch = outlineByNumber.get(n)
            const checked = selected.has(n)
            const id = `outline-select-${n}`
            return (
              <li key={n} className='flex items-start gap-3 py-2'>
                <Checkbox id={id} checked={checked} onCheckedChange={() => toggle(n)} className='mt-0.5' />
                <label htmlFor={id} className='min-w-0 flex-1 cursor-pointer'>
                  <p className='font-medium text-sm leading-snug'>
                    第 {n} 章{ch ? `: ${ch.title}` : null}
                    {ch && <span className='ml-2 text-xs font-normal text-muted-foreground'>(章立てあり)</span>}
                  </p>
                  {ch ? (
                    <p className='mt-0.5 line-clamp-2 text-xs leading-relaxed text-muted-foreground'>{ch.summary}</p>
                  ) : (
                    <p className='mt-0.5 text-xs italic leading-relaxed text-muted-foreground/60'>未生成</p>
                  )}
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
            <BookMarked />
            選択した {selected.size} 章の章立てを生成
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
