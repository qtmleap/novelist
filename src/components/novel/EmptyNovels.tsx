import { BookOpen, SquarePen } from 'lucide-react'
import { Button } from '@/components/ui/button'

export function EmptyNovels() {
  return (
    <div className='flex min-h-[320px] flex-col items-center justify-center gap-4 rounded-md border border-dashed px-6 py-12 text-center'>
      <BookOpen className='size-10 text-muted-foreground' />
      <div className='space-y-1'>
        <p className='font-semibold'>小説がまだありません</p>
        <p className='max-w-[28ch] text-sm text-muted-foreground'>
          あらすじを入力して、AI に小説を自動生成させましょう。
        </p>
      </div>
      <Button asChild size='sm' className='[&_svg]:size-5!'>
        <a href='/novels/new'>
          <SquarePen />
          新しい小説を書く
        </a>
      </Button>
    </div>
  )
}
