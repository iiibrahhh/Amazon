/* أدوات التاجر: حالة المتابعة، حاسبة الربح التقديرية، وروابط البحث عن مصدر التوريد.
   الحاسبة تقدّر ولا تضمن: النسب الافتراضية (جمارك 5%، عمولة 15%، ضريبة 15%) افتراضات قابلة للتعديل من الإعدادات
   وتختلف بحسب فئة المنتج وبنده الجمركي؛ راجع رسوم Amazon.sa وجمارك المنتج الفعلية قبل أي شراء. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.ASF = root.ASF || {}; root.ASF.merchant = api; }
})(typeof self !== 'undefined' ? self : this, function () {

  const WATCH_STATUS = { candidate: 'مرشح', studying: 'قيد الدراسة', sourced: 'تم التوريد', rejected: 'مرفوض' };
  const PROFIT_DEFAULTS = { customsPct: 5, referralFeePct: 15, vatPct: 15, vatRecoverable: false };
  const num = (v) => (v === null || v === undefined || v === '' || isNaN(Number(v))) ? null : Number(v);
  const r2 = (x) => Math.round(x * 100) / 100;

  /** price = سعر البيع على Amazon.sa (شامل الضريبة)؛ cost/shipping/fulfillment/other بالريال للوحدة. */
  function calcProfit(inp, defaults) {
    const d = Object.assign({}, PROFIT_DEFAULTS, defaults || {});
    const price = num(inp.price), cost = num(inp.cost);
    const missing = [];
    if (price === null || price <= 0) missing.push('سعر البيع');
    if (cost === null || cost < 0) missing.push('تكلفة الشراء');
    if (missing.length) return { ok: false, missing };
    const shipping = num(inp.shipping) || 0, fulfillment = num(inp.fulfillment) || 0, other = num(inp.other) || 0;
    const customsPct = num(inp.customsPct) !== null ? num(inp.customsPct) : d.customsPct;
    const feePct = num(inp.referralFeePct) !== null ? num(inp.referralFeePct) : d.referralFeePct;
    const vat = d.vatPct / 100, recoverable = !!d.vatRecoverable;

    const landed = cost + shipping;
    const customs = landed * customsPct / 100;
    const importVat = (landed + customs) * vat;
    const inputVatCost = recoverable ? 0 : importVat;
    const outputVat = price - price / (1 + vat);       // ضريبة البيع المضمّنة في السعر
    const netPrice = price - outputVat;
    const referral = price * feePct / 100;             // افتراض: العمولة على السعر شاملًا الضريبة (تقدير متحفظ)
    const outlay = landed + customs + inputVatCost + fulfillment + other;   // ما يُدفع قبل البيع (بلا عمولة أمازون)
    const profit = netPrice - outlay - referral;
    const denom = 1 / (1 + vat) - feePct / 100;
    return {
      ok: true,
      lines: [
        ['سعر البيع (شامل الضريبة)', r2(price)], ['− ضريبة القيمة المضافة المضمّنة في السعر', -r2(outputVat)], ['= صافي السعر بلا ضريبة', r2(netPrice)],
        ['− تكلفة الشراء', -r2(cost)], ['− الشحن إلى المملكة', -r2(shipping)], ['− الجمارك (' + customsPct + '%)', -r2(customs)],
        ['− ضريبة الاستيراد' + (recoverable ? ' (مستردة: لا تُحتسب)' : ''), -r2(inputVatCost)],
        ['− عمولة Amazon (' + feePct + '%)', -r2(referral)], ['− رسوم التنفيذ/التخزين', -r2(fulfillment)], ['− أخرى', -r2(other)]
      ],
      profit: r2(profit),
      marginPct: netPrice > 0 ? r2(profit / netPrice * 100) : null,        // الهامش على صافي السعر
      roiPct: outlay > 0 ? r2(profit / outlay * 100) : null,               // العائد على المبلغ المدفوع قبل البيع
      breakEvenPrice: denom > 0 ? r2(outlay / denom) : null,               // أدنى سعر بيع (شامل الضريبة) للتعادل
      assumptions: { customsPct, referralFeePct: feePct, vatPct: d.vatPct, vatRecoverable: recoverable }
    };
  }

  /** عبارة بحث عن المصدر: رقم الموديل أولًا، وإلا كلمات العنوان اللاتينية، وإلا بداية العنوان. */
  function sourcingQuery(prod) {
    prod = prod || {};
    const model = String(prod.modelNumber || '').trim();
    const brand = String(prod.brand || '').trim();
    if (model && model.length >= 3) return (brand && !/[؀-ۿ]/.test(brand) ? brand + ' ' : '') + model;
    const title = String(prod.title || '').replace(/[()\[\]{}|,;:،؛"'«»]/g, ' ').replace(/\s+/g, ' ').trim();
    const latin = title.split(' ').filter(w => /[A-Za-z0-9]/.test(w) && !/[؀-ۿ]/.test(w));
    if (latin.length >= 2) return latin.slice(0, 8).join(' ');
    return title.split(' ').slice(0, 8).join(' ');
  }
  function sourcingLinks(prod) {
    const q = sourcingQuery(prod); if (!q) return [];
    const e = encodeURIComponent(q);
    return [
      { name: 'AliExpress', url: 'https://www.aliexpress.com/wholesale?SearchText=' + e },
      { name: 'Alibaba', url: 'https://www.alibaba.com/trade/search?SearchText=' + e },
      { name: 'Google', url: 'https://www.google.com/search?q=' + encodeURIComponent(q + ' wholesale supplier') }
    ];
  }

  /** تنقية بيانات التاجر القادمة من النموذج. يعيد null إن كانت فارغة تمامًا. */
  function cleanMerchantData(m) {
    m = m || {};
    const out = {};
    if (m.status && WATCH_STATUS[m.status]) out.status = m.status;
    const note = String(m.note || '').trim().slice(0, 500); if (note) out.note = note;
    ['cost', 'shipping', 'fulfillment', 'other', 'customsPct', 'referralFeePct'].forEach(k => { const v = num(m[k]); if (v !== null && v >= 0) out[k] = v; });
    return Object.keys(out).length ? out : null;
  }

  return { WATCH_STATUS, PROFIT_DEFAULTS, calcProfit, sourcingQuery, sourcingLinks, cleanMerchantData };
});
