const test = require('node:test');
const assert = require('node:assert/strict');
const calibration = require('../extension/lib/calibration.js');
const opportunity = require('../extension/lib/opportunity.js');
const exporter = require('../extension/lib/export.js');

// بيانات اصطناعية (SYNTHETIC): تختبر الحساب فقط، وليست قياسًا حقيقيًا لدقة التصنيف على Amazon.sa.
const off = (i, truth, o) => Object.assign({ offerKey: 'A' + i + '|S', asin: 'A' + i, sellerName: 'S' + i, userStatus: truth, shipperType: 'seller', shippingStatus: 'unknown',
  handlingMinDays: 1, handlingMaxDays: 2, deliveryMinDays: 3, deliveryMaxDays: 5 }, o || {});

test('معايرة: بلا أمثلة مصنّفة ⇒ صفر، بلا توصية', () => {
  const r = calibration.evaluate([{ offerKey: 'x', asin: 'x', shippingStatus: 'likely' }], [], {});
  assert.equal(r.labeled, 0); assert.equal(r.recommendation, null); assert.ok(r.warnings.length === 0 || r.warnings.every(w => typeof w === 'string'));
});
test('معايرة: مصفوفة الالتباس والدقة/الاسترجاع/التغطية تُحسب بدقة', () => {
  const offers = [
    off(1, 'confirmed', { shippingStatus: 'likely' }),    // tp
    off(2, 'likely', { shippingStatus: 'unknown' }),      // دولي فاته الآلي (غير معلوم)
    off(3, 'confirmed', { shippingStatus: 'local' }),     // دولي صُنّف محليًا
    off(4, 'local', { shippingStatus: 'likely' }),        // fp
    off(5, 'local', { shippingStatus: 'local' }),         // tn
    off(6, 'local', { shippingStatus: 'unknown' }),       // غير دولي لم نعلّمه دوليًا
    off(7, 'unknown', { shippingStatus: 'likely' })       // «غير معلوم» يدويًا: يُستبعد
  ];
  const r = calibration.evaluate(offers, [], {});
  assert.equal(r.labeled, 6);
  const a = r.auto;
  assert.deepEqual([a.tp, a.fn_unknown, a.fn_local, a.fp, a.tn, a.tn_unknown], [1, 1, 1, 1, 1, 1]);
  assert.equal(a.precision, 0.5); assert.equal(a.recall, 1 / 3); assert.equal(a.coverage, 4 / 6);
  assert.equal(r.mismatches.length, 3);   // 2 و3 دوليان لم يُعلَّما دوليًا، و4 إيجابي كاذب؛ (1 و5 و6 صحيحة)
});
test('معايرة: عينة < 10 ⇒ تحذير وبلا توصية عتبات', () => {
  const r = calibration.evaluate([off(1, 'confirmed'), off(2, 'local')], [], {});
  assert.equal(r.recommendation, null); assert.ok(r.warnings.some(w => /صغيرة/.test(w)));
});
test('معايرة: تقترح عتبات أفضل حين تفصل العينة بوضوح، وتبقي الحالية حين لا تحسّن', () => {
  // دولي: تجهيز 8–9 أيام (حتى مع عتبة 5 يلتقطها)، غير دولي: تجهيز 1–2
  const intl = [1, 2, 3, 4, 5, 6].map(i => off(i, 'confirmed', { handlingMinDays: 8, handlingMaxDays: 9, deliveryMinDays: 9, deliveryMaxDays: 11, shippingStatus: 'likely' }));
  const loc = [7, 8, 9, 10, 11, 12].map(i => off(i, 'local', { shippingStatus: 'unknown' }));
  const r = calibration.evaluate(intl.concat(loc), [], { intlMinHandlingDays: 5, intlMinDeliveryDays: 14, intlMinTransitDays: 4 });
  assert.ok(r.recommendation); assert.equal(r.recommendation.currentAccuracy, 1); assert.equal(r.recommendation.keepCurrent, true);
});
test('معايرة: عتبات الحالية تُخطئ فتُقترح عتبات أدنى', () => {
  // دولي بتجهيز 3–4 وتوصيل 5–6 (فارق 1): العتبات الحالية (5/14/4) لا تلتقطه؛ التجهيز ≥ 3 يلتقطه ويفصله عن المحلي (تجهيز 1–2)
  const intl = [1, 2, 3, 4, 5, 6].map(i => off(i, 'confirmed', { handlingMinDays: 3, handlingMaxDays: 4, deliveryMinDays: 5, deliveryMaxDays: 6 }));
  const loc = [7, 8, 9, 10, 11, 12].map(i => off(i, 'local', { handlingMinDays: 1, handlingMaxDays: 2, deliveryMinDays: 3, deliveryMaxDays: 4 }));
  const r = calibration.evaluate(intl.concat(loc), [], {});
  assert.ok(r.recommendation); assert.ok(r.recommendation.currentAccuracy < 1); assert.equal(r.recommendation.best.acc, 1); assert.equal(r.recommendation.best.th.h, 3);
  assert.ok(r.recommendation.improvement >= 0.05); assert.ok(!r.recommendation.keepCurrent);
});
test('معايرة: فئة واحدة فقط في العينة ⇒ تحذير بنقص الفئة وبلا توصية', () => {
  const r = calibration.evaluate(Array.from({ length: 12 }, (_, i) => off(i + 1, 'confirmed')), [], {});
  assert.equal(r.recommendation, null); assert.ok(r.warnings.some(w => /تنقص فئة/.test(w)));
});

