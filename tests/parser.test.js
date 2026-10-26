const test = require('node:test');
const assert = require('node:assert/strict');
const { fixtureDoc, docFrom } = require('./helpers');
const parser = require('../extension/lib/parser.js');
const classifier = require('../extension/lib/classifier.js');

test('استخراج ASIN من روابط المنتج', () => {
  const ok = [
    ['https://www.amazon.sa/dp/B0TEST0001', 'B0TEST0001'],
    ['https://www.amazon.sa/-/en/Acme-Earbuds/dp/b0test0001/ref=sr_1_1?th=1', 'B0TEST0001'],
    ['https://www.amazon.sa/gp/product/B0TEST0002?psc=1', 'B0TEST0002'],
    ['https://www.amazon.sa/gp/aw/d/B0TEST0003/', 'B0TEST0003'],
    ['https://www.amazon.sa/something?asin=B0TEST0004&x=1', 'B0TEST0004'],
    ['/Some-Product/dp/B0LIST0003#reviews', 'B0LIST0003']
  ];
  for (const [u, a] of ok) assert.equal(parser.extractAsin(u), a, u);
  for (const u of ['https://www.amazon.sa/', 'https://www.amazon.sa/s?k=abc', 'https://www.amazon.sa/dp/SHORT', '', null])
    assert.equal(parser.extractAsin(u), null, String(u));
});

test('تحليل الأسعار بصيغ مختلفة (لاتينية/عربية)', () => {
  assert.deepEqual(parser.parsePrice('SAR 1,299.00'), { amount: 1299, currency: 'SAR' });
  assert.deepEqual(parser.parsePrice('‏١٬٢٩٩٫٥٠ ر.س.‏'), { amount: 1299.5, currency: 'SAR' });
  assert.deepEqual(parser.parsePrice('1.299,00 SAR'), { amount: 1299, currency: 'SAR' });
  assert.deepEqual(parser.parsePrice('SAR 12'), { amount: 12, currency: 'SAR' });
  assert.deepEqual(parser.parsePrice(''), { amount: null, currency: null });
  assert.deepEqual(parser.parsePrice('Currently unavailable'), { amount: null, currency: null });
});

test('استخراج اسم المنتج والسعر وبقية الحقول عند توفرها', () => {
  const p = parser.parseProductDocument(fixtureDoc('product_intl_confirmed.html'), 'https://www.amazon.sa/dp/B0TEST0001');
  assert.equal(p.ok, true);
  assert.equal(p.asin, 'B0TEST0001');
  assert.equal(p.title, 'Acme Wireless Earbuds Pro X');
  assert.equal(p.offer.price, 299, 'السعر الحالي لا السعر المشطوب');
  assert.equal(p.offer.currency, 'SAR');
  assert.equal(p.offer.listPrice, 399);
  assert.equal(p.offer.discountPct, 25);
  assert.equal(p.brand, 'Acme');
  assert.equal(p.rating, 4.4);
  assert.equal(p.reviewCount, 1234);
  assert.equal(p.bsrRank, 1520);
  assert.equal(p.bsrCategory, 'Electronics');
  assert.equal(p.modelNumber, 'AEP-X1');
  assert.equal(p.gtin, '0123456789012');
  assert.equal(p.imageUrl, 'https://example.invalid/img/earbuds-large.jpg');
  assert.equal(p.categoryPath, 'Electronics › Headphones');
  assert.equal(p.offer.sellerName, 'Acme Global Store');
  assert.equal(p.offer.sellerId, 'A1TESTSELLER01');
  assert.equal(p.offer.shipsFrom, 'United States');
  assert.equal(p.offer.deliveryDate, '28 October - 3 November');
  assert.equal(p.offer.shippingCost, 45);
  assert.equal(p.offer.importFees, 38.5);
  assert.equal(p.offer.numOffers, 3);
  assert.equal(p.offer.availability, 'in_stock');
});

test('منتج بلا سعر: لا يُخترع رقم، وتُسجَّل الحقول الناقصة', () => {
  const p = parser.parseProductDocument(fixtureDoc('product_arabic_no_price.html'), 'https://www.amazon.sa/dp/B0TEST0004');
  assert.equal(p.ok, true);
  assert.equal(p.offer.price, null);
  assert.equal(p.offer.currency, null);
  assert.equal(p.title, 'سماعة رأس لاسلكية للألعاب – إصدار محدود');
  assert.equal(p.brand, 'نوفا');
  assert.equal(p.rating, 4.3);
  assert.equal(p.reviewCount, 1200);
  assert.equal(p.offer.availability, 'out_of_stock');
  assert.equal(p.bsrRank, 123);
  assert.equal(p.bsrCategory, 'ألعاب الفيديو');
  assert.ok(p.fieldsMissing.includes('price'));
  assert.ok(p.fieldsMissing.includes('shipsFrom'));
});

test('صفحة لا تعرض معلومات الشحن → لا دليل ولا تصنيف دولي', () => {
  const p = parser.parseProductDocument(fixtureDoc('product_foreign_seller_no_ship_info.html'), 'https://www.amazon.sa/dp/B0TEST0003');
  assert.equal(p.offer.shipsFrom, null);
  assert.equal(p.offer.price, 120.5);
  const c = classifier.classifyShipping(p.shippingFields);
  assert.equal(c.status, 'unknown');
  assert.equal(c.evidence.length, 0);
});

