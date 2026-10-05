'use client'

// Stealth entry — app.flowstate.homes serves only this sign-in card.
// The public site lives at flowstate.homes (SEO engine); this subdomain
// is the operator door into the dashboard.
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { signIn, useSession } from '@/lib/auth-client'
import { offlineClear } from '@/lib/offline-cache'
import { LogoIcon } from '@/components/ui/Logo'
import { Loader2 } from 'lucide-react'

export default function LoginPage() {
  const router = useRouter()
  const { refetch: refreshSession } = useSession()
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsLoading(true)
    setError(null)
    try {
      const result = await signIn.email({ email, password })
      if (result.error) {
        setError(result.error.message || 'Failed to sign in. Please check your credentials.')
        setIsLoading(false)
        return
      }
      // Finish the session refresh before navigating — a prefetched
      // route can mount before Better Auth's signal update lands.
      await refreshSession()
      void offlineClear()
      router.push('/dashboard/analyze')
    } catch {
      setError('Failed to sign in. Please try again.')
      setIsLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <div className="relative w-full max-w-md">
        <div className="relative rounded-lg overflow-hidden bg-card">
          <div className="absolute inset-0 bg-foreground/[0.015]" />
          <div className="absolute inset-0 rounded-lg border border-border" />
          <div className="relative z-10">
            {/* Header */}
            <div className="p-6 pb-4">
              <div className="flex items-center gap-3 mb-4">
                <LogoIcon className="w-10 h-10" />
                <span className="text-xl font-semibold text-foreground">flowstate</span>
              </div>
            </div>

            {/* Form */}
            <div className="px-6 pb-6">
              {error && (
                <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl mb-3">
                  <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
                </div>
              )}
              <form onSubmit={handleSignIn}>
                <div className="mb-4">
                  <label htmlFor="signin-email" className="block text-sm font-medium text-foreground mb-1.5">
                    Liquidity.
                  </label>
                  <input
                    id="signin-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    className="w-full px-4 py-2.5 bg-secondary border border-border rounded-md text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring focus:border-ring transition-colors"
                    placeholder="you@example.com"
                  />
                </div>
                <div className="mb-4">
                  <label htmlFor="signin-password" className="block text-sm font-medium text-foreground mb-1.5">
                    Profitable Investments.
                  </label>
                  <input
                    id="signin-password"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    minLength={8}
                    className="w-full px-4 py-2.5 bg-secondary border border-border rounded-md text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring focus:border-ring transition-colors"
                    placeholder="••••••••"
                  />
                </div>
                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full py-2.5 px-4 bg-foreground text-background hover:bg-foreground/85 font-medium rounded-full disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-3"
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      <span>Signing in...</span>
                    </>
                  ) : (
                    <span>Sign In</span>
                  )}
                </button>
              </form>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
