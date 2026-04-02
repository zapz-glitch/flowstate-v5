'use client'

import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
import { SettingsPanel } from './SettingsPanel'
import type { UseReportSettingsReturn } from '@/hooks/use-report-settings'
import type { RecalcResult } from '@/lib/recalc'

interface EvaluationSettingsSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  settingsHook: UseReportSettingsReturn
  recalcData: RecalcResult | null
}

export function EvaluationSettingsSheet({ open, onOpenChange, settingsHook, recalcData }: EvaluationSettingsSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:w-[400px] sm:max-w-[400px] p-0 flex flex-col">
        <SheetHeader className="px-5 pt-5 pb-3 border-b border-border">
          <SheetTitle className="text-body font-semibold">Evaluation Settings</SheetTitle>
          <SheetDescription className="text-caption text-foreground-tertiary">
            Adjust filters, adjustments, and deal parameters to see real-time recalculation.
          </SheetDescription>
        </SheetHeader>
        <SettingsPanel settingsHook={settingsHook} recalcData={recalcData} />
      </SheetContent>
    </Sheet>
  )
}
