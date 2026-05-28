'use client'

import { FileWarning } from 'lucide-react'
import { Button } from '@/components/ui/button'

type Props = {
  message: string
  onRetry?: () => void
}

export function ErrorAlert({ message, onRetry }: Props) {
  return (
    <div
      role='alert'
      aria-live='polite'
      className='flex items-start gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive'
    >
      <FileWarning className='mt-0.5 size-5 shrink-0' />
      <div className='flex flex-1 flex-col gap-2'>
        <span>{message}</span>
        {onRetry && (
          <Button
            type='button'
            variant='outline'
            size='sm'
            onClick={onRetry}
            className='w-fit border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive'
          >
            再試行
          </Button>
        )}
      </div>
    </div>
  )
}
