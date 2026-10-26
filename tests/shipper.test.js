const test = require('node:test');
const assert = require('node:assert/strict');
const { fixtureDoc, newDb } = require('./helpers');
const rules = require('../extension/lib/rules.js');
const parser = require('../extension/lib/parser.js');
const { classifyShipping } = require('../extension/lib/classifier.js');
const ingest = require('../extension/lib/ingest.js');
const exporter = require('../extension/lib/export.js');

const NOW = new Date('2026-10-25T08:00:00Z');   // تاريخ الفحص في الحالة الحقيقية التي ألصقها المستخدم
const parse = (f, asin) => parser.parseProductDocument(fixtureDoc(f), 'https://www.amazon.sa/dp/' + asin, { now: NOW });
const cls = (p, extra) => classifyShipping(p.shippingFields, Object.assign({ url: p.url, now: NOW.toISOString() }, extra));

/* ---------- أدوات التوقيت ---------- */
test('مدة التجهيز: عربي وإنجليزي ووحدات أسابيع', () => {
  const h = (t) => rules.parseHandlingDays(t);
  assert.deepEqual([h('يتم شحنه عادة خلال 9 إلى 10 أيام').minDays, h('يتم شحنه عادة خلال 9 إلى 10 أيام').maxDays], [9, 10]);
  assert.equal(h('يتم شحنه عادةً خلال ٣ أيام').minDays, 3);
  assert.deepEqual([h('Usually ships within 2 to 3 days').minDays, h('Usually ships within 2 to 3 days').maxDays], [2, 3]);
  assert.equal(h('Usually dispatched within 1 week').minDays, 7);
  assert.equal(h('يتم شحنه عادة خلال أسبوعين').minDays, 14);
  assert.equal(h('متوفر'), null);
  assert.equal(h(''), null);
  assert.equal(h('التوصيل خلال 35 يومًا'), null, 'مدة التوصيل ليست مدة تجهيز');
});

test('نافذة التوصيل: صيغ عربية/إنجليزية، شهران، تجاوز السنة، «غدًا»', () => {
  const w = (t, now) => rules.parseDeliveryWindow(t, now || NOW);
  let r = w('توصيل مجاني نوفمبر 11 - 15. التفاصيل');
  assert.deepEqual([r.minDays, r.maxDays, r.startDate, r.endDate], [17, 21, '2026-11-11', '2026-11-15']);
  r = w('١٥ - ٢٥ نوفمبر'); assert.deepEqual([r.minDays, r.maxDays], [21, 31]);
  r = w('FREE delivery 30 December - 15 January'); assert.deepEqual([r.startDate, r.endDate], ['2026-12-30', '2027-01-15']);
  r = w('Delivery Dec 30 - Jan 15'); assert.deepEqual([r.startDate, r.endDate], ['2026-12-30', '2027-01-15']);
  r = w('Arrives November 11'); assert.equal(r.minDays, 17);
  r = w('Delivery 3 January', new Date('2026-12-28T10:00:00Z')); assert.equal(r.startDate, '2027-01-03', 'يمر على رأس السنة');
  r = w('Tomorrow, 26 October'); assert.equal(r.minDays, 1);
  assert.equal(w('Free delivery on orders over SAR 99'), null);
  assert.equal(w('Market place sells 45 items'), null, 'كلمة market ليست شهر mar');
});

/* ---------- حالة المستخدم الحقيقية (بنية اصطناعية) ---------- */
test('الشاحن / البائع: يُستخرج الاسم مرة واحدة (بلا تكرار) ويُعدّ الشاحن هو البائع', () => {
  const p = parse('product_seller_long_handling.html', 'B0TEST0K2H');
  assert.equal(p.offer.price, 955.55);
  assert.equal(p.offer.shipperName, 'Shopglobalstore - KSA');
  assert.equal(p.offer.sellerName, 'Shopglobalstore - KSA');
  assert.equal(p.offer.sellerId, 'A3FW2YHPVTP5KN');
  assert.equal(p.offer.shipperType, 'seller');
  assert.equal(p.shippingFields.shipperIsSeller, true);
  assert.equal(p.offer.handlingMinDays, 9); assert.equal(p.offer.handlingMaxDays, 10);
  assert.equal(p.offer.deliveryMinDays, 17); assert.equal(p.offer.deliveryMaxDays, 21);
  assert.equal(p.offer.deliveryDate, 'نوفمبر 11 - 15');
  assert.equal(p.offer.shippingCost, 0);
});

