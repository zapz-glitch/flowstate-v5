'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { signIn } from '@/lib/auth-client'
import { LogoIcon } from '@/components/ui/Logo'
import { Loader2 } from 'lucide-react'

interface AuthModalsProps {
  isSignInOpen: boolean
  onSignInOpenChange: (open: boolean) => void
}

export function AuthModals({
  isSignInOpen,
  onSignInOpenChange,
}: AuthModalsProps) {
  return (
    <SignInModal
      isOpen={isSignInOpen}
      onClose={() => onSignInOpenChange(false)}
    />
  )
}

interface SignInModalProps {
  isOpen: boolean
  onClose: () => void
}

function SignInModal({ isOpen, onClose }: SignInModalProps) {
  const router = useRouter()
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  // Reset form when modal opens/closes
  useEffect(() => {
    if (isOpen) {
      setError(null)
      setEmail('')
      setPassword('')
    }
  }, [isOpen])

  // Handle escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current()
    }
    if (isOpen) {
      document.addEventListener('keydown', handleEscape)
      document.body.style.overflow = 'hidden'
    }
    return () => {
      document.removeEventListener('keydown', handleEscape)
      document.body.style.overflow = 'unset'
    }
  }, [isOpen])

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsLoading(true)
    setError(null)

    try {
      const result = await signIn.email({
        email,
        password,
      })

      if (result.error) {
        setError(result.error.message || 'Failed to sign in. Please check your credentials.')
        setIsLoading(false)
        return
      }

      // Success - redirect to dashboard
      onClose()
      router.push('/dashboard')
      router.refresh()
    } catch {
      setError('Failed to sign in. Please try again.')
      setIsLoading(false)
    }
  }

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 dark:bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative w-full max-w-md mx-4 animate-in fade-in zoom-in-95 duration-200">
        <div className="relative rounded-lg overflow-hidden bg-card">
          {/* Background gradient */}
          <div className="absolute inset-0 bg-foreground/[0.015]" />
          <div className="absolute inset-0 rounded-lg border border-border" />

          {/* Content */}
          <div className="relative z-10">
            {/* Close button */}
            <button
              onClick={onClose}
              className="absolute top-4 right-4 p-2 rounded-full hover:bg-secondary transition-colors"
            >
              <svg className="w-5 h-5 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>

            {/* Header */}
            <div className="p-6 pb-4">
              <div className="flex items-center gap-3 mb-4">
                <LogoIcon className="w-10 h-10" />
                <span className="text-xl font-semibold text-foreground">flowstate</span>
              </div>

            </div>

            {/* Form */}
            <div className="px-6 pb-6">
              {/* Error message */}
              {error && (
                <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl mb-3">
                  <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
                </div>
              )}

              <form onSubmit={handleSignIn}>
                {/* Email field */}
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

                {/* Password field */}
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

                {/* Submit button */}
                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full py-2.5 px-4 bg-foreground text-background font-medium rounded-full hover:bg-foreground/85 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-3"
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
