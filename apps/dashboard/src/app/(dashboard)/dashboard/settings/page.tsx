'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { signOut } from '@/lib/auth-client'
import { AlertTriangle, Plus, X, Download } from 'lucide-react'
import { getUiPrefs, saveUiPrefs, type UiPrefs } from '@/lib/client-api'

const NAV_ITEMS = [
  { href: '/dashboard', defaultName: 'Overview' },
  { href: '/dashboard/analyze', defaultName: 'Property Search' },
  { href: '/dashboard/batch', defaultName: 'Batch Import' },
  { href: '/dashboard/reports', defaultName: 'Property Reports' },
  { href: '/dashboard/evaluation-settings', defaultName: 'Evaluation Settings' },
  { href: '/dashboard/api-hub', defaultName: 'API Hub' },
  { href: '/dashboard/admin', defaultName: 'Admin Panel' },
  { href: '/dashboard/admin/observability', defaultName: 'Observability' },
]

export default function SettingsPage() {
  const router = useRouter()
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deleteConfirmText, setDeleteConfirmText] = useState('')

  const [navLabels, setNavLabels] = useState<Record<string, string>>({})
  const [customLinks, setCustomLinks] = useState<Array<{ label: string; url: string }>>([])
  const [faviconUrl, setFaviconUrl] = useState('')
  const [prefsLoaded, setPrefsLoaded] = useState(false)
  const [prefsSaving, setPrefsSaving] = useState(false)
  const [prefsSaved, setPrefsSaved] = useState(false)

  useEffect(() => {
    getUiPrefs().then((p) => {
      setNavLabels(p.navLabels ?? {})
      setCustomLinks(p.customLinks ?? [])
      setFaviconUrl(p.faviconUrl ?? '')
      setPrefsLoaded(true)
    }).catch(() => setPrefsLoaded(true))
  }, [])

  const savePrefs = async () => {
    setPrefsSaving(true)
    try {
      const prefs: UiPrefs = {
        navLabels,
        customLinks: customLinks.filter((l) => l.label.trim() && l.url.trim()),
        faviconUrl: faviconUrl.trim() || null,
      }
      await saveUiPrefs(prefs)
      window.dispatchEvent(new CustomEvent<UiPrefs>('ui-prefs-updated', { detail: prefs }))
      setPrefsSaved(true)
      setTimeout(() => setPrefsSaved(false), 2000)
    } finally {
      setPrefsSaving(false)
    }
  }

  // Renders the Flowstate mark + wordmark to canvas and downloads a JPEG.
  // dark=true → black background version; dark=false → white background version.
  const downloadLogo = (dark: boolean) => {
    const W = 1600, H = 800
    const canvas = document.createElement('canvas')
    canvas.width = W
    canvas.height = H
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const bg = dark ? '#0a0a0a' : '#ffffff'
    const fg = dark ? '#fafafa' : '#0a0a0a'
    ctx.fillStyle = bg
    ctx.fillRect(0, 0, W, H)

    // Logo mark — rounded square + flow glyph, centered left of wordmark
    const icon = 260
    const gap = 48
    const font = '600 190px ui-sans-serif, system-ui, sans-serif'
    ctx.font = font
    const wordmark = 'flowstate'
    const textWidth = ctx.measureText(wordmark).width
    const totalWidth = icon + gap + textWidth
    const ix = (W - totalWidth) / 2
    const iy = (H - icon) / 2

    // Rounded-square icon background
    const r = 40
    ctx.fillStyle = fg
    ctx.beginPath()
    ctx.roundRect(ix, iy, icon, icon, r)
    ctx.fill()

    // Flow glyph — the 24x24 SVG path scaled into the icon box
    const scale = icon / 24
    ctx.save()
    ctx.translate(ix, iy)
    ctx.scale(scale, scale)
    const path = new Path2D(
      'M4.5 17.5 V10.8 L12 4.5 L19.5 10.8 V17.5 M4.5 17.5 C7 17.5 8 15.5 10.5 15.5 C13 15.5 14 17.5 16.5 17.5 C17.8 17.5 19 17 19.5 16.3'
    )
    ctx.strokeStyle = bg
    ctx.lineWidth = 1.9
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.stroke(path)
    ctx.restore()

    // Wordmark
    ctx.fillStyle = fg
    ctx.font = font
    ctx.textBaseline = 'middle'
    ctx.fillText(wordmark, ix + icon + gap, H / 2 + 8)

    const a = document.createElement('a')
    a.href = canvas.toDataURL('image/jpeg', 0.92)
    a.download = dark ? 'flowstate-logo-black.jpg' : 'flowstate-logo-white.jpg'
    a.click()
  }

  const handleDeleteAccount = async () => {
    if (deleteConfirmText !== 'DELETE') return

    // TODO: Implement account deletion server action
    alert('Account deletion not yet implemented')
  }

  return (
    <div className="space-y-8 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold text-neutral-900 dark:text-white">
          Settings
        </h1>
        <p className="text-neutral-600 dark:text-neutral-400 mt-1">
          Manage your account settings
        </p>
      </div>

      {/* Menu bar customization */}
      {prefsLoaded && (
        <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-800 p-6">
          <h2 className="text-lg font-semibold text-neutral-900 dark:text-white mb-1">
            Menu Bar
          </h2>
          <p className="text-sm text-neutral-500 dark:text-neutral-400 mb-4">
            Rename sidebar items, add your own links, or set a custom favicon.
          </p>

          <div className="space-y-2 mb-5">
            <p className="text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wide">Item names</p>
            {NAV_ITEMS.map((item) => (
              <div key={item.href} className="flex items-center gap-3">
                <span className="w-40 text-sm text-neutral-500 dark:text-neutral-400">{item.defaultName}</span>
                <input
                  type="text"
                  value={navLabels[item.href] ?? ''}
                  placeholder={item.defaultName}
                  onChange={(e) => {
                    const v = e.target.value
                    setNavLabels((prev) => {
                      const next = { ...prev }
                      if (v.trim()) next[item.href] = v
                      else delete next[item.href]
                      return next
                    })
                  }}
                  className="flex-1 px-3 py-1.5 text-sm rounded-md border border-neutral-200 dark:border-neutral-700 bg-transparent text-neutral-900 dark:text-white"
                />
              </div>
            ))}
          </div>

          <div className="space-y-2 mb-5">
            <p className="text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wide">Custom links</p>
            {customLinks.map((link, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  type="text"
                  value={link.label}
                  placeholder="Label"
                  onChange={(e) => setCustomLinks((prev) => prev.map((l, j) => j === i ? { ...l, label: e.target.value } : l))}
                  className="w-40 px-3 py-1.5 text-sm rounded-md border border-neutral-200 dark:border-neutral-700 bg-transparent text-neutral-900 dark:text-white"
                />
                <input
                  type="url"
                  value={link.url}
                  placeholder="https://…"
                  onChange={(e) => setCustomLinks((prev) => prev.map((l, j) => j === i ? { ...l, url: e.target.value } : l))}
                  className="flex-1 px-3 py-1.5 text-sm rounded-md border border-neutral-200 dark:border-neutral-700 bg-transparent text-neutral-900 dark:text-white"
                />
                <button
                  onClick={() => setCustomLinks((prev) => prev.filter((_, j) => j !== i))}
                  className="p-1.5 text-neutral-400 hover:text-red-500"
                  aria-label="Remove link"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ))}
            <button
              onClick={() => setCustomLinks((prev) => [...prev, { label: '', url: '' }])}
              className="flex items-center gap-1.5 px-3 py-1.5 text-sm text-neutral-600 dark:text-neutral-400 border border-dashed border-neutral-300 dark:border-neutral-700 rounded-md hover:bg-neutral-50 dark:hover:bg-neutral-800"
            >
              <Plus className="w-3.5 h-3.5" /> Add link
            </button>
          </div>

          <div className="mb-5">
            <p className="text-xs font-medium text-neutral-500 dark:text-neutral-400 uppercase tracking-wide mb-2">Favicon</p>
            <input
              type="url"
              value={faviconUrl}
              placeholder="https://example.com/icon.png (blank = default)"
              onChange={(e) => setFaviconUrl(e.target.value)}
              className="w-full px-3 py-1.5 text-sm rounded-md border border-neutral-200 dark:border-neutral-700 bg-transparent text-neutral-900 dark:text-white"
            />
          </div>

          <button
            onClick={savePrefs}
            disabled={prefsSaving}
            className="px-4 py-2 text-sm bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 rounded-lg hover:opacity-90 disabled:opacity-50"
          >
            {prefsSaved ? 'Saved' : prefsSaving ? 'Saving…' : 'Save menu bar settings'}
          </button>
        </div>
      )}

      {/* Brand assets */}
      <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-800 p-6">
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-white mb-1">
          Brand Assets
        </h2>
        <p className="text-sm text-neutral-500 dark:text-neutral-400 mb-4">
          Download the Flowstate logo as a JPEG.
        </p>
        <div className="flex flex-wrap gap-3">
          <button
            onClick={() => downloadLogo(true)}
            className="flex items-center gap-2 px-4 py-2 text-sm border border-neutral-200 dark:border-neutral-700 rounded-lg bg-neutral-900 text-white hover:opacity-90"
          >
            <Download className="w-4 h-4" /> Logo — black background
          </button>
          <button
            onClick={() => downloadLogo(false)}
            className="flex items-center gap-2 px-4 py-2 text-sm border border-neutral-300 rounded-lg bg-white text-neutral-900 hover:bg-neutral-50"
          >
            <Download className="w-4 h-4" /> Logo — white background
          </button>
        </div>
      </div>

      {/* Account section */}
      <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-800 p-6">
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-white mb-4">
          Account
        </h2>

        <div className="space-y-4">
          <button
            onClick={() => signOut().then(() => router.push('/'))}
            className="px-4 py-2 text-neutral-600 dark:text-neutral-400 border border-neutral-200 dark:border-neutral-700 rounded-lg hover:bg-neutral-50 dark:hover:bg-neutral-800"
          >
            Sign out
          </button>
        </div>
      </div>

      {/* Danger zone */}
      <div className="bg-white dark:bg-neutral-900 rounded-xl border border-red-200 dark:border-red-900/50 p-6">
        <div className="flex items-center gap-3 mb-4">
          <AlertTriangle className="w-5 h-5 text-red-500" />
          <h2 className="text-lg font-semibold text-red-600 dark:text-red-400">
            Danger Zone
          </h2>
        </div>

        {!showDeleteConfirm ? (
          <button
            onClick={() => setShowDeleteConfirm(true)}
            className="px-4 py-2 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 border border-red-200 dark:border-red-800 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/30"
          >
            Delete Account
          </button>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-neutral-600 dark:text-neutral-400">
              This action cannot be undone. All your API keys and usage data
              will be permanently deleted.
            </p>
            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                Type <strong>DELETE</strong> to confirm
              </label>
              <input
                type="text"
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value)}
                className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-white"
                placeholder="DELETE"
              />
            </div>
            <div className="flex gap-3">
              <button
                onClick={handleDeleteAccount}
                disabled={deleteConfirmText !== 'DELETE'}
                className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Delete Account
              </button>
              <button
                onClick={() => {
                  setShowDeleteConfirm(false)
                  setDeleteConfirmText('')
                }}
                className="px-4 py-2 text-neutral-600 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-white"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
