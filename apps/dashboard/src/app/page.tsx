'use client'

import { Suspense, useState, useEffect, useCallback } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useSession, signIn, signUp, forgetPassword } from '@/lib/auth-client'
import { LogoIcon } from '@/components/ui/Logo'
import { Loader2, ArrowLeft, CheckCircle, X } from 'lucide-react'
import { Navbar } from '@/components/landing/Navbar'
import { Hero } from '@/components/landing/Hero'
import { Features } from '@/components/landing/Features'
import { Pricing } from '@/components/landing/Pricing'
import { Footer } from '@/components/landing/Footer'

type AuthView = 'signin' | 'signup' | 'forgot-password'

export default function HomePage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-background" />}>
      <HomePageContent />
    </Suspense>
  )
}

function HomePageContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const session = useSession()
  const [showAuthModal, setShowAuthModal] = useState(false)
  const [authView, setAuthView] = useState<AuthView>('signin')

  const isSignedIn = !session.isPending && !!session.data?.user

  // Auto-open sign-in modal when redirected with ?signin=true
  useEffect(() => {
    if (searchParams.get('signin') === 'true' && !isSignedIn) {
      setAuthView('signin')
      setShowAuthModal(true)
    }
  }, [searchParams, isSignedIn])

  const openSignIn = useCallback(() => {
    if (isSignedIn) {
      router.push('/dashboard')
    } else {
      setAuthView('signin')
      setShowAuthModal(true)
    }
  }, [isSignedIn, router])

  const openSignUp = useCallback(() => {
    if (isSignedIn) {
      router.push('/dashboard')
    } else {
      setAuthView('signup')
      setShowAuthModal(true)
    }
  }, [isSignedIn, router])

  // Close modal on Escape key
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setShowAuthModal(false)
    }
    if (showAuthModal) {
      document.addEventListener('keydown', handleEscape)
      document.body.style.overflow = 'hidden'
    }
    return () => {
      document.removeEventListener('keydown', handleEscape)
      document.body.style.overflow = ''
    }
  }, [showAuthModal])

  return (
    <div className="min-h-screen bg-background">
      <Navbar
        onSignInClick={openSignIn}
        onSignUpClick={openSignUp}
        isSignedIn={isSignedIn}
      />
      <Hero onGetStartedClick={openSignUp} />
      <Features />
      {/* <Pricing onSignUpClick={openSignUp} /> */}
      <Footer />

      {/* Auth Modal Overlay */}
      {showAuthModal && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) setShowAuthModal(false)
          }}
        >
          <div className="relative w-full max-w-md animate-in fade-in zoom-in-95 duration-200">
            {/* Close button */}
            <button
              onClick={() => setShowAuthModal(false)}
              className="absolute -top-2 -right-2 z-10 p-1.5 rounded-full bg-secondary border border-border text-muted-foreground hover:text-foreground hover:bg-secondary/80 transition-colors"
            >
              <X className="h-4 w-4" />
            </button>

            {authView === 'signin' && (
              <SignInForm
                onForgotPassword={() => setAuthView('forgot-password')}
                onSwitchToSignUp={() => setAuthView('signup')}
              />
            )}
            {authView === 'signup' && (
              <SignUpForm
                onSwitchToSignIn={() => setAuthView('signin')}
              />
            )}
            {authView === 'forgot-password' && (
              <ForgotPasswordForm
                onBackToSignIn={() => setAuthView('signin')}
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function SignInForm({
  onForgotPassword,
  onSwitchToSignUp,
}: {
  onForgotPassword: () => void
  onSwitchToSignUp: () => void
}) {
  const router = useRouter()
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

      router.push('/dashboard')
      router.refresh()
    } catch {
      setError('Failed to sign in. Please try again.')
      setIsLoading(false)
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card">
      <div>
        <div className="p-6 pb-4">
          <div className="flex items-center gap-3 mb-4">
            <LogoIcon className="w-10 h-10" />
            <span className="text-xl font-semibold text-foreground">
              flowstate
            </span>
          </div>

          <h2 className="text-2xl font-bold text-foreground mb-1">Welcome back</h2>
          <p className="text-sm text-muted-foreground">Sign in to access your account</p>
        </div>

        <div className="px-6 pb-6">
          {error && (
            <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl mb-3">
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            </div>
          )}

          <form onSubmit={handleSignIn}>
            <div className="mb-4">
              <label htmlFor="signin-email" className="block text-sm font-medium text-foreground mb-1.5">
                Email
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
                Password
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

            <div className="mb-3 text-right">
              <button
                type="button"
                onClick={onForgotPassword}
                className="text-sm text-foreground underline underline-offset-4 hover:text-foreground-secondary"
              >
                Forgot password?
              </button>
            </div>

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

          <p className="text-sm text-muted-foreground text-center mt-4">
            Don&apos;t have an account?{' '}
            <button
              type="button"
              onClick={onSwitchToSignUp}
              className="text-foreground underline underline-offset-4 hover:text-foreground-secondary font-medium"
            >
              Sign up
            </button>
          </p>
        </div>
      </div>
    </div>
  )
}

function SignUpForm({ onSwitchToSignIn }: { onSwitchToSignIn: () => void }) {
  const router = useRouter()
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsLoading(true)
    setError(null)

    if (password !== confirmPassword) {
      setError('Passwords do not match')
      setIsLoading(false)
      return
    }

    if (password.length < 8) {
      setError('Password must be at least 8 characters')
      setIsLoading(false)
      return
    }

    try {
      const result = await signUp.email({ email, password, name })

      if (result.error) {
        setError(result.error.message || 'Failed to create account. Please try again.')
        setIsLoading(false)
        return
      }

      router.push('/dashboard')
      router.refresh()
    } catch {
      setError('Failed to create account. Please try again.')
      setIsLoading(false)
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card">
      <div>
        <div className="p-6 pb-4">
          <div className="flex items-center gap-3 mb-4">
            <LogoIcon className="w-10 h-10" />
            <span className="text-xl font-semibold text-foreground">
              flowstate
            </span>
          </div>

          <h2 className="text-2xl font-bold text-foreground mb-1">Create an account</h2>
          <p className="text-sm text-muted-foreground">Sign up to get started with Flowstate API</p>
        </div>

        <div className="px-6 pb-6">
          {error && (
            <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl mb-4">
              <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
            </div>
          )}

          <form onSubmit={handleSignUp}>
            <div className="mb-4">
              <label htmlFor="signup-name" className="block text-sm font-medium text-foreground mb-1.5">
                Full Name
              </label>
              <input
                id="signup-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                className="w-full px-4 py-2.5 bg-secondary border border-border rounded-md text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring focus:border-ring transition-colors"
                placeholder="John Doe"
              />
            </div>

            <div className="mb-4">
              <label htmlFor="signup-email" className="block text-sm font-medium text-foreground mb-1.5">
                Email
              </label>
              <input
                id="signup-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full px-4 py-2.5 bg-secondary border border-border rounded-md text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring focus:border-ring transition-colors"
                placeholder="you@example.com"
              />
            </div>

            <div className="mb-4">
              <label htmlFor="signup-password" className="block text-sm font-medium text-foreground mb-1.5">
                Password
              </label>
              <input
                id="signup-password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                minLength={8}
                className="w-full px-4 py-2.5 bg-secondary border border-border rounded-md text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring focus:border-ring transition-colors"
                placeholder="••••••••"
              />
              <p className="text-xs text-muted-foreground mt-1.5">Must be at least 8 characters</p>
            </div>

            <div className="mb-5">
              <label htmlFor="signup-confirm-password" className="block text-sm font-medium text-foreground mb-1.5">
                Confirm Password
              </label>
              <input
                id="signup-confirm-password"
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                required
                minLength={8}
                className="w-full px-4 py-2.5 bg-secondary border border-border rounded-md text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring focus:border-ring transition-colors"
                placeholder="••••••••"
              />
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className="w-full py-2.5 px-4 bg-foreground text-background font-medium rounded-full hover:bg-foreground/85 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-3"
            >
              {isLoading ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  <span>Creating account...</span>
                </>
              ) : (
                <span>Create Account</span>
              )}
            </button>
          </form>

          <p className="text-sm text-muted-foreground text-center mt-4">
            Already have an account?{' '}
            <button
              type="button"
              onClick={onSwitchToSignIn}
              className="text-foreground underline underline-offset-4 hover:text-foreground-secondary font-medium"
            >
              Sign in
            </button>
          </p>
        </div>
      </div>
    </div>
  )
}

