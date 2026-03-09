export function StatCell({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="py-2 px-2 text-center">
      <div className="text-caption-sm text-foreground-tertiary">{label}</div>
      <div className="text-body-sm font-medium mt-0.5">{value}</div>
    </div>
  )
}
