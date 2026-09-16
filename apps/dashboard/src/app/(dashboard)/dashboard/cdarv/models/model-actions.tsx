'use client'

import { useState, useTransition } from 'react'
import { Button } from '@/components/ui/button'
import {
  activateShadow, buildDataset, deactivateShadow, trainModel,
} from '../actions'

export function ModelActions({
  kind, enabled, modelId, datasetId,
}: {
  kind: 'build-dataset' | 'train' | 'activate' | 'deactivate'
  enabled: boolean
  modelId?: string
  datasetId?: string
}) {
  const [pending, startTransition] = useTransition()
  const [message, setMessage] = useState<string | null>(null)

  const run = (fn: () => Promise<{ ok: boolean; message?: string }>) =>
    startTransition(async () => {
      const r = await fn()
      setMessage(r.message ?? null)
    })

  if (kind === 'build-dataset') {
    return (
      <span className="flex items-center gap-2">
        <Button
          size="sm" variant="outline" disabled={pending || !enabled}
          onClick={() => run(() => buildDataset('baseline'))}
        >
          Build dataset
        </Button>
        {message && <span className="text-caption text-foreground-tertiary">{message}</span>}
      </span>
    )
  }
  if (kind === 'train') {
    return (
      <Button
        size="sm" variant="outline" disabled={pending || !enabled}
        onClick={() => run(() => trainModel(datasetId!))}
      >
        Train new version
      </Button>
    )
  }
  if (kind === 'activate') {
    return (
      <Button
        size="sm" variant="outline" disabled={pending || !enabled}
        onClick={() => run(() => activateShadow(modelId!))}
      >
        Activate shadow
      </Button>
    )
  }
  return (
    <span className="flex items-center gap-2">
      <Button
        size="sm" variant="destructive" disabled={pending || !enabled}
        onClick={() => run(deactivateShadow)}
      >
        Disable shadow
      </Button>
      {message && <span className="text-caption text-foreground-tertiary">{message}</span>}
    </span>
  )
}
