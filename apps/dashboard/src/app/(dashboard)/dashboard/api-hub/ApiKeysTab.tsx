'use client'

import { useState, useEffect, useCallback } from 'react'
import { Plus, Copy, Trash2, ToggleLeft, ToggleRight, Check, Loader2 } from 'lucide-react'
import {
  getApiKeys,
  createApiKey,
  deleteApiKey,
  toggleApiKey,
  getUser,
  PLAN_LIMITS,
  type ApiKey,
} from '@/lib/client-api'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

export default function ApiKeysTab() {
  const [keys, setKeys] = useState<ApiKey[]>([])
  const [plan, setPlan] = useState<string>('free')
  const [limits, setLimits] = useState({ monthlyRequests: 100, maxApiKeys: 1 })
  const [canCreateMore, setCanCreateMore] = useState(false)
  const [loading, setLoading] = useState(true)

  const [showCreate, setShowCreate] = useState(false)
  const [newKeyName, setNewKeyName] = useState('')
  const [newKey, setNewKey] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState('')

  const load = useCallback(async () => {
    try {
      const [keysData, userData] = await Promise.all([getApiKeys(), getUser()])
      const userPlan = (userData.plan || 'free') as keyof typeof PLAN_LIMITS
      const planLimits = PLAN_LIMITS[userPlan]
      setKeys(keysData)
      setPlan(userPlan)
      setLimits(planLimits)
      setCanCreateMore(planLimits.maxApiKeys === -1 || keysData.length < planLimits.maxApiKeys)
    } catch {
      setError('Failed to load API keys')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setCreating(true)
    try {
      const result = await createApiKey(newKeyName || 'Default Key')
      setNewKey(result.key)
      setNewKeyName('')
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create API key')
    } finally {
      setCreating(false)
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
    try {
      await deleteApiKey(id)
      await load()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete API key')
    }
  }

  const handleToggle = async (id: string, currentState: boolean) => {
    try {
      await toggleApiKey(id, !currentState)
      await load()
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to toggle API key')
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {error && !showCreate && (
        <p className="text-body-sm text-red-500">{error}</p>
      )}

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

      {/* New key created */}
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
              <Button type="submit" disabled={creating} className="h-11 px-5">
                {creating ? 'Creating...' : 'Create'}
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
            {error && <p className="text-body-sm text-red-500 mt-3">{error}</p>}
          </CardContent>
        </Card>
      )}

      {/* Create button */}
      {!showCreate && !newKey && (
        canCreateMore ? (
          <Button onClick={() => setShowCreate(true)} className="gap-2">
            <Plus className="w-4 h-4" />
            Create API Key
          </Button>
        ) : (
          <p className="text-body-sm text-foreground-tertiary">
            You&apos;ve reached your plan&apos;s API key limit ({limits.maxApiKeys === -1 ? 'unlimited' : limits.maxApiKeys}).
            Upgrade your plan to create more keys.
          </p>
        )
      )}

      {/* Keys list */}
      <Card>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border bg-secondary/30">
                <th className="text-left px-6 py-3 text-caption font-medium text-foreground-tertiary">Name</th>
                <th className="text-left px-6 py-3 text-caption font-medium text-foreground-tertiary">Key</th>
                <th className="text-left px-6 py-3 text-caption font-medium text-foreground-tertiary">Usage</th>
                <th className="text-left px-6 py-3 text-caption font-medium text-foreground-tertiary">Status</th>
                <th className="text-left px-6 py-3 text-caption font-medium text-foreground-tertiary">Last Used</th>
                <th className="text-right px-6 py-3 text-caption font-medium text-foreground-tertiary">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {keys.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-6 py-8 text-center text-body-sm text-foreground-tertiary">
                    No API keys yet. Create one to get started.
                  </td>
                </tr>
              ) : (
                keys.map((key) => (
                  <tr key={key.id} className="hover:bg-secondary/30 transition-colors">
                    <td className="px-6 py-4 text-body font-medium text-foreground">{key.name}</td>
                    <td className="px-6 py-4">
                      <code className="text-body-sm text-foreground-secondary font-mono bg-secondary px-2 py-0.5 rounded-lg">
                        {key.keyPrefix}...
                      </code>
                    </td>
                    <td className="px-6 py-4 text-body-sm text-foreground-secondary">
                      {key.currentUsage.toLocaleString()}
                      {key.monthlyQuota && (
                        <span className="text-foreground-tertiary"> / {key.monthlyQuota.toLocaleString()}</span>
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
                      {key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleDateString() : 'Never'}
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
