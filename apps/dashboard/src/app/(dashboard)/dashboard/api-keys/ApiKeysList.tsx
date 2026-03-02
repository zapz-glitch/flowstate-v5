'use client'

import { useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Plus, Copy, Trash2, ToggleLeft, ToggleRight, Check } from 'lucide-react'
import { createApiKey, deleteApiKey, toggleApiKey } from './actions'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

interface ApiKey {
  id: string
  name: string
  keyPrefix: string
  monthlyQuota: number | null
  currentUsage: number
  quotaResetAt: string
  isActive: boolean
  lastUsedAt: string | null
  createdAt: string
}

interface ApiKeysListProps {
  keys: ApiKey[]
  plan: string
  limits: {
    monthlyRequests: number
    maxApiKeys: number
  }
  canCreateMore: boolean
}

export default function ApiKeysList({
  keys,
  plan,
  limits,
  canCreateMore,
}: ApiKeysListProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [showCreate, setShowCreate] = useState(false)
  const [newKeyName, setNewKeyName] = useState('')
  const [newKey, setNewKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  // Auto-open create form if ?create=true is in URL
  useEffect(() => {
    if (searchParams.get('create') === 'true' && canCreateMore) {
      setShowCreate(true)
      // Clean up the URL
      router.replace('/dashboard/api-keys', { scroll: false })
    }
  }, [searchParams, canCreateMore, router])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const result = await createApiKey(newKeyName || 'Default Key')
      if (result.success && result.data) {
        setNewKey(result.data.key)
        setNewKeyName('')
        router.refresh()
      } else {
        setError(result.error || 'Failed to create API key')
      }
    } catch {
      setError('An unexpected error occurred')
    } finally {
      setLoading(false)
    }
  }

  const handleCopy = async () => {
    if (newKey) {
      await navigator.clipboard.writeText(newKey)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this API key?')) return

    const result = await deleteApiKey(id)
    if (result.success) {
      router.refresh()
    } else {
      alert(result.error || 'Failed to delete API key')
    }
  }

  const handleToggle = async (id: string, currentState: boolean) => {
    const result = await toggleApiKey(id, !currentState)
    if (result.success) {
      router.refresh()
    } else {
      alert(result.error || 'Failed to toggle API key')
    }
  }

  return (
    <div className="space-y-6">
      {/* Plan info */}
      <Card className="border-primary/20 bg-primary/[0.02]">
        <CardContent className="p-5">
          <div className="flex items-center justify-between">
            <div>
              <span className="text-body font-medium text-primary">
                {plan.charAt(0).toUpperCase() + plan.slice(1)} Plan
              </span>
              <p className="text-body-sm text-foreground-secondary mt-1">
                {limits.maxApiKeys === -1
                  ? 'Unlimited API keys'
                  : `${keys.length} / ${limits.maxApiKeys} API keys`}
                {' | '}
                {limits.monthlyRequests === -1
                  ? 'Unlimited requests'
                  : `${limits.monthlyRequests.toLocaleString()} requests/month`}
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* New key modal */}
      {newKey && (
        <Card className="border-emerald-500/30 bg-emerald-500/5">
          <CardContent className="p-5">
            <h3 className="text-body font-semibold text-emerald-600 dark:text-emerald-400 mb-2">
              API Key Created!
            </h3>
            <p className="text-body-sm text-emerald-600/80 dark:text-emerald-400/80 mb-4">
              Copy your API key now. You won&apos;t be able to see it again.
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 bg-card px-4 py-3 rounded-xl border border-emerald-500/30 text-body-sm font-mono text-foreground">
                {newKey}
              </code>
              <Button
                onClick={handleCopy}
                size="icon"
                className={cn(
                  'h-12 w-12 rounded-xl',
                  copied ? 'bg-emerald-600' : 'bg-emerald-500 hover:bg-emerald-600'
                )}
              >
                {copied ? <Check className="w-5 h-5" /> : <Copy className="w-5 h-5" />}
              </Button>
            </div>
            <button
              onClick={() => {
                setNewKey(null)
                setShowCreate(false)
              }}
              className="mt-4 text-body-sm text-emerald-600 dark:text-emerald-400 hover:underline"
            >
              I&apos;ve copied the key
            </button>
          </CardContent>
        </Card>
      )}

      {/* Create form */}
      {showCreate && !newKey && (
        <Card>
          <CardContent className="p-5">
            <form onSubmit={handleCreate} className="flex items-end gap-4">
              <div className="flex-1">
                <Label htmlFor="keyName" className="text-caption text-foreground-tertiary mb-2 block">
                  Key Name (optional)
                </Label>
                <Input
                  id="keyName"
                  type="text"
                  value={newKeyName}
                  onChange={(e) => setNewKeyName(e.target.value)}
                  placeholder="e.g., Production API Key"
                  className="h-11"
                />
              </div>
              <Button type="submit" disabled={loading} className="h-11 px-5">
                {loading ? 'Creating...' : 'Create'}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => setShowCreate(false)}
                className="h-11"
              >
                Cancel
              </Button>
            </form>
            {error && (
              <p className="text-body-sm text-red-500 mt-3">{error}</p>
            )}
          </CardContent>
        </Card>
      )}

      {/* Create button */}
      {!showCreate && !newKey && canCreateMore && (
        <Button onClick={() => setShowCreate(true)} className="gap-2">
          <Plus className="w-4 h-4" />
          Create API Key
        </Button>
      )}

      {/* Keys list */}
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border bg-secondary/30">
                <th className="text-left px-6 py-3 text-caption font-medium text-foreground-tertiary">
                  Name
                </th>
                <th className="text-left px-6 py-3 text-caption font-medium text-foreground-tertiary">
                  Key
                </th>
                <th className="text-left px-6 py-3 text-caption font-medium text-foreground-tertiary">
                  Usage
                </th>
                <th className="text-left px-6 py-3 text-caption font-medium text-foreground-tertiary">
                  Status
                </th>
                <th className="text-left px-6 py-3 text-caption font-medium text-foreground-tertiary">
                  Last Used
                </th>
                <th className="text-right px-6 py-3 text-caption font-medium text-foreground-tertiary">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {keys.length === 0 ? (
                <tr>
                  <td
                    colSpan={6}
                    className="px-6 py-8 text-center text-body-sm text-foreground-tertiary"
                  >
                    No API keys yet. Create one to get started.
                  </td>
                </tr>
              ) : (
                keys.map((key) => (
                  <tr key={key.id} className="hover:bg-secondary/30 transition-colors">
                    <td className="px-6 py-4 text-body font-medium text-foreground">
                      {key.name}
                    </td>
                    <td className="px-6 py-4">
                      <code className="text-body-sm text-foreground-secondary font-mono bg-secondary px-2 py-0.5 rounded-lg">
                        {key.keyPrefix}...
                      </code>
                    </td>
                    <td className="px-6 py-4 text-body-sm text-foreground-secondary">
                      {key.currentUsage.toLocaleString()}
                      {key.monthlyQuota && (
                        <span className="text-foreground-tertiary">
                          {' '}
                          / {key.monthlyQuota.toLocaleString()}
                        </span>
                      )}
                    </td>
                    <td className="px-6 py-4">
                      <Badge
                        variant="outline"
                        className={cn(
                          'text-caption-sm',
                          key.isActive
                            ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30'
                            : 'bg-secondary text-foreground-tertiary'
                        )}
                      >
                        {key.isActive ? 'Active' : 'Disabled'}
                      </Badge>
                    </td>
                    <td className="px-6 py-4 text-body-sm text-foreground-secondary">
                      {key.lastUsedAt
                        ? new Date(key.lastUsedAt).toLocaleDateString()
                        : 'Never'}
                    </td>
                    <td className="px-6 py-4 text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          onClick={() => handleToggle(key.id, key.isActive)}
                          className="p-2 text-foreground-tertiary hover:text-foreground transition-colors rounded-lg hover:bg-secondary"
                          title={key.isActive ? 'Disable' : 'Enable'}
                        >
                          {key.isActive ? (
                            <ToggleRight className="w-5 h-5 text-emerald-500" />
                          ) : (
                            <ToggleLeft className="w-5 h-5" />
                          )}
                        </button>
                        <button
                          onClick={() => handleDelete(key.id)}
                          className="p-2 text-foreground-tertiary hover:text-red-500 transition-colors rounded-lg hover:bg-red-500/10"
                          title="Delete"
                        >
                          <Trash2 className="w-5 h-5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
