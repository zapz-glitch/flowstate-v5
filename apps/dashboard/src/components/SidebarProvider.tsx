'use client'

import { createContext, useContext, useEffect, useState } from 'react'

interface SidebarContextType {
  // What is on screen right now: the stored choice, opened while the rail is hovered.
  collapsed: boolean
  collapsedPref: boolean
  setHoverExpanded: (expanded: boolean) => void
  setCollapsed: (collapsed: boolean) => void
  toggleCollapsed: () => void
}

const SidebarContext = createContext<SidebarContextType | undefined>(undefined)

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const [collapsedPref, setCollapsed] = useState(false)
  // Hover-expand lives here so the page moves over with the rail instead of sitting under it.
  const [hoverExpanded, setHoverExpanded] = useState(false)
  const collapsed = collapsedPref && !hoverExpanded

  useEffect(() => {
    const stored = localStorage.getItem('sidebar-collapsed')
    if (stored === 'true') setCollapsed(true)
  }, [])

  const toggleCollapsed = () => {
    const newState = !collapsedPref
    setCollapsed(newState)
    localStorage.setItem('sidebar-collapsed', String(newState))
  }

  return (
    <SidebarContext.Provider value={{ collapsed, collapsedPref, setCollapsed, setHoverExpanded, toggleCollapsed }}>
      {children}
    </SidebarContext.Provider>
  )
}

export function useSidebar() {
  const context = useContext(SidebarContext)
  if (!context) {
    throw new Error('useSidebar must be used within a SidebarProvider')
  }
  return context
}
