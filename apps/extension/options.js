import { DEFAULT_BASE_URL, apiUrlFor, normalizeBaseUrl } from './flowstate-url.js'
import { verifyKey } from './api.js'

const baseInput = document.getElementById('baseUrl')
const keyInput = document.getElementById('apiKey')
const apiInput = document.getElementById('apiUrl')
const status = document.getElementById('saved')

function showStatus(text, ok) {
  status.textContent = text
  status.style.color = ok ? '#4ade80' : '#f87171'
  status.style.display = 'block'
}

chrome.storage.sync.get({ baseUrl: DEFAULT_BASE_URL }, ({ baseUrl }) => {
  baseInput.value = baseUrl
})
chrome.storage.local.get({ apiKey: '', apiUrl: '' }, ({ apiKey, apiUrl }) => {
  keyInput.value = apiKey
  apiInput.value = apiUrl
})

document.getElementById('save').addEventListener('click', async () => {
  const baseUrl = normalizeBaseUrl(baseInput.value)
  if (!baseUrl) {
    showStatus('That is not a web address. Try https://app.flowstate.homes', false)
    return
  }
  const apiUrl = apiInput.value.trim() ? normalizeBaseUrl(apiInput.value) : ''
  if (apiUrl === null) {
    showStatus('The API URL is not a web address. Leave it blank to use the default.', false)
    return
  }
  const apiKey = keyInput.value.trim()
  await chrome.storage.sync.set({ baseUrl })
  await chrome.storage.local.set({ apiKey, apiUrl })
  baseInput.value = baseUrl
  apiInput.value = apiUrl
  if (!apiKey) {
    showStatus('Saved. No API key, so sends open Flowstate in a new tab.', true)
    return
  }
  showStatus('Saved. Checking the key…', true)
  const check = await verifyKey({ apiUrl: apiUrlFor(baseUrl, apiUrl), apiKey })
  showStatus(check.ok ? 'Saved. The key works — sends now run in the background.' : `Saved, but: ${check.error}`, check.ok)
})
