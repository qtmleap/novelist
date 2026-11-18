'use client'

import { TriangleAlert, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { OutlineWarning } from '@/schemas/story.dto'

type Props = {
  warnings: OutlineWarning[]
  onDismiss: () => void
}

// 章立ての生成・保存で出た確認事項。失敗ではなく「結果は保存したが利用者の目で確かめてほしい点」なので、
// ErrorAlert (destructive) と区別して注意の色にする。色だけに頼らず、アイコンと見出しの文言でも伝える。
//
// live region (role='status') は中身と同時に差し込まれると読み上げられないことがある。
// 外側の要素は警告が無くても常に描画し、そのときだけ sr-only (position: absolute) にしてレイアウトから外す。
// 親の space-y は兄弟の margin だけを触り、absolute の子は余白に寄与しないので、空のときに余白は増えない。
export function OutlineWarnings({ warnings, onDismiss }: Props) {
  const hasWarnings = warnings.length > 0
  return (
    <div
      role='status'
      aria-live='polite'
      className={cn(
        hasWarnings
          ? 'flex items-start gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-800 dark:text-amber-200'
          : 'sr-only'
      )}
    >
      {hasWarnings && (
        <>
          <TriangleAlert className='mt-0.5 size-5 shrink-0' aria-hidden='true' />
          <div className='min-w-0 flex-1 space-y-1.5'>
            <p className='font-medium'>章立ての確認事項（{warnings.length} 件）</p>
            <ul className='list-disc space-y-0.5 pl-5'>
              {warnings.map((w) => (
                // 警告は章・種別・文面で一意 (サーバーは人物名ごとに 1 件ずつ出す)。配列の添字はキーにしない。
                <li key={`${w.chapter_number}-${w.kind}-${w.message}`}>{w.message}</li>
              ))}
            </ul>
          </div>
          <Button
            type='button'
            variant='ghost'
            size='icon'
            aria-label='閉じる'
            onClick={onDismiss}
            className='-mt-1.5 -mr-2 size-8 shrink-0 text-amber-800 hover:bg-amber-500/20 hover:text-amber-800 dark:text-amber-200 dark:hover:text-amber-200'
          >
            <X className='size-4' />
          </Button>
        </>
      )}
    </div>
  )
}
