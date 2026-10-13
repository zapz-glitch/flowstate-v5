import { DEFAULT_BASE_URL, buildAnalyzeUrl, propertySearchUrl } from './flowstate-url.js'

const MENU_ID = 'flowstate-send'

// onInstalled alone misses a disable → re-enable, which wipes the menu.
function registerMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: 'Send "%s" to Flowstate',
      contexts: ['selection'],
    })
  })
}

chrome.runtime.onInstalled.addListener(registerMenu)
chrome.runtime.onStartup.addListener(registerMenu)

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ID) return
  const { baseUrl } = await chrome.storage.sync.get({ baseUrl: DEFAULT_BASE_URL })
  const url = buildAnalyzeUrl(baseUrl, info.selectionText)
  if (!url) return
  chrome.tabs.create({ url, ...(tab?.index != null ? { index: tab.index + 1 } : {}) })
})

// Without an action Chrome greys the toolbar icon out; the button opens Property Search.
chrome.action.onClicked.addListener(async () => {
  const { baseUrl } = await chrome.storage.sync.get({ baseUrl: DEFAULT_BASE_URL })
  chrome.tabs.create({ url: propertySearchUrl(baseUrl) })
})
