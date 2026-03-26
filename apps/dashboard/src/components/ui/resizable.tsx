"use client"

import { GripVertical } from "lucide-react"
import { Group, Panel, Separator } from "react-resizable-panels"

import { cn } from "@/lib/utils"

const ResizablePanelGroup = ({
  className,
  ...props
}: React.ComponentProps<typeof Group>) => (
  <Group
    className={cn(
      "flex h-full w-full",
      className
    )}
    {...props}
  />
)

const ResizablePanel = Panel

const ResizableHandle = ({
  withHandle,
  className,
  ...props
}: Omit<React.ComponentProps<typeof Separator>, 'children'> & {
  withHandle?: boolean
}) => (
  <Separator
    className={cn(
      "relative flex w-1 items-center justify-center bg-border cursor-col-resize",
      "after:absolute after:inset-y-0 after:-left-1.5 after:-right-1.5",
      "hover:bg-primary/30 [&[data-resize-handle-active]]:bg-primary/50",
      "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
      className
    )}
    {...props}
  >
    {withHandle && (
      <div className="z-10 flex h-8 w-4 items-center justify-center rounded-md border bg-muted shadow-sm">
        <GripVertical className="h-3.5 w-3.5 text-foreground-tertiary" />
      </div>
    )}
  </Separator>
)

export { ResizablePanelGroup, ResizablePanel, ResizableHandle }
