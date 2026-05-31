'use client'

import { useAtom } from 'jotai'
import { Moon, Sun } from 'lucide-react'
import { useEffect } from 'react'
import { Button } from '@/components/ui/button'
import { themeAtom } from '@/store/atoms'

export function ThemeToggle() {
  const [theme, setTheme] = useAtom(themeAtom)
  const isDark = theme === 'dark'

  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark)
  }, [isDark])

  return (
    <Button
      type='button'
      variant='ghost'
      size='icon'
      aria-label='テーマ切替'
      onClick={() => setTheme(isDark ? 'light' : 'dark')}
      className='[&_svg]:size-5!'
    >
      {isDark ? <Sun /> : <Moon />}
    </Button>
  )
}