// ---- درجة الفرصة ----
test('الفرصة: الدرجة = مجموع المكوّنات (≤ 100) والسبب لكل مكوّن، والناقص يُذكر بدل أن يُخمَّن', () => {
  const full = opportunity.score({ status: 'confirmed', bsrRank: 50, rating: 4.5, reviewCount: 600, price: 300, siblings: [], siblingsKnown: true });
  assert.equal(full.score, 100); assert.equal(full.missing.length, 0);
  assert.equal(full.parts.reduce((a, p) => a + p.pts, 0), full.score);
  const bare = opportunity.score({ status: 'unknown' });
  assert.deepEqual(bare.missing, ['ترتيب المبيعات (BSR)', 'التقييم والمراجعات', 'العروض الأخرى', 'السعر']);
  assert.equal(bare.score, 10, 'المنافسة وحدها (نصف النقاط مع عرض واحد مفحوص)');
});
test('الفرصة: أمازون تشحن نفس المنتج ⇒ صفر للمنافسة؛ عرض محلي ⇒ 8؛ محلي كحالة ⇒ لا نقاط شحن', () => {
  const base = { status: 'likely', bsrRank: 500, rating: 4.4, reviewCount: 120, price: 100 };
  const comp = (sib) => opportunity.score(Object.assign({}, base, { siblings: sib })).parts.find(p => p.k === 'competition').pts;
  assert.equal(comp([{ shipperType: 'amazon', status: 'local' }]), 0);
  assert.equal(comp([{ shipperType: 'seller', status: 'local' }]), 8);
  assert.equal(comp([{ shipperType: 'seller', status: 'likely' }, { shipperType: 'seller', status: 'unknown' }]), 20);
  assert.equal(opportunity.score({ status: 'local' }).parts[0].pts, 0);
  assert.ok(opportunity.score(Object.assign({}, base, { status: 'confirmed' })).score > opportunity.score(base).score);
});
test('الفرصة: في الصفوف المصدّرة — تُحسب للصف المفحوص فقط وتدخل الأعمدة', () => {
  const products = [{ asin: 'B0OPPTEST1', title: 't', detailScanned: true, bsrRank: 100, rating: 4.5, reviewCount: 300, url: 'u' }, { asin: 'B0OPPTEST2', title: 'u', detailScanned: false, url: 'u2' }];
  const offers = [{ offerKey: 'B0OPPTEST1|S', asin: 'B0OPPTEST1', sellerName: 'S', price: 200, shipperType: 'seller', shippingStatus: 'likely', sellerProfile: { code: 'CN', addressText: 'Shenzhen, CN' } }];
  const rows = exporter.buildRows(products, offers, []);
  const a = rows.find(r => r.asin === 'B0OPPTEST1'), b = rows.find(r => r.asin === 'B0OPPTEST2');
  assert.equal(typeof a.opportunityScore, 'number'); assert.equal(b.opportunityScore, null);
  assert.equal(a.sellerCountryCode, 'CN'); assert.equal(a.sellerAddressText, 'Shenzhen, CN');
  const csv = exporter.toCSV(rows);
  assert.match(csv, /درجة الفرصة/); assert.match(csv, /بلد عنوان البائع/);
});
