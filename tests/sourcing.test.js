const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const sourcing = require('../extension/lib/sourcing.js');
const backup = require('../extension/lib/backup.js');
const { newDb } = require('./helpers');
const subtle = crypto.webcrypto.subtle;

test('التوقيع: HMAC-SHA256 على مفاتيح مرتبة (يطابق حسابًا مستقلًا)', async () => {
  const params = { b: '2', a: '1', sign: 'x', empty: '' };
  const expected = crypto.createHmac('sha256', 'sec').update('a1b2').digest('hex').toUpperCase();
  assert.equal(await sourcing.sign(params, 'sec', subtle), expected);
});

test('بناء الطلب: يتضمن المعاملات والتوقيع، ويرفض بلا مفتاح', async () => {
  const url = await sourcing.buildRequest({ aliAppKey: 'K', aliAppSecret: 'S', aliTrackingId: 'T' }, 'Mini Fan', { now: 1700000000000, subtle });
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, sourcing.ENDPOINT);
  assert.equal(u.searchParams.get('method'), sourcing.METHOD); assert.equal(u.searchParams.get('keywords'), 'Mini Fan');
  assert.equal(u.searchParams.get('ship_to_country'), 'SA'); assert.match(u.searchParams.get('sign'), /^[0-9A-F]{64}$/);
  assert.ok(!url.includes('S&') && !/app_secret/.test(url), 'السر لا يُرسل');
  await assert.rejects(() => sourcing.buildRequest({}, 'x', { subtle }), /App|مفتاح/);
});

const OK = { aliexpress_affiliate_product_query_response: { resp_result: { resp_code: 200, result: { products: { product: [
  { product_id: 1005, product_title: 'Mini USB Fan', target_sale_price: '12.50', target_sale_price_currency: 'SAR', evaluate_rate: '96.1%', lastest_volume: 2300, product_detail_url: 'https://aliexpress.com/item/1005.html' }] } } } } };

test('تحليل الرد: يستخرج السعر والرابط والتقييم', () => {
  const [c] = sourcing.parseResponse(OK);
  assert.equal(c.price, 12.5); assert.equal(c.rating, 96.1); assert.equal(c.orders, 2300); assert.equal(c.currency, 'SAR'); assert.match(c.url, /1005/);
});

test('تحليل الرد: أخطاء الواجهة والبنية غير المتوقعة تظهر بوضوح لا كقائمة فارغة', () => {
  assert.throws(() => sourcing.parseResponse({ error_response: { code: 'IllegalAccessToken', msg: 'Invalid sign' } }), /Invalid sign/);
  assert.throws(() => sourcing.parseResponse({ x_response: { resp_result: { resp_code: 405, resp_msg: 'no permission' } } }), /no permission/);
  assert.throws(() => sourcing.parseResponse({ x_response: { foo: 1 } }), /غير متوقعة/);
  assert.deepEqual(sourcing.parseResponse({ x_response: { resp_result: { resp_code: 200, result: { total_record_count: 0 } } } }), []);
});

test('searchAliExpress: يعمل بـfetch مُحقَن ويتعامل مع HTTP خاطئ', async () => {
  const cfg = { aliAppKey: 'K', aliAppSecret: 'S' };
  const ok = await sourcing.searchAliExpress(cfg, 'fan', { subtle, fetch: async () => ({ ok: true, json: async () => OK }) });
  assert.equal(ok.length, 1);
  await assert.rejects(() => sourcing.searchAliExpress(cfg, 'fan', { subtle, fetch: async () => ({ ok: false, status: 403 }) }), /403/);
});

test('النسخ الاحتياطي لا يحمل مفتاح AliExpress ولا سره', async () => {
  const db = await newDb();
  const d = await backup.exportAll(db, { aliAppKey: 'K', aliAppSecret: 'S', aliTrackingId: 'T', vatPct: 15 }, '1.2.0');
  assert.deepEqual(d.settings, { vatPct: 15 });
});

test('pickBest: يفضّل أعلى تقاطع كلمات ثم الطلبات، ويتجاهل بلا سعر، ويعيد null للفارغ', () => {
  const list = [
    { title: 'Random Gadget', price: 5, url: 'u1', orders: 99999 },
    { title: 'Mini USB Fan Portable', price: 12, url: 'u2', orders: 10 },
    { title: 'Mini USB Fan Portable', price: null, url: 'u3', orders: 1e6 }
  ];
  const b = sourcing.pickBest('Mini USB Fan', list);
  assert.equal(b.url, 'u2'); assert.equal(b.match, 100);
  assert.equal(sourcing.pickBest('x', []), null);
});

test('مورد مقترح: يُحفظ دون مس المعتمد، ويظهر في التصدير كـ«مقترح»، والمعتمد يتقدم', async () => {
  const { fixtureDoc } = require('./helpers');
  const parser = require('../extension/lib/parser.js'), ingest = require('../extension/lib/ingest.js'), exporter = require('../extension/lib/export.js');
  const db = await newDb();
  await ingest.ingestProduct(db, parser.parseProductDocument(fixtureDoc('product_intl_confirmed.html'), 'https://www.amazon.sa/dp/B0TEST0001'), { now: '2026-10-01T00:00:00.000Z' });
  await ingest.setSupplierSuggestion(db, 'B0TEST0001', { platform: 'AliExpress', title: 'Fan', url: 'https://www.aliexpress.com/item/9.html', price: 12.5 });
  let r = exporter.buildRows(await db.all('products'), await db.all('offers'), [], { settings: {} })[0];
  assert.equal(r.supplierState, 'مقترح'); assert.equal(r.supplierPrice, 12.5);
  await ingest.setMerchantData(db, 'B0TEST0001', { supplierUrl: 'https://www.alibaba.com/x', supplierName: 'Mine' });
  r = exporter.buildRows(await db.all('products'), await db.all('offers'), [], { settings: {} })[0];
  assert.equal(r.supplierState, 'معتمد'); assert.equal(r.supplierName, 'Mine');
});
