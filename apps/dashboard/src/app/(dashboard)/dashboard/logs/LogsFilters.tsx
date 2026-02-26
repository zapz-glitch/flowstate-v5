'use client'

import { useRouter, useSearchParams } from 'next/navigation'
import { Key, X, ChevronDown, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'

interface ApiKey {
  id: string
  name: string
  keyPrefix: string
}

interface LogsFiltersProps {
  apiKeys: ApiKey[]
  selectedApiKeyId?: string
}

export default function LogsFilters({ apiKeys, selectedApiKeyId }: LogsFiltersProps) {
  const router = useRouter()
  const searchParams = useSearchParams()

  const handleApiKeyChange = (value: string | null) => {
    const params = new URLSearchParams(searchParams.toString())
    if (value === null) {
      params.delete('apiKeyId')
    } else {
      params.set('apiKeyId', value)
    }
    // Reset to page 1 when changing filter
    params.delete('page')
    router.push(`/dashboard/logs?${params.toString()}`)
  }

  const clearFilters = () => {
    router.push('/dashboard/logs')
  }

  const hasFilters = !!selectedApiKeyId
  const selectedKey = apiKeys.find((k) => k.id === selectedApiKeyId)

  return (
    <div className="flex items-center gap-4">
      <div className="flex items-center gap-2">
        <Key className="w-4 h-4 text-foreground-tertiary" />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="h-9 px-3 justify-between min-w-[200px]">
              <span className="truncate">
                {selectedKey ? selectedKey.name : 'All API Keys'}
              </span>
              <ChevronDown className="w-4 h-4 ml-2 opacity-50" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-[200px]">
            <DropdownMenuItem
              onClick={() => handleApiKeyChange(null)}
              className={cn(!selectedApiKeyId && 'bg-accent')}
            >
              <Check className={cn('w-4 h-4 mr-2', selectedApiKeyId && 'opacity-0')} />
              All API Keys
            </DropdownMenuItem>
            {apiKeys.map((key) => (
              <DropdownMenuItem
                key={key.id}
                onClick={() => handleApiKeyChange(key.id)}
                className={cn(selectedApiKeyId === key.id && 'bg-accent')}
              >
                <Check className={cn('w-4 h-4 mr-2', selectedApiKeyId !== key.id && 'opacity-0')} />
                <span className="truncate">{key.name}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {hasFilters && (
        <Button
          variant="ghost"
          size="sm"
          onClick={clearFilters}
          className="h-9 px-3 text-foreground-tertiary hover:text-foreground"
        >
          <X className="w-4 h-4 mr-1" />
          Clear filters
        </Button>
      )}
    </div>
  )
}
