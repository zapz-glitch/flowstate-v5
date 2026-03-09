'use client'

import { useState, useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { signIn, signUp, forgetPassword } from '@/lib/auth-client'
import { LogoIcon } from '@/components/ui/Logo'
import { Loader2, ArrowLeft, CheckCircle } from 'lucide-react'

interface AuthModalsProps {
  isSignInOpen: boolean
  isSignUpOpen: boolean
  onSignInOpenChange: (open: boolean) => void
  onSignUpOpenChange: (open: boolean) => void
}

export function AuthModals({
  isSignInOpen,
  isSignUpOpen,
  onSignInOpenChange,
  onSignUpOpenChange,
}: AuthModalsProps) {
  const [isForgotPasswordOpen, setIsForgotPasswordOpen] = useState(false)

  return (
    <>
      <SignInModal
        isOpen={isSignInOpen}
        onClose={() => onSignInOpenChange(false)}
        onForgotPassword={() => {
          onSignInOpenChange(false)
          setIsForgotPasswordOpen(true)
        }}
        onSwitchToSignUp={() => {
          onSignInOpenChange(false)
          onSignUpOpenChange(true)
        }}
      />
      <SignUpModal
        isOpen={isSignUpOpen}
        onClose={() => onSignUpOpenChange(false)}
        onSwitchToSignIn={() => {
          onSignUpOpenChange(false)
          onSignInOpenChange(true)
        }}
      />
      <ForgotPasswordModal
        isOpen={isForgotPasswordOpen}
        onClose={() => setIsForgotPasswordOpen(false)}
        onBackToSignIn={() => {
          setIsForgotPasswordOpen(false)
          onSignInOpenChange(true)
        }}
      />
    </>
  )
}

interface SignInModalProps {
  isOpen: boolean
  onClose: () => void
  onForgotPassword?: () => void
  onSwitchToSignUp?: () => void
}

function SignInModal({ isOpen, onClose, onForgotPassword, onSwitchToSignUp }: SignInModalProps) {
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
        <div className="relative rounded-3xl shadow-2xl overflow-hidden bg-card">
          {/* Background gradient */}
          <div className="absolute inset-0 bg-gradient-to-br from-purple-500/5 via-transparent to-violet-500/5" />
          <div className="absolute inset-0 rounded-3xl border border-border" />

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

              <h2 className="text-2xl font-bold text-foreground mb-1">
                Welcome back
              </h2>
              <p className="text-sm text-muted-foreground">
                Sign in to access your account
              </p>
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
                    Email
                  </label>
                  <input
                    id="signin-email"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    className="w-full px-4 py-2.5 bg-secondary border border-border rounded-xl text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-purple-500/50 focus:border-purple-500/50 transition-colors"
                    placeholder="you@example.com"
                  />
                </div>

                {/* Password field */}
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
                    className="w-full px-4 py-2.5 bg-secondary border border-border rounded-xl text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-purple-500/50 focus:border-purple-500/50 transition-colors"
                    placeholder="••••••••"
                  />
                </div>

                {/* Forgot password link */}
                {onForgotPassword && (
                  <div className="mb-3 text-right">
                    <button
                      type="button"
                      onClick={onForgotPassword}
                      className="text-sm text-purple-600 dark:text-purple-400 hover:underline"
                    >
                      Forgot password?
                    </button>
                  </div>
                )}

                {/* Submit button */}
                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full py-2.5 px-4 bg-gradient-to-r from-purple-500 to-violet-600 text-white font-medium rounded-xl hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-3 shadow-lg shadow-purple-500/25"
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

              {/* Switch to sign up */}
              {onSwitchToSignUp && (
                <p className="text-sm text-muted-foreground text-center mt-4">
                  Don&apos;t have an account?{' '}
                  <button
                    type="button"
                    onClick={onSwitchToSignUp}
                    className="text-purple-600 dark:text-purple-400 hover:underline font-medium"
                  >
                    Sign up
                  </button>
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

interface SignUpModalProps {
  isOpen: boolean
  onClose: () => void
  onSwitchToSignIn?: () => void
}

function SignUpModal({ isOpen, onClose, onSwitchToSignIn }: SignUpModalProps) {
  const router = useRouter()
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')

  // Reset form when modal opens/closes
  useEffect(() => {
    if (isOpen) {
      setError(null)
      setName('')
      setEmail('')
      setPassword('')
      setConfirmPassword('')
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

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsLoading(true)
    setError(null)

    // Validate passwords match
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
      const result = await signUp.email({
        email,
        password,
        name,
      })

      if (result.error) {
        setError(result.error.message || 'Failed to create account. Please try again.')
        setIsLoading(false)
        return
      }

      // Success - redirect to dashboard
      onClose()
      router.push('/dashboard')
      router.refresh()
    } catch {
      setError('Failed to create account. Please try again.')
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
      <div className="relative w-full max-w-md mx-4 animate-in fade-in zoom-in-95 duration-200 max-h-[90vh] overflow-y-auto">
        <div className="relative rounded-3xl shadow-2xl overflow-hidden bg-card">
          {/* Background gradient */}
          <div className="absolute inset-0 bg-gradient-to-br from-purple-500/5 via-transparent to-violet-500/5" />
          <div className="absolute inset-0 rounded-3xl border border-border" />

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
            <div className="p-6 pb-3">
              <div className="flex items-center gap-3 mb-3">
                <LogoIcon className="w-10 h-10" />
                <span className="text-xl font-semibold text-foreground">flowstate</span>
              </div>

              <h2 className="text-2xl font-bold text-foreground mb-1">
                Create an account
              </h2>
              <p className="text-sm text-muted-foreground">
                Sign up to get started with Flowstate API
              </p>
            </div>

            {/* Form */}
            <div className="px-6 pb-6">
              {/* Error message */}
              {error && (
                <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl mb-3">
                  <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
                </div>
              )}

              <form onSubmit={handleSignUp}>
                {/* Name and Email in a row */}
                <div className="grid grid-cols-2 gap-3 mb-3">
                  {/* Name field */}
                  <div>
                    <label htmlFor="signup-name" className="block text-sm font-medium text-foreground mb-1">
                      Full Name
                    </label>
                    <input
                      id="signup-name"
                      type="text"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      required
                      className="w-full px-3 py-2 bg-secondary border border-border rounded-xl text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-purple-500/50 focus:border-purple-500/50 transition-colors text-sm"
                      placeholder="John Doe"
                    />
                  </div>

                  {/* Email field */}
                  <div>
                    <label htmlFor="signup-email" className="block text-sm font-medium text-foreground mb-1">
                      Email
                    </label>
                    <input
                      id="signup-email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                      className="w-full px-3 py-2 bg-secondary border border-border rounded-xl text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-purple-500/50 focus:border-purple-500/50 transition-colors text-sm"
                      placeholder="you@example.com"
                    />
                  </div>
                </div>

                {/* Password fields in a row */}
                <div className="grid grid-cols-2 gap-3 mb-4">
                  {/* Password field */}
                  <div>
                    <label htmlFor="signup-password" className="block text-sm font-medium text-foreground mb-1">
                      Password
                    </label>
                    <input
                      id="signup-password"
                      type="password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      minLength={8}
                      className="w-full px-3 py-2 bg-secondary border border-border rounded-xl text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-purple-500/50 focus:border-purple-500/50 transition-colors text-sm"
                      placeholder="••••••••"
                    />
                  </div>

                  {/* Confirm Password field */}
                  <div>
                    <label htmlFor="signup-confirm-password" className="block text-sm font-medium text-foreground mb-1">
                      Confirm Password
                    </label>
                    <input
                      id="signup-confirm-password"
                      type="password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      required
                      minLength={8}
                      className="w-full px-3 py-2 bg-secondary border border-border rounded-xl text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-purple-500/50 focus:border-purple-500/50 transition-colors text-sm"
                      placeholder="••••••••"
                    />
                  </div>
                </div>

                <p className="text-xs text-muted-foreground mb-3">Password must be at least 8 characters</p>

                {/* Submit button */}
                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full py-2.5 px-4 bg-gradient-to-r from-purple-500 to-violet-600 text-white font-medium rounded-xl hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-3 shadow-lg shadow-purple-500/25"
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

              {/* Terms note */}
              <p className="text-xs text-muted-foreground text-center mt-3">
                By creating an account, you agree to our{' '}
                <a href="/terms" className="text-purple-600 dark:text-purple-400 hover:underline">Terms of Service</a>
                {' '}and{' '}
                <a href="/privacy" className="text-purple-600 dark:text-purple-400 hover:underline">Privacy Policy</a>
              </p>

              {/* Switch to sign in */}
              {onSwitchToSignIn && (
                <p className="text-sm text-muted-foreground text-center mt-3">
                  Already have an account?{' '}
                  <button
                    type="button"
                    onClick={onSwitchToSignIn}
                    className="text-purple-600 dark:text-purple-400 hover:underline font-medium"
                  >
                    Sign in
                  </button>
                </p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

interface ForgotPasswordModalProps {
  isOpen: boolean
  onClose: () => void
  onBackToSignIn?: () => void
}

function ForgotPasswordModal({ isOpen, onClose, onBackToSignIn }: ForgotPasswordModalProps) {
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const [isSuccess, setIsSuccess] = useState(false)

  // Reset form when modal opens/closes
  useEffect(() => {
    if (isOpen) {
      setError(null)
      setEmail('')
      setIsSuccess(false)
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
        <div className="relative rounded-3xl shadow-2xl overflow-hidden bg-card">
          {/* Background gradient */}
          <div className="absolute inset-0 bg-gradient-to-br from-purple-500/5 via-transparent to-violet-500/5" />
          <div className="absolute inset-0 rounded-3xl border border-border" />

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

              <h2 className="text-2xl font-bold text-foreground mb-1">
                {isSuccess ? 'Check your email' : 'Reset password'}
              </h2>
              <p className="text-sm text-muted-foreground">
                {isSuccess
                  ? 'We sent you a link to reset your password'
                  : 'Enter your email and we\'ll send you a reset link'}
              </p>
            </div>

            {/* Form */}
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
                    className="inline-flex items-center gap-2 text-purple-600 dark:text-purple-400 hover:underline font-medium"
                  >
                    <ArrowLeft className="w-4 h-4" />
                    Back to sign in
                  </button>
                </div>
              ) : (
                <>
                  {/* Error message */}
                  {error && (
                    <div className="p-3 bg-red-500/10 border border-red-500/20 rounded-xl mb-3">
                      <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
                    </div>
                  )}

                  <form onSubmit={handleSubmit}>
                    {/* Email field */}
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
                        className="w-full px-4 py-2.5 bg-secondary border border-border rounded-xl text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-purple-500/50 focus:border-purple-500/50 transition-colors"
                        placeholder="you@example.com"
                      />
                    </div>

                    {/* Submit button */}
                    <button
                      type="submit"
                      disabled={isLoading}
                      className="w-full py-2.5 px-4 bg-gradient-to-r from-purple-500 to-violet-600 text-white font-medium rounded-xl hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-3 shadow-lg shadow-purple-500/25"
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

                  {/* Back to sign in */}
                  {onBackToSignIn && (
                    <p className="text-sm text-muted-foreground text-center mt-4">
                      <button
                        type="button"
                        onClick={onBackToSignIn}
                        className="inline-flex items-center gap-1 text-purple-600 dark:text-purple-400 hover:underline font-medium"
                      >
                        <ArrowLeft className="w-4 h-4" />
                        Back to sign in
                      </button>
                    </p>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