test('شاحن = بائع + تجهيز 9–10 أيام + توصيل بعد 17–21 يومًا ⇒ «مرجح» (لا «غير معلوم» ولا «مؤكد»)', () => {
  const p = parse('product_seller_long_handling.html', 'B0TEST0K2H');
  const c = cls(p);
  assert.equal(c.status, 'likely');
  assert.equal(c.originCountry, null, 'لا نخترع بلدًا');
  const e = c.evidence.find(x => x.signal === 'seller_ships_long_handling_and_delivery');
  assert.ok(e); assert.equal(e.strength, 'likely'); assert.equal(e.field, 'combined');
  assert.match(e.text, /Shopglobalstore - KSA/); assert.match(e.text, /9–10/); assert.match(e.text, /17–21/);
  assert.ok(c.notes.some(n => n.includes('قرائن مجتمعة')));
  assert.ok(!c.evidence.some(x => x.strength === 'confirmed'));
});

test('وجود «KSA» في اسم البائع/الشاحن ليس دليلًا محليًا ولا دوليًا', () => {
  const c = classifyShipping({ shipsFrom: 'Saudi Gadgets Store', shipsFromIsName: true, shipperType: 'seller' });
  assert.equal(c.status, 'unknown');
  assert.ok(!c.evidence.some(e => e.strength === 'local'));
});

test('عتبات القرينة المركّبة قابلة للضبط', () => {
  const p = parse('product_seller_long_handling.html', 'B0TEST0K2H');
  assert.equal(cls(p, { intlMinHandlingDays: 12, intlMinDeliveryDays: 30, intlMinTransitDays: 99 }).status, 'unknown');
  assert.equal(cls(p, { intlMinHandlingDays: 12, intlMinDeliveryDays: 15, intlMinTransitDays: 99 }).evidence[0].signal, 'seller_ships_long_delivery');
  assert.equal(cls(p, { intlMinHandlingDays: 9, intlMinDeliveryDays: 99, intlMinTransitDays: 99 }).evidence[0].signal, 'seller_ships_long_handling');
});

test('شاحن = بائع لكن المدد قصيرة ⇒ غير معلوم مع ملاحظة', () => {
  const p = parse('product_seller_short_handling.html', 'B0TEST0K3L');
  assert.equal(p.offer.shipperType, 'seller');
  const c = cls(p);
  assert.equal(c.status, 'unknown');
  assert.ok(c.notes.some(n => n.includes('مدد الشحن قصيرة')));
});

test('الشاحن أمازون + تجهيز/توصيل طويل ⇒ محلي (لا قرينة دولية)', () => {
  const p = parse('product_amazon_ships_long_delivery.html', 'B0TEST0AMZ');
  assert.equal(p.offer.shipperType, 'amazon');
  assert.equal(p.offer.sellerName, 'GamerHub Trading');
  assert.equal(p.offer.handlingMinDays, 10);
  const c = cls(p);
  assert.equal(c.status, 'local');
  assert.ok(!c.evidence.some(e => e.signal.startsWith('seller_ships')));
});

test('مدد طويلة بلا معرفة الشاحن ⇒ لا قرينة (التوصيل وحده ليس دليلًا)', () => {
  const c = classifyShipping({ deliveryWindow: { minDays: 40, maxDays: 50 }, handling: { minDays: 30, maxDays: 30 } });
  assert.equal(c.status, 'unknown');
});

