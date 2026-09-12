'use client'

import { useState } from 'react'
import { Loader2, CheckCircle } from 'lucide-react'

type Status = 'idle' | 'submitting' | 'success' | 'error'

const inputClass =
  'w-full px-4 py-3 bg-secondary/50 border border-border rounded-md text-foreground placeholder:text-muted-foreground text-sm focus:outline-none focus:ring-1 focus:ring-ring focus:border-ring transition-colors'

export function DealForm() {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [address, setAddress] = useState('')
  const [notes, setNotes] = useState('')
  const [company, setCompany] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (status === 'submitting') return
    setStatus('submitting')
    setErrorMsg(null)

    try {
      const res = await fetch('/api/deal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, address, notes, company }),
      })

      if (res.status === 501) {
        setStatus('error')
        setErrorMsg('not_configured')
        return
      }

      const data = (await res.json()) as { ok?: boolean; error?: string }
      if (!res.ok || !data.ok) {
        setStatus('error')
        setErrorMsg(data.error || 'Something went wrong. Please try again.')
        return
      }

      setStatus('success')
    } catch {
      setStatus('error')
      setErrorMsg('Unable to connect. Please try again.')
    }
  }

  if (status === 'success') {
    return (
      <div className="border border-border rounded-lg p-8 text-left animate-fade-in">
        <div className="flex items-center gap-3 mb-2">
          <CheckCircle className="w-5 h-5 text-green-500 dark:text-green-400 shrink-0" />
          <p className="text-foreground font-medium">Received.</p>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">
          We will review the property and respond within 48 hours.
        </p>
      </div>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="text-left space-y-3">
      {errorMsg && errorMsg !== 'not_configured' && (
        <p className="text-sm text-red-600 dark:text-red-400">{errorMsg}</p>
      )}
      {errorMsg === 'not_configured' && (
        <p className="text-sm text-muted-foreground">
          The form is temporarily offline. Email us directly at{' '}
          <a href="mailto:hello@flowstate.homes" className="text-foreground underline underline-offset-4">
            hello@flowstate.homes
          </a>
          .
        </p>
      )}

      <div className="grid sm:grid-cols-2 gap-3">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          placeholder="Full name"
          autoComplete="name"
          className={inputClass}
        />
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          placeholder="Email"
          autoComplete="email"
          className={inputClass}
        />
      </div>
      <input
        type="text"
        value={address}
        onChange={(e) => setAddress(e.target.value)}
        required
        placeholder="Property address"
        className={inputClass}
      />
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        rows={3}
        placeholder="Condition, timeline, anything relevant (optional)"
        className={inputClass + ' resize-none'}
      />

      {/* Honeypot */}
      <input
        type="text"
        value={company}
        onChange={(e) => setCompany(e.target.value)}
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
        className="hidden"
      />

      <button
        type="submit"
        disabled={status === 'submitting'}
        className="w-full py-3 px-6 bg-foreground text-background font-medium rounded-full hover:bg-foreground/85 active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-150 flex items-center justify-center gap-2"
      >
        {status === 'submitting' ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            <span>Sending...</span>
          </>
        ) : (
          <span>Submit a deal</span>
        )}
      </button>
      <p className="text-xs text-muted-foreground/60 text-center">
        No obligation. We respond within 48 hours.
      </p>
    </form>
  )
}
