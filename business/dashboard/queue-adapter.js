// The queue viewer uses only storage and downloads from the extension API.
// Supply their browser equivalents when it runs inside the business panel.
window.chrome = window.chrome || {};
chrome.storage = {local:{
  async get(key) {
    try { return {[key]:JSON.parse(localStorage.getItem('combo.queue.'+key) || 'null')}; }
    catch { return {}; }
  },
  async set(values) {
    for (const [key,value] of Object.entries(values)) localStorage.setItem('combo.queue.'+key,JSON.stringify(value));
  }
}};
chrome.downloads = {async download({url,filename}) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Reference download failed');
  const blob = URL.createObjectURL(await response.blob());
  const link = document.createElement('a');
  link.href=blob; link.download=filename.split('/').pop(); link.click();
  setTimeout(() => URL.revokeObjectURL(blob),4000);
}};
