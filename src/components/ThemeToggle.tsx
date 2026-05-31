'use client'

import { useAtom } from 'jotai'
import { Moon, Sun } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { themeAtom } from '@/store/atoms'

export function ThemeToggle() {
  const [theme, setTheme] = useAtom(themeAtom)
  const [mounted, setMounted] = useState(false)
  const isDark = theme === 'dark'

  useEffect(() => {
    setMounted(true)
  }, [])

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
      {mounted ? (isDark ? <Sun /> : <Moon />) : <Moon />}
    </Button>
  )
}
