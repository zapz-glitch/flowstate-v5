'use client'

import { toast } from 'sonner'

import { useState, useCallback, useRef, useEffect } from 'react'
import { MapPin } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { searchTypeahead, type TypeaheadResult } from '@/lib/client-api'
import { cn } from '@/lib/utils'

interface AddressAutocompleteProps {
  value: string
  onChange: (value: string) => void
  onSelect?: (result: TypeaheadResult) => void
  onSubmit?: () => void
  placeholder?: string
  className?: string
  autoFocus?: boolean
  disabled?: boolean
}

export function AddressAutocomplete({
  value,
  onChange,
  onSelect,
  onSubmit,
  placeholder = '123 Main St, Tampa, FL 33607',
  className,
  autoFocus,
  disabled,
}: AddressAutocompleteProps) {
  const [results, setResults] = useState<TypeaheadResult[]>([])
  const [isOpen, setIsOpen] = useState(false)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [isLoading, setIsLoading] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Track whether the last change was a selection (skip fetching)
  const skipNextFetch = useRef(false)

  const fetchResults = useCallback(async (input: string) => {
    if (input.length < 3) {
      setResults([])
      setIsOpen(false)
      return
    }

    setIsLoading(true)
    try {
      const data = await searchTypeahead(input)
      setResults(data)
      setIsOpen(data.length > 0)
      setActiveIndex(-1)
    } catch {
      setResults([])
      setIsOpen(false)
      toast.error('Address provider unavailable. Retry the search shortly.')
    } finally {
      setIsLoading(false)
    }
  }, [])

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value
      onChange(val)

      if (skipNextFetch.current) {
        skipNextFetch.current = false
        return
      }

      // Debounce API calls
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => fetchResults(val), 250)
    },
    [onChange, fetchResults],
  )

  const handleSelect = useCallback(
    (result: TypeaheadResult) => {
      skipNextFetch.current = true
      onChange(result.address)
      setIsOpen(false)
      setResults([])
      onSelect?.(result)
    },
    [onChange, onSelect],
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!isOpen || results.length === 0) {
        if (e.key === 'Enter') {
          onSubmit?.()
        }
        return
      }

      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault()
          setActiveIndex((i) => (i < results.length - 1 ? i + 1 : 0))
          break
        case 'ArrowUp':
          e.preventDefault()
          setActiveIndex((i) => (i > 0 ? i - 1 : results.length - 1))
          break
        case 'Enter':
          e.preventDefault()
          if (activeIndex >= 0 && activeIndex < results.length) {
            handleSelect(results[activeIndex])
          } else {
            setIsOpen(false)
            onSubmit?.()
          }
          break
        case 'Escape':
          setIsOpen(false)
          setActiveIndex(-1)
          break
      }
    },
    [isOpen, results, activeIndex, handleSelect, onSubmit],
  )

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  // Cleanup debounce on unmount
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
  }, [])

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      <Input
        type="text"
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onFocus={() => {
          if (results.length > 0) setIsOpen(true)
        }}
        placeholder={placeholder}
        autoFocus={autoFocus}
        disabled={disabled}
        autoComplete="off"
      />

      {isOpen && results.length > 0 && (
        <div className="absolute z-50 top-full left-0 right-0 mt-1 rounded-lg border border-border bg-background shadow-xl overflow-hidden">
          <ul role="listbox" className="py-1 max-h-[280px] overflow-y-auto">
            {results.map((result, index) => (
              <li
                key={`${result.clip}-${index}`}
                role="option"
                aria-selected={index === activeIndex}
                className={cn(
                  'flex items-start gap-2.5 px-3 py-2 cursor-pointer text-sm transition-colors',
                  index === activeIndex
                    ? 'bg-primary/10 text-foreground'
                    : 'text-foreground-secondary hover:bg-muted/60',
                )}
                onMouseEnter={() => setActiveIndex(index)}
                onMouseDown={(e) => {
                  e.preventDefault() // Prevent input blur
                  handleSelect(result)
                }}
              >
                <MapPin className="w-3.5 h-3.5 text-foreground-tertiary mt-0.5 flex-shrink-0" />
                <div className="min-w-0">
                  <div className="font-medium truncate">{result.addressLine1}</div>
                  <div className="text-xs text-foreground-tertiary">
                    {result.city}, {result.state} {result.zip}
                  </div>
                </div>
              </li>
            ))}
          </ul>
          {isLoading && (
            <div className="px-3 py-1.5 text-xs text-foreground-tertiary border-t border-border">
              Loading...
            </div>
          )}
        </div>
      )}
    </div>
  )
}
