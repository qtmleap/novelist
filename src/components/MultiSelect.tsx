'use client'

import { Check, ChevronsUpDown } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

// Select 風のマルチセレクト。トリガーに選択中をまとめて表示し、ドロップダウンで項目をトグルする。
type Props = {
  options: readonly string[]
  selected: string[]
  onToggle: (option: string) => void
  placeholder?: string
  className?: string
}

export function MultiSelect({ options, selected, onToggle, placeholder = '選択', className }: Props) {
  const [open, setOpen] = useState(false)
  const label = selected.length > 0 ? selected.join('・') : placeholder
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type='button'
          variant='outline'
          role='combobox'
          aria-expanded={open}
          className={cn(
            'h-9 w-full justify-between font-normal',
            selected.length === 0 && 'text-muted-foreground',
            className
          )}
        >
          <span className='truncate'>{label}</span>
          <ChevronsUpDown className='ml-2 size-4 shrink-0 opacity-50' />
        </Button>
      </PopoverTrigger>
      <PopoverContent align='start' className='w-[var(--radix-popover-trigger-width)] p-1'>
        <div className='max-h-60 overflow-auto'>
          {options.map((o) => {
            const active = selected.includes(o)
            return (
              <button
                key={o}
                type='button'
                onClick={() => onToggle(o)}
                className='flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm hover:bg-accent'
              >
                <span>{o}</span>
                {active && <Check className='size-4 text-primary' />}
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