function ForgotPasswordForm({ onBackToSignIn }: { onBackToSignIn: () => void }) {
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const [isSuccess, setIsSuccess] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsLoading(true)
    setError(null)

    try {
      const result = await forgetPassword({
        email,
        redirectTo: '/reset-password',
      })

      if (result.error) {
        setError(result.error.message || 'Failed to send reset email. Please try again.')
        setIsLoading(false)
        return
      }

      setIsSuccess(true)
      setIsLoading(false)
    } catch {
      setError('Failed to send reset email. Please try again.')
      setIsLoading(false)
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card">
      <div>
        <div className="p-6 pb-4">
          <div className="flex items-center gap-3 mb-4">
            <LogoIcon className="w-10 h-10" />
            <span className="text-xl font-semibold text-foreground">
              flowstate
            </span>
          </div>

          <h2 className="text-2xl font-bold text-foreground mb-1">
            {isSuccess ? 'Check your email' : 'Reset password'}
          </h2>
          <p className="text-sm text-muted-foreground">
            {isSuccess
              ? 'We sent you a link to reset your password'
              : 'Enter your email and we\'ll send you a reset link'}
          </p>
        </div>

        <div className="px-6 pb-6">
          {isSuccess ? (
            <div className="text-center py-4">
              <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-green-500/20 flex items-center justify-center">
                <CheckCircle className="w-8 h-8 text-green-600 dark:text-green-400" />
              </div>
              <p className="text-muted-foreground mb-4">
                We&apos;ve sent a password reset link to <strong className="text-foreground">{email}</strong>
              </p>
              <p className="text-sm text-muted-foreground/70 mb-6">
                Didn&apos;t receive the email? Check your spam folder or try again.
              </p>
              <button
                type="button"
                onClick={onBackToSignIn}
                className="inline-flex items-center gap-2 text-foreground underline underline-offset-4 hover:text-foreground-secondary font-medium"
              >
                <ArrowLeft className="w-4 h-4" />
                Back to sign in
              </button>
            </div>
          ) : (
            <>
              {error && (
                <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl mb-3">
                  <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
                </div>
              )}

              <form onSubmit={handleSubmit}>
                <div className="mb-4">
                  <label htmlFor="forgot-email" className="block text-sm font-medium text-foreground mb-1.5">
                    Email
                  </label>
                  <input
                    id="forgot-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    className="w-full px-4 py-2.5 bg-secondary border border-border rounded-md text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring focus:border-ring transition-colors"
                    placeholder="you@example.com"
                  />
                </div>

                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full py-2.5 px-4 bg-foreground text-background font-medium rounded-full hover:bg-foreground/85 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-3"
                >
                  {isLoading ? (
                    <>
                      <Loader2 className="w-5 h-5 animate-spin" />
                      <span>Sending...</span>
                    </>
                  ) : (
                    <span>Send Reset Link</span>
                  )}
                </button>
              </form>

              <p className="text-sm text-muted-foreground text-center mt-4">
                <button
                  type="button"
                  onClick={onBackToSignIn}
                  className="inline-flex items-center gap-1 text-foreground underline underline-offset-4 hover:text-foreground-secondary font-medium"
                >
                  <ArrowLeft className="w-4 h-4" />
                  Back to sign in
                </button>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
