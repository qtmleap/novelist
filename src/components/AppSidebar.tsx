'use client'

import { Library, LogIn, LogOut, Settings, Users } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar
} from '@/components/ui/sidebar'
import { useAuth } from '@/hooks/useAuth'
import { cn } from '@/lib/utils'

const NAV_ITEMS = [
  { label: '小説一覧', href: '/novels', icon: Library },
  { label: '登場人物一覧', href: '/characters', icon: Users },
  { label: '設定', href: '/settings', icon: Settings }
]

export function AppSidebar() {
  const pathname = usePathname()
  const { isMobile, setOpenMobile } = useSidebar()
  const auth = useAuth()

  const activeHref = NAV_ITEMS.map((item) => item.href)
    .filter((href) => pathname === href || pathname.startsWith(`${href}/`))
    .sort((a, b) => b.length - a.length)[0]

  const closeIfMobile = () => {
    if (isMobile) setOpenMobile(false)
  }

  return (
    <Sidebar collapsible='icon'>
      <SidebarHeader className='h-16 justify-center border-b'>
        <Link
          href='/novels'
          onClick={closeIfMobile}
          className={cn(
            'group-data-[collapsible=icon]:hidden',
            'inline-flex items-center px-3 text-sm font-semibold tracking-widest text-sidebar-foreground transition-colors hover:text-sidebar-accent-foreground'
          )}
        >
          NOVELIST
        </Link>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>メニュー</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_ITEMS.map((item) => {
                const isActive = item.href === activeHref
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton asChild isActive={isActive} tooltip={item.label} className='[&>svg]:size-5!'>
                      <Link href={item.href} onClick={closeIfMobile}>
                        <item.icon />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className='border-t'>
        <SidebarMenu>
          <SidebarMenuItem>
            {auth.status === 'authenticated' ? (
              <SidebarMenuButton asChild tooltip='ログアウト' className='[&>svg]:size-5!'>
                {/* CF Access のログアウトエンドポイント。Worker は介さずに CF が直接処理する。 */}
                <a href='/cdn-cgi/access/logout'>
                  <LogOut />
                  <span className='truncate'>{auth.email}</span>
                </a>
              </SidebarMenuButton>
            ) : (
              <SidebarMenuButton
                asChild
                tooltip={auth.status === 'loading' ? '確認中…' : 'ログイン'}
                className='[&>svg]:size-5!'
                disabled={auth.status === 'loading'}
              >
                {/* CF Access の Application で /api/auth/login を Allow に設定すれば、ここで認証フローが起動する。 */}
                <a href='/api/auth/login'>
                  <LogIn />
                  <span>{auth.status === 'loading' ? '確認中…' : 'ログイン'}</span>
                </a>
              </SidebarMenuButton>
            )}
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
      <SidebarRail />
    </Sidebar>
  )
}
