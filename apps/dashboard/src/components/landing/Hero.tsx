'use client'

import { ArrowRight, MapPin, Terminal, Copy, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useState, useEffect, useCallback } from 'react'

interface HeroProps {
  onGetStartedClick: () => void
}

interface TerminalLine {
  type: 'command' | 'output' | 'success' | 'loading'
  content: string
  color?: string
}

export function Hero({ onGetStartedClick }: HeroProps) {
  const [copied, setCopied] = useState(false)
  const [lines, setLines] = useState<TerminalLine[]>([])
  const [currentText, setCurrentText] = useState('')
  const [isTyping, setIsTyping] = useState(false)
  const [showCursor, setShowCursor] = useState(true)
  const [commandIndex, setCommandIndex] = useState(0)

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
    <section className="relative pt-24 sm:pt-32 pb-12 sm:pb-16 overflow-hidden bg-background">
      {/* Subtle gradient overlay */}
      <div className="absolute inset-0 bg-gradient-to-br from-transparent via-purple-950/10 to-transparent" />

      <div className="relative z-10 max-w-6xl mx-auto px-4 sm:px-6 w-full">
        <div className="grid lg:grid-cols-2 gap-8 lg:gap-16 items-center">
          {/* Left side - Text content */}
          <div className="space-y-6 sm:space-y-8 text-center lg:text-left">
            {/* Main headline - italic serif style like agent.flowstate.homes */}
            <h1 className="text-4xl sm:text-5xl lg:text-6xl font-serif font-normal text-foreground leading-[1.1] mb-4 sm:mb-6">
              <span className="italic">Analyze fast,</span>
              <br />
              <span>invest smarter</span>
            </h1>

            {/* Subtitle */}
            <p className="text-base sm:text-lg text-muted-foreground max-w-md leading-relaxed mx-auto lg:mx-0">
              Get instant property valuations, comparable sales, and investment analysis powered by AI.
            </p>

            {/* Search input like agent site */}
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 sm:gap-3 p-2 sm:pl-5 bg-secondary/50 border border-border rounded-xl max-w-md mx-auto lg:mx-0">
              <div className="flex items-center gap-3 flex-1 px-3 sm:px-0">
                <MapPin className="h-5 w-5 text-muted-foreground flex-shrink-0" />
                <Input
                  type="text"
                  placeholder="Enter a property address..."
                  className="flex-1 bg-transparent border-0 text-foreground placeholder:text-muted-foreground text-[15px] focus-visible:ring-0 shadow-none"
                />
              </div>
              <Button
                onClick={onGetStartedClick}
                variant="secondary"
                className="bg-secondary hover:bg-secondary/80 text-foreground w-full sm:w-auto"
              >
                Analyze
                <ArrowRight className="h-4 w-4" />
              </Button>
            </div>
          </div>

          {/* Right side - Terminal API demo */}
          <div className="w-full">
            <div className="rounded-xl overflow-hidden border border-border bg-card shadow-2xl">
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
                          <span className="text-purple-500 dark:text-purple-400">
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
                            <span className="w-1.5 h-1.5 rounded-full bg-purple-500 dark:bg-purple-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                            <span className="w-1.5 h-1.5 rounded-full bg-purple-500 dark:bg-purple-400 animate-bounce" style={{ animationDelay: '150ms' }} />
                            <span className="w-1.5 h-1.5 rounded-full bg-purple-500 dark:bg-purple-400 animate-bounce" style={{ animationDelay: '300ms' }} />
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
