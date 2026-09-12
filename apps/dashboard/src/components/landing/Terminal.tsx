'use client'

import { useEffect, useRef, useState } from 'react'
import { Loader2, Check } from 'lucide-react'
import { scenarios } from './terminal-script'

type TerminalLine =
  | { id: number; kind: 'command'; text: string }
  | { id: number; kind: 'step'; label: string; ms: number; done: boolean }
  | { id: number; kind: 'kv'; key: string; value: string; highlight?: boolean }
  | { id: number; kind: 'done'; text: string }
  | { id: number; kind: 'spacer' }

type Phase = 'typing' | 'running' | 'idle'

type TerminalLineInput = TerminalLine extends infer T
  ? T extends TerminalLine
    ? Omit<T, 'id'>
    : never
  : never

const MAX_LINES = 22

export function Terminal() {
  const [lines, setLines] = useState<TerminalLine[]>([])
  const [typed, setTyped] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const idCounter = useRef(0)

  useEffect(() => {
    let cancelled = false
    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
    const nextId = () => ++idCounter.current
    const push = (line: TerminalLineInput): number => {
      const id = nextId()
      setLines((prev) => [...prev, { ...line, id } as TerminalLine].slice(-MAX_LINES))
      return id
    }

    // Reduced motion: render the first scenario fully completed, no animation
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const scenario = scenarios[0]
      const rendered: TerminalLine[] = [
        { id: nextId(), kind: 'command', text: scenario.command },
        ...scenario.lines.map((l): TerminalLine => {
          if (l.kind === 'step') {
            return { id: nextId(), kind: 'step', label: l.label, ms: l.ms, done: true }
          }
          if (l.kind === 'kv') {
            return { id: nextId(), kind: 'kv', key: l.key, value: l.value, highlight: l.highlight }
          }
          return { id: nextId(), kind: 'done', text: l.text }
        }),
      ]
      setLines(rendered)
      setPhase('idle')
      return
    }

    const run = async () => {
      await sleep(600)
      if (cancelled) return

      let firstRun = true
      for (let i = 0; !cancelled; i = (i + 1) % scenarios.length) {
        const scenario = scenarios[i]
        if (!firstRun) push({ kind: 'spacer' })
        firstRun = false

        setPhase('typing')
        for (let n = 0; n < scenario.command.length; n++) {
          setTyped(scenario.command.slice(0, n + 1))
          await sleep(22 + Math.random() * 30)
          if (cancelled) return
        }
        await sleep(250)
        if (cancelled) return
        push({ kind: 'command', text: scenario.command })
        setTyped('')
        setPhase('running')

        for (const line of scenario.lines) {
          if (cancelled) return
          if (line.kind === 'step') {
            const id = push({ kind: 'step', label: line.label, ms: line.ms, done: false })
            await sleep(line.ms)
            if (cancelled) return
            setLines((prev) =>
              prev.map((l) => (l.id === id && l.kind === 'step' ? { ...l, done: true } : l))
            )
          } else if (line.kind === 'kv') {
            push({ kind: 'kv', key: line.key, value: line.value, highlight: line.highlight })
            await sleep(90)
            if (cancelled) return
          } else {
            await sleep(300)
            if (cancelled) return
            push({ kind: 'done', text: line.text })
          }
        }

        setPhase('idle')
        await sleep(3200)
      }
    }

    run()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5 bg-secondary/60 border-b border-border">
        <span className="h-2.5 w-2.5 rounded-full bg-border" />
        <span className="h-2.5 w-2.5 rounded-full bg-border" />
        <span className="h-2.5 w-2.5 rounded-full bg-border" />
        <span className="mono-label !text-[10px] ml-2">flowstate / underwriting</span>
      </div>

      <div className="p-4 font-mono text-[12px] sm:text-[13px] leading-relaxed h-[280px] sm:h-[320px] overflow-hidden flex flex-col justify-end">
        {lines.map((line) => (
          <div key={line.id} className="animate-[fadeIn_0.2s_ease-out_forwards]">
            {line.kind === 'command' && (
              <div>
                <span className="text-[#00D632] select-none">$</span>{' '}
                <span className="text-foreground/85 break-all">{line.text}</span>
              </div>
            )}
            {line.kind === 'step' && (
              <div className="pl-4 flex items-center gap-2">
                <span className="text-muted-foreground">
                  {'\u25B8'} {line.label}
                </span>
                <span className="flex-1 border-b border-dotted border-border/70 mx-1" />
                {line.done ? (
                  <span className="text-muted-foreground tabular-nums">
                    {(line.ms / 1000).toFixed(1)}s
                  </span>
                ) : (
                  <Loader2 className="h-3 w-3 animate-spin text-[#00D632]" />
                )}
              </div>
            )}
            {line.kind === 'kv' && (
              <div className="pl-4 flex gap-3">
                <span className="w-14 sm:w-16 shrink-0 text-muted-foreground">{line.key}</span>
                <span className={line.highlight ? 'text-[#00D632] font-medium' : 'text-foreground'}>
                  {line.value}
                </span>
              </div>
            )}
            {line.kind === 'done' && (
              <div className="pl-4 mt-1 flex items-center gap-2 text-foreground-secondary">
                <Check className="h-3.5 w-3.5 text-[#00D632]" />
                {line.text}
              </div>
            )}
            {line.kind === 'spacer' && <div className="h-3" />}
          </div>
        ))}

        {phase !== 'running' && (
          <div className="animate-[fadeIn_0.2s_ease-out_forwards]">
            <span className="text-[#00D632] select-none">$</span>{' '}
            <span className="text-foreground/85 break-all">{typed}</span>
            <span className="inline-block w-[7px] h-[15px] bg-[#00D632] align-middle ml-0.5 animate-caret" />
          </div>
        )}
      </div>
    </div>
  )
}
