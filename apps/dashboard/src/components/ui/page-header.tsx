import * as React from "react"

import { cn } from "@/lib/utils"

interface PageHeaderProps {
  title: string
  /** Buttons / controls shown on the right. Keep to real actions. */
  actions?: React.ReactNode
  className?: string
}

// Page title: one line, left. Actions: right. Nothing else — no icon,
// no subtitle, no eyebrow.
function PageHeader({ title, actions, className }: PageHeaderProps) {
  return (
    <header className={cn("flex min-h-9 items-center justify-between gap-4", className)}>
      <h1 className="min-w-0 truncate text-heading-lg text-foreground">{title}</h1>
      {actions ? (
        <div className="flex flex-shrink-0 flex-wrap items-center justify-end gap-2">{actions}</div>
      ) : null}
    </header>
  )
}

export { PageHeader }
