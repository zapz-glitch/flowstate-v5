'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { signOut } from '@/lib/auth-client'
import { Plus, X, Download, ArrowUp, ArrowDown, Eye, EyeOff } from 'lucide-react'
import { getUiPrefs, saveUiPrefs, type UiPrefs } from '@/lib/client-api'
import { PageHeader } from '@/components/ui/page-header'
import { Skeleton } from '@/components/ui/skeleton'

const NAV_ITEMS = [
  { href: '/dashboard', defaultName: 'Overview' },
  { href: '/dashboard/analyze', defaultName: 'Property Search' },
  { href: '/dashboard/batch', defaultName: 'Batch Import' },
  { href: '/dashboard/reports', defaultName: 'Property Reports' },
  { href: '/dashboard/evaluation-settings', defaultName: 'Evaluation Settings' },
  { href: '/dashboard/api-hub', defaultName: 'API Hub' },
  { href: '/dashboard/tasks', defaultName: 'Tasks' },
  { href: '/dashboard/admin', defaultName: 'Admin Panel' },
  { href: '/dashboard/admin/observability', defaultName: 'Observability' },
]

export default function SettingsPage() {
  const router = useRouter()
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deleteConfirmText, setDeleteConfirmText] = useState('')

  const [navLabels, setNavLabels] = useState<Record<string, string>>({})
  const [navOrder, setNavOrder] = useState<string[]>(NAV_ITEMS.map((i) => i.href))
  const [navHidden, setNavHidden] = useState<string[]>([])
  const [customLinks, setCustomLinks] = useState<Array<{ label: string; url: string }>>([])
  const [faviconUrl, setFaviconUrl] = useState('')
  const [prefsLoaded, setPrefsLoaded] = useState(false)
  const [prefsSaving, setPrefsSaving] = useState(false)
  const [prefsSaved, setPrefsSaved] = useState(false)

  useEffect(() => {
    getUiPrefs().then((p) => {
      setNavLabels(p.navLabels ?? {})
      // Saved order first, then any new items appended in default order
      const saved = p.navOrder ?? []
      setNavOrder([...saved.filter((h) => NAV_ITEMS.some((i) => i.href === h)), ...NAV_ITEMS.map((i) => i.href).filter((h) => !saved.includes(h))])
      setNavHidden(p.navHidden ?? [])
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
        navOrder,
        navHidden,
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

  // Renders the Flowstate mark exactly as the app draws it — a rounded-md
  // bg-foreground square holding the FlowGlyph at sm sizing — to a PNG.
  // App geometry (Logo size="sm", 28×28): glyph is 16/28 of the square,
  // corner radius 6/28, stroke 1.9 units on a 24-unit viewBox, dark-theme
  // foreground #ebebeb square with background #0a0a0a glyph.
  const downloadLogo = () => {
    const S = 512
    const canvas = document.createElement('canvas')
    canvas.width = S
    canvas.height = S
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const fg = '#ebebeb'   // --foreground (dark theme): the square
    const bg = '#0a0a0a'   // --background (dark theme): the glyph stroke

    // Rounded square, edge-to-edge — same rounded-md ratio (6/28)
    const r = (6 / 28) * S
    ctx.fillStyle = fg
    ctx.beginPath()
    ctx.moveTo(r, 0)
    ctx.lineTo(S - r, 0)
    ctx.arcTo(S, 0, S, r, r)
    ctx.lineTo(S, S - r)
    ctx.arcTo(S, S, S - r, S, r)
    ctx.lineTo(r, S)
    ctx.arcTo(0, S, 0, S - r, r)
    ctx.lineTo(0, r)
    ctx.arcTo(0, 0, r, 0, r)
    ctx.closePath()
    ctx.fill()

    // FlowGlyph — the 24×24 SVG path scaled to 16/28 of the square, centered
    const glyph = (16 / 28) * S
    const scale = glyph / 24
    ctx.save()
    ctx.translate((S - glyph) / 2, (S - glyph) / 2)
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

    canvas.toBlob((blob) => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'flowstate-logo.png'
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    }, 'image/png')
  }

  const handleDeleteAccount = async () => {
    if (deleteConfirmText !== 'DELETE') return

    // TODO: Implement account deletion server action
    alert('Account deletion not yet implemented')
  }

  return (
    <div className="space-y-8 max-w-2xl">
      <PageHeader title="Settings" />

      {/* Menu bar customization */}
      {!prefsLoaded && (
        <div className="rounded-xl border border-border p-6 space-y-4" role="status" aria-busy="true">
          <span className="sr-only">Loading menu bar settings</span>
          <Skeleton className="h-5 w-40" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-2/3" />
        </div>
      )}
      {prefsLoaded && (
        <div className="bg-card rounded-xl border border-border p-6">
          <h2 className="text-heading text-foreground mb-1">
            Menu Bar
          </h2>
          <p className="text-body text-foreground-tertiary mb-4">
            Rename, reorder, or hide sidebar items, add your own links, or set a custom favicon.
          </p>

          <div className="space-y-2 mb-5">
            <p className="text-caption font-semibold text-foreground-secondary">Item names, order & visibility</p>
            {navOrder.map((href, idx) => {
              const item = NAV_ITEMS.find((i) => i.href === href)
              if (!item) return null
              const isHidden = navHidden.includes(item.href)
              const move = (dir: -1 | 1) => {
                const j = idx + dir
                if (j < 0 || j >= navOrder.length) return
                setNavOrder((prev) => {
                  const next = [...prev]
                  ;[next[idx], next[j]] = [next[j], next[idx]]
                  return next
                })
              }
              return (
                <div key={item.href} className={`flex items-center gap-2 ${isHidden ? 'opacity-50' : ''}`}>
                  <div className="flex flex-col">
                    <button onClick={() => move(-1)} disabled={idx === 0} className="text-foreground-tertiary hover:text-foreground disabled:opacity-30" aria-label="Move up">
                      <ArrowUp className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => move(1)} disabled={idx === navOrder.length - 1} className="text-foreground-tertiary hover:text-foreground disabled:opacity-30" aria-label="Move down">
                      <ArrowDown className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <span className="w-40 text-body text-foreground-tertiary">{item.defaultName}</span>
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
                    className="flex-1 px-3 py-1.5 text-body rounded-md border border-border bg-transparent text-foreground"
                  />
                  <button
                    onClick={() =>
                      setNavHidden((prev) =>
                        isHidden ? prev.filter((h) => h !== item.href) : [...prev, item.href]
                      )
                    }
                    className="p-1.5 text-foreground-tertiary hover:text-foreground"
                    aria-label={isHidden ? `Show ${item.defaultName}` : `Hide ${item.defaultName}`}
                    title={isHidden ? 'Show in sidebar' : 'Hide from sidebar'}
                  >
                    {isHidden ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              )
            })}
          </div>

          <div className="space-y-2 mb-5">
            <p className="text-caption font-semibold text-foreground-secondary">Custom links</p>
            {customLinks.map((link, i) => (
              <div key={i} className="flex items-center gap-2">
                <input
                  type="text"
                  value={link.label}
                  placeholder="Label"
                  onChange={(e) => setCustomLinks((prev) => prev.map((l, j) => j === i ? { ...l, label: e.target.value } : l))}
                  className="w-40 px-3 py-1.5 text-body rounded-md border border-border bg-transparent text-foreground"
                />
                <input
                  type="url"
                  value={link.url}
                  placeholder="https://…"
                  onChange={(e) => setCustomLinks((prev) => prev.map((l, j) => j === i ? { ...l, url: e.target.value } : l))}
                  className="flex-1 px-3 py-1.5 text-body rounded-md border border-border bg-transparent text-foreground"
                />
                <button
                  onClick={() => setCustomLinks((prev) => prev.filter((_, j) => j !== i))}
                  className="p-1.5 text-foreground-tertiary hover:text-destructive"
                  aria-label="Remove link"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            ))}
            <button
              onClick={() => setCustomLinks((prev) => [...prev, { label: '', url: '' }])}
              className="flex items-center gap-1.5 px-3 py-1.5 text-body text-foreground-secondary border border-dashed border-border rounded-md hover:bg-accent"
            >
              <Plus className="w-3.5 h-3.5" /> Add link
            </button>
          </div>

          <div className="mb-5">
            <p className="text-caption font-semibold text-foreground-secondary mb-2">Favicon</p>
            <input
              type="url"
              value={faviconUrl}
              placeholder="https://example.com/icon.png (blank = default)"
              onChange={(e) => setFaviconUrl(e.target.value)}
              className="w-full px-3 py-1.5 text-body rounded-md border border-border bg-transparent text-foreground"
            />
          </div>

          <button
            onClick={savePrefs}
            disabled={prefsSaving}
            className="px-4 py-2 text-body bg-primary text-primary-foreground rounded-lg hover:opacity-90 disabled:opacity-50"
          >
            {prefsSaved ? 'Saved' : prefsSaving ? 'Saving…' : 'Save menu bar settings'}
          </button>
        </div>
      )}

      {/* Brand assets */}
      <div className="bg-card rounded-xl border border-border p-6">
        <h2 className="text-heading text-foreground mb-1">
          Brand Assets
        </h2>
        <p className="text-body text-foreground-tertiary mb-4">
          Download the Flowstate logo — identical to the app mark (transparent PNG).
        </p>
        <div className="flex flex-wrap gap-3">
          <button
            onClick={() => downloadLogo()}
            className="flex items-center gap-2 px-4 py-2 text-body border border-border rounded-lg bg-primary text-primary-foreground hover:opacity-90"
          >
            <Download className="w-4 h-4" /> Download logo
          </button>
        </div>
      </div>

      {/* Account section */}
      <div className="bg-card rounded-xl border border-border p-6">
        <h2 className="text-heading text-foreground mb-4">
          Account
        </h2>

        <div className="space-y-4">
          <button
            onClick={() => signOut().then(() => router.push('/'))}
            className="px-4 py-2 text-foreground-secondary border border-border rounded-lg hover:bg-accent"
          >
            Sign out
          </button>
        </div>
      </div>

      {/* Danger zone */}
      <div className="bg-card rounded-xl border border-destructive/30 p-6">
        <h2 className="text-heading text-destructive mb-4">
          Danger Zone
        </h2>

        {!showDeleteConfirm ? (
          <button
            onClick={() => setShowDeleteConfirm(true)}
            className="px-4 py-2 bg-destructive/10 text-destructive border border-destructive/30 rounded-lg hover:bg-destructive/20"
          >
            Delete Account
          </button>
        ) : (
          <div className="space-y-4">
            <p className="text-body text-foreground-secondary">
              This action cannot be undone. All your API keys and usage data
              will be permanently deleted.
            </p>
            <div>
              <label className="block text-body font-medium text-foreground-secondary mb-1">
                Type <strong>DELETE</strong> to confirm
              </label>
              <input
                type="text"
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value)}
                className="w-full px-3 py-2 border border-input rounded-lg bg-background text-foreground"
                placeholder="DELETE"
              />
            </div>
            <div className="flex gap-3">
              <button
                onClick={handleDeleteAccount}
                disabled={deleteConfirmText !== 'DELETE'}
                className="px-4 py-2 bg-destructive text-destructive-foreground rounded-lg hover:bg-destructive/90 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Delete Account
              </button>
              <button
                onClick={() => {
                  setShowDeleteConfirm(false)
                  setDeleteConfirmText('')
                }}
                className="px-4 py-2 text-foreground-secondary hover:text-foreground"
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
