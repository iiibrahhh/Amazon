const test = require('node:test');
const assert = require('node:assert/strict');
const { docFrom, newDb } = require('./helpers');
const parser = require('../extension/lib/parser.js');
const { classifyShipping } = require('../extension/lib/classifier.js');
const ingest = require('../extension/lib/ingest.js');
const rules = require('../extension/lib/rules.js');

// مصغّر اصطناعي (SYNTHETIC) أُعيد بناؤه من بنية صفحة منتج متوفر حقيقية من Amazon.sa وُصفت للمشروع (بائع يشحن من خارج المملكة).
// ليس نسخة منها: أسماء وعناوين مُنقّاة، وهو يوثّق البنية التي رُصدت فقط ولا يثبت سلوك بقية الصفحات.
const REAL_LIKE = '<html><body><span id="productTitle">Headset</span>' +
  '<div id="corePrice_feature_div"><span class="a-price"><span class="a-offscreen">ريال3,766.16</span></span></div>' +
  '<div id="availability"><span class="a-color-success">تبقى 1 فقط - اطلبه الآن.</span></div>' +
  '<div id="availabilityInsideBuyBox_feature_div"><span>تبقى 1 فقط - اطلبه الآن.</span> <span>يشحن المنتج من خارج المملكة العربية السعودية. اعرف المزيد</span><style>.availabilityMoreDetailsIcon { width: 12px; }</style></div>' +
  '<div id="mir-layout-DELIVERY_BLOCK"><span>توصيل بـ‏49ريال <b>نوفمبر 19 - 23</b>. التفاصيل</span></div>' +
  '<div id="fulfillerInfoFeature_feature_div"></div>' +
  '<div id="merchantInfoFeature_feature_div"><span>يتم شحنها وبيعها بواسطة <a id="sellerProfileTriggerId" href="/gp/help/seller/at-a-glance.html/ref=dp_merchant_link?ie=UTF8&seller=A3TESTSELLER01&asin=B0REALLIKE&ref_=dp_merchant_link">Test Trading LLC</a></span>' +
  '<span>يتم شحنها وبيعها بواسطة Test Trading LLC</span><span>الشاحن / البائع Test Trading LLC</span></div></body></html>';
const NOW = new Date('2026-11-05T08:00:00Z');
const parse = () => parser.parseProductDocument(docFrom(REAL_LIKE), 'https://www.amazon.sa/dp/B0REALLIKE', { now: NOW });

test('بنية حقيقية: بائع ينسخ «الشاحن / البائع» ثلاث مرات ⇒ اسم واحد نظيف ونوع seller', () => {
  const p = parse();
  assert.equal(p.offer.sellerName, 'Test Trading LLC'); assert.equal(p.offer.shipperName, 'Test Trading LLC'); assert.equal(p.offer.shipperType, 'seller');
  assert.equal(p.offer.sellerId, 'A3TESTSELLER01');
});
test('بنية حقيقية: نص صندوق التوفر «يشحن المنتج من خارج المملكة العربية السعودية» ⇒ مؤكد بدليل نصي صريح', () => {
  const c = classifyShipping(parse().shippingFields);
  assert.equal(c.status, 'confirmed');
  const e = c.evidence.find(x => x.signal === 'ships_from_abroad_ar');
  assert.ok(e); assert.equal(e.strength, 'confirmed'); assert.match(e.text, /خارج المملكة/);
  assert.equal(c.originCountry, null, 'البلد غير مذكور فلا يُخمَّن');
});
test('بنية حقيقية: التوفر «تبقى 1 فقط» متوفر، وتكلفة «توصيل بـ49 ريال» تُقرأ، ورابط صفحة البائع من الصفحة نفسها', () => {
  const p = parse();
  assert.equal(p.offer.availability, 'in_stock'); assert.equal(p.offer.price, 3766.16);
  assert.equal(p.offer.shippingCost, 49);
  assert.equal(p.offer.sellerPageUrl, '/gp/help/seller/at-a-glance.html?seller=A3TESTSELLER01');
  assert.ok(!/availabilityMoreDetailsIcon|width: 12px/.test(p.shippingFields.availabilityBlockText), 'لا CSS في النص');
});
test('النص الإنجليزي المكافئ: «ships the item from outside Saudi Arabia» ⇒ مؤكد', () => {
  const html = '<html><body><span id="productTitle">x</span><div id="availabilityInsideBuyBox_feature_div">In stock. This product ships from outside the Kingdom of Saudi Arabia.</div></body></html>';
  assert.equal(classifyShipping(parser.parseProductDocument(docFrom(html), 'https://www.amazon.sa/dp/B0REALLIKE', { now: NOW }).shippingFields).status, 'confirmed');
  const html2 = '<html><body><span id="productTitle">x</span><div id="availabilityInsideBuyBox_feature_div">The item ships from outside Saudi Arabia.</div></body></html>';
  assert.equal(classifyShipping(parser.parseProductDocument(docFrom(html2), 'https://www.amazon.sa/dp/B0REALLIKE', { now: NOW }).shippingFields).status, 'confirmed');
});
test('«يشحن من داخل المملكة» أو أمازون لا يصبحان مؤكدًا بسبب الصياغة الأوسع', () => {
  const html = '<html><body><span id="productTitle">x</span><div id="availabilityInsideBuyBox_feature_div">متوفر. يشحن المنتج من الرياض.</div></body></html>';
  assert.notEqual(classifyShipping(parser.parseProductDocument(docFrom(html), 'https://www.amazon.sa/dp/B0REALLIKE', { now: NOW }).shippingFields).status, 'confirmed');
});
test('التخزين: sellerPageUrl يُحفظ كجزء من العرض المحلل ولا يكسر الدمج', async () => {
  const db = await newDb();
  const r = await ingest.ingestProduct(db, parse(), { now: '2026-11-05T10:00:00.000Z', settings: rules.DEFAULT_SETTINGS });
  assert.equal(r.classification.status, 'confirmed');
  const o = await db.get('offers', r.offer.offerKey);
  assert.equal(o.shipperType, 'seller'); assert.equal(o.shippingStatus, 'confirmed'); assert.equal(o.shippingCost, 49);
});
