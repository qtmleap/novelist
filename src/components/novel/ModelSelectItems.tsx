import { SelectItem } from '@/components/ui/select'
import { GEMINI_MODELS, MODEL_PRICING_USD_PER_M_TOKENS } from '@/schemas/novel.dto'

// モデル選択の選択肢。名前の横に 1M トークンあたりの単価 (入力 / 出力、USD) を添える。
export function ModelSelectItems() {
  return GEMINI_MODELS.map((m) => {
    const p = MODEL_PRICING_USD_PER_M_TOKENS[m]
    return (
      <SelectItem key={m} value={m}>
        {m}
        <span className='ml-2 text-xs text-muted-foreground'>
          ${p.input.toFixed(2)} / ${p.output.toFixed(2)}
        </span>
      </SelectItem>
    )
  })
}
