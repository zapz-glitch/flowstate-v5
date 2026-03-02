'use client'

import { useEffect } from 'react'
import { useRouter, usePathname } from 'next/navigation'
import Link from 'next/link'
import { Logo } from '@/components/ui/Logo'
import { ArrowLeft, Sun, Moon, Loader2 } from 'lucide-react'
import { useTheme } from '@/components/theme-provider'
import { Button } from '@/components/ui/button'
import { useSession } from '@/lib/auth-client'
import { cn } from '@/lib/utils'

const tabs = [
  { name: 'API Reference', href: '/docs' },
  { name: 'Methodology', href: '/docs/methodology' },
]

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter()
  const pathname = usePathname()
  const session = useSession()
  const { theme, toggleTheme } = useTheme()

  // Redirect unauthenticated users to login
  useEffect(() => {
    if (!session.isPending && !session.data?.user) {
      router.replace('/')
    }
  }, [session.isPending, session.data, router])

  if (session.isPending || !session.data?.user) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-purple-500" />
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="fixed top-0 left-0 right-0 z-50 border-b border-border bg-background/80 backdrop-blur-xl">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
          <div className="flex items-center gap-6">
            <Link href="/" className="flex items-center gap-2">
              <Logo size="sm" />
            </Link>
            {/* Tabs */}
            <nav className="hidden sm:flex items-center gap-1">
              {tabs.map((tab) => {
                const isActive =
                  tab.href === '/docs'
                    ? pathname === '/docs'
                    : pathname.startsWith(tab.href)
                return (
                  <Link
                    key={tab.href}
                    href={tab.href}
                    className={cn(
                      'px-3 py-1.5 rounded-lg text-sm transition-colors',
                      isActive
                        ? 'text-foreground font-medium bg-secondary'
                        : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'
                    )}
                  >
                    {tab.name}
                  </Link>
                )
              })}
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleTheme}
              className="text-muted-foreground hover:text-foreground hover:bg-secondary"
            >
              {theme === 'dark' ? (
                <Sun className="h-5 w-5" />
              ) : (
                <Moon className="h-5 w-5" />
              )}
            </Button>
            <Link
              href="/dashboard"
              className="flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to Dashboard
            </Link>
          </div>
        </div>
        {/* Mobile tabs */}
        <div className="sm:hidden flex items-center gap-1 px-6 pb-2">
          {tabs.map((tab) => {
            const isActive =
              tab.href === '/docs'
                ? pathname === '/docs'
                : pathname.startsWith(tab.href)
            return (
              <Link
                key={tab.href}
                href={tab.href}
                className={cn(
                  'px-3 py-1.5 rounded-lg text-sm transition-colors',
                  isActive
                    ? 'text-foreground font-medium bg-secondary'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {tab.name}
              </Link>
            )
          })}
        </div>
      </header>

      {/* Content */}
      <main className="pt-16">
        {children}
      </main>
    </div>
  )
}
