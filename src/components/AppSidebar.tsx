'use client'

import { Library, Settings, Users } from 'lucide-react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  Sidebar,
  SidebarContent,
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
import { cn } from '@/lib/utils'

const NAV_ITEMS = [
  { label: '小説一覧', href: '/novels', icon: Library },
  { label: '登場人物一覧', href: '/characters', icon: Users },
  { label: '設定', href: '/settings', icon: Settings }
]

export function AppSidebar() {
  const pathname = usePathname()
  const { isMobile, setOpenMobile } = useSidebar()

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
      <SidebarRail />
    </Sidebar>
  )
}
