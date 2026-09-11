const DEFAULT_BASE_URL = 'https://app.flowstate.homes'

chrome.storage.sync.get({ baseUrl: DEFAULT_BASE_URL }, ({ baseUrl }) => {
  document.getElementById('baseUrl').value = baseUrl
})

document.getElementById('save').addEventListener('click', () => {
  const baseUrl = document.getElementById('baseUrl').value.trim() || DEFAULT_BASE_URL
  chrome.storage.sync.set({ baseUrl }, () => {
    const el = document.getElementById('saved')
    el.style.display = 'block'
    setTimeout(() => { el.style.display = 'none' }, 1500)
  })
})
