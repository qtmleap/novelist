'use client'

import { SelectGroup, SelectItem, SelectLabel } from '@/components/ui/select'
import { useModelCatalog } from '@/hooks/useModelCatalog'
import { formatPrice } from '@/schemas/novel.dto'
import type { AvailableModel } from '@/schemas/provider.dto'

function ModelPriceText({ model }: { model: AvailableModel }) {
  return (
    <span className='ml-2 text-xs text-muted-foreground'>
      {model.price === null ? '単価不明' : formatPrice(model.price)}
    </span>
  )
}

// モデル選択の選択肢。名前の横に 1M トークンあたりの単価 (入力 / 出力、USD) を添える。
// Gemini と OpenAI 互換はグループで分ける。current が一覧に無い (サーバーの /models から消えた、
// 設定が外れた) ときも、選択中の値が空表示にならないよう 1 件足す。
export function ModelSelectItems({ current }: { current?: string }) {
  const { catalog } = useModelCatalog()
  const gemini = catalog.models.filter((m) => m.provider === 'gemini')
  const openai = catalog.models.filter((m) => m.provider === 'openai')
  const missing = current !== undefined && !catalog.models.some((m) => m.ref === current)

  return (
    <>
      <SelectGroup>
        <SelectLabel>Gemini</SelectLabel>
        {gemini.map((m) => (
          <SelectItem key={m.ref} value={m.ref}>
            {m.name}
            <ModelPriceText model={m} />
          </SelectItem>
        ))}
      </SelectGroup>
      {openai.length > 0 && (
        <SelectGroup>
          <SelectLabel>OpenAI 互換</SelectLabel>
          {openai.map((m) => (
            <SelectItem key={m.ref} value={m.ref}>
              {m.name}
              <ModelPriceText model={m} />
            </SelectItem>
          ))}
        </SelectGroup>
      )}
      {missing && (
        <SelectGroup>
          <SelectLabel>一覧にありません</SelectLabel>
          <SelectItem value={current}>{current}</SelectItem>
        </SelectGroup>
      )}
    </>
  )
}
