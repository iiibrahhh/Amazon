const test = require('node:test');
const assert = require('node:assert/strict');
const { docFrom, newDb } = require('./helpers');
const parser = require('../extension/lib/parser.js');
const ingest = require('../extension/lib/ingest.js');
const { classifyShipping } = require('../extension/lib/classifier.js');

// كل الصفحات هنا اصطناعية (SYNTHETIC FIXTURE) تحاكي تنسيقات معروفة؛ لا تثبت سلوك Amazon.sa الحقيقي.
const NOW = new Date('2026-10-26T08:00:00Z');
const URL = 'https://www.amazon.sa/dp/B0EXTRACT1';
const parse = (body) => parser.parseProductDocument(docFrom('<html><body><span id="productTitle">x</span>' + body + '</body></html>'), URL, { now: NOW });
const LINK = (n) => '<a id="sellerProfileTriggerId" href="/sp?seller=A1TESTSELLER01">' + n + '</a>';
const tab = (ship, sold, shipL, soldL) => '<div id="tabular-buybox"><div tabular-attribute-name="' + shipL + '"><span>' + shipL + '</span><span>' + ship + '</span></div><div tabular-attribute-name="' + soldL + '"><span>' + soldL + '</span>' + sold + '</div></div>';
const feat = (id, l, v) => '<div id="' + id + '"><div class="offer-display-feature"><span class="offer-display-feature-label">' + l + '</span><span class="offer-display-feature-text">' + v + '</span></div></div>';
const check = (p, seller, shipper, type) => {
  assert.equal(p.offer.sellerName, seller); assert.equal(p.offer.shipperName, shipper); assert.equal(p.offer.shipperType, type);
};

// الحالة 1: Sold by Aoyiwo / Ships from Amazon → amazon
const AMAZON_CASES = {
  'tabular إنجليزي': tab('Amazon', LINK('Aoyiwo'), 'Ships from', 'Sold by'),
  'tabular عربي': tab('Amazon', LINK('Aoyiwo'), 'يشحن من', 'يباع بواسطة'),
  'tabular عربي «الشحن من قبل / يباع من»': tab('Amazon', LINK('Aoyiwo'), 'الشحن من قبل', 'يباع من'),
  'صفوف offer-display-feature': feat('fulfillerInfoFeature_feature_div', 'Ships from', 'Amazon') + feat('merchantInfoFeature_feature_div', 'Sold by', 'Aoyiwo'),
  'نص حر إنجليزي بلا رابط': '<div id="fulfillerInfoFeature_feature_div">Ships from Amazon</div><div id="merchantInfoFeature_feature_div">Sold by Aoyiwo</div>',
  'نص حر عربي بلا رابط': '<div id="fulfillerInfoFeature_feature_div">يشحن من Amazon</div><div id="merchantInfoFeature_feature_div">يباع بواسطة Aoyiwo</div>',
  'سطر واحد بنقطتين': '<div id="merchant-info">Sold by: Aoyiwo  Ships from: Amazon</div>',
  'سطر واحد عربي بنقطتين': '<div id="merchant-info">يباع بواسطة: Aoyiwo الشحن من: Amazon</div>',
  'Sold by X and Fulfilled by Amazon': '<div id="merchantInfoFeature_feature_div">Sold by Aoyiwo and Fulfilled by Amazon.</div>',
  'عربي: يباع بواسطة X ويتم الشحن بواسطة أمازون': '<div id="merchant-info">يباع بواسطة Aoyiwo ويتم الشحن بواسطة أمازون.</div>'
};
for (const [name, body] of Object.entries(AMAZON_CASES)) {
  test('البائع Aoyiwo والشاحن أمازون (نوع amazon) — ' + name, () => {
    const p = parse(body);
    assert.equal(p.offer.sellerName, 'Aoyiwo');
    assert.equal(p.offer.shipperType, 'amazon');
    assert.match(p.offer.shipperName, /^(?:Amazon|أمازون)$/);
  });
}

// الحالة 2: Sold by MahzuzStores / Ships from MahzuzStores → seller
const SELLER_CASES = {
  'tabular إنجليزي': tab('MahzuzStores', LINK('MahzuzStores'), 'Ships from', 'Sold by'),
  'عربي «الشحن من قبل / يباع من»': '<div id="fulfillerInfoFeature_feature_div"><span>الشحن من قبل</span> <span>MahzuzStores</span></div><div id="merchantInfoFeature_feature_div"><span>يباع من</span> ' + LINK('MahzuzStores') + '</div>',
  'Ships from and sold by': '<div id="merchant-info">Ships from and sold by MahzuzStores.</div>',
  'نص حر بنقطتين': '<div id="merchant-info">Sold by: MahzuzStores Ships from: MahzuzStores</div>',
  'صفوف offer-display-feature': feat('fulfillerInfoFeature_feature_div', 'Ships from', 'MahzuzStores') + feat('merchantInfoFeature_feature_div', 'Sold by', 'MahzuzStores')
};
for (const [name, body] of Object.entries(SELLER_CASES)) {
  test('البائع والشاحن MahzuzStores (نوع seller) — ' + name, () => {
    const p = parse(body);
    check(p, 'MahzuzStores', 'MahzuzStores', 'seller');
    assert.equal(parser.extractShippingFields(docFrom('<html><body>' + body + '</body></html>'), undefined, NOW).shipperIsSeller, true);
  });
}

