'use client'

import { useState, useCallback } from 'react'
import { MessageSquare, Send, Pencil, Trash2, Reply, X, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useUser } from '@/components/auth/UserProvider'
import {
  getComments,
  createComment,
  updateComment,
  deleteComment,
  type DocComment,
} from '@/lib/client-api'

function getInitials(name: string): string {
  return name
    .split(' ')
    .map((n) => n[0])
    .join('')
    .toUpperCase()
    .slice(0, 2)
}

function timeAgo(dateStr: string): string {
  const now = Date.now()
  const date = new Date(dateStr).getTime()
  const diff = now - date
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  return new Date(dateStr).toLocaleDateString()
}

function CommentForm({
  onSubmit,
  onCancel,
  placeholder,
  autoFocus,
}: {
  onSubmit: (content: string) => Promise<void>
  onCancel?: () => void
  placeholder: string
  autoFocus?: boolean
}) {
  const [content, setContent] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async () => {
    if (!content.trim() || submitting) return
    setSubmitting(true)
    try {
      await onSubmit(content.trim())
      setContent('')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-2">
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        rows={3}
        maxLength={2000}
        className="w-full rounded-xl border border-border bg-background px-4 py-3 text-body-sm text-foreground placeholder:text-foreground-tertiary focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
      />
      <div className="flex items-center justify-between">
        <span className="text-caption-sm text-foreground-tertiary">
          {content.length}/2000
        </span>
        <div className="flex items-center gap-2">
          {onCancel && (
            <Button variant="ghost" size="sm" onClick={onCancel} className="text-foreground-tertiary">
              Cancel
            </Button>
          )}
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={!content.trim() || submitting}
            className="gap-1.5"
          >
            {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
            Post
          </Button>
        </div>
      </div>
    </div>
  )
}

function CommentItem({
  comment,
  onReply,
  onRefresh,
  isReply,
}: {
  comment: DocComment
  onReply?: (parentId: string) => void
  onRefresh: () => void
  isReply?: boolean
}) {
  const { user } = useUser()
  const [editing, setEditing] = useState(false)
  const [editContent, setEditContent] = useState(comment.content)
  const [saving, setSaving] = useState(false)

  const isOwner = user?.id === comment.user.id

  const handleEdit = async () => {
    if (!editContent.trim() || saving) return
    setSaving(true)
    try {
      await updateComment(comment.id, editContent.trim())
      setEditing(false)
      onRefresh()
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!confirm('Delete this comment?')) return
    await deleteComment(comment.id)
    onRefresh()
  }

  return (
    <div className={cn('flex gap-3', isReply && 'ml-10')}>
      <div className="flex-shrink-0 w-8 h-8 rounded-full bg-primary/15 text-primary flex items-center justify-center text-caption-sm font-medium">
        {getInitials(comment.user.name)}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-body-sm font-medium text-foreground">
            {comment.user.name}
          </span>
          <span className="text-caption-sm text-foreground-tertiary">
            {timeAgo(comment.createdAt)}
          </span>
          {comment.updatedAt !== comment.createdAt && !comment.isDeleted && (
            <span className="text-caption-sm text-foreground-tertiary">(edited)</span>
          )}
        </div>

        {editing ? (
          <div className="space-y-2">
            <textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              rows={3}
              maxLength={2000}
              className="w-full rounded-xl border border-border bg-background px-4 py-3 text-body-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/30 resize-none"
              autoFocus
            />
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={handleEdit} disabled={!editContent.trim() || saving}>
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Save'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => { setEditing(false); setEditContent(comment.content) }}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <p className={cn(
            'text-body-sm whitespace-pre-wrap',
            comment.isDeleted ? 'text-foreground-tertiary italic' : 'text-foreground-secondary'
          )}>
            {comment.content}
          </p>
        )}

        {!comment.isDeleted && !editing && (
          <div className="flex items-center gap-1 mt-1.5">
            {!isReply && onReply && (
              <button
                onClick={() => onReply(comment.id)}
                className="flex items-center gap-1 px-2 py-1 rounded-md text-caption-sm text-foreground-tertiary hover:text-foreground hover:bg-secondary transition-colors"
              >
                <Reply className="w-3 h-3" />
                Reply
              </button>
            )}
            {isOwner && (
              <>
                <button
                  onClick={() => setEditing(true)}
                  className="flex items-center gap-1 px-2 py-1 rounded-md text-caption-sm text-foreground-tertiary hover:text-foreground hover:bg-secondary transition-colors"
                >
                  <Pencil className="w-3 h-3" />
                  Edit
                </button>
                <button
                  onClick={handleDelete}
                  className="flex items-center gap-1 px-2 py-1 rounded-md text-caption-sm text-foreground-tertiary hover:text-red-500 hover:bg-red-500/10 transition-colors"
                >
                  <Trash2 className="w-3 h-3" />
                  Delete
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

export default function CommentThread({ sectionId }: { sectionId: string }) {
  const [comments, setComments] = useState<DocComment[]>([])
  const [totalCount, setTotalCount] = useState(0)
  const [isExpanded, setIsExpanded] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [replyingTo, setReplyingTo] = useState<string | null>(null)

  const fetchComments = useCallback(async () => {
    setIsLoading(true)
    try {
      const data = await getComments(sectionId)
      setComments(data.comments)
      setTotalCount(data.totalCount)
      setLoaded(true)
    } catch (err) {
      console.error('Failed to load comments:', err)
    } finally {
      setIsLoading(false)
    }
  }, [sectionId])

  const handleExpand = async () => {
    if (!loaded) {
      await fetchComments()
    }
    setIsExpanded(!isExpanded)
  }

  const handleNewComment = async (content: string) => {
    const newComment = await createComment({ sectionId, content })
    setComments((prev) => [...prev, newComment])
    setTotalCount((prev) => prev + 1)
  }

  const handleReply = async (content: string) => {
    if (!replyingTo) return
    const reply = await createComment({ sectionId, content, parentId: replyingTo })
    // Add reply to the parent comment
    setComments((prev) =>
      prev.map((c) =>
        c.id === replyingTo ? { ...c, replies: [...c.replies, reply] } : c
      )
    )
    setTotalCount((prev) => prev + 1)
    setReplyingTo(null)
  }

  return (
    <div className="mt-6 pt-4 border-t border-border">
      <button
        onClick={handleExpand}
        className="flex items-center gap-2 text-body-sm text-foreground-tertiary hover:text-foreground transition-colors"
      >
        <MessageSquare className="w-4 h-4" />
        <span>
          {isExpanded ? 'Hide' : 'Show'} Discussion
          {totalCount > 0 && ` (${totalCount})`}
        </span>
      </button>

      {isExpanded && (
        <div className="mt-4 space-y-5">
          {isLoading && (
            <div className="flex items-center gap-2 text-body-sm text-foreground-tertiary">
              <Loader2 className="w-4 h-4 animate-spin" />
              Loading comments...
            </div>
          )}

          {loaded && comments.length === 0 && !isLoading && (
            <p className="text-body-sm text-foreground-tertiary">
              No comments yet. Be the first to share your thoughts on this section.
            </p>
          )}

          {comments.map((comment) => (
            <div key={comment.id} className="space-y-3">
              <CommentItem
                comment={comment}
                onReply={(parentId) => setReplyingTo(replyingTo === parentId ? null : parentId)}
                onRefresh={fetchComments}
              />

              {/* Replies */}
              {comment.replies.map((reply) => (
                <CommentItem
                  key={reply.id}
                  comment={reply}
                  onRefresh={fetchComments}
                  isReply
                />
              ))}

              {/* Reply form */}
              {replyingTo === comment.id && (
                <div className="ml-10">
                  <CommentForm
                    onSubmit={handleReply}
                    onCancel={() => setReplyingTo(null)}
                    placeholder="Write a reply..."
                    autoFocus
                  />
                </div>
              )}
            </div>
          ))}

          {/* New comment form */}
          <div className="pt-2">
            <CommentForm
              onSubmit={handleNewComment}
              placeholder="Share your thoughts on this section..."
            />
          </div>
        </div>
      )}
    </div>
  )
}
