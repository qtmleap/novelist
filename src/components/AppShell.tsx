'use client'

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { AppSidebar } from '@/components/AppSidebar'
import { ThemeToggle } from '@/components/ThemeToggle'
import { SidebarInset, SidebarProvider, SidebarTrigger } from '@/components/ui/sidebar'

const queryClient = new QueryClient()

export function AppShell({ children }: { children: ReactNode }) {
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
            <div className='mx-auto max-w-4xl'>{children}</div>
          </main>
        </SidebarInset>
      </SidebarProvider>
    </QueryClientProvider>
  )
}
