'use client'

import { useState, useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { METHODOLOGY_SECTIONS } from './content'
import CommentThread from './CommentThread'

export default function MethodologyPage() {
  const [activeSection, setActiveSection] = useState(METHODOLOGY_SECTIONS[0].id)
  const sectionRefs = useRef<Map<string, HTMLDivElement>>(new Map())
  const observerRef = useRef<IntersectionObserver | null>(null)

  // Track which section is in view
  useEffect(() => {
    observerRef.current = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setActiveSection(entry.target.id)
            break
          }
        }
      },
      { rootMargin: '-100px 0px -60% 0px', threshold: 0 }
    )

    sectionRefs.current.forEach((el) => {
      observerRef.current?.observe(el)
    })

    return () => observerRef.current?.disconnect()
  }, [])

  const scrollToSection = (sectionId: string) => {
    const el = sectionRefs.current.get(sectionId)
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }

  return (
    <div className="mx-auto max-w-7xl px-6 py-8 space-y-6 animate-in fade-in duration-500">
      {/* Header */}
      <div className="space-y-2">
        <h1 className="text-3xl font-bold text-foreground tracking-tight">Evaluation Methodology</h1>
        <p className="text-base text-foreground-tertiary">
          Detailed documentation of our property analysis and valuation process. Comment on any section to share feedback.
        </p>
      </div>

      <div className="flex gap-8">
        {/* Table of Contents — sticky on desktop */}
        <nav className="hidden lg:block w-56 flex-shrink-0">
          <div className="sticky top-24 space-y-1">
            <p className="text-sm font-medium text-foreground-tertiary mb-3 px-3">
              On this page
            </p>
            {METHODOLOGY_SECTIONS.map((section) => (
              <button
                key={section.id}
                onClick={() => scrollToSection(section.id)}
                className={cn(
                  'block w-full text-left px-3 py-2 rounded-lg text-sm transition-colors',
                  activeSection === section.id
                    ? 'text-primary bg-primary/10 font-medium'
                    : 'text-foreground-tertiary hover:text-foreground hover:bg-secondary'
                )}
              >
                {section.title}
              </button>
            ))}
          </div>
        </nav>

        {/* Mobile section nav */}
        <div className="lg:hidden overflow-x-auto pb-2 -mx-4 px-4 mb-2 flex gap-2">
          {METHODOLOGY_SECTIONS.map((section) => (
            <button
              key={section.id}
              onClick={() => scrollToSection(section.id)}
              className={cn(
                'flex-shrink-0 px-3 py-1.5 rounded-lg text-sm transition-colors whitespace-nowrap',
                activeSection === section.id
                  ? 'text-primary bg-primary/10 font-medium'
                  : 'text-foreground-tertiary bg-secondary hover:text-foreground'
              )}
            >
              {section.title}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0 space-y-12">
          {METHODOLOGY_SECTIONS.map((section) => (
            <div
              key={section.id}
              id={section.id}
              ref={(el) => {
                if (el) sectionRefs.current.set(section.id, el)
              }}
              className="scroll-mt-24"
            >
              <div className="rounded-2xl border border-border p-6 lg:p-8">
                <h2 className="text-2xl font-semibold text-foreground mb-6">
                  {section.title}
                </h2>
                {section.content}
                <CommentThread sectionId={section.id} />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
