'use client'

import { useState, useCallback, useRef, Fragment } from 'react'
import { Plus, X, Loader2, Sparkles } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  uploadReportPhotos,
  deleteReportPhoto,
  type UploadedPhoto,
} from '@/lib/client-api'

interface PhotoItem {
  id: string
  fileName: string
  mimeType: string
  sizeBytes: number
}

interface PhotoUploadProps {
  jobId: string
  photos: PhotoItem[]
  onPhotosChange: (photos: PhotoItem[]) => void
  analyzing?: boolean
  onAnalyze: () => void
}

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB
const MAX_FILES = 20
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp']

export function PhotoUpload({ jobId, photos, onPhotosChange, analyzing, onAnalyze }: PhotoUploadProps) {
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFiles = useCallback(async (files: FileList | File[]) => {
    setError(null)
    const fileArray = Array.from(files)

    if (photos.length + fileArray.length > MAX_FILES) {
      setError(`Maximum ${MAX_FILES} photos per report`)
      return
    }

    for (const file of fileArray) {
      if (!ALLOWED_TYPES.includes(file.type)) {
        setError(`Invalid file type: ${file.name}. Only JPEG, PNG, and WebP.`)
        return
      }
      if (file.size > MAX_FILE_SIZE) {
        setError(`${file.name} exceeds 10MB limit`)
        return
      }
    }

    try {
      setUploading(true)
      const uploaded = await uploadReportPhotos(jobId, fileArray)
      const newPhotos: PhotoItem[] = uploaded.map((p: UploadedPhoto) => ({
        id: p.id,
        fileName: p.fileName,
        mimeType: p.mimeType,
        sizeBytes: p.sizeBytes,
      }))
      onPhotosChange([...photos, ...newPhotos])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed')
    } finally {
      setUploading(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }, [jobId, photos, onPhotosChange])

  const handleDelete = useCallback(async (photoId: string) => {
    try {
      setDeletingId(photoId)
      await deleteReportPhoto(jobId, photoId)
      onPhotosChange(photos.filter((p) => p.id !== photoId))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed')
    } finally {
      setDeletingId(null)
    }
  }, [jobId, photos, onPhotosChange])

  return (
    <Fragment>
      {/* Uploaded photo thumbnails */}
      {photos.map((photo) => (
        <div
          key={photo.id}
          className="relative group flex-shrink-0 w-20 h-14 rounded-lg bg-muted/60 border border-border overflow-hidden flex items-center justify-center"
        >
          <span className="text-[9px] text-foreground-tertiary text-center px-1 truncate max-w-full leading-tight">
            {photo.fileName}
          </span>
          <button
            type="button"
            onClick={() => handleDelete(photo.id)}
            disabled={deletingId === photo.id}
            className="absolute top-0.5 right-0.5 p-0.5 rounded-full bg-background/90 text-foreground-tertiary hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
          >
            {deletingId === photo.id ? (
              <Loader2 className="w-2.5 h-2.5 animate-spin" />
            ) : (
              <X className="w-2.5 h-2.5" />
            )}
          </button>
        </div>
      ))}

      {/* + Upload tile */}
      <button
        type="button"
        onClick={() => fileInputRef.current?.click()}
        disabled={uploading}
        className={cn(
          'flex-shrink-0 w-20 h-14 rounded-lg border-2 border-dashed flex flex-col items-center justify-center gap-0.5 cursor-pointer transition-colors',
          uploading
            ? 'border-primary/40 bg-primary/5 pointer-events-none'
            : 'border-border hover:border-foreground-tertiary hover:bg-muted/30'
        )}
      >
        {uploading ? (
          <Loader2 className="w-4 h-4 text-primary animate-spin" />
        ) : (
          <Plus className="w-4 h-4 text-foreground-tertiary" />
        )}
        <span className="text-[9px] text-foreground-tertiary leading-tight">
          {uploading ? 'Uploading' : 'Upload'}
        </span>
      </button>

      {/* Analyze button */}
      {photos.length > 0 && (
        <button
          type="button"
          onClick={onAnalyze}
          disabled={analyzing || uploading}
          className={cn(
            'flex-shrink-0 h-14 px-3 rounded-lg flex items-center gap-1.5 text-caption font-medium transition-colors',
            analyzing
              ? 'bg-primary/10 text-primary cursor-wait'
              : 'bg-primary text-white hover:bg-primary/90'
          )}
        >
          {analyzing ? (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span className="hidden sm:inline">Analyzing...</span>
            </>
          ) : (
            <>
              <Sparkles className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Analyze</span>
            </>
          )}
        </button>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        multiple
        className="hidden"
        onChange={(e) => e.target.files?.length && handleFiles(e.target.files)}
      />

      {/* Error tooltip — positioned absolute so it doesn't break the flex row */}
      {error && (
        <span className="flex-shrink-0 text-[10px] text-red-500 self-center">{error}</span>
      )}
    </Fragment>
  )
}
