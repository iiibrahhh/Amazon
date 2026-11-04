/* درجة الفرصة (0–100): مؤشر إرشادي مركّب لترتيب المنتجات، وليس توقعًا للمبيعات ولا للأرباح.
   الأوزان اجتهادية (غير معايرة على مبيعات فعلية)، وكل مكوّن يُعرض بسببه في لوحة التفاصيل.
   مكوّن غير متوفر البيانات يأخذ 0 ويُذكر في «ناقص» بدل أن يُخمَّن. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.ASF = root.ASF || {}; root.ASF.opportunity = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  const MAX = { shipping: 30, demand: 20, proof: 15, competition: 20, price: 15 };
  const num = (v) => (v === null || v === undefined || v === '' || isNaN(Number(v))) ? null : Number(v);

  /** in: { status, bsrRank, rating, reviewCount, price, siblings:[{shipperType,status}] , siblingsKnown } */
  function score(inp) {
    const parts = [], missing = [];
    const add = (k, label, pts, why) => parts.push({ k, label, pts, max: MAX[k], why });
    // 1) الشحن الدولي: وجود الفرصة أصلًا (منتج يُشحن من الخارج ⇒ مجال لتوفيره محليًا)
    const st = inp.status || 'unknown';
    add('shipping', 'الشحن الدولي', st === 'confirmed' ? 30 : st === 'likely' ? 22 : 0,
      st === 'confirmed' ? 'شحن دولي مؤكد' : st === 'likely' ? 'شحن دولي مرجح' : st === 'local' ? 'الشحن محلي: لا فجوة' : 'غير معلوم: لا نقاط');
    // 2) الطلب: ترتيب BSR (الأقل أفضل)
    const bsr = num(inp.bsrRank);
    if (bsr === null || bsr <= 0) { missing.push('ترتيب المبيعات (BSR)'); add('demand', 'الطلب (BSR)', 0, 'غير متوفر'); }
    else add('demand', 'الطلب (BSR)', bsr <= 100 ? 20 : bsr <= 1000 ? 16 : bsr <= 5000 ? 12 : bsr <= 20000 ? 8 : bsr <= 100000 ? 4 : 1, 'الترتيب ' + bsr);
    // 3) الإثبات الاجتماعي: عدد المراجعات + التقييم
    const rc = num(inp.reviewCount), rt = num(inp.rating);
    if (rc === null && rt === null) { missing.push('التقييم والمراجعات'); add('proof', 'التقييم والمراجعات', 0, 'غير متوفر'); }
    else {
      const a = rc === null ? 0 : rc >= 500 ? 10 : rc >= 100 ? 8 : rc >= 20 ? 5 : rc >= 1 ? 2 : 0;
      const b = rt === null ? 0 : rt >= 4.3 ? 5 : rt >= 4.0 ? 3 : rt >= 3.8 ? 1 : 0;
      add('proof', 'التقييم والمراجعات', a + b, (rc === null ? 'مراجعات؟' : rc + ' مراجعة') + ' · ' + (rt === null ? 'تقييم؟' : rt));
    }
    // 4) المنافسة المحلية: هل تبيعه أمازون أو بائع محلي؟
    const sib = inp.siblings || [];
    if (sib.some(s => s.shipperType === 'amazon')) add('competition', 'المنافسة', 0, 'أمازون تشحنه (عرض محلي موجود)');
    else if (sib.some(s => s.status === 'local')) add('competition', 'المنافسة', 8, 'يوجد عرض محلي من بائع');
    else if (sib.length >= 2 || inp.siblingsKnown) add('competition', 'المنافسة', 20, 'لا عرض من أمازون ولا عرض محلي ظاهر');
    else { missing.push('العروض الأخرى'); add('competition', 'المنافسة', 10, 'عرض واحد فقط مفحوص؛ العروض الأخرى لم تُفحص (نصف النقاط)'); }
    // 5) نطاق السعر: هامش معقول لتحمل الشحن والرسوم
    const pr = num(inp.price);
    if (pr === null) { missing.push('السعر'); add('price', 'نطاق السعر', 0, 'غير متوفر'); }
    else add('price', 'نطاق السعر', pr >= 50 && pr <= 1500 ? 15 : pr > 1500 ? 8 : pr >= 20 ? 8 : 3, pr + ' ريال');
    const total = parts.reduce((a, p) => a + p.pts, 0);
    return { score: total, parts, missing };
  }
  return { score, MAX };
});
