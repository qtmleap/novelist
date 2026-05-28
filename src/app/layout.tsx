import type { ReactNode } from 'react'
import { AppShell } from '@/components/AppShell'
import { TooltipProvider } from '@/components/ui/tooltip'
import '../index.css'

const noFlashScript = `try{var t=localStorage.getItem('theme');if(t==='dark'||(t===null&&matchMedia('(prefers-color-scheme: dark)').matches)){document.documentElement.classList.add('dark')}}catch(e){}`

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang='ja' suppressHydrationWarning>
      <head>
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: no-flash theme init must run before paint */}
        <script dangerouslySetInnerHTML={{ __html: noFlashScript }} />
      </head>
      <body>
        <TooltipProvider>
          <AppShell>{children}</AppShell>
        </TooltipProvider>
      </body>
    </html>
  )
}
