'use client'

import { Handle, type Node, type NodeProps, Position } from '@xyflow/react'
import { Star, Trash2 } from 'lucide-react'
import { createContext, useContext } from 'react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { CHARACTER_ROLES, type CharacterVariant } from '@/schemas/character.dto'

// React Flow のノード data。キャストの「人物 + その小説での役割 + 使用バリエーション」を持つ。
// variantId は null = ベース (Character 本体)。
export type CharacterNodeData = {
  characterId: string
  name: string
  role: string
  variantId: string | null
}
export type CharacterFlowNode = Node<CharacterNodeData, 'character'>

// Radix Select は空文字 value を許さないので「ベース」を表す番兵値を使う。
const BASE_VARIANT_VALUE = '__base__'

// ノードからグラフ全体の状態・操作へアクセスするためのコンテキスト。
// data に閉じ込めると stale closure になりやすいので、語り手判定とハンドラはここで配る。
type CastGraphActions = {
  narratorId: string
  canChooseNarrator: boolean
  variantsOf: (characterId: string) => CharacterVariant[]
  onRoleChange: (characterId: string, role: string) => void
  onVariantChange: (characterId: string, variantId: string | null) => void
  onToggleNarrator: (characterId: string) => void
  onDelete: (characterId: string) => void
}

export const CastGraphContext = createContext<CastGraphActions | null>(null)

function useCastGraph() {
  const ctx = useContext(CastGraphContext)
  if (ctx === null) throw new Error('CastGraphContext provider が見つかりません')
  return ctx
}

export function CharacterNode({ data }: NodeProps<CharacterFlowNode>) {
  const { narratorId, canChooseNarrator, variantsOf, onRoleChange, onVariantChange, onToggleNarrator, onDelete } =
    useCastGraph()
  const isNarrator = narratorId === data.characterId
  const variants = variantsOf(data.characterId)

  const initial = data.name.length > 0 ? data.name.slice(0, 1) : '?'

  return (
    <div
      className={cn(
        'w-52 overflow-hidden rounded-xl border bg-background shadow-sm transition-shadow hover:shadow-md',
        isNarrator ? 'border-primary ring-1 ring-primary/50' : 'border-border'
      )}
    >
      {/* 接続点はノード中央に 1 つ。connectionMode=loose + 広い connectionRadius により、
          ノードのどこにドロップしてもこの中央ハンドルにスナップして繋がる。 */}
      <Handle
        type='source'
        position={Position.Top}
        className='!top-1/2 !left-1/2 size-3 !-translate-x-1/2 !-translate-y-1/2 border-2 border-background !bg-primary'
      />

      <div className='flex items-center gap-2 px-2.5 pt-2.5 pb-2'>
        <div className='flex size-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-base font-semibold text-primary'>
          {initial}
        </div>
        <div className='min-w-0 flex-1'>
          <div className='truncate text-sm font-semibold leading-tight'>{data.name}</div>
          {isNarrator && <span className='text-xs font-medium text-primary'>語り手</span>}
        </div>
        <div className='flex shrink-0 items-center'>
          {canChooseNarrator && (
            <Button
              type='button'
              variant='ghost'
              size='icon'
              aria-label={isNarrator ? '語り手を解除' : '語り手にする'}
              title={isNarrator ? '語り手' : '語り手にする'}
              className='nodrag size-7 [&_svg]:size-4!'
              onClick={() => onToggleNarrator(data.characterId)}
            >
              <Star className={cn(isNarrator ? 'fill-primary text-primary' : 'text-muted-foreground')} />
            </Button>
          )}
          <Button
            type='button'
            variant='ghost'
            size='icon'
            aria-label='登場人物を削除'
            className='nodrag size-7 text-muted-foreground hover:bg-destructive/10 hover:text-destructive [&_svg]:size-4!'
            onClick={() => onDelete(data.characterId)}
          >
            <Trash2 />
          </Button>
        </div>
      </div>

      <div className='divide-y border-t bg-muted/40'>
        <div className='px-2 py-1.5'>
          <Select value={data.role} onValueChange={(v) => onRoleChange(data.characterId, v)}>
            <SelectTrigger className='nodrag h-7 w-full border-0 bg-transparent text-xs shadow-none focus-visible:ring-0'>
              <SelectValue placeholder='役割を選ぶ（任意）' />
            </SelectTrigger>
            <SelectContent>
              {CHARACTER_ROLES.map((r) => (
                <SelectItem key={r} value={r}>
                  {r}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {variants.length > 0 && (
          <div className='px-2 py-1.5'>
            <Select
              value={data.variantId === null ? BASE_VARIANT_VALUE : data.variantId}
              onValueChange={(v) => onVariantChange(data.characterId, v === BASE_VARIANT_VALUE ? null : v)}
            >
              <SelectTrigger className='nodrag h-7 w-full border-0 bg-transparent text-xs shadow-none focus-visible:ring-0'>
                <SelectValue placeholder='バリエーション' />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={BASE_VARIANT_VALUE}>基本</SelectItem>
                {variants.map((v) => (
                  <SelectItem key={v.id} value={v.id}>
                    {v.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>
    </div>
  )
}
