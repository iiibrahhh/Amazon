const test = require('node:test');
const assert = require('node:assert/strict');
const { newDb } = require('./helpers');
const { classifyShipping } = require('../extension/lib/classifier.js');
const search = require('../extension/lib/search.js');
const rules = require('../extension/lib/rules.js');
const { JSDOM } = require('jsdom');
const { fx } = require('./helpers');

const seller = (h, d, extra) => Object.assign({ shipperType: 'seller', shipperName: 'MahzuzStores', soldBy: 'MahzuzStores',
  handling: { minDays: h[0], maxDays: h[1] }, deliveryWindow: { minDays: d[0], maxDays: d[1] } }, extra);

test('فارق النقل: قيم منتج المستخدم (تجهيز 4–5، توصيل بعد 9–10) ⇒ مرجح بسبب «long_transit» وليس بسبب العتبتين القديمتين', () => {
  const c = classifyShipping(seller([4, 5], [9, 10]));
  assert.equal(c.status, 'likely');
  assert.equal(c.evidence[0].signal, 'seller_ships_long_transit');
  assert.match(c.evidence[0].text, /فارق النقل المقدّر: 4/);
  assert.equal(c.originCountry, null);
});

test('فارق النقل: مدد محلية معتادة (تجهيز 1–2، توصيل 3–5) ⇒ غير معلوم', () => {
  assert.equal(classifyShipping(seller([1, 2], [3, 5])).status, 'unknown');
  assert.equal(classifyShipping(seller([4, 5], [8, 9])).status, 'unknown', 'فارق 3 أيام لا يكفي');
});

test('فارق النقل لا يعمل مع أمازون ولا بلا مدة تجهيز، والعتبة قابلة للضبط', () => {
  assert.equal(classifyShipping(seller([4, 5], [9, 10], { shipperType: 'amazon', fulfillerText: 'Fulfilled by Amazon' })).status, 'local');
  assert.equal(classifyShipping({ shipperType: 'seller', deliveryWindow: { minDays: 9, maxDays: 10 } }).status, 'unknown');
  assert.equal(classifyShipping(seller([4, 5], [9, 10]), { intlMinTransitDays: 6 }).status, 'unknown');
  assert.equal(classifyShipping(seller([1, 2], [3, 5]), { intlMinTransitDays: 1 }).status, 'likely');
});

/* ---------- سرعة البحث ---------- */
const B = 'https://www.amazon.sa';
const parseHtml = (h) => new JSDOM(h).window.document;
const mkSite = () => { const calls = []; const routes = {
  [B + '/s?k=keyboard']: fx('search_results.html'), [B + '/dp/B0SRCH0001']: fx('product_seller_long_handling.html'),
  [B + '/dp/B0SRCH0002']: fx('product_seller_short_handling.html'), [B + '/dp/B0SRCH0003']: fx('product_amazon_ships_long_delivery.html') };
  return { calls, fetchHtml: async (u) => { calls.push(u); return u in routes ? { status: 200, url: u, html: routes[u] } : { status: 404, url: u, html: '' }; } }; };

test('البحث: لا انتظار قبل أول طلب تفصيلي، وتأخير 1.5–3 ثوانٍ بين الباقي', async () => {
  const db = await newDb(); const site = mkSite(); const sleeps = [];
  const settings = Object.assign({}, rules.DEFAULT_SETTINGS);
  const res = await search.runSearch({ db, settings, fetchHtml: site.fetchHtml, parseHtml, sleep: async (ms) => sleeps.push(ms), random: () => 0.5 }, 'keyboard', { pages: 1, deepScan: 3 });
  assert.equal(res.scanned, 3);
  assert.deepEqual(sleeps, [2250, 2250], 'انتظاران فقط لثلاثة طلبات، كل منهما 2.25 ثانية');
});

test('البحث: المنتج المفحوص حديثًا لا يُجلب ثانية ولا ينتظر له', async () => {
  const db = await newDb(); const settings = Object.assign({}, rules.DEFAULT_SETTINGS);
  const run = async (site, sleeps, s) => search.runSearch({ db, settings: s || settings, fetchHtml: site.fetchHtml, parseHtml, sleep: async (ms) => sleeps.push(ms), random: () => 0 }, 'keyboard', { pages: 1, deepScan: 3 });
  await run(mkSite(), []);
  const site2 = mkSite(); const sl2 = [];
  const r2 = await run(site2, sl2);
  assert.equal(r2.skippedFresh, 3); assert.equal(r2.scanned, 0); assert.equal(sl2.length, 0);
  assert.ok(!site2.calls.some(u => u.includes('/dp/')), 'لا طلب صفحة منتج');
  const site3 = mkSite();
  const r3 = await run(site3, [], Object.assign({}, settings, { skipFreshHours: 0 }));
  assert.equal(r3.scanned, 3, 'skipFreshHours=0 يعيد الفحص دائمًا');
});
