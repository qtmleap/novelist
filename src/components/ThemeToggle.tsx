'use client'

import { useAtom } from 'jotai'
import { Moon, Sun } from 'lucide-react'
import { useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { themeAtom } from '@/store/atoms'

export function ThemeToggle() {
  const [theme, setTheme] = useAtom(themeAtom)

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
  }, [theme])

  return (
    <Button
      type='button'
      variant='ghost'
      size='icon'
      aria-label='テーマ切替'
      onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
      className='[&_svg]:size-5!'
    >
      <Moon className='dark:hidden' />
      <Sun className='hidden dark:block' />
    </Button>
  )
}
