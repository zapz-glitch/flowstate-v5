import { Skeleton, SkeletonPageHeader, SkeletonRows } from '@/components/ui/skeleton'

// Mirrors the Tasks page: title, the add-a-task card, the task list.
export default function TasksLoading() {
  return (
    <div className="max-w-3xl space-y-6" aria-busy="true">
      <SkeletonPageHeader />
      <Skeleton className="h-[116px] rounded-xl" aria-hidden />
      <SkeletonRows label="Loading tasks" rows={4} />
    </div>
  )
}
