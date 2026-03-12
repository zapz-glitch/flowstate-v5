'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  Plug,
  Loader2,
  Copy,
  Check,
  AlertCircle,
  ExternalLink,
  Trash2,
  TestTube,
} from 'lucide-react'
import {
  getGHLSettings,
  saveGHLSettings,
  deleteGHLSettings,
  testGHLConnection,
  type GHLSettingsData,
  type GHLSettingsInput,
} from '@/lib/client-api'

interface FormState {
  apiToken: string
  locationId: string
  isEnabled: boolean
  fieldMappings: Record<string, string>
  monetaryValueField: string
}

export default function IntegrationsTab() {
  const [settings, setSettings] = useState<GHLSettingsData | null>(null)
  const [isConfigured, setIsConfigured] = useState(false)

  const [form, setForm] = useState<FormState>({
    apiToken: '',
    locationId: '',
    isEnabled: true,
    fieldMappings: {},
    monetaryValueField: 'arv',
  })
  const [dirty, setDirty] = useState(false)

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null)
  const [copied, setCopied] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const settingsRes = await getGHLSettings()
      setSettings(settingsRes.settings)
      setIsConfigured(settingsRes.isConfigured)

      if (settingsRes.settings) {
        setForm({
          apiToken: '',
          locationId: settingsRes.settings.locationId,
          isEnabled: settingsRes.settings.isEnabled,
          fieldMappings: settingsRes.settings.fieldMappings || {},
          monetaryValueField: settingsRes.settings.monetaryValueField || 'arv',
        })
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load settings')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    if (success) {
      const t = setTimeout(() => setSuccess(null), 5000)
      return () => clearTimeout(t)
    }
  }, [success])

  useEffect(() => {
    if (testResult) {
      const t = setTimeout(() => setTestResult(null), 8000)
      return () => clearTimeout(t)
    }
  }, [testResult])

  const handleSave = async () => {
    setSaving(true)
    setError(null)
    setSuccess(null)
    try {
      const input: GHLSettingsInput = {
        locationId: form.locationId,
        isEnabled: form.isEnabled,
        fieldMappings: form.fieldMappings,
        monetaryValueField: form.monetaryValueField,
      }
      if (form.apiToken) {
        input.apiToken = form.apiToken
      }
      const res = await saveGHLSettings(input)
      setSettings(res.settings)
      setIsConfigured(res.isConfigured)
      setForm((f) => ({ ...f, apiToken: '' }))
      setDirty(false)
      setSuccess('Settings saved successfully')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!confirm('Remove GHL integration? This will disable the webhook.')) return
    setDeleting(true)
    setError(null)
    try {
      await deleteGHLSettings()
      setSettings(null)
      setIsConfigured(false)
      setForm({
        apiToken: '',
        locationId: '',
        isEnabled: true,
        fieldMappings: {},
        monetaryValueField: 'arv',
      })
      setDirty(false)
      setSuccess('Integration removed')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to remove')
    } finally {
      setDeleting(false)
    }
  }

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await testGHLConnection()
      setTestResult(result)
    } catch (e) {
      setTestResult({ success: false, error: e instanceof Error ? e.message : 'Test failed' })
    } finally {
      setTesting(false)
    }
  }

  const handleCopyWebhook = async () => {
    if (!settings?.webhookUrl) return
    await navigator.clipboard.writeText(settings.webhookUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const updateForm = (updates: Partial<FormState>) => {
    setForm((f) => ({ ...f, ...updates }))
    setDirty(true)
  }

  const updateFieldMapping = (key: string, value: string) => {
    setForm((f) => ({
      ...f,
      fieldMappings: { ...f.fieldMappings, [key]: value },
    }))
    setDirty(true)
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="max-w-3xl space-y-6">
      {/* Error / Success Messages */}
      {error && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 text-red-500 text-sm">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}
      {success && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-green-500/10 text-green-500 text-sm">
          <Check className="w-4 h-4 flex-shrink-0" />
          {success}
        </div>
      )}

      {/* GoHighLevel Section */}
      <div className="rounded-xl border border-border bg-card">
        <div className="flex items-center justify-between p-5 border-b border-border">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-blue-500/10 flex items-center justify-center">
              <span className="text-blue-500 font-bold text-xs">GHL</span>
            </div>
            <div>
              <h2 className="text-sm font-semibold text-foreground">GoHighLevel</h2>
              <p className="text-xs text-muted-foreground">
                Push analysis results to GHL opportunities via webhook
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {isConfigured && (
              <>
                <button
                  onClick={() => updateForm({ isEnabled: !form.isEnabled })}
                  className={`relative w-10 h-5 rounded-full transition-colors ${
                    form.isEnabled ? 'bg-primary' : 'bg-border'
                  }`}
                  title={form.isEnabled ? 'Disable integration' : 'Enable integration'}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                      form.isEnabled ? 'translate-x-5' : ''
                    }`}
                  />
                </button>
                <button
                  onClick={handleDelete}
                  disabled={deleting}
                  className="p-1.5 rounded-lg text-muted-foreground hover:text-red-500 hover:bg-red-500/10 transition-colors"
                  title="Remove integration"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </>
            )}
          </div>
        </div>

        <div className="p-5 space-y-5">
          {/* Connection Settings */}
          <div className="space-y-4">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Connection
            </h3>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">
                Private Integration Token
              </label>
              <input
                type="password"
                placeholder={
                  settings?.hasApiToken
                    ? `Current: ${settings.apiTokenMasked} (enter new to update)`
                    : 'Enter your GHL Private Integration Token'
                }
                value={form.apiToken}
                onChange={(e) => updateForm({ apiToken: e.target.value })}
                className="w-full h-9 px-3 rounded-lg border border-border bg-background text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
              />
              <p className="text-xs text-muted-foreground">
                Found in GHL &gt; Settings &gt; Integrations &gt; Private Integrations
              </p>
            </div>

            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">Location ID</label>
              <input
                type="text"
                placeholder="e.g., abc123def456"
                value={form.locationId}
                onChange={(e) => updateForm({ locationId: e.target.value })}
                className="w-full h-9 px-3 rounded-lg border border-border bg-background text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
              />
              <p className="text-xs text-muted-foreground">
                Your GHL sub-account / location ID
              </p>
            </div>

            {isConfigured && (
              <div className="flex items-center gap-3">
                <button
                  onClick={handleTest}
                  disabled={testing}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-border text-sm font-medium text-foreground hover:bg-secondary transition-colors disabled:opacity-50"
                >
                  {testing ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <TestTube className="w-3.5 h-3.5" />
                  )}
                  Test Connection
                </button>
                {testResult && (
                  <span
                    className={`text-xs ${
                      testResult.success ? 'text-green-500' : 'text-red-500'
                    }`}
                  >
                    {testResult.success ? 'Connection successful' : testResult.error || 'Failed'}
                  </span>
                )}
              </div>
            )}
          </div>

          {/* Webhook URL */}
          {isConfigured && settings?.webhookUrl && (
            <div className="space-y-4 pt-2">
              <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                Webhook URL
              </h3>
              <div className="space-y-1.5">
                <p className="text-xs text-muted-foreground">
                  Paste this URL into your GHL workflow&apos;s &quot;Custom Webhook&quot; action
                </p>
                <div className="flex items-center gap-2">
                  <code className="flex-1 px-3 py-2 rounded-lg bg-secondary text-xs text-foreground font-mono break-all">
                    {settings.webhookUrl}
                  </code>
                  <button
                    onClick={handleCopyWebhook}
                    className="p-2 rounded-lg border border-border hover:bg-secondary transition-colors flex-shrink-0"
                    title="Copy webhook URL"
                  >
                    {copied ? (
                      <Check className="w-4 h-4 text-green-500" />
                    ) : (
                      <Copy className="w-4 h-4 text-muted-foreground" />
                    )}
                  </button>
                </div>
                <div className="space-y-2 text-xs text-muted-foreground">
                  <p>
                    <strong className="text-foreground">Required header:</strong>{' '}
                    <code className="text-[10px] bg-secondary px-1 py-0.5 rounded">
                      X-API-Key: your_flowstate_api_key
                    </code>
                  </p>
                  <p>
                    Use an <strong className="text-foreground">Opportunity trigger</strong> (e.g.
                    Pipeline Stage Changed). The property address is read from the{' '}
                    <code className="text-[10px] bg-secondary px-1 py-0.5 rounded">
                      property_details
                    </code>{' '}
                    opportunity custom field.
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Monetary Value Mapping */}
          <div className="space-y-4 pt-2">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Opportunity Value
            </h3>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">
                Set Monetary Value From
              </label>
              <select
                value={form.monetaryValueField}
                onChange={(e) => updateForm({ monetaryValueField: e.target.value })}
                className="w-full h-9 px-3 rounded-lg border border-border bg-background text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
              >
                <option value="">Don&apos;t set monetary value</option>
                <option value="arv">ARV</option>
                <option value="projectedProfit">Projected Profit</option>
                <option value="buyPrice">Buy Price</option>
              </select>
              <p className="text-xs text-muted-foreground">
                This value will be set as the opportunity&apos;s monetary value in GHL
              </p>
            </div>
          </div>

          {/* Custom Field Mapping */}
          <div className="space-y-4 pt-2">
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Custom Field Mapping
            </h3>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">
                Property Address Field ID
              </label>
              <input
                type="text"
                placeholder="GHL custom field ID for property address"
                value={form.fieldMappings['propertyAddress'] || ''}
                onChange={(e) => updateFieldMapping('propertyAddress', e.target.value)}
                className="w-full h-9 px-3 rounded-lg border border-border bg-background text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
              />
              <p className="text-xs text-muted-foreground">
                The GHL opportunity custom field ID that contains the property address (e.g. &quot;3301 E 24th Ave, Tampa, FL 33605&quot;).
                The webhook reads this field to know which property to analyze.
              </p>
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-foreground">
                Report URL Field ID
              </label>
              <input
                type="text"
                placeholder="GHL custom field ID for report link"
                value={form.fieldMappings['reportUrl'] || ''}
                onChange={(e) => updateFieldMapping('reportUrl', e.target.value)}
                className="w-full h-9 px-3 rounded-lg border border-border bg-background text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
              />
              <p className="text-xs text-muted-foreground">
                The analysis report URL will be pushed to this GHL opportunity custom field.{' '}
                <a
                  href="https://help.gohighlevel.com/support/solutions/articles/155000000521-how-to-use-custom-fields-for-opportunities"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline inline-flex items-center gap-0.5"
                >
                  How to get field IDs
                  <ExternalLink className="w-3 h-3" />
                </a>
              </p>
            </div>
          </div>

          {/* Save Button */}
          <div className="flex items-center justify-end gap-2 pt-3 border-t border-border">
            {dirty && (
              <button
                onClick={() => {
                  load()
                  setDirty(false)
                }}
                className="px-3 py-1.5 rounded-lg text-sm font-medium text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
              >
                Cancel
              </button>
            )}
            <button
              onClick={handleSave}
              disabled={saving || (!dirty && isConfigured)}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              {isConfigured ? 'Save Changes' : 'Connect'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
