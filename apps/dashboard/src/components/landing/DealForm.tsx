'use client'

import { useState, useRef, useEffect } from 'react'
import { Loader2, CheckCircle, ArrowRight, ArrowLeft } from 'lucide-react'
import { cn } from '@/lib/utils'

type Status = 'idle' | 'submitting' | 'success' | 'error'

interface Step {
  key: 'name' | 'email' | 'address' | 'notes'
  question: string
  placeholder: string
  type: 'text' | 'email' | 'textarea'
  optional?: boolean
  autoComplete?: string
}

const STEPS: Step[] = [
  { key: 'name', question: "What's your name?", placeholder: 'Full name', type: 'text', autoComplete: 'name' },
  { key: 'email', question: "What's your email?", placeholder: 'you@example.com', type: 'email', autoComplete: 'email' },
  { key: 'address', question: "What's the property address?", placeholder: '123 Main St, Tampa, FL 33607', type: 'text' },
  { key: 'notes', question: 'Anything we should know?', placeholder: 'Condition, timeline, occupants (optional)', type: 'textarea', optional: true },
]

const inputClass =
  'w-full px-4 py-3.5 bg-secondary/50 border border-border rounded-md text-lg sm:text-xl text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-ring focus:border-ring transition-colors autofill:bg-secondary/50'

export function DealForm() {
  const [stepIndex, setStepIndex] = useState(0)
  const [direction, setDirection] = useState<'fwd' | 'back'>('fwd')
  const [values, setValues] = useState({ name: '', email: '', address: '', notes: '' })
  const [company, setCompany] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)
  const [stepError, setStepError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  const mountedRef = useRef(false)

  const step = STEPS[stepIndex]
  const isLast = stepIndex === STEPS.length - 1

  useEffect(() => {
    // Don't steal focus (or scroll) on initial page load
    if (!mountedRef.current) {
      mountedRef.current = true
      return
    }
    inputRef.current?.focus({ preventScroll: true })
  }, [stepIndex])

  const setValue = (key: Step['key'], value: string) => {
    setValues((prev) => ({ ...prev, [key]: value }))
    setStepError(null)
  }

  const validateCurrent = (): boolean => {
    const value = values[step.key].trim()
    if (!value && !step.optional) {
      setStepError('Required')
      return false
    }
    if (step.key === 'email' && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
      setStepError('Enter a valid email')
      return false
    }
    setStepError(null)
    return true
  }

  const goNext = () => {
    if (!validateCurrent()) return
    setDirection('fwd')
    setStepIndex((i) => Math.min(i + 1, STEPS.length - 1))
  }

  const goBack = () => {
    setDirection('back')
    setStepError(null)
    setStepIndex((i) => Math.max(i - 1, 0))
  }

  const handleSubmit = async () => {
    if (status === 'submitting') return
    setStatus('submitting')
    setErrorMsg(null)

    try {
      const res = await fetch('/api/deal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...values, company }),
      })
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

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Enter') return
    if (step.type === 'textarea' && e.shiftKey) return
    e.preventDefault()
    if (isLast) handleSubmit()
    else goNext()
  }

  if (status === 'success') {
    return (
      <div className="animate-in fade-in duration-200 text-left">
        <div className="flex items-center gap-3 mb-2">
          <CheckCircle className="w-5 h-5 text-green-500 dark:text-green-400 shrink-0" />
          <p className="text-lg text-foreground font-medium">Received, {values.name.split(' ')[0]}.</p>
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">
          We will review the property and respond within 24 hours.
        </p>
      </div>
    )
  }

  return (
    <form
      onSubmit={(e) => { e.preventDefault(); if (isLast) handleSubmit(); else goNext() }}
      className="text-left"
    >
      {/* Progress */}
      <div className="flex items-center gap-3 mb-8">
        <p className="mono-label !text-[10px] shrink-0">
          {String(stepIndex + 1).padStart(2, '0')} / {String(STEPS.length).padStart(2, '0')}
        </p>
        <div className="h-px flex-1 bg-border">
          <div
            className="h-px bg-foreground transition-all duration-300"
            style={{ width: `${((stepIndex + 1) / STEPS.length) * 100}%` }}
          />
        </div>
      </div>

      {/* Current step */}
      <div
        key={stepIndex}
        className={cn(
          'animate-in fade-in duration-200',
          direction === 'fwd' ? 'slide-in-from-right-4' : 'slide-in-from-left-4'
        )}
      >
        <label className="block font-serif italic text-2xl sm:text-3xl text-foreground mb-6">
          {step.question}
        </label>

        {step.type === 'textarea' ? (
          <textarea
            ref={(el) => { inputRef.current = el }}
            value={values[step.key]}
            onChange={(e) => setValue(step.key, e.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
            placeholder={step.placeholder}
            className={cn(inputClass, 'resize-none')}
          />
        ) : (
          <input
            ref={(el) => { inputRef.current = el }}
            type={step.type}
            value={values[step.key]}
            onChange={(e) => setValue(step.key, e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={step.placeholder}
            autoComplete={step.autoComplete}
            className={inputClass}
          />
        )}

        {stepError && (
          <p className="mt-3 text-sm text-red-600 dark:text-red-400">{stepError}</p>
        )}
        {errorMsg && (
          <div className="mt-3 text-sm text-muted-foreground">
            <p className="text-red-600 dark:text-red-400">{errorMsg}</p>
            <p className="mt-1">
              Or email us at{' '}
              <a href="mailto:hello@flowstate.homes" className="text-foreground underline underline-offset-4">
                hello@flowstate.homes
              </a>
              .
            </p>
          </div>
        )}
      </div>

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

      {/* Controls */}
      <div className="mt-8 flex items-center justify-between">
        {stepIndex > 0 ? (
          <button
            type="button"
            onClick={goBack}
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground active:scale-[0.97] transition-all duration-150"
          >
            <ArrowLeft className="h-4 w-4" />
            <span>Back</span>
          </button>
        ) : (
          <span />
        )}

        <button
          type="submit"
          disabled={status === 'submitting'}
          className="inline-flex items-center gap-2 py-2.5 px-5 bg-foreground text-background text-sm font-medium rounded-full hover:bg-foreground/85 active:scale-[0.98] disabled:opacity-50 transition-all duration-150"
        >
          {status === 'submitting' ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              <span>Sending...</span>
            </>
          ) : isLast ? (
            <span>Submit</span>
          ) : (
            <>
              <span>Continue</span>
              <ArrowRight className="h-4 w-4" />
            </>
          )}
        </button>
      </div>

      <p className="mt-6 text-xs text-muted-foreground/60 leading-relaxed">
        Press Enter to continue. No obligation; we respond within 24 hours.
        By submitting you agree to our{' '}
        <a href="/terms" className="underline underline-offset-2 hover:text-muted-foreground">Terms of Service</a>
        {' '}and{' '}
        <a href="/privacy" className="underline underline-offset-2 hover:text-muted-foreground">Privacy Policy</a>
        {' '}and consent to email follow-up about your submission.
      </p>
    </form>
  )
}
