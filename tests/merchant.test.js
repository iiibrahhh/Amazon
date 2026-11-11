const test = require('node:test');
const assert = require('node:assert/strict');
const { fixtureDoc, docFrom, newDb } = require('./helpers');
const merchant = require('../extension/lib/merchant.js');
const backup = require('../extension/lib/backup.js');
const ingest = require('../extension/lib/ingest.js');
const parser = require('../extension/lib/parser.js');
const exporter = require('../extension/lib/export.js');

test('calcProfit: حساب يدوي بالافتراضات (جمارك 5% عمولة 15% ضريبة 15%)', () => {
  const r = merchant.calcProfit({ price: 115, cost: 50, shipping: 10 });
  assert.equal(r.ok, true);
  // landed 60، جمارك 3، ضريبة استيراد 9.45، صافي السعر 100، عمولة 17.25
  assert.equal(r.profit, 10.3);
  assert.equal(r.marginPct, 10.3);
  assert.equal(r.roiPct, 14.22);
  // عند سعر التعادل يكون الربح صفرًا
  const be = merchant.calcProfit({ price: r.breakEvenPrice, cost: 50, shipping: 10 });
  assert.ok(Math.abs(be.profit) < 0.05, 'ربح عند التعادل = ' + be.profit);
});

test('calcProfit: استرداد ضريبة الاستيراد يرفع الربح، والنسب الخاصة تتقدم على الافتراضية', () => {
  const a = merchant.calcProfit({ price: 115, cost: 50, shipping: 10 }, { vatRecoverable: true });
  assert.equal(a.profit, 19.75);
  const b = merchant.calcProfit({ price: 115, cost: 50, shipping: 10, customsPct: 0, referralFeePct: 8 });
  assert.equal(b.assumptions.customsPct, 0); assert.equal(b.assumptions.referralFeePct, 8);
});

test('calcProfit: مدخلات ناقصة لا تعطي رقمًا مخترعًا', () => {
  assert.deepEqual(merchant.calcProfit({ price: 100 }).missing, ['تكلفة الشراء']);
  assert.deepEqual(merchant.calcProfit({ cost: 10 }).missing, ['سعر البيع']);
  assert.equal(merchant.calcProfit({ price: 0, cost: 1 }).ok, false);
});

test('sourcingQuery/Links: رقم الموديل ثم كلمات لاتينية، والروابط مرمّزة', () => {
  assert.equal(merchant.sourcingQuery({ brand: 'Acme', modelNumber: 'XZ-200', title: 'x' }), 'Acme XZ-200');
  assert.equal(merchant.sourcingQuery({ title: 'سماعة Bluetooth Pro 5.3 لاسلكية' }), 'Bluetooth Pro 5.3');
  const l = merchant.sourcingLinks({ title: 'Mini Fan USB' });
  assert.equal(l.length, 3); assert.ok(l[0].url.includes('SearchText=Mini%20Fan%20USB'));
  assert.deepEqual(merchant.sourcingLinks({}), []);
});

test('cleanMerchantData: تنقية وحدود', () => {
  assert.equal(merchant.cleanMerchantData({ status: 'x', note: '  ', cost: '' }), null);
  const c = merchant.cleanMerchantData({ status: 'candidate', note: ' ملاحظة ', cost: '12.5', shipping: '-3', other: 'abc' });
  assert.deepEqual(c, { status: 'candidate', note: 'ملاحظة', cost: 12.5 });
});

test('خصوصية الموقع: يُحفظ المدينة فقط دون اسم المستخدم', () => {
  const html = '<html><body><span id="glow-ingress-line2">إبراهيم - الرياض 12211</span></body></html>';
  const loc = (h) => { const q = h; return parser.parseProductDocument(docFrom(q), 'https://www.amazon.sa/dp/B0TEST0001').offer.deliveryLocation; };
  assert.equal(loc(html), 'الرياض 12211');
  assert.equal(loc(html.replace('إبراهيم - الرياض 12211', 'Riyadh 12211')), 'Riyadh 12211');
});

test('بيانات التاجر: تُحفظ في المنتج، تظهر في التصدير، وتُحذف', async () => {
  const db = await newDb();
  const p = parser.parseProductDocument(fixtureDoc('product_intl_confirmed.html'), 'https://www.amazon.sa/dp/B0TEST0001');
  await ingest.ingestProduct(db, p, { now: '2026-10-01T00:00:00.000Z' });
  await ingest.setMerchantData(db, 'B0TEST0001', { status: 'studying', note: 'اختبار', cost: 20 });
  await ingest.ingestProduct(db, p, { now: '2026-10-02T00:00:00.000Z' });   // إعادة الفحص لا تمسح بياناتي
  const prod = await db.get('products', 'B0TEST0001');
  assert.equal(prod.merchant.status, 'studying');
  const rows = exporter.buildRows(await db.all('products'), await db.all('offers'), [], { settings: {} });
  assert.equal(rows[0].merchantStatus, 'studying'); assert.equal(rows[0].merchantNote, 'اختبار');
  assert.equal(typeof rows[0].profitPerUnit, 'number');
  await ingest.setMerchantData(db, 'B0TEST0001', null);
  assert.equal((await db.get('products', 'B0TEST0001')).merchant, undefined);
});

