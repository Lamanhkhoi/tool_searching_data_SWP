// Bấm biểu tượng extension → mở giao diện chính trong một tab mới
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('app.html') });
});