// الحالات الناقصة: غير معلوم (null) بدل التخمين
test('البائع فقط: الشاحن ونوعه null', () => {
  const p = parse('<div id="merchantInfoFeature_feature_div"><span>Sold by</span> ' + LINK('Aoyiwo') + '</div>');
  check(p, 'Aoyiwo', null, null);
});
test('الشاحن فقط: البائع null', () => {
  const p = parse('<div id="fulfillerInfoFeature_feature_div"><span>Ships from</span> <span>Amazon</span></div>');
  check(p, null, 'Amazon', 'amazon');
});
test('لا شيء: الثلاثة null ولا دليل استخراج', () => {
  const p = parse('<div id="fulfillerInfoFeature_feature_div"></div>');
  check(p, null, null, null);
  assert.equal(p.offer.extraction.seller, null); assert.equal(p.offer.extraction.shipper, null); assert.equal(p.offer.extraction.shipperType, null);
});
test('«يشحن من الصين»: مكان وليس اسم شاحن ⇒ الشاحن ونوعه null، ولا يُستنتج شيء من اسم البائع', () => {
  const p = parse(tab('China', LINK('Aoyiwo'), 'Ships from', 'Sold by'));
  check(p, 'Aoyiwo', null, null);
  assert.equal(p.offer.shipsFrom, 'China');
  assert.match(p.offer.extraction.shipper.rejected, /مكان/);
});
test('تسمية بلا قيمة (Sold by فارغة / Ships from and) لا تلتقط التسمية التالية كقيمة', () => {
  const p = parse('<div id="merchant-info">Sold by Ships from Amazon</div>');
  check(p, null, 'Amazon', 'amazon');
});
test('اسم يحوي «KSA/Saudi/China» لا يغيّر شيئًا ولا يُنتج بلد شحن', () => {
  const p = parse(tab('Shopglobalstore - KSA', LINK('Shopglobalstore - KSA'), 'Ships from', 'Sold by'));
  check(p, 'Shopglobalstore - KSA', 'Shopglobalstore - KSA', 'seller');
  assert.notEqual(classifyShipping(p.shippingFields).status, 'local', 'اسم فيه KSA ليس دليل شحن محلي');
  assert.notEqual(classifyShipping(p.shippingFields).status, 'confirmed');
});

// دليل الاستخراج
test('دليل الاستخراج: الطريقة والتسمية والنص محفوظة لكل حقل', () => {
  const t = parse(tab('Amazon', LINK('Aoyiwo'), 'Ships from', 'Sold by')).offer.extraction;
  assert.equal(t.shipper.method, 'tabular-attribute-name'); assert.equal(t.shipper.value, 'Amazon'); assert.match(t.shipper.text, /Ships from/);
  assert.equal(t.seller.method, 'seller-link'); assert.equal(t.seller.selector, '#sellerProfileTriggerId'); assert.equal(t.seller.value, 'Aoyiwo');
  assert.deepEqual([t.shipperType.value, t.shipperType.basis], ['amazon', 'shipper-name']);
  const x = parse('<div id="merchant-info">يباع بواسطة Aoyiwo ويتم الشحن بواسطة أمازون.</div>').offer.extraction;
  assert.equal(x.seller.method, 'labeled-text'); assert.match(x.seller.text, /يباع بواسطة/); assert.equal(x.shipper.method, 'labeled-text');
});
test('نوع الشاحن من نص «Fulfilled by Amazon» بلا اسم شاحن يُسجَّل أساسه fulfillment-text', () => {
  const p = parse('<div id="merchant-info">Fulfilled by Amazon</div>');
  assert.equal(p.offer.shipperType, 'amazon');
});

// التخزين: الدليل يُحفظ، وما لم يثبت في الفحص الجديد لا يبقى قديمه
test('التخزين: extraction تُحفظ مع العرض، وإعادة الفحص بلا شاحن تمسح الشاحن القديم بدل الإبقاء عليه', async () => {
  const db = await newDb();
  const full = parse(tab('Amazon', LINK('Aoyiwo'), 'Ships from', 'Sold by'));
  const r1 = await ingest.ingestProduct(db, full, { now: '2026-10-26T10:00:00.000Z' });
  let o = await db.get('offers', r1.offer.offerKey);
  assert.equal(o.shipperName, 'Amazon'); assert.equal(o.shipperType, 'amazon'); assert.equal(o.extraction.seller.method, 'seller-link');
  const partial = parse('<div id="merchantInfoFeature_feature_div"><span>Sold by</span> ' + LINK('Aoyiwo') + '</div>');
  const r2 = await ingest.ingestProduct(db, partial, { now: '2026-10-27T10:00:00.000Z' });
  assert.equal(r2.offer.offerKey, r1.offer.offerKey);
  o = await db.get('offers', r1.offer.offerKey);
  assert.equal(o.sellerName, 'Aoyiwo'); assert.equal(o.shipperName, null); assert.equal(o.shipperType, null); assert.equal(o.extraction.shipper, null);
});
