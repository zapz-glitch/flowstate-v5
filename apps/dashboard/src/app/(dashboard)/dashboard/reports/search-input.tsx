'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useRef, useTransition } from 'react'
import { Search, X } from 'lucide-react'

export function ReportSearchInput() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [isPending, startTransition] = useTransition()
  const currentSearch = searchParams.get('search') || ''
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const navigate = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParams.toString())
      if (value) {
        params.set('search', value)
        params.delete('page')
      } else {
        params.delete('search')
      }
      startTransition(() => {
        router.push(`/dashboard/reports?${params.toString()}`)
      })
    },
    [router, searchParams]
  )

  const handleChange = useCallback(
    (value: string) => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => navigate(value), 300)
    },
    [navigate]
  )

  const handleClear = useCallback(() => {
    if (inputRef.current) inputRef.current.value = ''
    if (debounceRef.current) clearTimeout(debounceRef.current)
    navigate('')
  }, [navigate])

  return (
    <div className="relative">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-foreground-tertiary" />
      <input
        ref={inputRef}
        type="text"
        placeholder="Search by address, city, or state..."
        defaultValue={currentSearch}
        onChange={(e) => handleChange(e.target.value)}
        className="w-full pl-9 pr-9 py-2 rounded-lg border border-border bg-background text-body-sm text-foreground placeholder:text-foreground-tertiary focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-colors"
      />
      {(currentSearch || isPending) && (
        <div className="absolute right-3 top-1/2 -translate-y-1/2">
          {isPending ? (
            <div className="w-4 h-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin" />
          ) : (
            <button
              type="button"
              onClick={handleClear}
              className="text-foreground-tertiary hover:text-foreground transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      )}
    </div>
  )
}
