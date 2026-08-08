import { fmtTokens } from '@/lib/novel/format'
import type { ChapterCost } from '@/schemas/novel.dto'

type Props = {
  chars: number
  cost?: ChapterCost
}

// 章詳細・OutlineView・NovelDetail の 3 箇所で複製されていたコストメタ行。
// 文字数 / モデル / 入出力トークン / USD をコンパクトに並べる。
export function ChapterCostMeta({ chars, cost }: Props) {
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
