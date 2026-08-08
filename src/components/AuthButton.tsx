import type { ReactNode } from 'react'
import { Button, type buttonVariants } from '@/components/ui/button'
import type { VariantProps } from 'class-variance-authority'

type ButtonProps = VariantProps<typeof buttonVariants>

type BaseProps = {
  allowed: boolean
  disabledTitle?: string
  children: ReactNode
} & Pick<ButtonProps, 'variant' | 'size'>

// allowed=true のときはリンクとして機能する Button (asChild + a) を返す。
// allowed=false のときは disabled Button に title でヒントを出す。
// 「編集ボタン else ログイン誘導」パターン 5 箇所で使う。
export function AuthLinkButton({
  allowed,
  disabledTitle = 'ログインが必要です',
  href,
  children,
  variant,
  size,
  className
}: BaseProps & { href: string; className?: string }) {
  if (allowed) {
    return (
      <Button asChild size={size} variant={variant} className={className}>
        <a href={href}>{children}</a>
      </Button>
    )
  }
  return (
    <Button size={size} variant={variant} className={className} disabled title={disabledTitle}>
      {children}
    </Button>
  )
}
