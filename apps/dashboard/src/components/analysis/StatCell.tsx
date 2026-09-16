import { cn } from '@/lib/utils'
import { matchTextClass, type MatchState } from './feature-match'

export function StatCell({ label, value, match }: { label: string; value: string | number; match?: MatchState }) {
  return (
    <div className="py-2 px-2 text-center border-r border-border/50 last:border-r-0 min-w-[70px] flex-1">
      <div className="text-caption-sm text-foreground-tertiary">{label}</div>
      <div className={cn('text-body-sm font-medium mt-0.5', match && matchTextClass(match))}>{value}</div>
    </div>
  )
}
