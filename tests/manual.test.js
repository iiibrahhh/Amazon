const test = require('node:test');
const assert = require('node:assert/strict');
const { fixtureDoc, newDb } = require('./helpers');
const parser = require('../extension/lib/parser.js');
const classifier = require('../extension/lib/classifier.js');
const ingest = require('../extension/lib/ingest.js');
const ex = require('../extension/lib/export.js');

const parse = (f, a) => parser.parseProductDocument(fixtureDoc(f), 'https://www.amazon.sa/dp/' + a);
async function seeded() {
  const db = await newDb();
  const r = await ingest.ingestProduct(db, parse('product_seller_short_handling.html', 'B0TESTSHRT'), {});
  return { db, key: r.offer.offerKey, asin: r.asin };
}

test('حالة واقعية: الشاحن = البائع، تجهيز 4–5 أيام، توصيل بعد 9–10 أيام → «مرجح» بقرينة فارق النقل (1.1.4)', () => {
  // قيم مأخوذة من فحص المستخدم الفعلي لمنتج B0DCVPGB9N (يؤكد المستخدم أنه دولي؛ الصفحة لا تذكر بلد الشحن).
  // العتبتان القديمتان (تجهيز ≥ 5، توصيل ≥ 14) لا تلتقطانه، أما فارق النقل (9 − 5 = 4 أيام) فيلتقطه.
  const f = { shipperType: 'seller', shipperName: 'MahzuzStores', soldBy: 'MahzuzStores',
    handling: { minDays: 4, maxDays: 5 }, deliveryWindow: { minDays: 9, maxDays: 10 } };
  const c = classifier.classifyShipping(f);
  assert.equal(c.status, 'likely');
  assert.equal(c.evidence[0].signal, 'seller_ships_long_transit');
  assert.equal(classifier.classifyShipping(f, { intlMinTransitDays: 5 }).status, 'unknown', 'يعود «غير معلوم» إن رُفعت عتبة الفارق');
});

test('التحقق اليدوي يتطلب دليلًا نصيًا للمؤكد/المرجح', async () => {
  const { db, key } = await seeded();
  await assert.rejects(() => ingest.setUserVerdict(db, key, { status: 'confirmed', note: '' }), /دليلك/);
  await assert.rejects(() => ingest.setUserVerdict(db, key, { status: 'likely', note: 'ok' }), /دليلك/);
  await assert.rejects(() => ingest.setUserVerdict(db, key, { status: 'weird', note: 'xxxxxx' }), /غير صالحة/);
  await ingest.setUserVerdict(db, key, { status: 'local', note: '' });       // محلي/غير معلوم لا يحتاج دليلًا
  assert.equal((await db.get('offers', key)).userStatus, 'local');
});

test('الحالة اليدوية منفصلة عن الآلية، وتصمد أمام إعادة الفحص، وتنعكس على المنتج والتصدير', async () => {
  const { db, key, asin } = await seeded();
  const auto = (await db.get('offers', key)).shippingStatus;
  await ingest.setUserVerdict(db, key, { status: 'confirmed', country: 'الصين', note: 'عنوان نشاط البائع في الصين حسب صفحة البائع', now: '2026-10-26T10:00:00.000Z' });
  await ingest.ingestProduct(db, parse('product_seller_short_handling.html', 'B0TESTSHRT'), { now: '2026-10-27T10:00:00.000Z' });
  const o = await db.get('offers', key);
  assert.equal(o.shippingStatus, auto, 'التصنيف الآلي لم يتغير بسبب التحقق اليدوي');
  assert.equal(o.userStatus, 'confirmed'); assert.equal(o.userCountry, 'الصين');
  assert.equal(o.userAt, '2026-10-26T10:00:00.000Z', 'إعادة الفحص لا تمس التحقق اليدوي');
  assert.equal((await db.get('products', asin)).shippingStatus, 'confirmed');
  const rows = ex.buildRows(await db.all('products'), await db.all('offers'), await db.all('evidence'));
  const r = rows[0];
  assert.equal(r.shippingStatus, 'confirmed'); assert.equal(r.autoStatus, auto);
  assert.equal(r.statusSource, 'يدوي من المستخدم'); assert.equal(r.userNote.includes('الصين'), true);
  assert.equal(r.evidenceText, null, 'لا يُخلط الدليل اليدوي بأدلة الصفحة');
});

test('إزالة التحقق اليدوي تعيد الحالة الآلية', async () => {
  const { db, key, asin } = await seeded();
  const auto = (await db.get('offers', key)).shippingStatus;
  await ingest.setUserVerdict(db, key, { status: 'confirmed', note: 'دليل كافٍ هنا' });
  await ingest.clearUserVerdict(db, key);
  const o = await db.get('offers', key);
  assert.equal(o.userStatus, undefined);
  assert.equal((await db.get('products', asin)).shippingStatus, auto);
});

test('CSV: جولة تصدير/استيراد تحفظ التحقق اليدوي ولا تحوّله إلى تصنيف آلي', async () => {
  const { db, key } = await seeded();
  await ingest.setUserVerdict(db, key, { status: 'confirmed', country: 'الصين', note: 'عنوان البائع في الصين' });
  const rows = ex.buildRows(await db.all('products'), await db.all('offers'), await db.all('evidence'));
  const csv = ex.toCSV(rows);
  const db2 = await newDb();
  const { records } = ex.recordsFromCsv(csv);
  await ex.importRecords(db2, records);
  const offers = await db2.all('offers');
  assert.equal(offers.length, 1);
  assert.equal(offers[0].userStatus, 'confirmed'); assert.equal(offers[0].userNote, 'عنوان البائع في الصين');
  assert.notEqual(offers[0].shippingStatus, 'confirmed', 'الحالة الآلية لا تُلوَّث بالمستورد اليدوي');
});

test('CSV: تحقق يدوي «مؤكد» بلا دليل في الملف يُرفض', async () => {
  const csv = 'ASIN,اسم البائع (يباع بواسطة),تصنيف المستخدم اليدوي\nB0NOTEMISS,Shop,مؤكد\n';
  const db = await newDb();
  const { records } = ex.recordsFromCsv(csv);
  const r = await ex.importRecords(db, records);
  assert.equal(r.downgraded, 1);
  assert.equal((await db.all('offers'))[0].userStatus, undefined);
});
