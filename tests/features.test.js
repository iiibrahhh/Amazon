const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { fx, fixtureDoc, newDb } = require('./helpers');
const parser = require('../extension/lib/parser.js');
const ingest = require('../extension/lib/ingest.js');
const ex = require('../extension/lib/export.js');
const crawler = require('../extension/lib/crawler.js');
const rules = require('../extension/lib/rules.js');

const parse = (f, a) => parser.parseProductDocument(fixtureDoc(f), 'https://www.amazon.sa/dp/' + a);
async function rowsFor(list) {
  const db = await newDb();
  for (const [f, a] of list) await ingest.ingestProduct(db, parse(f, a), {});
  return ex.buildRows(await db.all('products'), await db.all('offers'), await db.all('evidence'));
}

test('اسم البائع ≠ اسم الشاحن: بائع مستقل وأمازون تشحن', async () => {
  const p = parse('product_local_fba.html', 'B0TEST0002');
  assert.match(p.offer.sellerName, /Shenzhen Bright/);
  assert.equal(p.offer.shipperName, 'Amazon');
  const [r] = await rowsFor([['product_local_fba.html', 'B0TEST0002']]);
  assert.equal(r.sellerIsShipper, 'لا');
  assert.equal(r.shippingCost, 'مجاني');
  assert.equal(r.shippingStatus, 'local');
});

test('البائع هو الشاحن نفسه («يشحن ويباع بواسطة») بلا استنتاج بلد', async () => {
  const p = parse('product_seller_ships.html', 'B0TEST0007');
  assert.equal(p.offer.sellerName, 'Sunrise Shop');
  assert.equal(p.offer.shipperName, 'Sunrise Shop');
  assert.equal(p.offer.shippingCost, 12);
  const [r] = await rowsFor([['product_seller_ships.html', 'B0TEST0007']]);
  assert.equal(r.sellerIsShipper, 'نعم');
  assert.equal(r.shippingStatus, 'unknown');
  assert.equal(r.shippingOrigin, null);
});

test('بلد الشحن يظهر بالعربية فقط عند ثبوته بدليل، وعنوان التوصيل وسعر الشحن ورسوم الاستيراد', async () => {
  const p = parse('product_intl_confirmed.html', 'B0TEST0001');
  assert.equal(p.offer.shipperName, null, 'قيمة «يشحن من» دولة لا اسم جهة');
  assert.equal(p.offer.deliveryLocation, 'Riyadh 12211');
  const rows = await rowsFor([['product_intl_confirmed.html', 'B0TEST0001'], ['product_foreign_seller_no_ship_info.html', 'B0TEST0003']]);
  const a = rows.find(r => r.asin === 'B0TEST0001'), b = rows.find(r => r.asin === 'B0TEST0003');
  assert.equal(a.shippingOrigin, 'الولايات المتحدة');
  assert.equal(a.shippingCost, 45); assert.equal(a.importFees, 38.5); assert.equal(a.deliveryLocation, 'Riyadh 12211');
  assert.match(a.evidenceText, /United States/); assert.ok(a.verifiedAt && a.evidenceSource);
  assert.equal(b.shippingOrigin, null, 'بلا دليل لا بلد');
  assert.equal(b.shippingCost, 0 === b.shippingCost ? 'مجاني' : b.shippingCost);
  const csv = ex.toCSV(rows); const t = ex.parseCSV(csv);
  for (const h of ['اسم البائع (يباع بواسطة)', 'اسم الشاحن (يشحن بواسطة)', 'بلد الشحن (إن ثبت)', 'سعر الشحن', 'رسوم الاستيراد المقدرة', 'عنوان التوصيل المعتمد', 'الكتالوج', 'دليل التصنيف'])
    assert.ok(t[0].includes(h), h);
});

test('«مجاني» يُستورد من CSV كصفر ولا يُفقد', async () => {
  const csv = 'ASIN,اسم البائع,سعر الشحن\nB0FREESHP1,Shop,مجاني\n';
  const { records } = ex.recordsFromCsv(csv);
  assert.equal(records[0].shippingCost, 0); assert.equal(records[0].sellerName, 'Shop');
});

