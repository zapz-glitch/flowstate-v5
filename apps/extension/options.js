import { DEFAULT_BASE_URL, normalizeBaseUrl } from './flowstate-url.js'

const input = document.getElementById('baseUrl')
const status = document.getElementById('saved')

function showStatus(text, ok) {
  status.textContent = text
  status.style.color = ok ? '#4ade80' : '#f87171'
  status.style.display = 'block'
  if (ok) setTimeout(() => { status.style.display = 'none' }, 1500)
}

chrome.storage.sync.get({ baseUrl: DEFAULT_BASE_URL }, ({ baseUrl }) => {
  input.value = baseUrl
})

document.getElementById('save').addEventListener('click', () => {
  const baseUrl = normalizeBaseUrl(input.value)
  if (!baseUrl) {
    showStatus('That is not a web address. Try https://app.flowstate.homes', false)
    return
  }
  chrome.storage.sync.set({ baseUrl }, () => {
    input.value = baseUrl
    showStatus('Saved.', true)
  })
})
