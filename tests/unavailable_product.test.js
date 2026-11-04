const test = require('node:test');
const assert = require('node:assert/strict');
const { docFrom } = require('./helpers');
const parser = require('../extension/lib/parser.js');
const { classifyShipping } = require('../extension/lib/classifier.js');

// مصغّر اصطناعي (SYNTHETIC) على نمط صفحة Amazon.sa حقيقية لمنتج «غير متوفر حالياً» وُصفت للمشروع:
// حاوية #outOfStock فيها سكربت AOD ثم النص العربي. ليس نسخة من الصفحة الحقيقية ولا يثبت سلوك بقية الصفحات.
const PAGE = '<html><body><span id="productTitle">PS5 Game</span><div id="outOfStock" class="a-box"><div><script>P.when("A", "load").execute("aod-assets-loaded", function(A){ var m = "Failed to load AOD assets"; });</script>' +
  '<style>.x{color:red}</style><span class="a-color-price a-text-bold">غير متوفر حالياً.</span><br/>لا نعرف متى أو فيما إذا كان هذا المنتج سيتوفر مرة أخرى</div></div></body></html>';

test('منتج غير متوفر: نص التوفر بلا كود سكربت، والتوفر out_of_stock', () => {
  const p = parser.parseProductDocument(docFrom(PAGE), 'https://www.amazon.sa/dp/B0UNAVAIL1', { now: new Date('2026-10-26T08:00:00Z') });
  assert.equal(p.offer.availability, 'out_of_stock');
  assert.match(p.offer.availabilityText, /^غير متوفر حالياً\./);
  assert.ok(!/aod|P\.when|function|color:red/i.test(p.offer.availabilityText), 'لا يدخل كود JS/CSS في النص');
});
test('منتج غير متوفر: لا بائع ولا شاحن ولا نوع (غير معلوم، لا تخمين)', () => {
  const p = parser.parseProductDocument(docFrom(PAGE), 'https://www.amazon.sa/dp/B0UNAVAIL1', { now: new Date('2026-10-26T08:00:00Z') });
  assert.equal(p.offer.sellerName, null); assert.equal(p.offer.shipperName, null); assert.equal(p.offer.shipperType, null);
  assert.equal(classifyShipping(p.shippingFields).status, 'unknown');
});
test('معرّفات الحاويات الحقيقية الإضافية (merchantInfo_feature_div / fulfillerInfo_feature_div) تُقرأ', () => {
  const html = '<html><body><span id="productTitle">x</span><div id="fulfillerInfo_feature_div"><span>Ships from</span> <span>Amazon</span></div><div id="merchantInfo_feature_div"><span>Sold by</span> <a href="/sp?seller=A1REALIDSELLER">Aoyiwo</a></div></body></html>';
  const p = parser.parseProductDocument(docFrom(html), 'https://www.amazon.sa/dp/B0UNAVAIL2', { now: new Date() });
  assert.equal(p.offer.sellerName, 'Aoyiwo'); assert.equal(p.offer.shipperName, 'Amazon'); assert.equal(p.offer.shipperType, 'amazon');
});
