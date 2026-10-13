// The list of addresses sent from this browser, newest first. Kept in chrome.storage.local.
// A job: { id, address, status: 'running' | 'done' | 'error', startedAt, jobId?, arv?, offer?, error? }
// `id` is made here at send time; `jobId` is Flowstate's, known once the API answers.

const MAX_JOBS = 25

/** Adds a job, or merges new fields into the one with the same id. */
export function upsertJob(jobs, job) {
  const at = jobs.findIndex((j) => j.id === job.id)
  if (at === -1) return [job, ...jobs].slice(0, MAX_JOBS)
  return jobs.map((j, i) => (i === at ? { ...j, ...job } : j))
}

/** Toolbar badge: how many evaluations are still running. */
export function badgeText(jobs) {
  const running = jobs.filter((j) => j.status === 'running').length
  return running ? String(running) : ''
}

const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`

/** One line for the popup row and the notification. */
export function describeJob(job) {
  if (job.status === 'running') return 'Evaluating…'
  if (job.status === 'error') return job.error || 'The evaluation failed.'
  const parts = [job.arv != null && `ARV ${money(job.arv)}`, job.offer != null && `Offer ${money(job.offer)}`].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'Done — open the report'
}

const STUCK_AFTER_MS = 20 * 60_000

/** A run with no answer after 20 minutes is treated as lost, so polling stops. */
export function isStuck(job, now) {
  return job.status === 'running' && now - job.startedAt > STUCK_AFTER_MS
}
