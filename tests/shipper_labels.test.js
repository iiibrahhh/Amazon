const test = require('node:test');
const assert = require('node:assert/strict');
const { docFrom } = require('./helpers');
const parser = require('../extension/lib/parser.js');
const { classifyShipping } = require('../extension/lib/classifier.js');

// صفحات اصطناعية (SYNTHETIC) تحاكي تسميات أمازون العربية «الشحن من قبل / يباع من» التي أبقت الشاحن فارغًا.
const page = (body) => docFrom('<html><body><span id="productTitle">x</span>' + body + '</body></html>');
const parse = (body) => parser.parseProductDocument(page(body), 'https://www.amazon.sa/dp/B0LABEL001', { now: new Date('2026-10-26T08:00:00Z') });
const SELLER = (n) => '<a id="sellerProfileTriggerId" href="/sp?seller=A1TESTSELLER01">' + n + '</a>';

test('«الشحن من قبل Amazon / يباع من X» (نصي): الشاحن أمازون والبائع X والحكم محلي', () => {
  const p = parse('<div id="fulfillerInfoFeature_feature_div"><span>الشحن من قبل</span> <span>Amazon</span></div><div id="merchantInfoFeature_feature_div"><span>يباع من</span> ' + SELLER('Aoyiwo') + '</div>');
  assert.equal(p.offer.shipperName, 'Amazon'); assert.equal(p.offer.shipperType, 'amazon'); assert.equal(p.offer.sellerName, 'Aoyiwo');
  assert.equal(classifyShipping(p.shippingFields).status, 'local');
});

test('نفس التسميات بسمات tabular-attribute-name', () => {
  const p = parse('<div id="tabular-buybox"><div tabular-attribute-name="الشحن من قبل"><span>الشحن من قبل</span><span>Amazon</span></div><div tabular-attribute-name="يباع من"><span>يباع من</span>' + SELLER('Aoyiwo') + '</div></div>');
  assert.equal(p.offer.shipperName, 'Amazon'); assert.equal(p.offer.shipperType, 'amazon'); assert.equal(p.offer.sellerName, 'Aoyiwo');
});

test('«الشحن من قبل X» لجهة غير أمازون ⇒ نوع الشاحن «البائع» وليس بلدًا', () => {
  const p = parse('<div id="fulfillerInfoFeature_feature_div"><span>الشحن من قبل</span> <span>China Gadgets Hub</span></div><div id="merchantInfoFeature_feature_div"><span>يباع من</span> ' + SELLER('China Gadgets Hub') + '</div>');
  assert.equal(p.offer.shipperName, 'China Gadgets Hub'); assert.equal(p.offer.shipperType, 'seller');
  assert.equal(classifyShipping(p.shippingFields).status, 'unknown', 'اسم الجهة ليس دليل بلد');
});

test('التسميات الإنجليزية والعربية القديمة ما زالت تعمل', () => {
  const en = parse('<div id="fulfillerInfoFeature_feature_div"><span>Ships from</span> <span>Amazon</span></div><div id="merchantInfoFeature_feature_div"><span>Sold by</span> ' + SELLER('Anker') + '</div>');
  assert.equal(en.offer.shipperType, 'amazon'); assert.equal(en.offer.sellerName, 'Anker');
  const ar = parse('<div id="fulfillerInfoFeature_feature_div"><span>الشاحن</span> <span>Amazon.sa</span></div><div id="merchantInfoFeature_feature_div"><span>البائع</span> ' + SELLER('Anker') + '</div>');
  assert.equal(ar.offer.shipperType, 'amazon'); assert.equal(ar.offer.sellerName, 'Anker');
});

/* ---- نص حقيقي (ألصقه المستخدم) يتكرر بنمط «تسمية قيمة قيمة تسمية قيمة» ---- */
const DUP_FULFILLER = '<div id="fulfillerInfoFeature_feature_div"><span>الشحن من قبل</span> <span>Amazon</span> <span class="a-offscreen">Amazon</span> <span>الشحن من قبل</span> <span>Amazon</span></div>';
const DUP_MERCHANT = '<div id="merchantInfoFeature_feature_div"><span>يباع من</span> <span>The last one us UK</span> <span>The last one us UK</span> <span>يباع من</span> <span>The last one us UK</span></div>';

test('نص مكرر حقيقي (دوراسيل / The last one us UK): الشاحن أمازون والبائع باسم نظيف، والحكم محلي', () => {
  const p = parse(DUP_FULFILLER + DUP_MERCHANT);
  assert.equal(p.offer.shipperName, 'Amazon'); assert.equal(p.offer.shipperType, 'amazon');
  assert.equal(p.offer.sellerName, 'The last one us UK');
  assert.equal(p.shippingFields.shipperIsSeller, false);
  assert.equal(classifyShipping(p.shippingFields).status, 'local');
});

test('نص مكرر مع رابط البائع: يُعتمد نص الرابط النظيف، ويبقى اسم يحتوي كلمة Seller سليمًا', () => {
  const p = parse(DUP_FULFILLER + DUP_MERCHANT.replace('</div>', ' <a id="sellerProfileTriggerId" href="/sp?seller=A36X6M5HFFHXNP">The last one us UK</a></div>'));
  assert.equal(p.offer.sellerName, 'The last one us UK'); assert.equal(p.offer.sellerId, 'A36X6M5HFFHXNP');
  const q = parse('<div id="fulfillerInfoFeature_feature_div"><span>الشحن من قبل</span> <span>Amazon</span></div><div id="merchantInfoFeature_feature_div"><span>يباع من</span> <span>Best Seller Store</span></div>');
  assert.equal(q.offer.sellerName, 'Best Seller Store', 'لا نقطع عند كلمة Seller داخل اسم البائع');
});

test('الماركة: «قم بزيارة متجر Duracell» ← Duracell', () => {
  const p = parse('<a id="bylineInfo" href="#">قم بزيارة متجر Duracell</a>');
  assert.equal(p.brand, 'Duracell');
});
