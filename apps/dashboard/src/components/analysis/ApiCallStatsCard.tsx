'use client'

import { Activity, Database, Globe, Brain } from 'lucide-react'
import type { ApiCallStats } from './shared-types'

interface ApiCallStatsCardProps {
  stats: ApiCallStats
}

export function ApiCallStatsCard({ stats }: ApiCallStatsCardProps) {
  return (
    <div className="rounded-xl overflow-hidden border border-border">
      <div className="px-6 py-4">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-8 h-8 rounded-lg bg-violet-500/10 flex items-center justify-center">
            <Activity className="w-4 h-4 text-violet-600" />
          </div>
          <div>
            <h3 className="text-body font-semibold text-foreground">API Call Statistics</h3>
            <p className="text-caption-sm text-foreground-tertiary">
              {stats.totalExternalCalls} total external calls
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {/* CoreLogic */}
          <div className="rounded-lg bg-muted/40 p-3">
            <div className="flex items-center gap-2 mb-2">
              <Database className="w-3.5 h-3.5 text-blue-500" />
              <span className="text-caption font-medium text-foreground-secondary">CoreLogic</span>
              <span className="ml-auto text-body-sm font-semibold tabular-nums">{stats.corelogic.total}</span>
            </div>
            {stats.corelogic.endpoints.length > 0 && (
              <div className="space-y-1">
                {stats.corelogic.endpoints.map((ep) => (
                  <div key={ep.endpoint} className="flex items-center justify-between text-caption-sm">
                    <span className="text-foreground-tertiary truncate mr-2">{ep.endpoint}</span>
                    <span className="text-foreground-secondary tabular-nums flex-shrink-0">{ep.count}</span>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Firecrawl */}
          <div className="rounded-lg bg-muted/40 p-3">
            <div className="flex items-center gap-2 mb-2">
              <Globe className="w-3.5 h-3.5 text-orange-500" />
              <span className="text-caption font-medium text-foreground-secondary">Firecrawl</span>
              <span className="ml-auto text-body-sm font-semibold tabular-nums">{stats.firecrawl.total}</span>
            </div>
            <div className="space-y-1">
              <div className="flex items-center justify-between text-caption-sm">
                <span className="text-foreground-tertiary">Scrape requests</span>
                <span className="text-foreground-secondary tabular-nums">{stats.firecrawl.total}</span>
              </div>
              <div className="flex items-center justify-between text-caption-sm">
                <span className="text-foreground-tertiary">Cache hits</span>
                <span className="text-foreground-secondary tabular-nums">{stats.firecrawl.cached}</span>
              </div>
            </div>
          </div>

          {/* LLM */}
          <div className="rounded-lg bg-muted/40 p-3">
            <div className="flex items-center gap-2 mb-2">
              <Brain className="w-3.5 h-3.5 text-purple-500" />
              <span className="text-caption font-medium text-foreground-secondary">LLM</span>
              <span className="ml-auto text-body-sm font-semibold tabular-nums">{stats.llm.total}</span>
            </div>
            {stats.llm.breakdown.length > 0 ? (
              <div className="space-y-1">
                {stats.llm.breakdown.map((item) => (
                  <div key={item.purpose} className="flex items-center justify-between text-caption-sm">
                    <span className="text-foreground-tertiary">{formatPurpose(item.purpose)}</span>
                    <span className="text-foreground-secondary tabular-nums">{item.count}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-caption-sm text-foreground-tertiary">No LLM calls</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function formatPurpose(purpose: string): string {
  return purpose
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}
