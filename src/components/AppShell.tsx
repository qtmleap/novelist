'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'
import { AppSidebar } from '@/components/AppSidebar'
import { ThemeToggle } from '@/components/ThemeToggle'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'
import { cn } from '@/lib/utils'

const queryClient = new QueryClient()

// キャンバス系のページは横幅を使い切りたいので、既定の読み物幅 (max-w-4xl) を外す。
const WIDE_ROUTE = /^\/novels\/[^/]+\/cast$/

export function AppShell({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  const wide = WIDE_ROUTE.test(pathname)

  return (
    <QueryClientProvider client={queryClient}>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset>
          <header className='flex h-16 shrink-0 items-center gap-2 border-b px-4'>
            <SidebarTrigger className='-ml-1 [&_svg]:size-5!' />
            <div className='ml-auto'>
              <ThemeToggle />
            </div>
          </header>
          <main className='flex-1 p-4 md:p-6'>
            <div className={cn(wide ? 'max-w-none' : 'max-w-4xl')}>{children}</div>
          </main>
        </SidebarInset>
      </SidebarProvider>
    </QueryClientProvider>
  )
}
