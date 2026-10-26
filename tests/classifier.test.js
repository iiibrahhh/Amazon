const test = require('node:test');
const assert = require('node:assert/strict');
const { fixtureDoc } = require('./helpers');
const parser = require('../extension/lib/parser.js');
const { classifyShipping } = require('../extension/lib/classifier.js');

const parse = (f, asin) => parser.parseProductDocument(fixtureDoc(f), 'https://www.amazon.sa/dp/' + asin);

test('«مؤكد»: حقل يشحن من = دولة أجنبية، مع حفظ الدليل والمصدر وتاريخ التحقق', () => {
  const p = parse('product_intl_confirmed.html', 'B0TEST0001');
  const c = classifyShipping(p.shippingFields, { url: p.url, now: '2026-10-22T00:00:00.000Z' });
  assert.equal(c.status, 'confirmed');
  assert.equal(c.originCountry, 'US');
  const e = c.evidence.find(x => x.strength === 'confirmed');
  assert.equal(e.text, 'United States');
  assert.equal(e.field, 'shipsFrom');
  assert.equal(e.source, 'amazon.sa:product-page');
  assert.equal(e.checkedAt, '2026-10-22T00:00:00.000Z');
  assert.ok(c.evidence.some(x => x.signal.startsWith('import_fees')), 'رسوم الاستيراد قرينة إضافية');
});

test('«مؤكد»: نص عربي صريح «يشحن من الخارج» / «الشحن من الصين»', () => {
  assert.equal(classifyShipping({ fulfillerText: 'يشحن من الخارج ويباع بواسطة متجر' }).status, 'confirmed');
  const c = classifyShipping({ fulfillerText: 'الشحن من الصين ويباع بواسطة متجر' });
  assert.equal(c.status, 'confirmed'); assert.equal(c.originCountry, 'CN');
  const e = classifyShipping({ deliveryText: 'Ships from abroad. Delivery 12 November' });
  assert.equal(e.status, 'confirmed'); assert.equal(e.originCountry, null); assert.ok(e.originNote);
});

test('«مرجح»: شارة Amazon Global + رسوم استيراد بلا ذكر بلد الشحن', () => {
  const p = parse('product_amazon_global_likely.html', 'B0TEST0006');
  const c = classifyShipping(p.shippingFields);
  assert.equal(c.status, 'likely');
  assert.equal(c.originCountry, null);
  assert.ok(c.evidence.every(e => e.strength === 'likely'));
});

test('خيار importFeesAsConfirmed يرفع رسوم الاستيراد إلى «مؤكد» فقط عند تفعيله', () => {
  const f = { importFeesText: 'Import Fees Deposit SAR 25.00 included' };
  assert.equal(classifyShipping(f).status, 'likely');
  assert.equal(classifyShipping(f, { importFeesAsConfirmed: true }).status, 'confirmed');
});

test('البائع الأجنبي وحده ليس دليلًا (اسم/بلد البائع)', () => {
  const p = parse('product_foreign_seller_no_ship_info.html', 'B0TEST0003');
  assert.match(p.offer.sellerName, /China/);
  const c = classifyShipping(p.shippingFields);
  assert.equal(c.status, 'unknown');
  assert.equal(classifyShipping({ soldBy: 'Shenzhen Trading Co., Ltd (China)' }).status, 'unknown');
  assert.equal(classifyShipping({ soldBy: 'متجر الصين للإلكترونيات' }).status, 'unknown');
});

test('مدة/موعد التوصيل الطويل وحده ليس دليلًا', () => {
  for (const t of ['Delivery in 45 days', 'FREE delivery 30 December - 15 January', 'التوصيل خلال ٣٥ يومًا — ٢٠ ديسمبر', 'Arrives in 6 weeks'])
    assert.equal(classifyShipping({ deliveryText: t }).status, 'unknown', t);
});

test('اسم جهة تبدأ باسم دولة في حقل «يشحن من» لا يُعد دولة', () => {
  const c = classifyShipping({ shipsFrom: 'United States Trading Co Ltd' });
  assert.equal(c.status, 'unknown');
  assert.ok(c.notes.some(n => n.includes('اسم جهة')));
  assert.equal(classifyShipping({ shipsFrom: 'Sunrise Electronics' }).status, 'unknown');
});

test('«محلي»: التنفيذ بواسطة أمازون حتى مع بائع باسم أجنبي', () => {
  const p = parse('product_local_fba.html', 'B0TEST0002');
  const c = classifyShipping(p.shippingFields);
  assert.equal(c.status, 'local');
  assert.equal(classifyShipping({ shipsFrom: 'Ships from Saudi Arabia' }).status, 'local');
  assert.equal(classifyShipping({ fulfillerText: 'يشحن من الرياض' }).status, 'local');
  assert.equal(classifyShipping({ fulfillerText: 'تنفيذ أمازون' }).status, 'local');
});

test('تعارض الأدلة يخفّض التصنيف ولا يخفيه', () => {
  const a = classifyShipping({ shipsFrom: 'China', fulfillerText: 'Fulfilled by Amazon' });
  assert.equal(a.status, 'likely'); assert.ok(a.notes.some(n => n.includes('تعارض')));
  const b = classifyShipping({ badges: ['Amazon Global'], fulfillerText: 'Fulfilled by Amazon' });
  assert.equal(b.status, 'unknown');
});

test('حقول فارغة/غائبة → غير معلوم بلا أخطاء', () => {
  assert.equal(classifyShipping({}).status, 'unknown');
  assert.equal(classifyShipping(null).status, 'unknown');
  assert.equal(classifyShipping(undefined).evidence.length, 0);
});

test('Amazon.com / Amazon Global في حقل «يشحن من» = مرجح لا مؤكد', () => {
  assert.equal(classifyShipping({ shipsFrom: 'Amazon Global' }).status, 'likely');
  assert.equal(classifyShipping({ shipsFrom: 'Amazon.com' }).status, 'likely');
});
