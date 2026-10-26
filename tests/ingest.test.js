const test = require('node:test');
const assert = require('node:assert/strict');
const { fixtureDoc, newDb } = require('./helpers');
const parser = require('../extension/lib/parser.js');
const ingest = require('../extension/lib/ingest.js');

const parse = (f, asin) => parser.parseProductDocument(fixtureDoc(f), 'https://www.amazon.sa/dp/' + asin);

test('منع التكرار: فحص المنتج نفسه مرتين لا ينشئ سجلات مكررة', async () => {
  const db = await newDb();
  const p = parse('product_intl_confirmed.html', 'B0TEST0001');
  const r1 = await ingest.ingestProduct(db, p, { now: '2026-10-01T10:00:00.000Z' });
  const r2 = await ingest.ingestProduct(db, p, { now: '2026-10-02T10:00:00.000Z' });
  assert.equal(r1.isNew, true); assert.equal(r2.isNew, false);
  assert.equal(await db.count('products'), 1);
  assert.equal(await db.count('offers'), 1);
  const prod = await db.get('products', 'B0TEST0001');
  assert.equal(prod.firstSeenAt, '2026-10-01T10:00:00.000Z', 'يُحفظ تاريخ أول اكتشاف');
  assert.equal(prod.lastCheckedAt, '2026-10-02T10:00:00.000Z', 'يُحدَّث تاريخ آخر فحص');
  const ev = await db.byIndex('evidence', 'offerKey', r2.offer.offerKey);
  assert.equal(ev.length, r1.classification.evidence.length, 'الأدلة تُستبدل ولا تتراكم');
  assert.equal(await db.count('priceHistory'), 1, 'لا سجل سعر جديد دون تغيّر');
});

test('سجل الأسعار يُضاف عند تغيّر السعر فقط', async () => {
  const db = await newDb();
  const p = parse('product_intl_confirmed.html', 'B0TEST0001');
  await ingest.ingestProduct(db, p, { now: '2026-10-01T00:00:00.000Z' });
  const p2 = JSON.parse(JSON.stringify(p)); p2.offer.price = 279;
  await ingest.ingestProduct(db, p2, { now: '2026-10-03T00:00:00.000Z' });
  const hist = await db.all('priceHistory');
  assert.deepEqual(hist.map(h => h.price), [299, 279]);
});

test('منتج واحد بعدة بائعين → منتج واحد وعدة عروض، وحالة المنتج = الأقوى', async () => {
  const db = await newDb();
  const a = parse('product_intl_confirmed.html', 'B0TEST0001');
  const b = JSON.parse(JSON.stringify(a));
  b.offer.sellerName = 'LocalShop KSA'; b.offer.sellerId = 'A9LOCALSELLER1'; b.offer.shipsFrom = 'Amazon';
  b.shippingFields = { shipsFrom: 'Amazon', fulfillerText: 'Fulfilled by Amazon' };
  await ingest.ingestProduct(db, a, {});
  await ingest.ingestProduct(db, b, {});
  assert.equal(await db.count('products'), 1);
  assert.equal(await db.count('offers'), 2);
  assert.equal((await db.get('products', 'B0TEST0001')).shippingStatus, 'confirmed');
});

test('اكتشاف من قائمة ثم فحص صفحة المنتج: بلا تكرار، ويصبح «مفحوصًا»', async () => {
  const db = await newDb();
  const n = await ingest.ingestListingItems(db, [{ asin: 'B0TEST0001', url: 'https://www.amazon.sa/dp/B0TEST0001', title: 'من القائمة', price: 310, currency: 'SAR' }]);
  assert.equal(n, 1);
  let prod = await db.get('products', 'B0TEST0001');
  assert.equal(prod.detailScanned, false); assert.equal(prod.shippingStatus, 'unknown'); assert.equal(prod.lastCheckedAt, null);
  await ingest.ingestProduct(db, parse('product_intl_confirmed.html', 'B0TEST0001'), {});
  assert.equal(await db.count('products'), 1);
  prod = await db.get('products', 'B0TEST0001');
  assert.equal(prod.detailScanned, true); assert.equal(prod.title, 'Acme Wireless Earbuds Pro X');
  // إعادة اكتشافه من قائمة لا تغيّر حالة الفحص ولا تنشئ سجلًا جديدًا
  assert.equal(await ingest.ingestListingItems(db, [{ asin: 'B0TEST0001', url: 'x', title: 'عنوان آخر' }]), 0);
  assert.equal((await db.get('products', 'B0TEST0001')).detailScanned, true);
  assert.equal(await db.count('products'), 1);
});

test('فحص ناقص لا يمحو بيانات قديمة صحيحة، ولا يخترع سعرًا', async () => {
  const db = await newDb();
  await ingest.ingestProduct(db, parse('product_intl_confirmed.html', 'B0TEST0001'), {});
  const bare = parse('product_arabic_no_price.html', 'B0TEST0001'); // نفس ASIN، لا سعر/بائع
  bare.title = null; bare.rating = null;
  await ingest.ingestProduct(db, bare, {});
  const prod = await db.get('products', 'B0TEST0001');
  assert.equal(prod.title, 'Acme Wireless Earbuds Pro X');
  assert.equal(prod.rating, 4.4);
  const nop = parse('product_arabic_no_price.html', 'B0TEST0004');
  await ingest.ingestProduct(db, nop, {});
  const offers = await db.byIndex('offers', 'asin', 'B0TEST0004');
  assert.equal(offers[0].price === undefined || offers[0].price === null, true);
  assert.equal(offers[0].shippingStatus, 'unknown');
});

test('حذف منتج يحذف عروضه وأدلته وسجل أسعاره', async () => {
  const db = await newDb();
  await ingest.ingestProduct(db, parse('product_intl_confirmed.html', 'B0TEST0001'), {});
  await ingest.ingestProduct(db, parse('product_local_fba.html', 'B0TEST0002'), {});
  await ingest.deleteProducts(db, ['B0TEST0001']);
  assert.equal(await db.count('products'), 1);
  assert.equal(await db.count('offers'), 1);
  assert.equal((await db.all('evidence')).every(e => e.asin === 'B0TEST0002'), true);
  assert.equal((await db.all('priceHistory')).every(h => h.asin === 'B0TEST0002'), true);
});

test('قائمة العروض المنافسة تُحفظ كعروض منفصلة بتصنيف مستقل', async () => {
  const db = await newDb();
  await ingest.ingestProduct(db, parse('product_intl_confirmed.html', 'B0TEST0001'), {});
  const offers = parser.parseOffersDocument(fixtureDoc('offers_aod.html'));
  await ingest.ingestCompetitorOffers(db, 'B0TEST0001', offers, {});
  const all = await db.byIndex('offers', 'asin', 'B0TEST0001');
  assert.equal(all.length, 2, 'عرض البائع نفسه (A1TESTSELLER01) يُدمج، والمنافس يُضاف');
  assert.deepEqual(all.map(o => o.shippingStatus).sort(), ['confirmed', 'local']);
});
