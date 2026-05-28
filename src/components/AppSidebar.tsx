'use client'

import { Library, Settings, Users } from 'lucide-react'
import { useEffect, useState } from 'react'
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
  SidebarRail
} from '@/components/ui/sidebar'

const NAV_ITEMS = [
  { label: '小説一覧', href: '/novels', icon: Library },
  { label: '登場人物一覧', href: '/characters', icon: Users },
  { label: '設定', href: '/settings', icon: Settings }
]

export function AppSidebar() {
  const [pathname, setPathname] = useState('')

  useEffect(() => {
    setPathname(window.location.pathname)
  }, [])

  const activeHref = NAV_ITEMS.map((item) => item.href)
    .filter((href) => pathname === href || pathname.startsWith(`${href}/`))
    .sort((a, b) => b.length - a.length)[0]

  return (
    <Sidebar collapsible='icon'>
      <SidebarHeader className='h-16 justify-center border-b'>
        <SidebarMenu>
          <SidebarMenuItem className='group-data-[collapsible=icon]:hidden'>
            <SidebarMenuButton size='lg' asChild>
              <a href='/novels'>
                <span className='font-semibold tracking-widest'>NOVELIST</span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
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
                      <a href={item.href}>
                        <item.icon />
                        <span>{item.label}</span>
                      </a>
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
