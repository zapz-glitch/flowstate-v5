import { DEFAULT_BASE_URL, buildAnalyzeUrl, propertySearchUrl, reportUrl } from './flowstate-url.js'
import { describeJob } from './jobs.js'

const list = document.getElementById('jobs')
const hint = document.getElementById('hint')
const sendButton = document.getElementById('send')

async function baseUrl() {
  return (await chrome.storage.sync.get({ baseUrl: DEFAULT_BASE_URL })).baseUrl
}

function render(jobs) {
  list.replaceChildren(...jobs.map((job) => {
    const row = document.createElement('li')
    const address = document.createElement('div')
    address.className = 'address'
    address.textContent = job.address
    const status = document.createElement('div')
    status.className = `status ${job.status}`
    status.textContent = describeJob(job)
    row.append(address, status)
    row.addEventListener('click', async () => {
      const base = await baseUrl()
      chrome.tabs.create({ url: job.status === 'done' && job.jobId ? reportUrl(base, job.jobId) : buildAnalyzeUrl(base, job.address) })
    })
    return row
  }))
}

async function load() {
  const { jobs, apiKey } = await chrome.storage.local.get({ jobs: [], apiKey: '' })
  render(jobs)
  hint.textContent = apiKey.trim()
    ? 'Runs in the background. You get a notice when it is done.'
    : 'No API key set, so this opens Flowstate in a new tab. Add a key in Settings to run in the background.'
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && (changes.jobs || changes.apiKey)) load()
})

sendButton.addEventListener('click', async () => {
  sendButton.disabled = true
  await chrome.runtime.sendMessage({ type: 'send-active-tab' })
  sendButton.disabled = false
})

document.getElementById('open').addEventListener('click', async () => {
  chrome.tabs.create({ url: propertySearchUrl(await baseUrl()) })
})

document.getElementById('clear').addEventListener('click', async () => {
  const { jobs } = await chrome.storage.local.get({ jobs: [] })
  await chrome.storage.local.set({ jobs: jobs.filter((job) => job.status === 'running') })
})

document.getElementById('options').addEventListener('click', () => chrome.runtime.openOptionsPage())

load()
chrome.runtime.sendMessage({ type: 'refresh' })
