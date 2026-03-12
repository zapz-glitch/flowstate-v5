'use client'

import { useSearchParams, useRouter } from 'next/navigation'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Key, BarChart3, Plug, BookOpen, ExternalLink } from 'lucide-react'
import ApiKeysTab from './ApiKeysTab'
import UsageTab from './UsageTab'
import IntegrationsTab from './IntegrationsTab'

const VALID_TABS = ['api-keys', 'usage', 'integrations'] as const
type TabValue = (typeof VALID_TABS)[number]

export default function ApiHubPage() {
  const searchParams = useSearchParams()
  const router = useRouter()

  const tabParam = searchParams.get('tab')
  const activeTab: TabValue = VALID_TABS.includes(tabParam as TabValue)
    ? (tabParam as TabValue)
    : 'api-keys'

  const onTabChange = (value: string) => {
    const params = new URLSearchParams(searchParams.toString())
    if (value === 'api-keys') {
      params.delete('tab')
    } else {
      params.set('tab', value)
    }
    const qs = params.toString()
    router.replace(`/dashboard/api-hub${qs ? `?${qs}` : ''}`, { scroll: false })
  }

  return (
    <div className="space-y-8 animate-in fade-in duration-500">
      {/* Header */}
      <div className="space-y-1">
        <h1 className="text-heading-lg text-foreground tracking-tight">API Hub</h1>
        <p className="text-body text-foreground-tertiary">
          Manage your API keys, monitor usage, and configure integrations
        </p>
      </div>

      {/* Tabs */}
      <Tabs value={activeTab} onValueChange={onTabChange} className="space-y-6">
        <TabsList>
          <TabsTrigger value="api-keys" className="gap-1.5">
            <Key className="w-4 h-4" />
            API Keys
          </TabsTrigger>
          <TabsTrigger value="usage" className="gap-1.5">
            <BarChart3 className="w-4 h-4" />
            Usage
          </TabsTrigger>
          <TabsTrigger value="integrations" className="gap-1.5">
            <Plug className="w-4 h-4" />
            Integrations
          </TabsTrigger>
          <a
            href="/docs"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            <BookOpen className="w-4 h-4" />
            API Docs
            <ExternalLink className="w-3 h-3" />
          </a>
        </TabsList>

        <TabsContent value="api-keys">
          <ApiKeysTab />
        </TabsContent>

        <TabsContent value="usage">
          <UsageTab />
        </TabsContent>

        <TabsContent value="integrations">
          <IntegrationsTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}
