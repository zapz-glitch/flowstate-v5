'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  Key,
  BarChart3,
  LogOut,
  Home,
  FileText,
  Search,
  ChevronLeft,
  ChevronRight,
  Sun,
  Moon,
  ChevronsUpDown,
  User,
  BookOpen,
} from 'lucide-react'
import { signOut } from '@/lib/auth-client'
import { Logo } from '@/components/ui/Logo'
import { cn } from '@/lib/utils'
import { useUser } from '@/components/auth/UserProvider'
import { useTheme } from '@/components/theme-provider'
import { useSidebar } from '@/components/SidebarProvider'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

const navigation: Array<{
  name: string
  href: string
  icon: typeof Home
  external?: boolean
}> = [
  { name: 'Overview', href: '/dashboard', icon: Home },
  { name: 'API Playground', href: '/dashboard/analyze', icon: Search },
  { name: 'API Keys', href: '/dashboard/api-keys', icon: Key },
  { name: 'Usage', href: '/dashboard/usage', icon: BarChart3 },
  { name: 'API Logs', href: '/dashboard/logs', icon: FileText },
  { name: 'API Docs', href: '/docs', icon: BookOpen, external: true },
]

export default function Sidebar() {
  const pathname = usePathname()
  const { user } = useUser()
  const { theme, toggleTheme } = useTheme()
  const { collapsed, toggleCollapsed } = useSidebar()

  const handleSignOut = async () => {
    await signOut()
    window.location.href = '/'
  }

  if (!user) return null

  const initials = user.name
    ? user.name
        .split(' ')
        .map((n) => n[0])
        .join('')
        .toUpperCase()
        .slice(0, 2)
    : user.email[0].toUpperCase()

  return (
    <>
      {/* Sidebar */}
      <div
        className={cn(
          'fixed inset-y-0 left-0 z-40 hidden lg:flex lg:flex-col bg-card border-r border-border/60 transition-all duration-300 ease-in-out',
          collapsed ? 'w-[72px]' : 'w-64'
        )}
      >
        <div className="flex flex-col h-full">
          {/* Logo & Collapse Button */}
          <div className="flex items-center justify-between h-16 px-4 border-b border-border/60">
            <Link href="/dashboard" className="flex items-center">
              {collapsed ? (
                <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-purple-500 to-violet-600 flex items-center justify-center">
                  <span className="text-white font-bold text-sm">F</span>
                </div>
              ) : (
                <Logo size="sm" />
              )}
            </Link>
            <button
              onClick={toggleCollapsed}
              className={cn(
                'p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors',
                collapsed && 'absolute -right-3 top-6 bg-card border border-border shadow-sm'
              )}
              aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            >
              {collapsed ? (
                <ChevronRight className="w-4 h-4" />
              ) : (
                <ChevronLeft className="w-4 h-4" />
              )}
            </button>
          </div>

          {/* Navigation */}
          <nav className="flex-1 p-2.5 space-y-1 overflow-y-auto">
            {navigation.map((item) => {
              // For /dashboard (Overview), only match exactly to avoid matching all sub-routes
              const isActive =
                item.href === '/dashboard'
                  ? pathname === '/dashboard'
                  : pathname === item.href || pathname.startsWith(item.href + '/')
              const linkClasses = cn(
                'flex items-center gap-2.5 rounded-lg text-xs font-medium transition-all duration-200',
                collapsed ? 'justify-center px-2.5 py-2.5' : 'px-3 py-2.5',
                isActive
                  ? 'bg-primary/10 text-primary'
                  : 'text-foreground-secondary hover:text-foreground hover:bg-secondary/60'
              )

              if (item.external) {
                return (
                  <a
                    key={item.name}
                    href={item.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    className={linkClasses}
                    title={collapsed ? item.name : undefined}
                  >
                    <item.icon className="w-[18px] h-[18px] flex-shrink-0" />
                    {!collapsed && <span>{item.name}</span>}
                  </a>
                )
              }

              return (
                <Link
                  key={item.name}
                  href={item.href}
                  className={linkClasses}
                  title={collapsed ? item.name : undefined}
                >
                  <item.icon
                    className={cn('w-[18px] h-[18px] flex-shrink-0', isActive && 'text-primary')}
                  />
                  {!collapsed && <span>{item.name}</span>}
                </Link>
              )
            })}
          </nav>

          {/* User Section with Dropdown */}
          <div className="p-3 border-t border-border/60">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className={cn(
                    'flex items-center gap-3 w-full rounded-lg p-2 text-left transition-colors hover:bg-secondary',
                    collapsed && 'justify-center'
                  )}
                >
                  <Avatar className="h-9 w-9 flex-shrink-0">
                    <AvatarFallback className="bg-gradient-to-br from-purple-500 to-violet-600 text-white text-body-sm font-medium">
                      {initials}
                    </AvatarFallback>
                  </Avatar>
                  {!collapsed && (
                    <>
                      <div className="flex-1 min-w-0">
                        <p className="text-body-sm font-medium text-foreground truncate">
                          {user.name || 'User'}
                        </p>
                        <p className="text-caption-sm text-foreground-tertiary truncate">{user.email}</p>
                      </div>
                      <ChevronsUpDown className="w-4 h-4 text-foreground-tertiary flex-shrink-0" />
                    </>
                  )}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                side={collapsed ? 'right' : 'top'}
                align={collapsed ? 'start' : 'center'}
                className="w-56"
              >
                <DropdownMenuLabel className="font-normal">
                  <div className="flex flex-col space-y-1">
                    <p className="text-body-sm font-medium">{user.name || 'User'}</p>
                    <p className="text-caption-sm text-foreground-tertiary truncate">{user.email}</p>
                  </div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link href="/dashboard/settings" className="cursor-pointer">
                    <User className="mr-2 h-4 w-4" />
                    Account Settings
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={toggleTheme}>
                  {theme === 'dark' ? (
                    <>
                      <Sun className="mr-2 h-4 w-4" />
                      Light Mode
                    </>
                  ) : (
                    <>
                      <Moon className="mr-2 h-4 w-4" />
                      Dark Mode
                    </>
                  )}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={handleSignOut}
                  className="text-red-500 focus:text-red-500 focus:bg-red-500/10"
                >
                  <LogOut className="mr-2 h-4 w-4" />
                  Sign Out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      {/* Mobile Header */}
      <div className="lg:hidden fixed top-0 left-0 right-0 z-40 h-16 bg-card border-b border-border/60 flex items-center justify-between px-4">
        <Link href="/dashboard">
          <Logo size="sm" />
        </Link>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="p-1">
              <Avatar className="h-8 w-8">
                <AvatarFallback className="bg-gradient-to-br from-purple-500 to-violet-600 text-white text-xs font-medium">
                  {initials}
                </AvatarFallback>
              </Avatar>
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel className="font-normal">
              <div className="flex flex-col space-y-1">
                <p className="text-body-sm font-medium">{user.name || 'User'}</p>
                <p className="text-caption-sm text-foreground-tertiary truncate">{user.email}</p>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {navigation.map((item) => (
              <DropdownMenuItem key={item.name} asChild>
                <Link href={item.href} className="cursor-pointer">
                  <item.icon className="mr-2 h-4 w-4" />
                  {item.name}
                </Link>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={toggleTheme}>
              {theme === 'dark' ? (
                <>
                  <Sun className="mr-2 h-4 w-4" />
                  Light Mode
                </>
              ) : (
                <>
                  <Moon className="mr-2 h-4 w-4" />
                  Dark Mode
                </>
              )}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={handleSignOut}
              className="text-red-500 focus:text-red-500 focus:bg-red-500/10"
            >
              <LogOut className="mr-2 h-4 w-4" />
              Sign Out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Mobile Navigation Bottom Bar */}
      <div className="lg:hidden fixed bottom-0 left-0 right-0 z-40 h-16 bg-card border-t border-border/60">
        <nav className="flex items-center justify-around h-full px-2">
          {navigation.slice(0, 5).map((item) => {
            const isActive = pathname === item.href
            return (
              <Link
                key={item.name}
                href={item.href}
                className={cn(
                  'flex flex-col items-center justify-center gap-0.5 px-2 py-1.5 rounded-lg transition-colors',
                  isActive
                    ? 'text-primary'
                    : 'text-foreground-tertiary hover:text-foreground'
                )}
              >
                <item.icon className="w-[18px] h-[18px]" />
                <span className="text-caption-sm">{item.name.split(' ')[0]}</span>
              </Link>
            )
          })}
        </nav>
      </div>
    </>
  )
}
