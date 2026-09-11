'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  Key,
  LogOut,
  Home,
  ClipboardList,
  Search,
  ChevronLeft,
  ChevronRight,
  Sun,
  Moon,
  Sunrise,
  Lightbulb,
  Check,
  ChevronsUpDown,
  User,
  Settings2,
  ShieldCheck,
  Upload,
  Activity,
} from 'lucide-react'
import { signOut } from '@/lib/auth-client'
import { Logo, LogoIcon } from '@/components/ui/Logo'
import { cn } from '@/lib/utils'
import { useUser } from '@/components/auth/UserProvider'
import { useTheme } from '@/components/theme-provider'
import { useSidebar } from '@/components/SidebarProvider'
import { useAnalysis } from '@/hooks/use-analysis'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

const baseNavigation: Array<{
  name: string
  href: string
  icon: typeof Home
  external?: boolean
}> = [
  { name: 'Overview', href: '/dashboard', icon: Home },
  { name: 'Property Search', href: '/dashboard/analyze', icon: Search },
  { name: 'Batch Import', href: '/dashboard/batch', icon: Upload },
  { name: 'Property Reports', href: '/dashboard/reports', icon: ClipboardList },
  { name: 'Evaluation Settings', href: '/dashboard/evaluation-settings', icon: Settings2 },
  { name: 'API Hub', href: '/dashboard/api-hub', icon: Key },
]

const adminNavigation: Array<{
  name: string
  href: string
  icon: typeof Home
  external?: boolean
}> = [
  { name: 'Admin Panel', href: '/dashboard/admin', icon: ShieldCheck },
  { name: 'Observability', href: '/dashboard/admin/observability', icon: Activity },
]

const THEME_PRESETS = [
  { id: 'night', label: 'Night', icon: Moon },
  { id: 'dawn', label: 'Early morning', icon: Sunrise },
  { id: 'outdoor', label: 'Outdoor', icon: Sun },
  { id: 'led', label: 'Bright indoor', icon: Lightbulb },
] as const

export default function Sidebar() {
  const pathname = usePathname()
  const { user } = useUser()
  const { theme, setTheme } = useTheme()
  const { collapsed, toggleCollapsed } = useSidebar()
  const { activeAnalysis, analysisState } = useAnalysis()

  const isAnalysisRunning = activeAnalysis !== null && analysisState.status !== 'completed' && analysisState.status !== 'failed'

  const navigation = user?.role === 'admin'
    ? [...baseNavigation, ...adminNavigation]
    : baseNavigation

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
          'fixed inset-y-0 left-0 z-40 hidden lg:flex lg:flex-col bg-background border-r border-border transition-all duration-300 ease-in-out',
          collapsed ? 'w-[72px]' : 'w-64'
        )}
      >
        <div className="flex flex-col h-full">
          {/* Logo & Collapse Button */}
          <div className="flex items-center justify-between h-16 px-4 border-b border-border">
            <Link href="/dashboard" className="flex items-center">
              {collapsed ? <LogoIcon /> : <Logo size="sm" showText={false} />}
            </Link>
            <button
              onClick={toggleCollapsed}
              className={cn(
                'p-1.5 rounded-lg text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors',
                collapsed && 'absolute -right-3 top-6 bg-background border border-border shadow-sm'
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
                  : 'text-foreground-secondary hover:text-foreground hover:bg-secondary'
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

              const showAnalysisIndicator = isAnalysisRunning && item.href === '/dashboard/analyze'

              return (
                <Link
                  key={item.name}
                  href={item.href}
                  className={cn(linkClasses, 'relative')}
                  title={collapsed ? item.name : undefined}
                >
                  <item.icon
                    className={cn('w-[18px] h-[18px] flex-shrink-0', isActive && 'text-primary')}
                  />
                  {!collapsed && <span>{item.name}</span>}
                  {showAnalysisIndicator && (
                    <span className={cn('relative flex h-1.5 w-1.5 ml-auto', collapsed && 'absolute top-1.5 right-1.5')}>
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                      <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500" />
                    </span>
                  )}
                </Link>
              )
            })}
          </nav>

          {/* User Section with Dropdown */}
          <div className="p-3 border-t border-border">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className={cn(
                    'flex items-center gap-3 w-full rounded-lg p-2 text-left transition-colors hover:bg-secondary',
                    collapsed && 'justify-center'
                  )}
                >
                  <Avatar className="h-9 w-9 flex-shrink-0">
                    <AvatarFallback className="bg-secondary border border-border text-foreground text-body-sm font-medium">
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
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="mono-label !text-[10px]">Environment</DropdownMenuLabel>
                {THEME_PRESETS.map((p) => (
                  <DropdownMenuItem key={p.id} onClick={() => setTheme(p.id)} className="cursor-pointer">
                    <p.icon className="mr-2 h-4 w-4" />
                    {p.label}
                    {theme === p.id && <Check className="ml-auto h-3.5 w-3.5" />}
                  </DropdownMenuItem>
                ))}
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
      <div className="lg:hidden fixed top-0 left-0 right-0 z-40 h-16 bg-background border-b border-border flex items-center justify-between px-4">
        <Link href="/dashboard">
          <Logo size="sm" showText={false} />
        </Link>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="p-1">
              <Avatar className="h-8 w-8">
                <AvatarFallback className="bg-secondary border border-border text-foreground text-xs font-medium">
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
            <DropdownMenuLabel className="mono-label !text-[10px]">Environment</DropdownMenuLabel>
            {THEME_PRESETS.map((p) => (
              <DropdownMenuItem key={p.id} onClick={() => setTheme(p.id)} className="cursor-pointer">
                <p.icon className="mr-2 h-4 w-4" />
                {p.label}
                {theme === p.id && <Check className="ml-auto h-3.5 w-3.5" />}
              </DropdownMenuItem>
            ))}
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
      <div className="lg:hidden fixed bottom-0 left-0 right-0 z-40 h-16 bg-background border-t border-border">
        <nav className="flex items-center justify-around h-full px-2">
          {navigation.slice(0, 5).map((item) => {
            const isActive = pathname === item.href
            const showMobileIndicator = isAnalysisRunning && item.href === '/dashboard/analyze'
            return (
              <Link
                key={item.name}
                href={item.href}
                className={cn(
                  'relative flex flex-col items-center justify-center gap-0.5 px-2 py-1.5 rounded-lg transition-colors',
                  isActive
                    ? 'text-primary'
                    : 'text-foreground-tertiary hover:text-foreground'
                )}
              >
                <item.icon className="w-[18px] h-[18px]" />
                <span className="text-caption-sm">{item.name.split(' ')[0]}</span>
                {showMobileIndicator && (
                  <span className="absolute top-1.5 right-1.5 flex h-1.5 w-1.5">
                    <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
                    <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-500" />
                  </span>
                )}
              </Link>
            )
          })}
        </nav>
      </div>
    </>
  )
}
