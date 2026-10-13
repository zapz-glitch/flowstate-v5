import { DEFAULT_BASE_URL, apiUrlFor, buildAnalyzeUrl, cleanAddress, reportUrl } from './flowstate-url.js'
import { pickAddress } from './address.js'
import { checkJob, findExistingReport, startAnalysis } from './api.js'
import { badgeText, describeJob, isStuck, upsertJob } from './jobs.js'

const MENU_ID = 'flowstate-send'
const COMMAND_ID = 'send-to-flowstate'
const POLL_ALARM = 'flowstate-poll'
const NO_ADDRESS = 'flowstate-no-address'

// onInstalled alone misses a disable → re-enable, which wipes the menu.
function registerMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: 'Send to Flowstate',
      contexts: ['page', 'selection', 'link', 'image', 'frame'],
    })
  })
}

chrome.runtime.onInstalled.addListener(registerMenu)
chrome.runtime.onStartup.addListener(registerMenu)

async function loadSettings() {
  const { baseUrl } = await chrome.storage.sync.get({ baseUrl: DEFAULT_BASE_URL })
  // The key stays on this machine — storage.sync would copy it to every signed-in Chrome.
  const { apiKey, apiUrl } = await chrome.storage.local.get({ apiKey: '', apiUrl: '' })
  return { baseUrl, apiKey: apiKey.trim(), apiUrl: apiUrlFor(baseUrl, apiUrl) }
}

// ─── Job list ────────────────────────────────────────────────────────

// Sends overlap (several listings in a row), so list updates run one at a time.
let jobsQueue = Promise.resolve()
function updateJob(job) {
  jobsQueue = jobsQueue.then(async () => {
    const { jobs } = await chrome.storage.local.get({ jobs: [] })
    const next = upsertJob(jobs, job)
    await chrome.storage.local.set({ jobs: next })
    await chrome.action.setBadgeBackgroundColor({ color: '#0a0a0a' })
    await chrome.action.setBadgeText({ text: badgeText(next) })
    if (next.some((j) => j.status === 'running')) {
      if (!(await chrome.alarms.get(POLL_ALARM))) chrome.alarms.create(POLL_ALARM, { periodInMinutes: 0.5 })
    } else {
      await chrome.alarms.clear(POLL_ALARM)
    }
    return next.find((j) => j.id === job.id)
  })
  return jobsQueue
}

function notify(id, title, message) {
  chrome.notifications.create(id, { type: 'basic', iconUrl: 'icons/icon-128.png', title, message })
}

function notifyJob(job) {
  const title = job.status === 'running' ? 'Sent to Flowstate' : job.status === 'done' ? 'Flowstate: evaluation done' : 'Flowstate: could not evaluate'
  notify(job.id, title, `${job.address}\n${describeJob(job)}`)
}

/** Where a job leads: its report once done, otherwise the search page (which joins a live run). */
function jobUrl(job, baseUrl) {
  return job.status === 'done' && job.jobId ? reportUrl(baseUrl, job.jobId) : buildAnalyzeUrl(baseUrl, job.address)
}

chrome.notifications.onClicked.addListener(async (id) => {
  chrome.notifications.clear(id)
  if (id === NO_ADDRESS) return
  const { jobs } = await chrome.storage.local.get({ jobs: [] })
  const job = jobs.find((j) => j.id === id)
  if (!job) return
  const { baseUrl } = await loadSettings()
  chrome.tabs.create({ url: jobUrl(job, baseUrl) })
})

// ─── Reading the page ────────────────────────────────────────────────

// Runs inside the page, so it can use nothing from this file.
function probePage() {
  const texts = (selector) => Array.from(document.querySelectorAll(selector), (el) => (el.textContent || '').slice(0, 200000)).slice(0, 30)
  const meta = (name) => document.querySelector(`meta[property="${name}"], meta[name="${name}"]`)?.content || ''
  return {
    selection: String(window.getSelection() || ''),
    jsonLd: texts('script[type="application/ld+json"]'),
    headings: [meta('og:title'), meta('twitter:title'), document.title, ...texts('h1')],
  }
}

async function readPage(tab) {
  try {
    const [injection] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: probePage })
    return injection?.result ?? null
  } catch {
    // chrome:// pages, the Web Store and PDFs can't be read.
    return null
  }
}

// ─── Sending ─────────────────────────────────────────────────────────

async function send(tab, selectionText) {
  const selected = cleanAddress(selectionText)
  const found = selected ? { address: selected } : pickAddress(await readPage(tab))
  if (!found) {
    notify(NO_ADDRESS, 'No address found on this page', 'Highlight the address, then send it again.')
    return
  }
  const { address } = found
  const { baseUrl, apiKey, apiUrl } = await loadSettings()
  const existing = await findExistingReport({ apiUrl, address })

  if (!apiKey) {
    // No key: open Flowstate in a tab, straight on the report when one exists.
    const url = existing ? reportUrl(baseUrl, existing.jobId) : buildAnalyzeUrl(baseUrl, address)
    chrome.tabs.create({ url, ...(tab?.index != null ? { index: tab.index + 1 } : {}) })
    return
  }

  const id = crypto.randomUUID()
  const base = { id, address, startedAt: Date.now() }
  if (existing) {
    notifyJob(await updateJob({ ...base, status: 'done', ...existing }))
    return
  }
  notifyJob(await updateJob({ ...base, status: 'running' }))
  const started = await startAnalysis({ apiUrl, apiKey, address })
  if (started.state === 'running') {
    await updateJob({ id, jobId: started.jobId })
    return
  }
  const { state, ...rest } = started
  notifyJob(await updateJob({ id, status: state, ...rest }))
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_ID) send(tab, info.selectionText)
})

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === COMMAND_ID) send(tab)
})

// ─── Polling ─────────────────────────────────────────────────────────

async function poll() {
  const { apiKey, apiUrl } = await loadSettings()
  const { jobs } = await chrome.storage.local.get({ jobs: [] })
  for (const job of jobs.filter((j) => j.status === 'running')) {
    // A job with no jobId yet is still being started (or its start was cut off).
    const { state, ...rest } = isStuck(job, Date.now())
      ? { state: 'error', error: 'No answer after 20 minutes. Open Flowstate to check.' }
      : job.jobId ? await checkJob({ apiUrl, apiKey, jobId: job.jobId }) : { state: 'running' }
    if (state !== 'running') notifyJob(await updateJob({ id: job.id, status: state, ...rest }))
  }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === POLL_ALARM) poll()
})

// The popup asks for a send of the tab it sits on, and a fresh poll when it opens.
chrome.runtime.onMessage.addListener((message, _sender, respond) => {
  if (message?.type === 'send-active-tab') {
    chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => send(tab)).then(() => respond(true))
    return true
  }
  if (message?.type === 'refresh') {
    poll().then(() => respond(true))
    return true
  }
  return false
})
