'use client'

import { Terminal, Copy, Check, Loader2, CheckCircle } from 'lucide-react'
import { useState, useEffect, useCallback } from 'react'

interface HeroProps {
  onGetStartedClick: () => void
}

interface TerminalLine {
  type: 'command' | 'output' | 'success' | 'loading'
  content: string
  color?: string
}

export function Hero({ onGetStartedClick: _onGetStartedClick }: HeroProps) {
  const [copied, setCopied] = useState(false)
  const [lines, setLines] = useState<TerminalLine[]>([])
  const [currentText, setCurrentText] = useState('')
  const [isTyping, setIsTyping] = useState(false)
  const [showCursor, setShowCursor] = useState(true)
  const [commandIndex, setCommandIndex] = useState(0)

  // Waitlist form state
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [waitlistLoading, setWaitlistLoading] = useState(false)
  const [waitlistError, setWaitlistError] = useState<string | null>(null)
  const [waitlistSuccess, setWaitlistSuccess] = useState<string | null>(null)

  const handleWaitlistSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setWaitlistLoading(true)
    setWaitlistError(null)

    try {
      const apiUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8787'
      const res = await fetch(`${apiUrl}/waitlist`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, firstName, lastName }),
      })
      const data = await res.json() as { success?: boolean; error?: string; message?: string }
      if (!res.ok || !data.success) {
        setWaitlistError(data.error || 'Something went wrong. Please try again.')
        return
      }
      setWaitlistSuccess(data.message || 'You\'ve been added to the waitlist!')
      setFirstName('')
      setLastName('')
      setEmail('')
    } catch {
      setWaitlistError('Unable to connect. Please try again later.')
    } finally {
      setWaitlistLoading(false)
    }
  }

  const curlCommand = `curl -X POST https://api.flowstate.homes/v1/analyze \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"address": "123 Main St, Tampa, FL 33607"}'`

  const commands = [
    {
      text: 'curl -X POST api.flowstate.homes/v1/analyze -H "Authorization: Bearer fs_k..." -d \'{"address": "123 Main St, Tampa, FL 33607"}\'',
      response: [
        '{ "success": true, "data": {',
        '    "jobId": "job_17081234_abc",',
        '    "status": "queued",',
        '    "propertyBundle": {',
        '      "subject": {',
        '        "address": "123 Main St, Tampa, FL",',
        '        "bedrooms": 3, "bathrooms": 2,',
        '        "squareFeet": 1850,',
        '        "yearBuilt": 1995',
        '      }',
        '    },',
        '    "streamUrl": "/sse/analyze/job_..."',
        '  }',
        '}',
      ],
      successMsg: 'Job queued — streaming results via SSE'
    },
    {
      text: 'curl -X POST api.flowstate.homes/v1/analyze -H "Authorization: Bearer fs_k..." -d \'{"address": "456 Oak Ave, Miami, FL", "searchOptions": {"radiusMiles": 0.5, "monthsBack": 6}}\'',
      response: [
        '{ "success": true, "data": {',
        '    "jobId": "job_17089876_xyz",',
        '    "status": "queued",',
        '    "propertyBundle": {',
        '      "subject": {',
        '        "address": "456 Oak Ave, Miami, FL",',
        '        "bedrooms": 4, "bathrooms": 3,',
        '        "squareFeet": 2400,',
        '        "yearBuilt": 2003',
        '      }',
        '    },',
        '    "streamUrl": "/sse/analyze/job_..."',
        '  }',
        '}',
      ],
      successMsg: 'Job queued — custom search radius 0.5mi'
    },
    {
      text: 'curl -X POST api.flowstate.homes/v1/analyze -H "Authorization: Bearer fs_k..." -d \'{"address": "789 Palm Dr, Orlando, FL", "buybox": {"rehabLevelIndex": 3, "closingCostsPercent": 8}}\'',
      response: [
        '{ "success": true, "data": {',
        '    "jobId": "job_17085555_def",',
        '    "status": "queued",',
        '    "propertyBundle": {',
        '      "subject": {',
        '        "address": "789 Palm Dr, Orlando, FL",',
        '        "bedrooms": 3, "bathrooms": 2,',
        '        "squareFeet": 1650,',
        '        "yearBuilt": 1988',
        '      }',
        '    },',
        '    "streamUrl": "/sse/analyze/job_..."',
        '  }',
        '}',
      ],
      successMsg: 'Job queued — rehab level 3, 8% closing'
    },
    {
      text: 'curl api.flowstate.homes/v1/analyze/jobs/job_17081234_abc',
      response: [
        '{ "success": true, "data": {',
        '    "status": "completed",',
        '    "result": {',
        '      "arv": 485000,',
        '      "buyPrice": 339500,',
        '      "rehabCost": 42750,',
        '      "recommendation": "Strong Buy",',
        '      "roi": 28.4,',
        '      "compsUsed": 3',
        '    }',
        '  }',
        '}',
      ],
      successMsg: 'Analysis complete — Strong Buy, 28.4% ROI'
    }
  ]

  // Blinking cursor
  useEffect(() => {
    const cursorInterval = setInterval(() => {
      setShowCursor(prev => !prev)
    }, 530)
    return () => clearInterval(cursorInterval)
  }, [])

  // Type a single character
  const typeCharacter = useCallback((text: string, index: number, onComplete: () => void) => {
    if (index <= text.length) {
      setCurrentText(text.slice(0, index))
      if (index < text.length) {
        const delay = 25 + Math.random() * 35 // Natural typing speed
        setTimeout(() => typeCharacter(text, index + 1, onComplete), delay)
      } else {
        onComplete()
      }
    }
  }, [])

  // Add output lines one by one
  const showOutput = useCallback((outputLines: string[], index: number, onComplete: () => void) => {
    if (index < outputLines.length) {
      setLines(prev => [...prev, { type: 'output', content: outputLines[index] }])
      setTimeout(() => showOutput(outputLines, index + 1, onComplete), 60)
    } else {
      onComplete()
    }
  }, [])

  // Main animation loop
  useEffect(() => {
    const runAnimation = async () => {
      const command = commands[commandIndex]

      // Clear and start fresh
      setLines([])
      setCurrentText('')
      setIsTyping(true)

      // Wait a moment before starting
      await new Promise(resolve => setTimeout(resolve, 800))

      // Type the command
      await new Promise<void>(resolve => {
        typeCharacter(command.text, 0, resolve)
      })

      // Add the command to lines
      setLines([{ type: 'command', content: command.text }])
      setCurrentText('')
      setIsTyping(false)

      // Show loading
      await new Promise(resolve => setTimeout(resolve, 300))
      setLines(prev => [...prev, { type: 'loading', content: 'Fetching...' }])

      // Wait for "response"
      await new Promise(resolve => setTimeout(resolve, 600))

      // Remove loading and show response
      setLines(prev => prev.filter(l => l.type !== 'loading'))

      await new Promise<void>(resolve => {
        showOutput(command.response, 0, resolve)
      })

      // Show success message
      await new Promise(resolve => setTimeout(resolve, 200))
      setLines(prev => [...prev, { type: 'success', content: command.successMsg }])

      // Wait before next command
      await new Promise(resolve => setTimeout(resolve, 3000))

      // Move to next command
      setCommandIndex(prev => (prev + 1) % commands.length)
    }

    runAnimation()
  }, [commandIndex]) // eslint-disable-line react-hooks/exhaustive-deps

  const handleCopy = () => {
    navigator.clipboard.writeText(curlCommand)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <section className="relative pt-28 sm:pt-40 pb-16 sm:pb-24 overflow-hidden bg-background border-b border-border">
      <div className="relative z-10 max-w-6xl mx-auto px-4 sm:px-6 w-full">
        <div className="grid lg:grid-cols-2 gap-10 lg:gap-20 items-center">
          {/* Left side - Text content */}
          <div className="space-y-6 sm:space-y-8 text-center lg:text-left">
            <p className="mono-label">01 / Property valuation API</p>

            {/* Main headline - tight grotesque, monochrome */}
            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-sans font-medium tracking-[-0.03em] text-foreground leading-[1.05] mb-4 sm:mb-6">
              Analyze fast.
              <br />
              <span className="text-foreground-secondary">Invest smarter.</span>
            </h1>

            {/* Subtitle */}
            <p className="text-base sm:text-lg text-muted-foreground max-w-md leading-relaxed mx-auto lg:mx-0">
              Get instant property valuations, comparable sales, and investment analysis powered by AI.
            </p>

            {/* Waitlist form */}
            <div className="max-w-md mx-auto lg:mx-0">
              {waitlistSuccess ? (
                <div className="flex items-center gap-3">
                  <CheckCircle className="w-5 h-5 text-green-500 flex-shrink-0" />
                  <p className="text-foreground font-medium text-sm">{waitlistSuccess}</p>
                </div>
              ) : (
                <form onSubmit={handleWaitlistSubmit} className="space-y-2.5">
                  {waitlistError && (
                    <p className="text-sm text-red-600 dark:text-red-400">{waitlistError}</p>
                  )}
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={firstName}
                      onChange={(e) => setFirstName(e.target.value)}
                      required
                      placeholder="First name"
                      className="flex-1 min-w-0 px-3.5 py-2.5 bg-secondary/50 border border-border rounded-md text-foreground placeholder:text-muted-foreground text-sm focus:outline-none focus:ring-1 focus:ring-ring focus:border-ring transition-colors"
                    />
                    <input
                      type="text"
                      value={lastName}
                      onChange={(e) => setLastName(e.target.value)}
                      required
                      placeholder="Last name"
                      className="flex-1 min-w-0 px-3.5 py-2.5 bg-secondary/50 border border-border rounded-md text-foreground placeholder:text-muted-foreground text-sm focus:outline-none focus:ring-1 focus:ring-ring focus:border-ring transition-colors"
                    />
                  </div>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    placeholder="you@example.com"
                    className="w-full px-3.5 py-2.5 bg-secondary/50 border border-border rounded-md text-foreground placeholder:text-muted-foreground text-sm focus:outline-none focus:ring-1 focus:ring-ring focus:border-ring transition-colors"
                  />
                  <button
                    type="submit"
                    disabled={waitlistLoading}
                    className="w-full py-2.5 px-4 bg-foreground text-background font-medium rounded-full hover:bg-foreground/85 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-2"
                  >
                    {waitlistLoading ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        <span>Joining...</span>
                      </>
                    ) : (
                      <span>Get Early Access</span>
                    )}
                  </button>
                  <p className="text-xs text-muted-foreground/50">No spam. Unsubscribe anytime.</p>
                </form>
              )}
            </div>
          </div>

          {/* Right side - Terminal API demo */}
          <div className="w-full">
            <div className="rounded-lg overflow-hidden border border-border bg-card">
              {/* Terminal header */}
              <div className="flex items-center justify-between px-3 sm:px-4 py-2.5 sm:py-3 bg-secondary border-b border-border">
                <div className="flex items-center gap-2">
                  <div className="flex gap-1.5">
                    <div className="w-2.5 sm:w-3 h-2.5 sm:h-3 rounded-full bg-red-500/80 transition-all hover:bg-red-500" />
                    <div className="w-2.5 sm:w-3 h-2.5 sm:h-3 rounded-full bg-yellow-500/80 transition-all hover:bg-yellow-500" />
                    <div className="w-2.5 sm:w-3 h-2.5 sm:h-3 rounded-full bg-green-500/80 transition-all hover:bg-green-500" />
                  </div>
                  <div className="flex items-center gap-2 ml-2 sm:ml-3 text-muted-foreground text-xs sm:text-sm">
                    <Terminal className="h-3.5 sm:h-4 w-3.5 sm:w-4" />
                    <span className="hidden sm:inline">Terminal</span>
                  </div>
                </div>
                <button
                  onClick={handleCopy}
                  className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors px-2 py-1 rounded hover:bg-secondary"
                >
                  {copied ? (
                    <>
                      <Check className="h-3.5 w-3.5 text-green-500 dark:text-green-400" />
                      <span className="text-green-500 dark:text-green-400 hidden sm:inline">Copied</span>
                    </>
                  ) : (
                    <>
                      <Copy className="h-3.5 w-3.5" />
                      <span className="hidden sm:inline">Copy</span>
                    </>
                  )}
                </button>
              </div>

              {/* Terminal content */}
              <div className="p-3 sm:p-4 font-mono text-xs sm:text-sm min-h-[200px] sm:min-h-[300px] max-h-[250px] sm:max-h-[300px] overflow-hidden">
                {/* Previous lines */}
                <div className="space-y-1">
                  {lines.map((line, index) => (
                    <div
                      key={index}
                      className="animate-in fade-in slide-in-from-bottom-1 duration-150"
                    >
                      {line.type === 'command' && (
                        <div className="flex items-start gap-2">
                          <span className="text-green-500 dark:text-green-400 select-none">$</span>
                          <span className="text-foreground/80 break-all">{line.content}</span>
                        </div>
                      )}
                      {line.type === 'output' && (
                        <div className="ml-4 text-xs">
                          <span className="text-foreground-secondary">
                            {line.content.replace(/"([^"]+)":/g, (_, key) => `"${key}":`).split(':')[0]}
                          </span>
                          <span className="text-muted-foreground">
                            {line.content.includes(':') ? ':' + line.content.split(':').slice(1).join(':') : ''}
                          </span>
                          {!line.content.includes(':') && (
                            <span className="text-muted-foreground">{line.content}</span>
                          )}
                        </div>
                      )}
                      {line.type === 'loading' && (
                        <div className="flex items-center gap-2 ml-4 text-muted-foreground">
                          <div className="flex gap-1">
                            <span className="w-1.5 h-1.5 rounded-full bg-foreground/50 animate-bounce" style={{ animationDelay: '0ms' }} />
                            <span className="w-1.5 h-1.5 rounded-full bg-foreground/50 animate-bounce" style={{ animationDelay: '150ms' }} />
                            <span className="w-1.5 h-1.5 rounded-full bg-foreground/50 animate-bounce" style={{ animationDelay: '300ms' }} />
                          </div>
                          <span className="text-xs">{line.content}</span>
                        </div>
                      )}
                      {line.type === 'success' && (
                        <div className="flex items-center gap-2 ml-4 text-green-500 dark:text-green-400 text-xs mt-2">
                          <Check className="h-3.5 w-3.5" />
                          <span>{line.content}</span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>

                {/* Current typing line */}
                {isTyping && (
                  <div className="flex items-start gap-2 mt-1">
                    <span className="text-green-500 dark:text-green-400 select-none">$</span>
                    <span className="text-foreground/80 break-all">
                      {currentText}
                      <span
                        className={`inline-block w-2 h-4 bg-foreground/70 ml-0.5 align-middle transition-opacity duration-100 ${
                          showCursor ? 'opacity-100' : 'opacity-0'
                        }`}
                      />
                    </span>
                  </div>
                )}

                {/* Waiting cursor when not typing */}
                {!isTyping && lines.length === 0 && (
                  <div className="flex items-start gap-2">
                    <span className="text-green-500 dark:text-green-400 select-none">$</span>
                    <span
                      className={`inline-block w-2 h-4 bg-foreground/70 transition-opacity duration-100 ${
                        showCursor ? 'opacity-100' : 'opacity-0'
                      }`}
                    />
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}
