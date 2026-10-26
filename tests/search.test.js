const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { fx, newDb } = require('./helpers');
const search = require('../extension/lib/search.js');
const rules = require('../extension/lib/rules.js');

const settings = Object.assign({}, rules.DEFAULT_SETTINGS, { minDelayMs: 10, maxDelayMs: 20 });
const parseHtml = (h) => new JSDOM(h).window.document;
const B = 'https://www.amazon.sa';

function mockSite(extra) {
  const calls = [];
  const routes = Object.assign({
    [B + '/s?k=keyboard']: fx('search_results.html'),
    [B + '/s?k=keyboard&page=2']: fx('search_results_p2.html'),
    [B + '/s?k=nothing+here']: fx('search_empty.html'),
    [B + '/dp/B0SRCH0001']: fx('product_seller_long_handling.html'),   // شاحن = بائع + تجهيز 9–10 أيام
    [B + '/dp/B0SRCH0002']: fx('product_seller_short_handling.html'),  // شاحن = بائع + مدد قصيرة
    [B + '/dp/B0SRCH0003']: fx('product_amazon_ships_long_delivery.html'), // الشاحن أمازون
    [B + '/dp/B0SRCH0004']: fx('product_intl_confirmed.html')
  }, extra || {});
  const fetchHtml = async (url) => {
    calls.push(url);
    if (url in routes) { const r = routes[url]; return typeof r === 'object' ? r : { status: 200, url, html: r }; }
    return { status: 404, url, html: '<html></html>' };
  };
  return { fetchHtml, calls };
}
const mk = (db, site, extra) => Object.assign({ db, settings, fetchHtml: site.fetchHtml, parseHtml, sleep: async () => {}, random: () => 0.5 }, extra);

test('parseQuery: كلمة / ASIN / رابط amazon.sa (حتى الطويل) / رابط غريب / فارغ', () => {
  assert.deepEqual(search.parseQuery('  mechanical keyboard '), { kind: 'keyword', keyword: 'mechanical keyboard' });
  assert.deepEqual(search.parseQuery('b0dcvpgb9n'), { kind: 'asin', asin: 'B0DCVPGB9N', from: 'asin' });
  const longUrl = 'https://www.amazon.sa/%D9%85%D9%8A%D9%83%D8%A7%D9%86%D9%8A%D9%83%D8%A7%D9%84/dp/B0DCVPGB9N/ref=sr_1_29?dib=eyJ2IjoiMSJ9&dib_tag=se&m=A3FW2YHPVTP5KN&qid=1792668819&s=merchant-items&sr=1-29';
  assert.equal(search.parseQuery(longUrl).asin, 'B0DCVPGB9N');
  assert.equal(search.parseQuery('https://www.amazon.sa/s?k=%D9%84%D9%88%D8%AD%D8%A9').keyword, 'لوحة');
  assert.equal(search.parseQuery('https://www.amazon.com/dp/B0DCVPGB9N').kind, 'foreign-url');
  assert.equal(search.parseQuery('https://www.amazon.sa/gp/help').kind, 'bad-url');
  assert.equal(search.parseQuery('   ').kind, 'empty');
  assert.equal(search.parseQuery('لوحة مفاتيح ميكانيكية').kind, 'keyword');
});

test('searchUrl: ترميز الكلمات العربية والصفحة واللغة', () => {
  assert.equal(search.searchUrl(settings, 'keyboard', 1), B + '/s?k=keyboard');
  assert.equal(search.searchUrl(settings, 'keyboard', 2), B + '/s?k=keyboard&page=2');
  assert.match(search.searchUrl(Object.assign({}, settings, { language: 'ar_AE' }), 'لوحة مفاتيح', 1), /k=%D9%84.*&language=ar_AE|language=ar_AE.*k=/);
});