test('صفحة بترتيب مختلف وحقول غائبة (محدد سعر بديل، بلا ماركة/تقييم)', () => {
  const p = parser.parseProductDocument(fixtureDoc('product_shuffled_arabic_abroad.html'), 'https://www.amazon.sa/dp/B0TEST0005');
  assert.equal(p.ok, true);
  assert.equal(p.title, 'طابعة ليزر ملونة');
  assert.equal(p.offer.price, 1299.5);
  assert.equal(p.brand, null);
  assert.equal(p.rating, null);
  assert.equal(p.reviewCount, null);
  assert.equal(p.offer.sellerName, 'متجر العالم');
  assert.equal(p.offer.sellerId, 'A4SHUFFLE00001');
  assert.equal(p.offer.deliveryDate, '15 - 25 نوفمبر');
  assert.equal(classifier.classifyShipping(p.shippingFields).status, 'confirmed');
});

test('صفحة ليست منتجًا → ok=false بلا استثناء', () => {
  const r = parser.parseProductDocument(docFrom('<html><body><p>لا شيء</p></body></html>'), 'https://www.amazon.sa/gp/help');
  assert.equal(r.ok, false);
});

test('صفحة قائمة: منتجات وفئات وصفحة تالية، وتجاهل روابط البحث والمواقع الخارجية', () => {
  const r = parser.parseListingDocument(fixtureDoc('listing_bestsellers.html'), 'https://www.amazon.sa');
  const asins = r.items.map(i => i.asin).sort();
  assert.deepEqual(asins, ['B0LIST0001', 'B0LIST0002', 'B0LIST0003']);
  const first = r.items.find(i => i.asin === 'B0LIST0001');
  assert.equal(first.price, 12.5); assert.equal(first.rating, 4.1); assert.equal(first.reviewCount, 1234, 'عدد المراجعات لا يلتقط نص النجوم');
  assert.equal(first.imageUrl, 'https://example.invalid/a.jpg', 'الصورة الكسولة من data-src لا base64'); assert.equal(first.title, 'Item One Title');
  assert.ok(r.categoryLinks.includes('https://www.amazon.sa/gp/bestsellers/electronics'));
  assert.ok(r.categoryLinks.includes('https://www.amazon.sa/gp/bestsellers/home'));
  assert.ok(r.categoryLinks.includes('https://www.amazon.sa/-/en/gp/new-releases/toys'));
  assert.ok(!r.categoryLinks.some(u => u.includes('evil.example.com') || u.includes('/s?')));
  assert.match(r.nextPage, /pg=2/);
});

test('كشف صفحة التحقق (CAPTCHA) دون محاولة تجاوزها', () => {
  assert.equal(parser.detectBlocked(fixtureDoc('captcha.html'), 'https://www.amazon.sa/dp/B0X').blocked, true);
  assert.equal(parser.detectBlocked(fixtureDoc('product_local_fba.html'), 'https://www.amazon.sa/dp/B0TEST0002').blocked, false);
  assert.equal(parser.detectBlocked(null, 'https://www.amazon.sa/ap/signin?x').blocked, true);
});

test('قائمة العروض: بائع وجهة شحن وسعر لكل عرض', () => {
  const o = parser.parseOffersDocument(fixtureDoc('offers_aod.html'));
  assert.equal(o.length, 2);
  assert.equal(o[0].shipsFrom, 'United States'); assert.equal(o[0].sellerId, 'A1TESTSELLER01'); assert.equal(o[0].price, 299);
  assert.equal(o[1].shipsFrom, 'Amazon'); assert.equal(o[1].sellerName, 'LocalShop KSA');
  assert.equal(classifier.classifyShipping(o[0].shippingFields).status, 'confirmed');
  assert.equal(classifier.classifyShipping(o[1].shippingFields).status, 'local');
});

test('parseCount: اختصارات K/ألف وتجاهل النصوص غير الرقمية', () => {
  assert.equal(parser.parseCount('1.2K'), 1200); assert.equal(parser.parseCount('(3,456)'), 3456);
  assert.equal(parser.parseCount('٢ ألف'), 2000); assert.equal(parser.parseCount('بلا أرقام'), null);
});

test('رسوم الاستيراد: يُؤخذ المبلغ المكتوب بعد «المقدرة» لا أول مبلغ ولا المجموع (نص حقيقي من Amazon.sa، B0HCQVV2L9)', () => {
  // النص منسوخ من فحص المستخدم الفعلي، وهو نص عام لا بيانات شخصية.
  const real = 'ريال164.05ريال164.05 رسوم الاستيراد مشمولة السلعة: 122.73 ريال رسوم الاستيراد المقدرة: 41.32 ريال المجموع: 164.05 ريال سنُحصِّل رسوم الاستيراد في وقت الشراء ونستخدمها لتغطية الضرائب والرسوم المطبقة على الاستيراد.';
  const r = parser.parseImportFees(real);
  assert.equal(r.amount, 41.32);
  assert.equal(r.amountKind, 'estimated');
  // الصيغة القديمة (المبلغ قبل التسمية) ما زالت تعمل
  assert.equal(parser.parseImportFees('Includes SAR 38.50 Import Fees Deposit.').amount, 38.5);
  // لا مبلغ → null لا رقم مخترع
  assert.equal(parser.parseImportFees('سنُحصِّل رسوم الاستيراد عند الشراء.').amount, null);
});
