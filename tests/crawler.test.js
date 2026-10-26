const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { fx, newDb } = require('./helpers');
const crawler = require('../extension/lib/crawler.js');
const rules = require('../extension/lib/rules.js');

const settings = Object.assign({}, rules.DEFAULT_SETTINGS, { minDelayMs: 10, maxDelayMs: 20, maxPagesPerRun: 100, maxCategoryDepth: 0 });
const parseHtml = (h) => new JSDOM(h).window.document;

function mockSite(extra) {
  const calls = [];
  const routes = Object.assign({
    'https://www.amazon.sa/gp/bestsellers': fx('listing_bestsellers.html'),
    'https://www.amazon.sa/dp/B0LIST0001': fx('product_intl_confirmed.html'),
    'https://www.amazon.sa/dp/B0LIST0002': fx('product_local_fba.html'),
    'https://www.amazon.sa/dp/B0LIST0003': fx('product_foreign_seller_no_ship_info.html')
  }, extra || {});
  const fetchHtml = async (url) => {
    calls.push(url);
    if (url in routes) { const r = routes[url]; return typeof r === 'object' ? r : { status: 200, url, html: r }; }
    return { status: 404, url, html: '<html></html>' };
  };
  return { fetchHtml, calls };
}

test('الزاحف يكتشف المنتجات تلقائيًا دون كلمات بحث ويصنّفها', async () => {
  const db = await newDb();
  const site = mockSite();
  const sleeps = [];
  const runner = crawler.createRunner({ db, settings, fetchHtml: site.fetchHtml, parseHtml, sleep: async (ms) => sleeps.push(ms), random: () => 0.5 });
  const stats = await runner.run();
  assert.equal(stats.stoppedBecause, 'queue_empty');
  assert.ok(!site.calls.some(u => /[?&]k=|\/s\?/.test(u)), 'لا طلبات بحث بكلمات');
  const prods = await db.all('products');
  const by = Object.fromEntries(prods.map(p => [p.asin, p]));
  assert.ok(by.B0LIST0001 && by.B0LIST0002 && by.B0LIST0003);
  assert.equal(by.B0LIST0001.detailScanned, true);
  assert.equal(by.B0LIST0001.shippingStatus, 'confirmed');
  assert.equal(by.B0LIST0002.shippingStatus, 'local');
  assert.equal(by.B0LIST0003.shippingStatus, 'unknown');
  assert.ok(sleeps.length > 0 && sleeps.every(ms => ms === 15), 'تأخير بين الطلبات ضمن الحدود');
  assert.equal(new Set(site.calls).size, site.calls.length, 'لا طلب مكرر للرابط نفسه');
});

test('عند ظهور CAPTCHA يتوقف فورًا ولا يتجاوزه ولا يتابع الطلبات', async () => {
  const db = await newDb();
  const site = mockSite({ 'https://www.amazon.sa/gp/bestsellers': fx('captcha.html') });
  const runner = crawler.createRunner({ db, settings, fetchHtml: site.fetchHtml, parseHtml, sleep: async () => {} });
  const stats = await runner.run();
  assert.equal(stats.stoppedBecause, 'blocked');
  assert.equal(site.calls.length, 1);
  const q = await db.get('queue', 'https://www.amazon.sa/gp/bestsellers');
  assert.equal(q.status, 'pending', 'يبقى في الطابور للاستكمال لاحقًا');
});

test('الإيقاف بحد الصفحات ثم الاستكمال دون إعادة ما اكتمل', async () => {
  const db = await newDb();
  const site = mockSite();
  const s1 = Object.assign({}, settings, { maxPagesPerRun: 2 });
  const r1 = await crawler.createRunner({ db, settings: s1, fetchHtml: site.fetchHtml, parseHtml, sleep: async () => {} }).run();
  assert.equal(r1.stoppedBecause, 'max_pages');
  const before = site.calls.length;
  const r2 = await crawler.createRunner({ db, settings, fetchHtml: site.fetchHtml, parseHtml, sleep: async () => {} }).run();
  assert.equal(r2.stoppedBecause, 'queue_empty');
  assert.equal(new Set(site.calls).size, site.calls.length, 'لم يُعد جلب صفحة مكتملة');
  assert.ok(site.calls.length > before);
});

test('أخطاء 503 المتتالية توقف الزاحف، وفشل صفحة واحدة لا يفشل العملية', async () => {
  const db = await newDb();
  const r503 = { status: 503, url: 'x', html: '' };
  const site = mockSite({ 'https://www.amazon.sa/gp/bestsellers': r503, 'https://www.amazon.sa/gp/new-releases': r503, 'https://www.amazon.sa/gp/movers-and-shakers': r503 });
  const stats = await crawler.createRunner({ db, settings, fetchHtml: site.fetchHtml, parseHtml, sleep: async () => {} }).run();
  assert.equal(stats.stoppedBecause, 'throttled');

  const db2 = await newDb();
  const site2 = mockSite({ 'https://www.amazon.sa/dp/B0LIST0002': { status: 404, url: 'x', html: '' } });
  const s2 = await crawler.createRunner({ db: db2, settings, fetchHtml: site2.fetchHtml, parseHtml, sleep: async () => {} }).run();
  assert.equal(s2.stoppedBecause, 'queue_empty');
  assert.ok(s2.errors >= 1);
  assert.ok((await db2.all('logs')).length >= 1, 'الخطأ مسجّل');
  assert.equal((await db2.get('products', 'B0LIST0001')).detailScanned, true, 'بقية الصفحات اكتملت');
});
