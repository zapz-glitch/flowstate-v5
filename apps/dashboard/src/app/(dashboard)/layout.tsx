'use client'

import Sidebar from '@/components/Sidebar'
import { UserProvider } from '@/components/auth/UserProvider'
import { ImpersonationProvider } from '@/components/auth/ImpersonationProvider'
import { SidebarProvider, useSidebar } from '@/components/SidebarProvider'
import { useImpersonation } from '@/components/auth/ImpersonationProvider'
import { AnalysisBridge } from '@/components/AnalysisBridge'
import { FaviconManager } from '@/components/FaviconManager'
import { cn } from '@/lib/utils'

function DashboardContent({ children }: { children: React.ReactNode }) {
  const { collapsed } = useSidebar()
  const { isImpersonating } = useImpersonation()

  return (
    <div className={cn('min-h-[100dvh] bg-background', isImpersonating && 'pt-10')}>
      <Sidebar />
      <main
        className={cn(
          'transition-all duration-300 ease-in-out',
          // Desktop: dynamic padding based on sidebar state
          collapsed ? 'lg:pl-[72px]' : 'lg:pl-64',
          // Mobile: padding for top header and bottom nav (incl. safe areas)
          'pt-[calc(3.5rem+var(--sat))] pb-[calc(3.5rem+var(--sab))] lg:pt-0 lg:pb-0'
        )}
      >
        <div className="p-4 sm:p-6 lg:p-8">{children}</div>
      </main>
    </div>
  )
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <UserProvider requireAuth>
      <ImpersonationProvider>
        <SidebarProvider>
          <AnalysisBridge />
          <FaviconManager />
          <DashboardContent>{children}</DashboardContent>
        </SidebarProvider>
      </ImpersonationProvider>
    </UserProvider>
  )
}
