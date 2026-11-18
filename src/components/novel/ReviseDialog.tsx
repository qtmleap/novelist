'use client'

import { PenLine } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import type { ReviewIssue } from '@/schemas/story.dto'

// サーバー (GenerateChapterOptionsSchema.instruction) の上限と同じ。
export const MAX_INSTRUCTION_CHARS = 2000

// 検査の指摘を指示の下書きにする。「「引用」: 理由」の箇条書き。
function draftFromIssues(issues: ReviewIssue[]): string {
  return issues.map((i) => `- 「${i.quote}」: ${i.reason}`).join('\n')
}

type FormProps = {
  chapterNumber: number
  issues: ReviewIssue[]
  disabled: boolean
  onSubmit: (instruction: string) => void
}

// 入力欄。ダイアログが開くたびに作り直されるので (DialogContent は閉じると外れる)、
// 下書きは useState の初期値で渡すだけで済む。開いている間の編集は、再描画で消えない。
function ReviseForm({ chapterNumber, issues, disabled, onSubmit }: FormProps) {
  const [instruction, setInstruction] = useState(() => draftFromIssues(issues))
  // サーバーの上限は文字列の長さ (UTF-16) で数えるので、同じ数え方にする。
  const remaining = MAX_INSTRUCTION_CHARS - instruction.length
  const trimmed = instruction.trim()
  const canSubmit = !disabled && trimmed !== '' && remaining >= 0

  return (
    <>
      <div className='space-y-1.5'>
        <label htmlFor='revise-instruction' className='text-xs font-medium text-muted-foreground'>
          直してほしい点
        </label>
        <Textarea
          id='revise-instruction'
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder={'例:\n- 冒頭で、主人公が手袋をしている描写を足す\n- 第 2 場の会話の呼び方を「先輩」に直す'}
          rows={8}
          className='max-h-[50vh] text-sm'
        />
        <div className='flex flex-wrap items-center justify-between gap-2 text-xs'>
          <span className='text-muted-foreground'>
            {issues.length > 0
              ? `チェックを入れた ${issues.length} 件の指摘を下書きに入れました。自由に書き足せます。`
              : '検査の指摘にチェックを入れてから開くと、下書きが入ります。'}
          </span>
          <span
            className={cn('tabular-nums', remaining < 0 ? 'font-medium text-destructive' : 'text-muted-foreground')}
          >
            残り {remaining.toLocaleString()} 字
          </span>
        </div>
      </div>
      <DialogFooter>
        <DialogClose asChild>
          <Button type='button' variant='ghost'>
            キャンセル
          </Button>
        </DialogClose>
        <Button
          type='button'
          disabled={!canSubmit}
          onClick={() => onSubmit(trimmed)}
          title={trimmed === '' ? '指示を入力してください' : undefined}
          className='[&_svg]:size-5!'
        >
          <PenLine />第 {chapterNumber} 章を書き直す
        </Button>
      </DialogFooter>
    </>
  )
}

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  chapterNumber: number
  // 検査の指摘のうち、書き直しに使うものとして選んだもの。指示の下書きになる。
  issues: ReviewIssue[]
  disabled: boolean
  onSubmit: (instruction: string) => void
}

export function ReviseDialog({ open, onOpenChange, chapterNumber, issues, disabled, onSubmit }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='sm:max-w-2xl'>
        <DialogHeader>
          <DialogTitle>第 {chapterNumber} 章を指示して書き直す</DialogTitle>
          <DialogDescription>指示した点だけを直した新しい版を作ります。元の版は履歴に残ります。</DialogDescription>
        </DialogHeader>
        <ReviseForm chapterNumber={chapterNumber} issues={issues} disabled={disabled} onSubmit={onSubmit} />
      </DialogContent>
    </Dialog>
  )
}
