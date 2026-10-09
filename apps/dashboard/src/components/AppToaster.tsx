'use client'

import { Toaster } from 'sonner'
import { useTheme } from '@/components/theme-provider'

export function AppToaster() {
  const { theme } = useTheme()
  const dark = theme === 'night' || theme === 'dawn'
  return <Toaster theme={dark ? 'dark' : 'light'} position="top-right" richColors closeButton />
}