test('نسخ احتياطي: ذهاب وإياب كامل، ورفض الملفات التالفة دون لمس البيانات', async () => {
  const a = await newDb();
  const p = parser.parseProductDocument(fixtureDoc('product_intl_confirmed.html'), 'https://www.amazon.sa/dp/B0TEST0001');
  await ingest.ingestProduct(a, p, { now: '2026-10-01T00:00:00.000Z' });
  await ingest.setMerchantData(a, 'B0TEST0001', { status: 'candidate', cost: 9 });
  const dump = JSON.parse(JSON.stringify(await backup.exportAll(a, { customsPct: 7 }, '1.2.0')));
  const b = await newDb();
  const r = await backup.importAll(b, dump);
  assert.equal(r.counts.products, 1); assert.equal(r.settings.customsPct, 7);
  assert.equal((await b.get('products', 'B0TEST0001')).merchant.cost, 9);
  assert.equal(await b.count('offers'), await a.count('offers'));
  assert.equal(await b.count('evidence'), await a.count('evidence'));
  await assert.rejects(() => backup.importAll(b, { format: 'other' }), /ليس نسخة/);
  await assert.rejects(() => backup.importAll(b, Object.assign({}, dump, { stores: { products: [{}] } })), /بلا ASIN/);
  assert.equal(await b.count('products'), 1, 'الرفض لا يمسح البيانات');
});

test('تنظيف السجلات القديمة: يُزال الاسم وتبقى المدينة، ولا يُمس غيرها', async () => {
  const db = await newDb();
  await db.put('offers', { offerKey: 'a', asin: 'A', deliveryLocation: 'Mustafa - الرياض' });
  await db.put('offers', { offerKey: 'b', asin: 'B', deliveryLocation: 'الرياض 12211' });
  await db.put('offers', { offerKey: 'c', asin: 'C' });
  assert.equal(await ingest.scrubDeliveryLocations(db), 1);
  assert.equal((await db.get('offers', 'a')).deliveryLocation, 'الرياض');
  assert.equal((await db.get('offers', 'b')).deliveryLocation, 'الرياض 12211');
  assert.equal(await ingest.scrubDeliveryLocations(db), 0);
});

test('المورد: يُحفظ بمنصته، ويرفض الروابط غير http، ويظهر في التصدير', async () => {
  assert.equal(merchant.supplierPlatform('https://www.aliexpress.com/item/1.html'), 'AliExpress');
  assert.equal(merchant.supplierPlatform('https://www.alibaba.com/product-detail/x'), 'Alibaba');
  assert.equal(merchant.supplierPlatform('https://detail.1688.com/offer/1.html'), '1688');
  assert.equal(merchant.supplierPlatform('javascript:alert(1)'), null);
  assert.equal(merchant.cleanMerchantData({ supplierUrl: 'javascript:alert(1)' }), null);
  const db = await newDb();
  const p = parser.parseProductDocument(fixtureDoc('product_intl_confirmed.html'), 'https://www.amazon.sa/dp/B0TEST0001');
  await ingest.ingestProduct(db, p, { now: '2026-10-01T00:00:00.000Z' });
  await ingest.setMerchantData(db, 'B0TEST0001', merchant.cleanMerchantData({ supplierUrl: 'https://www.aliexpress.com/item/1.html', supplierName: 'Foo Store' }));
  const rows = exporter.buildRows(await db.all('products'), await db.all('offers'), [], { settings: {} });
  assert.equal(rows[0].supplierName, 'Foo Store'); assert.match(rows[0].supplierUrl, /aliexpress/);
});

test('بحث بالصورة: رابط Lens بصورة المنتج فقط إن كانت http(s)', () => {
  const l = merchant.sourcingLinks({ title: 'Mini Fan', imageUrl: 'https://m.media-amazon.com/images/I/a b.jpg' });
  const img = l.find(x => x.name === 'بحث بالصورة');
  assert.ok(img.url.startsWith('https://lens.google.com/uploadbyurl?url=https%3A%2F%2Fm.media-amazon.com'));
  assert.equal(merchant.imageSearchLink({ imageUrl: 'javascript:1' }), null);
  assert.equal(merchant.sourcingLinks({ title: 'Mini Fan' }).some(x => x.name === 'بحث بالصورة'), false);
});

test('عبارة البحث: لا أرقام وحدها ولا عربية (سبب النتائج العشوائية)، وعبارة التاجر تتقدم', () => {
  const t = 'ستيري [عبوتان] شاشة خصوصية الكمبيوتر 27 انش لشاشة عريضة 16:9 حماية العين - غشاء واقي 27 انش';
  assert.equal(merchant.sourcingQuery({ title: t }), '');
  assert.deepEqual(merchant.sourcingLinks({ title: t }), [], 'بلا صورة ولا عبارة: لا روابط نصية');
  const withImg = merchant.sourcingLinks({ title: t, imageUrl: 'https://m.media-amazon.com/x.jpg' });
  assert.deepEqual(withImg.map(x => x.name), ['بحث بالصورة']);
  assert.equal(merchant.sourcingQuery({ title: t, merchant: { searchQuery: '27 inch privacy screen filter' } }), '27 inch privacy screen filter');
  assert.equal(merchant.sourcingQuery({ title: 'شاشة UPERFECT USteam E6 Pro 18.5 بوصة 1080P' }), 'UPERFECT USteam E6 Pro 18.5 1080P');
  assert.equal(merchant.cleanMerchantData({ searchQuery: ' privacy screen ' }).searchQuery, 'privacy screen');
});
