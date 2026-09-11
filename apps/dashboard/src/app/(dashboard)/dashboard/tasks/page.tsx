'use client'

import { useEffect, useMemo, useState } from 'react'
import { Plus, Trash2, Check, Calendar, Folder, ListTodo } from 'lucide-react'
import { getTasks, createTask, updateTask, deleteTask, type TaskItem } from '@/lib/client-api'
import { cn } from '@/lib/utils'

export default function TasksPage() {
  const [tasks, setTasks] = useState<TaskItem[]>([])
  const [loading, setLoading] = useState(true)
  const [title, setTitle] = useState('')
  const [project, setProject] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [adding, setAdding] = useState(false)

  const notifyTasksChanged = () => window.dispatchEvent(new Event('tasks-updated'))

  useEffect(() => {
    getTasks()
      .then((r) => setTasks(r.tasks))
      .catch(() => {})
      .finally(() => { setLoading(false); notifyTasksChanged() })
  }, [])

  const projects = useMemo(
    () => [...new Set(tasks.map((t) => t.project).filter((p): p is string => !!p))].sort(),
    [tasks]
  )

  const addTask = async () => {
    if (!title.trim()) return
    setAdding(true)
    try {
      const { task } = await createTask({
        title: title.trim(),
        project: project.trim() || undefined,
        dueDate: dueDate || undefined,
      })
      setTasks((prev) => [task, ...prev])
      setTitle('')
      setDueDate('')
      notifyTasksChanged()
    } finally {
      setAdding(false)
    }
  }

  const toggleDone = async (t: TaskItem) => {
    const next = !t.done
    setTasks((prev) => prev.map((x) => (x.id === t.id ? { ...x, done: next } : x)))
    try {
      await updateTask(t.id, { done: next })
    } catch {
      setTasks((prev) => prev.map((x) => (x.id === t.id ? { ...x, done: !next } : x)))
    }
    notifyTasksChanged()
  }

  const remove = async (t: TaskItem) => {
    setTasks((prev) => prev.filter((x) => x.id !== t.id))
    await deleteTask(t.id).catch(() => {})
    notifyTasksChanged()
  }

  const fmtDue = (d: string | null) => {
    if (!d) return null
    const dt = new Date(d)
    return Number.isNaN(dt.getTime()) ? d : dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  }

  const isOverdue = (t: TaskItem) =>
    !t.done && t.dueDate && new Date(t.dueDate).getTime() < Date.now()

  const openCount = tasks.filter((t) => !t.done).length

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <ListTodo className="w-6 h-6" /> Tasks
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            {openCount} open · {tasks.length} total
          </p>
        </div>
      </div>

      {/* Add task */}
      <div className="rounded-xl border border-border bg-card p-4 space-y-3">
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && addTask()}
          placeholder="Add a task…"
          className="w-full px-3 py-2 text-sm rounded-md border border-border bg-transparent"
        />
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            value={project}
            onChange={(e) => setProject(e.target.value)}
            placeholder="Project (optional)"
            list="task-projects"
            className="w-48 px-3 py-1.5 text-sm rounded-md border border-border bg-transparent"
          />
          <datalist id="task-projects">
            {projects.map((p) => <option key={p} value={p} />)}
          </datalist>
          <input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            className="px-3 py-1.5 text-sm rounded-md border border-border bg-transparent"
          />
          <button
            onClick={addTask}
            disabled={adding || !title.trim()}
            className="flex items-center gap-1.5 px-4 py-1.5 text-sm bg-foreground text-background rounded-md hover:opacity-90 disabled:opacity-40"
          >
            <Plus className="w-4 h-4" /> Add
          </button>
        </div>
      </div>

      {/* List */}
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : tasks.length === 0 ? (
        <p className="text-sm text-muted-foreground">No tasks yet.</p>
      ) : (
        <ul className="rounded-xl border border-border divide-y divide-border overflow-hidden">
          {tasks.map((t) => (
            <li
              key={t.id}
              className={cn(
                'flex items-center gap-3 px-4 py-3 bg-card',
                t.done && 'opacity-50'
              )}
            >
              <button
                onClick={() => toggleDone(t)}
                className={cn(
                  'w-5 h-5 rounded border flex-shrink-0 flex items-center justify-center transition-colors',
                  t.done ? 'bg-emerald-500 border-emerald-500 text-white' : 'border-border hover:border-foreground'
                )}
                aria-label={t.done ? 'Mark open' : 'Mark done'}
              >
                {t.done && <Check className="w-3.5 h-3.5" />}
              </button>

              <span className={cn('flex-1 text-sm', t.done && 'line-through')}>{t.title}</span>

              {t.project && (
                <span className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full bg-secondary text-foreground-secondary">
                  <Folder className="w-3 h-3" /> {t.project}
                </span>
              )}
              {t.dueDate && (
                <span className={cn(
                  'flex items-center gap-1 text-[11px]',
                  isOverdue(t) ? 'text-red-500' : 'text-foreground-tertiary'
                )}>
                  <Calendar className="w-3 h-3" /> {fmtDue(t.dueDate)}
                </span>
              )}

              <button
                onClick={() => remove(t)}
                className="p-1.5 text-foreground-tertiary hover:text-red-500 transition-colors"
                aria-label="Delete task"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
