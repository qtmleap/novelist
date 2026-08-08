import { BookOpen, SquarePen } from 'lucide-react'
import { EmptyState } from '@/components/EmptyState'
import { Button } from '@/components/ui/button'
import { routes } from '@/lib/routes'

export function EmptyNovels() {
  return (
    <EmptyState
      icon={BookOpen}
      title='小説がまだありません'
      description='あらすじを入力して、AI に小説を自動生成させましょう。'
      action={
        <Button asChild size='sm' className='[&_svg]:size-5!'>
          <a href={routes.novels.new}>
            <SquarePen />
            新しい小説を書く
          </a>
        </Button>
      }
    />
  )
}
