'use client'

import { ListChecks, TriangleAlert } from 'lucide-react'
import { useId } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { withKeys } from '@/lib/keys'
import type { ChapterReview, ReviewIssueKind } from '@/schemas/story.dto'

// 検査の指摘の種別の表示名。章ページと履歴の両方で使う。
export const REVIEW_ISSUE_LABELS: Record<ReviewIssueKind, string> = {
  setting: '設定',
  fact: '既出の事実',
  address: '呼び方',
  timeline: '時系列',
  thread: '伏線',
  presence: '人物の居場所・知識',
  other: 'その他'
}

// 成人指定の作品の本文に、未成年を指す語がある (minor_term)。この警告が出ている章は、書き直しの元の版に語があるので、
// どんな指示でもサーバーが断る。書き直しでは直せないので、章を再生成してもらう。
export const MINOR_TERM_NOTE = 'この警告は書き直しでは直せません。章を再生成してください。'

export function hasMinorTermWarning(review: ChapterReview | null): boolean {
  return review?.checks.some((c) => c.kind === 'minor_term') === true
}

// 警告の件数 (機械的な検査 + 内容の指摘)。review が無い (未検査) 章は 0。
export function reviewWarningCount(review: ChapterReview | null): number {
  return review === null ? 0 : review.checks.length + review.issues.length
}

type Props = {
  review: ChapterReview
  // 書き直しに使う指摘の選択 (review.issues の添字)。onToggleIssue を渡したときだけチェックボックスを出す。
  selectedIssues?: ReadonlySet<number>
  onToggleIssue?: (index: number) => void
  // チェックボックスを触れないとき (生成中など)。
  disabled?: boolean
}

// 書き上がった章の検査の結果。「要再生成」の注意 (amber の塗り) より控えめに、枠だけの体裁にしている。
// 検査はモデルの判断を含み誤りがありうるので、そのことを箱の中に添える。
export function ChapterReviewView({ review, selectedIssues, onToggleIssue, disabled = false }: Props) {
  const uid = useId()
  const total = review.checks.length + review.issues.length

  if (total === 0) {
    return (
      <p className='text-xs text-muted-foreground'>
        {review.reviewed
          ? '検査で問題は見つかりませんでした'
          : '機械的な検査で問題は見つかりませんでした（内容の検査は未実行）'}
      </p>
    )
  }

  return (
    <details open className='rounded-md border px-4 py-3 text-sm'>
      <summary className='flex w-fit cursor-pointer select-none items-center gap-2 font-medium'>
        <ListChecks className='size-4 shrink-0 text-muted-foreground' aria-hidden='true' />
        検査の結果（<span className='tabular-nums'>{total}</span> 件）
      </summary>
      <div className='mt-3 space-y-4'>
        <p className='text-xs text-muted-foreground'>検査は AI による判定で、誤りを含むことがあります</p>

        {review.issues.length > 0 && (
          <section className='space-y-1.5'>
            <h3 className='text-xs font-medium text-muted-foreground'>内容の矛盾</h3>
            <ul className='space-y-2.5'>
              {withKeys(review.issues, (i) => `${i.kind}:${i.quote}`).map(({ key, item, index }) => {
                const id = `${uid}-issue-${index}`
                const label = REVIEW_ISSUE_LABELS[item.kind]
                return (
                  <li key={key} className='flex items-start gap-3'>
                    {onToggleIssue !== undefined && (
                      <Checkbox
                        id={id}
                        checked={selectedIssues?.has(index) === true}
                        onCheckedChange={() => onToggleIssue(index)}
                        disabled={disabled}
                        aria-label={`書き直しに使う: ${label}の指摘`}
                        className='mt-0.5'
                      />
                    )}
                    <label htmlFor={onToggleIssue !== undefined ? id : undefined} className='min-w-0 flex-1 space-y-1'>
                      <span className='block text-xs font-medium text-muted-foreground'>{label}</span>
                      <span className='block whitespace-pre-wrap border-l-2 border-muted-foreground/30 pl-3 leading-relaxed text-foreground/80'>
                        {item.quote}
                      </span>
                      <span className='block leading-relaxed'>{item.reason}</span>
                    </label>
                  </li>
                )
              })}
            </ul>
          </section>
        )}

        {review.checks.length > 0 && (
          <section className='space-y-1.5'>
            <h3 className='text-xs font-medium text-muted-foreground'>機械的な検査</h3>
            <ul className='list-disc space-y-0.5 pl-5'>
              {withKeys(review.checks, (c) => `${c.kind}:${c.message}`).map(({ key, item }) => (
                <li key={key}>
                  {item.message}
                  {item.kind === 'minor_term' && (
                    <span className='mt-0.5 flex items-start gap-1.5 text-xs text-amber-800 dark:text-amber-200'>
                      <TriangleAlert className='mt-px size-3.5 shrink-0' aria-hidden='true' />
                      {MINOR_TERM_NOTE}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </details>
  )
}
