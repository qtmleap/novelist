import type { ReactNode } from 'react'

type Props = {
  description: string
  children: ReactNode
}

// 編集画面末尾の「危険な操作」セクション。
// characters/novels/chapters 編集ページ 3 箇所で同じスタイルを複製していた。
export function DangerZone({ description, children }: Props) {
  return (
    <div className='border-t pt-6'>
      <h2 className='text-sm font-semibold text-destructive'>危険な操作</h2>
      <p className='mt-1 text-sm text-muted-foreground'>{description}</p>
      <div className='mt-3'>{children}</div>
    </div>
  )
}