test('الصفحات القديمة ما زالت تعمل: «Ships from and sold by» → شاحن = بائع بنفس القواعد', () => {
  const p = parser.parseProductDocument(fixtureDoc('product_seller_ships.html'), 'https://www.amazon.sa/dp/B0TEST0007', { now: new Date('2026-10-22T08:00:00Z') });
  assert.equal(p.offer.shipperName, 'Sunrise Shop');
  assert.equal(p.offer.shipperType, 'seller');
  assert.equal(cls(p).status, 'unknown');
});

/* ---------- التخزين والتصدير ---------- */
test('التخزين: الحقول الجديدة تُحفظ وتُستبدل عند إعادة الفحص بلا تكرار، والعتبات من الإعدادات', async () => {
  const db = await newDb();
  const p = parse('product_seller_long_handling.html', 'B0TEST0K2H');
  const r1 = await ingest.ingestProduct(db, p, { now: NOW.toISOString(), settings: rules.DEFAULT_SETTINGS });
  assert.equal(r1.classification.status, 'likely');
  let offer = (await db.all('offers'))[0];
  assert.equal(offer.shipperType, 'seller'); assert.equal(offer.handlingMinDays, 9); assert.equal(offer.deliveryMinDays, 17);
  assert.equal((await db.get('products', 'B0TEST0K2H')).shippingStatus, 'likely');

  // فحص لاحق: الصفحة لم تعد تذكر مهلة التجهيز → لا تبقى القيمة القديمة
  const p2 = JSON.parse(JSON.stringify(p));
  p2.offer.handlingMinDays = null; p2.offer.handlingMaxDays = null; p2.shippingFields.handling = null;
  p2.offer.price = 891;
  await ingest.ingestProduct(db, p2, { now: '2026-10-25T08:11:00.000Z', settings: Object.assign({}, rules.DEFAULT_SETTINGS, { intlMinDeliveryDays: 99 }) });
  assert.equal((await db.all('products')).length, 1); assert.equal((await db.all('offers')).length, 1);
  offer = (await db.all('offers'))[0];
  assert.equal(offer.handlingMinDays, null);
  assert.equal(offer.shippingStatus, 'unknown');
  const hist = await db.byIndex('priceHistory', 'asin', 'B0TEST0K2H');
  assert.deepEqual(hist.map(h => h.price), [955.55, 891]);
});

test('التصدير: أعمدة نوع الشاحن ومدة التجهيز والتوصيل بعد X يومًا', async () => {
  const db = await newDb();
  await ingest.ingestProduct(db, parse('product_seller_long_handling.html', 'B0TEST0K2H'), { now: NOW.toISOString(), settings: rules.DEFAULT_SETTINGS });
  const rows = exporter.buildRows(await db.all('products'), await db.all('offers'), await db.all('evidence'));
  assert.equal(rows[0].shipperTypeAr, 'البائع (ليس أمازون)');
  assert.equal(rows[0].handlingText, '9–10'); assert.equal(rows[0].deliveryDaysText, '17–21');
  assert.deepEqual([rows[0].handlingMinDays, rows[0].handlingMaxDays, rows[0].deliveryMinDays, rows[0].deliveryMaxDays], [9, 10, 17, 21]);
  const v = exporter.shippingVerdict(rows[0]);
  assert.equal(v.status, 'likely'); assert.match(v.headline, /شحن دولي مرجح/);
  assert.ok(v.lines.some(([k, t]) => k === 'الشاحن' && /Shopglobalstore - KSA.*هو البائع نفسه/.test(t)));
  assert.equal(rows[0].sellerIsShipper, 'نعم');
  assert.match(rows[0].evidenceText, /مهلة التجهيز: 9–10 يوم/);
  const csv = exporter.toCSV(rows);
  assert.ok(csv.includes('نوع الشاحن') && csv.includes('مدة التجهيز - من') && csv.includes('Shopglobalstore - KSA'));
  const head = csv.split('\r\n')[0].split(','), line = csv.split('\r\n')[1].split(',');
  assert.equal(line[head.indexOf('مدة التجهيز - من (يوم)')], '9');
  // Excel: أعمدة الأيام أرقام حقيقية لا نصوص
  const xlsx = exporter.buildXlsx(rows); assert.ok(xlsx.length > 500);
});
