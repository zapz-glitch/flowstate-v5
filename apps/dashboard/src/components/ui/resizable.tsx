"use client"

import { GripVertical } from "lucide-react"
import { Group, Panel, Separator } from "react-resizable-panels"

import { cn } from "@/lib/utils"

const ResizablePanelGroup = ({
  className,
  ...props
}: React.ComponentProps<typeof Group>) => (
  <Group
    className={cn("flex h-full w-full", className)}
    {...props}
  />
)

const ResizablePanel = Panel

function ResizableHandle({ withHandle, className }: { withHandle?: boolean; className?: string }) {
  return (
    <Separator className={cn("relative flex items-center justify-center", className)}>
      {withHandle && (
        <div className="z-10 flex h-8 w-4 items-center justify-center rounded-md border bg-muted shadow-sm hover:bg-secondary transition-colors">
          <GripVertical className="h-3.5 w-3.5 text-foreground-tertiary" />
        </div>
      )}
    </Separator>
  )
}

export { ResizablePanelGroup, ResizablePanel, ResizableHandle }
