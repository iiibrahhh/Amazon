/* Service worker: يفتح لوحة التحكم، ويستقبل الصفحات الملتقطة أثناء تصفحك ويحفظها محليًا. */
importScripts('lib/rules.js', 'lib/classifier.js', 'lib/parser.js', 'lib/db.js', 'lib/ingest.js');

chrome.action.onClicked.addListener(() => chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') }));

let dbPromise = null;
const getDb = () => dbPromise || (dbPromise = self.ASF.db.open('amazon_sa_finder'));
async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return Object.assign({}, self.ASF.rules.DEFAULT_SETTINGS, settings || {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (!sender.url || !/^https:\/\/(?:www\.)?amazon\.sa\//.test(sender.url)) return { ok: false, error: 'مصدر غير مسموح' };
    const db = await getDb();
    const settings = await getSettings();
    if (msg.type === 'capture-product') {
      const r = await self.ASF.ingest.ingestProduct(db, msg.parsed, { settings, source: 'amazon.sa:browsed-page' });
      return { ok: true, asin: r.asin, status: r.classification.status };
    }
    if (msg.type === 'capture-listing') {
      const n = await self.ASF.ingest.ingestListingItems(db, msg.items, { source: 'amazon.sa:browsed-listing' });
      return { ok: true, created: n };
    }
    return { ok: false, error: 'نوع رسالة غير معروف' };
  })().then(sendResponse).catch(e => sendResponse({ ok: false, error: e.message }));
  return true;
});
