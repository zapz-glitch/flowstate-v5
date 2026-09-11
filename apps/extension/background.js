const DEFAULT_BASE_URL = 'https://app.flowstate.homes'

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'flowstate-analyze',
    title: 'Analyze "%s" in Flowstate',
    contexts: ['selection'],
  })
})

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== 'flowstate-analyze' || !info.selectionText) return
  const { baseUrl } = await chrome.storage.sync.get({ baseUrl: DEFAULT_BASE_URL })
  const base = (baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')
  chrome.tabs.create({
    url: `${base}/dashboard/analyze?address=${encodeURIComponent(info.selectionText.trim())}`,
  })
})
