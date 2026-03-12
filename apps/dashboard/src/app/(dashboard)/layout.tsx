'use client'

import Sidebar from '@/components/Sidebar'
import { UserProvider } from '@/components/auth/UserProvider'
import { SidebarProvider, useSidebar } from '@/components/SidebarProvider'
import { AnalysisBridge } from '@/components/AnalysisBridge'
import { cn } from '@/lib/utils'

function DashboardContent({ children }: { children: React.ReactNode }) {
  const { collapsed } = useSidebar()

  return (
    <div className="min-h-screen bg-background">
      <Sidebar />
      <main
        className={cn(
          'transition-all duration-300 ease-in-out',
          // Desktop: dynamic padding based on sidebar state
          collapsed ? 'lg:pl-[72px]' : 'lg:pl-64',
          // Mobile: padding for top header and bottom nav
          'pt-16 pb-16 lg:pt-0 lg:pb-0'
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
      <SidebarProvider>
        <AnalysisBridge />
        <DashboardContent>{children}</DashboardContent>
      </SidebarProvider>
    </UserProvider>
  )
}
