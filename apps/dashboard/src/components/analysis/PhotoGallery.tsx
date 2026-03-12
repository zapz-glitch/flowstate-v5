'use client'

import { useState, useEffect } from 'react'
import { ChevronLeft, ChevronRight, X } from 'lucide-react'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { cn } from '@/lib/utils'

export function PhotoGallery({ photos, className, children }: { photos: string[]; className?: string; children?: React.ReactNode }) {
  const [lightboxOpen, setLightboxOpen] = useState(false)
  const [currentIndex, setCurrentIndex] = useState(0)

  const goToPrevious = () => {
    setCurrentIndex((prev) => (prev === 0 ? photos.length - 1 : prev - 1))
  }

  const goToNext = () => {
    setCurrentIndex((prev) => (prev === photos.length - 1 ? 0 : prev + 1))
  }

  useEffect(() => {
    if (!lightboxOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowLeft') setCurrentIndex((prev) => (prev === 0 ? photos.length - 1 : prev - 1))
      else if (e.key === 'ArrowRight') setCurrentIndex((prev) => (prev === photos.length - 1 ? 0 : prev + 1))
      else if (e.key === 'Escape') setLightboxOpen(false)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [lightboxOpen, photos.length])

  const hasPhotos = photos && photos.length > 0

  if (!hasPhotos && !children) return null

  return (
    <>
      <div className={cn('flex gap-1.5 overflow-x-auto pb-1 items-center', className)}>
        {hasPhotos && photos.slice(0, 6).map((photo, i) => (
          <button
            key={i}
            onClick={() => { setCurrentIndex(i); setLightboxOpen(true) }}
            className="relative group flex-shrink-0 rounded-lg overflow-hidden focus:outline-none focus:ring-2 focus:ring-primary focus:ring-offset-2"
          >
            <img
              src={photo}
              alt={`Photo ${i + 1}`}
              referrerPolicy="no-referrer"
              className="w-20 h-14 object-cover transition-transform group-hover:scale-105"
              onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
            />
            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-colors" />
          </button>
        ))}
        {hasPhotos && photos.length > 6 && (
          <button
            onClick={() => { setCurrentIndex(6); setLightboxOpen(true) }}
            className="w-20 h-14 rounded-lg border border-border flex items-center justify-center text-caption text-foreground-tertiary flex-shrink-0 hover:bg-secondary/80 transition-colors"
          >
            +{photos.length - 6}
          </button>
        )}
        {children}
      </div>

      {hasPhotos && <Dialog open={lightboxOpen} onOpenChange={setLightboxOpen}>
        <DialogContent className="max-w-4xl w-full p-0 bg-black/95 border-white/10 gap-0 overflow-hidden">
          <div className="relative flex items-center justify-center min-h-[60vh]">
            <button onClick={() => setLightboxOpen(false)} className="absolute top-4 right-4 z-10 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors">
              <X className="w-5 h-5" />
            </button>
            {photos.length > 1 && (
              <>
                <button onClick={goToPrevious} className="absolute left-4 z-10 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors">
                  <ChevronLeft className="w-6 h-6" />
                </button>
                <button onClick={goToNext} className="absolute right-4 z-10 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors">
                  <ChevronRight className="w-6 h-6" />
                </button>
              </>
            )}
            <img src={photos[currentIndex]} alt={`Photo ${currentIndex + 1}`} referrerPolicy="no-referrer" className="max-h-[70vh] max-w-full object-contain" />
          </div>
          <div className="p-4 bg-black/80 border-t border-white/10">
            <div className="flex gap-2 justify-center overflow-x-auto">
              {photos.map((photo, i) => (
                <button
                  key={i}
                  onClick={() => setCurrentIndex(i)}
                  className={cn(
                    'w-16 h-12 rounded-lg overflow-hidden flex-shrink-0 transition-all',
                    i === currentIndex ? 'ring-2 ring-primary ring-offset-2 ring-offset-black' : 'opacity-50 hover:opacity-100'
                  )}
                >
                  <img src={photo} alt={`Thumbnail ${i + 1}`} referrerPolicy="no-referrer" className="w-full h-full object-cover" />
                </button>
              ))}
            </div>
            <div className="text-center text-white/60 text-caption mt-2">{currentIndex + 1} / {photos.length}</div>
          </div>
        </DialogContent>
      </Dialog>}
    </>
  )
}
