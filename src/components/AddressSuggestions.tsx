'use client'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { ADDRESS_STYLES } from '@/schemas/character.dto'

// 呼び方の候補チップ。入力欄 (自由入力) の下に並べ、クリックでその値を入れる。
// ネイティブ datalist だと OS 標準の見た目で浮くので、shadcn 風のチップにそろえる。
export function AddressSuggestions({ value, onPick }: { value: string; onPick: (v: string) => void }) {
  return (
    <div className='flex flex-wrap gap-1'>
      {ADDRESS_STYLES.map((s) => {
        const active = value === s
        return (
          <Button
            key={s}
            type='button'
            size='sm'
            variant={active ? 'default' : 'outline'}
            onClick={() => onPick(s)}
            className={cn('h-6 rounded-full px-2.5 text-[11px] font-medium', !active && 'text-muted-foreground')}
          >
            {s}
          </Button>
        )
      })}
    </div>
  )
}