test('parseSearchDocument: بطاقات النتائج فقط، بلا لافتات ولا تكرار', () => {
  const r = search.parseSearchDocument(parseHtml(fx('search_results.html')), B);
  assert.deepEqual(r.items.map(i => i.asin), ['B0SRCH0001', 'B0SRCH0002', 'B0SRCH0003']);
  assert.equal(r.items[0].price, 955.55); assert.equal(r.items[0].title, 'Mechanical Keyboard One');
  assert.equal(r.items[2].price, null, 'نتيجة بلا سعر: لا رقم مخترع');
  assert.ok(r.nextPage && /page=2/.test(r.nextPage));
});

test('بحث بكلمة: يجمع النتائج ويفحص تفاصيل الأوائل ويصنّف كل واحد حسب دليله', async () => {
  const db = await newDb(); const site = mockSite(); const sleeps = [];
  const res = await search.runSearch(mk(db, site, { sleep: async (ms) => sleeps.push(ms) }), 'keyboard', { pages: 1, deepScan: 3 });
  assert.equal(res.kind, 'keyword'); assert.equal(res.stoppedBecause, 'done');
  assert.deepEqual(res.asins, ['B0SRCH0001', 'B0SRCH0002', 'B0SRCH0003']);
  assert.equal(res.found, 3); assert.equal(res.scanned, 3); assert.equal(res.errors, 0);
  const by = Object.fromEntries((await db.all('products')).map(p => [p.asin, p]));
  assert.equal(by.B0SRCH0001.shippingStatus, 'likely', 'شاحن=بائع + 9–10 أيام تجهيز');
  assert.equal(by.B0SRCH0002.shippingStatus, 'unknown', 'مدد قصيرة');
  assert.equal(by.B0SRCH0003.shippingStatus, 'local', 'الشاحن أمازون');
  assert.ok(Object.values(by).every(p => p.detailScanned === true));
  assert.equal(by.B0SRCH0001.catalog, 'بحث: keyboard');
  assert.ok(!(await db.get('products', 'B0BANNER001')), 'ASIN اللافتة لا يُدخل');
  assert.equal(new Set(site.calls).size, site.calls.length, 'لا طلب مكرر');
  assert.ok(sleeps.length >= 2 && sleeps.every(ms => ms >= 1500 && ms <= 3000), "تأخير 1.5–3 ثوانٍ بين الطلبات التفصيلية");
});

test('بحث بكلمة: عدد الفحص التفصيلي محدود، والبقية تبقى «لم تُفحص»', async () => {
  const db = await newDb(); const site = mockSite();
  const res = await search.runSearch(mk(db, site), 'keyboard', { pages: 1, deepScan: 1 });
  assert.equal(res.found, 3); assert.equal(res.scanned, 1);
  assert.equal((await db.get('products', 'B0SRCH0001')).detailScanned, true);
  assert.equal((await db.get('products', 'B0SRCH0002')).detailScanned, false);
  assert.ok(!site.calls.includes(B + '/dp/B0SRCH0002'));
  const none = await search.runSearch(mk(await newDb(), mockSite()), 'keyboard', { pages: 1, deepScan: 0 });
  assert.equal(none.scanned, 0); assert.equal(none.found, 3);
});

test('بحث بكلمة: صفحتا نتائج، وإعادة البحث لا تكرر المنتجات', async () => {
  const db = await newDb(); const site = mockSite();
  const r1 = await search.runSearch(mk(db, site), 'keyboard', { pages: 2, deepScan: 0 });
  assert.deepEqual(r1.asins, ['B0SRCH0001', 'B0SRCH0002', 'B0SRCH0003', 'B0SRCH0004']);
  const r2 = await search.runSearch(mk(db, mockSite()), 'keyboard', { pages: 2, deepScan: 1 });
  assert.equal(r2.newProducts, 0);
  assert.equal((await db.all('products')).length, 4);
  assert.equal((await db.all('offers')).length, 1);
});

test('بحث بلا نتائج: found=0 دون خطأ ودون اختراع منتجات', async () => {
  const db = await newDb(); const site = mockSite();
  const res = await search.runSearch(mk(db, site), 'nothing here', { pages: 2, deepScan: 5 });
  assert.equal(res.found, 0); assert.equal(res.errors, 0); assert.equal((await db.all('products')).length, 0);
  assert.equal(site.calls.length, 1);
});

