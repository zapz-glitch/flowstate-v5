'use client'

import { useState } from 'react'
import { Loader2, CheckCircle } from 'lucide-react'

export function Waitlist() {
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsLoading(true)
    setError(null)
    setSuccess(null)

    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8787'
      const res = await fetch(`${apiUrl}/waitlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, firstName, lastName }),
      })

      const data = await res.json() as { success?: boolean; error?: string; message?: string }

      if (!res.ok || !data.success) {
        setError(data.error || 'Something went wrong. Please try again.')
        return
      }

      setSuccess(data.message ?? 'You have been added to the waitlist!')
      setFirstName('')
      setLastName('')
      setEmail('')
    } catch {
      setError('Unable to connect. Please try again later.')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <section id="waitlist" className="relative py-20 sm:py-28 overflow-hidden">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="max-w-xl mx-auto text-center">
          <h2 className="text-3xl sm:text-4xl font-bold text-foreground mb-4">
            Join the Waitlist
          </h2>
          <p className="text-lg text-muted-foreground mb-8">
            Be the first to know when we launch. Sign up to get early access.
          </p>

          {success ? (
            <div className="flex flex-col items-center gap-3 p-6 rounded-2xl border border-green-500/20 bg-green-500/10">
              <CheckCircle className="w-10 h-10 text-green-500" />
              <p className="text-foreground font-medium">{success}</p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              {error && (
                <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl">
                  <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
                </div>
              )}

              <div className="flex gap-3">
                <input
                  type="text"
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  required
                  placeholder="First name"
                  className="flex-1 px-4 py-2.5 bg-secondary border border-border rounded-md text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring focus:border-ring transition-colors"
                />
                <input
                  type="text"
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  required
                  placeholder="Last name"
                  className="flex-1 px-4 py-2.5 bg-secondary border border-border rounded-md text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring focus:border-ring transition-colors"
                />
              </div>

              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                placeholder="you@example.com"
                className="w-full px-4 py-2.5 bg-secondary border border-border rounded-md text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring focus:border-ring transition-colors"
              />

              <button
                type="submit"
                disabled={isLoading}
                className="w-full py-2.5 px-4 bg-foreground text-background font-medium rounded-full hover:bg-foreground/85 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-3"
              >
                {isLoading ? (
                  <>
                    <Loader2 className="w-5 h-5 animate-spin" />
                    <span>Joining...</span>
                  </>
                ) : (
                  <span>Join Waitlist</span>
                )}
              </button>
            </form>
          )}
        </div>
      </div>
    </section>
  )
}
