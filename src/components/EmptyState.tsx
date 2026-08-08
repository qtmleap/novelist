import type { LucideIcon } from 'lucide-react'
import type { ReactNode } from 'react'

type Props = {
  icon: LucideIcon
  title: string
  description: string
  action?: ReactNode
}

// 空状態を示す共通ビュー。dashed border + アイコン + 見出し + 説明 + 任意 CTA。
// EmptyNovels / EmptyCategories / EmptyCharacters を統一する。
export function EmptyState({ icon: Icon, title, description, action }: Props) {
  return (
    <div className='flex min-h-[320px] flex-col items-center justify-center gap-4 rounded-md border border-dashed px-6 py-12 text-center'>
      <Icon className='size-10 text-muted-foreground' />
      <div className='space-y-1'>
        <p className='font-semibold'>{title}</p>
        <p className='max-w-[28ch] text-sm text-muted-foreground'>{description}</p>
      </div>
      {action}
    </div>
  )
}