/* ---------- الكتالوج ---------- */
const settings = Object.assign({}, rules.DEFAULT_SETTINGS, { minDelayMs: 1, maxDelayMs: 2, maxCategoryDepth: 1 });
const parseHtml = (h) => new JSDOM(h).window.document;
function site(extra) {
  const calls = [];
  const routes = Object.assign({
    'https://www.amazon.sa/gp/bestsellers': fx('listing_bestsellers.html'),
    'https://www.amazon.sa/gp/bestsellers/electronics': fx('listing_bestsellers.html'),
    'https://www.amazon.sa/dp/B0LIST0001': fx('product_intl_confirmed.html'),
    'https://www.amazon.sa/dp/B0LIST0002': fx('product_local_fba.html'),
    'https://www.amazon.sa/dp/B0LIST0003': fx('product_foreign_seller_no_ship_info.html')
  }, extra || {});
  return { calls, fetchHtml: async (url) => { calls.push(url); return url in routes ? { status: 200, url, html: routes[url] } : { status: 404, url, html: '' }; } };
}

test('اكتشاف الكتالوجات تلقائيًا من صفحة الأكثر مبيعًا (الأقسام الرئيسية فقط)', async () => {
  const s = site();
  const list = await crawler.discoverCatalogs({ settings, fetchHtml: s.fetchHtml, parseHtml });
  assert.deepEqual(list.map(c => c.name).sort(), ['Electronics', 'Home']);
  assert.ok(list.every(c => /\/gp\/bestsellers\/[^/]+$/.test(c.url)));
});

test('الجمع ضمن كتالوج محدد: لا بذور عامة، ولا خروج عن النطاق، والمنتجات تحمل اسم الكتالوج', async () => {
  const db = await newDb();
  const s = site();
  const scoped = Object.assign({}, settings, { catalogScope: [{ name: 'Electronics', url: 'https://www.amazon.sa/gp/bestsellers/electronics' }] });
  const stats = await crawler.createRunner({ db, settings: scoped, fetchHtml: s.fetchHtml, parseHtml, sleep: async () => {} }).run();
  assert.equal(stats.stoppedBecause, 'queue_empty');
  assert.ok(!s.calls.includes('https://www.amazon.sa/gp/new-releases'), 'لا بذور عامة');
  assert.ok(!s.calls.some(u => u.endsWith('/gp/bestsellers/home')), 'قسم خارج النطاق لم يُطلب');
  const prods = await db.all('products');
  assert.ok(prods.length >= 3);
  assert.ok(prods.every(p => p.catalog === 'Electronics'));
  const q = await db.all('queue');
  assert.ok(q.every(i => i.catalog === 'Electronics'));
});

test('الجمع بلا نطاق يغطي كل البذور، وكتالوج المنتج يؤخذ من القسم المكتشَف', async () => {
  const db = await newDb();
  const s = site({ 'https://www.amazon.sa/gp/bestsellers/home': fx('listing_bestsellers.html') });
  await crawler.createRunner({ db, settings, fetchHtml: s.fetchHtml, parseHtml, sleep: async () => {} }).run();
  assert.ok(s.calls.includes('https://www.amazon.sa/gp/bestsellers'));
  assert.ok(s.calls.includes('https://www.amazon.sa/gp/bestsellers/home'), 'الأقسام الفرعية تُتبع');
});

test('فلتر الكتالوج: الصفوف تحمل الكتالوج، ويُحفظ أول كتالوج ولا يُستبدل', async () => {
  const db = await newDb();
  await ingest.ingestListingItems(db, [{ asin: 'B0TEST0001', url: 'u', title: 't' }], { catalog: 'الإلكترونيات' });
  await ingest.ingestProduct(db, parse('product_intl_confirmed.html', 'B0TEST0001'), {});   // مسار الفئة في الصفحة: Electronics
  const p = await db.get('products', 'B0TEST0001');
  assert.equal(p.catalog, 'الإلكترونيات');
  await ingest.ingestProduct(db, parse('product_local_fba.html', 'B0TEST0002'), {});
  assert.equal((await db.get('products', 'B0TEST0002')).catalog, null, 'بلا مسار فئة ولا قائمة: لا كتالوج مخترع');
  const rows = ex.buildRows(await db.all('products'), await db.all('offers'), []);
  assert.deepEqual(rows.filter(r => r.catalog === 'الإلكترونيات').map(r => r.asin), ['B0TEST0001']);
});