test('ASIN أو رابط منتج: يجلب الصفحة ويحلل الشحن ويرجع مفتاح العرض', async () => {
  const db = await newDb();
  const site = mockSite({ [B + '/dp/B0DCVPGB9N']: fx('product_seller_long_handling.html') });
  const url = B + '/%D9%85%D9%8A%D9%83/dp/B0DCVPGB9N/ref=sr_1_29?m=A3FW2YHPVTP5KN&sr=1-29';
  const res = await search.runSearch(mk(db, site), url, {});
  assert.equal(res.kind, 'asin'); assert.equal(res.asin, 'B0DCVPGB9N');
  assert.equal(res.classification.status, 'likely');
  assert.ok(res.offerKey.startsWith('B0DCVPGB9N|'));
  assert.deepEqual(site.calls, [B + '/dp/B0DCVPGB9N']);
  const o = await db.get('offers', res.offerKey);
  assert.equal(o.shipperType, 'seller'); assert.equal(o.handlingMinDays, 9);
  assert.equal((await db.get('products', 'B0DCVPGB9N')).detailScanned, true);
});

test('CAPTCHA في صفحة البحث: يتوقف فورًا بلا تجاوز', async () => {
  const db = await newDb(); const site = mockSite({ [B + '/s?k=keyboard']: fx('captcha.html') });
  const res = await search.runSearch(mk(db, site), 'keyboard', { pages: 3, deepScan: 5 });
  assert.equal(res.stoppedBecause, 'blocked'); assert.equal(site.calls.length, 1); assert.equal(res.scanned, 0);
  assert.ok((await db.all('logs')).length >= 1);
});

test('CAPTCHA أثناء الفحص التفصيلي: يتوقف ويبقي ما اكتمل', async () => {
  const db = await newDb(); const site = mockSite({ [B + '/dp/B0SRCH0002']: fx('captcha.html') });
  const res = await search.runSearch(mk(db, site), 'keyboard', { pages: 1, deepScan: 3 });
  assert.equal(res.stoppedBecause, 'blocked'); assert.equal(res.scanned, 1);
  assert.ok(!site.calls.includes(B + '/dp/B0SRCH0003'), 'لا طلبات بعد الحجب');
  assert.equal((await db.get('products', 'B0SRCH0001')).detailScanned, true);
  assert.equal((await db.get('products', 'B0SRCH0003')).detailScanned, false);
});

test('خطأ 503 يوقف البحث، وصفحة 404 واحدة لا توقفه', async () => {
  const a = await search.runSearch(mk(await newDb(), mockSite({ [B + '/dp/B0SRCH0001']: { status: 503, url: 'x', html: '' } })), 'keyboard', { pages: 1, deepScan: 3 });
  assert.equal(a.stoppedBecause, 'throttled');
  const b = await search.runSearch(mk(await newDb(), mockSite({ [B + '/dp/B0SRCH0001']: { status: 404, url: 'x', html: '' } })), 'keyboard', { pages: 1, deepScan: 3 });
  assert.equal(b.stoppedBecause, 'done'); assert.equal(b.errors, 1); assert.equal(b.scanned, 2);
});

test('زر الإيقاف: يوقف بين الطلبات ويحفظ ما تم', async () => {
  const db = await newDb(); const site = mockSite(); let stop = false;
  const res = await search.runSearch(mk(db, site, { isStopped: () => stop, onProgress: (p) => { if (p.phase === 'detail' && p.done === 1) stop = true; } }), 'keyboard', { pages: 1, deepScan: 3 });
  assert.equal(res.stoppedBecause, 'user_stop'); assert.equal(res.scanned, 1);
});

test('مدخلات غير صالحة: رسالة واضحة بلا أي طلب', async () => {
  const site = mockSite(); const db = await newDb();
  assert.match((await search.runSearch(mk(db, site), '', {})).error, /اكتب/);
  assert.match((await search.runSearch(mk(db, site), 'https://www.amazon.com/dp/B0DCVPGB9N', {})).error, /ليس من amazon\.sa/);
  assert.equal(site.calls.length, 0);
});
