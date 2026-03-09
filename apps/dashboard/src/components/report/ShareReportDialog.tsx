'use client'

import { useState, useEffect, useCallback } from 'react'
import { Copy, Check, Loader2, Link2, Lock, Eye, EyeOff } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  getReportShareSettings,
  updateReportShareSettings,
  type ShareSettings,
} from '@/lib/client-api'

interface ShareReportDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  jobId: string
}

export function ShareReportDialog({ open, onOpenChange, jobId }: ShareReportDialogProps) {
  const [settings, setSettings] = useState<ShareSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [successMsg, setSuccessMsg] = useState('')

  const fetchSettings = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getReportShareSettings(jobId)
      setSettings(data)
    } catch {
      setError('Failed to load share settings')
    } finally {
      setLoading(false)
    }
  }, [jobId])

  useEffect(() => {
    if (open) {
      fetchSettings()
      setPassword('')
      setShowPassword(false)
      setError('')
      setCopied(false)
      setSuccessMsg('')
    }
  }, [open, fetchSettings])

  const handleEnableSharing = async () => {
    if (!password) {
      setError('Please enter a password')
      return
    }
    if (password.length < 4) {
      setError('Password must be at least 4 characters')
      return
    }
    setSaving(true)
    setError('')
    try {
      const updated = await updateReportShareSettings(jobId, {
        isShared: true,
        password,
      })
      setSettings(updated)
      setPassword('')
      setShowPassword(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to enable sharing')
    } finally {
      setSaving(false)
    }
  }

  const handleDisableSharing = async () => {
    setSaving(true)
    setError('')
    try {
      const updated = await updateReportShareSettings(jobId, { isShared: false })
      setSettings(updated)
      setPassword('')
      setShowPassword(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to disable sharing')
    } finally {
      setSaving(false)
    }
  }

  const handleUpdatePassword = async () => {
    if (!password) return
    if (password.length < 4) {
      setError('Password must be at least 4 characters')
      return
    }
    setSaving(true)
    setError('')
    setSuccessMsg('')
    try {
      const updated = await updateReportShareSettings(jobId, {
        isShared: true,
        password,
      })
      setSettings(updated)
      setPassword('')
      setShowPassword(false)
      setSuccessMsg('Password updated')
      setTimeout(() => setSuccessMsg(''), 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update password')
    } finally {
      setSaving(false)
    }
  }

  const handleCopyLink = async () => {
    if (!settings?.shareUrl) return
    try {
      await navigator.clipboard.writeText(settings.shareUrl)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // fallback
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Share Report</DialogTitle>
          <DialogDescription>
            Create a password-protected link to share this report.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-5 h-5 animate-spin text-foreground-tertiary" />
          </div>
        ) : settings ? (
          <div className="space-y-5">
            {!settings.isShared ? (
              /* ─── Not Shared: Setup Form ─────────────────────────── */
              <div className="space-y-4">
                <div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-secondary/50 border border-border">
                  <Lock className="w-5 h-5 text-foreground-tertiary flex-shrink-0" />
                  <div>
                    <p className="text-body-sm font-medium text-foreground">This report is private</p>
                    <p className="text-caption text-foreground-tertiary">Only you can view it. Set a password to share.</p>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="share-password" className="text-body-sm font-medium text-foreground">
                    Password for viewers
                  </Label>
                  <div className="relative">
                    <Input
                      id="share-password"
                      type={showPassword ? 'text' : 'password'}
                      placeholder="Choose a password"
                      value={password}
                      onChange={(e) => { setPassword(e.target.value); setError('') }}
                      onKeyDown={(e) => { if (e.key === 'Enter' && password) { e.preventDefault(); handleEnableSharing() } }}
                      className="pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-foreground-tertiary hover:text-foreground transition-colors"
                      tabIndex={-1}
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                  <p className="text-caption text-foreground-tertiary">
                    Anyone with the link will need this password to view.
                  </p>
                </div>

                <button
                  type="button"
                  onClick={handleEnableSharing}
                  disabled={saving || !password}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-primary text-white text-body-sm font-medium hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {saving ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                  ) : (
                    <Link2 className="w-4 h-4" />
                  )}
                  {saving ? 'Creating link...' : 'Create shareable link'}
                </button>
              </div>
            ) : (
              /* ─── Shared: Active State ───────────────────────────── */
              <div className="space-y-4">
                <div className="flex items-center gap-3 px-4 py-3 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
                  <Link2 className="w-5 h-5 text-emerald-600 flex-shrink-0" />
                  <div>
                    <p className="text-body-sm font-medium text-emerald-700">Sharing is active</p>
                    <p className="text-caption text-emerald-600/80">Anyone with the link and password can view.</p>
                  </div>
                </div>

                {/* Share URL */}
                <div className="space-y-2">
                  <Label className="text-body-sm font-medium text-foreground">
                    Share link
                  </Label>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 px-3 py-2 rounded-lg bg-secondary text-xs font-mono break-all text-foreground-secondary select-all">
                      {settings.shareUrl}
                    </code>
                    <button
                      type="button"
                      onClick={handleCopyLink}
                      className="p-2 rounded-lg border border-border hover:bg-secondary transition-colors flex-shrink-0"
                      title="Copy link"
                    >
                      {copied ? (
                        <Check className="w-4 h-4 text-emerald-500" />
                      ) : (
                        <Copy className="w-4 h-4 text-foreground-tertiary" />
                      )}
                    </button>
                  </div>
                </div>

                {/* Change password */}
                <div className="space-y-2">
                  <Label htmlFor="change-password" className="text-body-sm font-medium text-foreground">
                    Change password
                  </Label>
                  <div className="flex gap-2">
                    <div className="relative flex-1">
                      <Input
                        id="change-password"
                        type={showPassword ? 'text' : 'password'}
                        placeholder="New password"
                        value={password}
                        onChange={(e) => { setPassword(e.target.value); setError(''); setSuccessMsg('') }}
                        onKeyDown={(e) => { if (e.key === 'Enter' && password) { e.preventDefault(); handleUpdatePassword() } }}
                        className="pr-10"
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword(!showPassword)}
                        className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-foreground-tertiary hover:text-foreground transition-colors"
                        tabIndex={-1}
                      >
                        {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                      </button>
                    </div>
                    <button
                      type="button"
                      onClick={handleUpdatePassword}
                      disabled={saving || !password}
                      className="px-3 py-2 rounded-lg text-body-sm font-medium bg-secondary text-foreground hover:bg-secondary/80 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex-shrink-0"
                    >
                      {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Update'}
                    </button>
                  </div>
                  {successMsg && (
                    <p className="text-caption text-emerald-600 flex items-center gap-1">
                      <Check className="w-3 h-3" /> {successMsg}
                    </p>
                  )}
                </div>

                {/* Divider */}
                <div className="border-t border-border" />

                {/* Stop sharing */}
                <button
                  type="button"
                  onClick={handleDisableSharing}
                  disabled={saving}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2 rounded-lg text-body-sm font-medium text-red-600 bg-red-500/5 border border-red-500/20 hover:bg-red-500/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Stop sharing'}
                </button>
              </div>
            )}

            {error && (
              <p className="text-body-sm text-red-500">{error}</p>
            )}
          </div>
        ) : (
          <p className="text-body-sm text-red-500 py-4">{error || 'Failed to load settings'}</p>
        )}
      </DialogContent>
    </Dialog>
  )
}
