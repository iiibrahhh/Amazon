/* معايرة التصنيف الآلي على تصنيفاتك اليدوية («تحقق يدوي»): مصفوفة الالتباس، والدقة/الاسترجاع، وبحث في العتبات.
   الحقيقة المرجعية = تصنيفك اليدوي (مؤكد/مرجح ⇒ دولي، محلي ⇒ غير دولي؛ «غير معلوم» يُستبعد).
   لا تُوصي بعتبات إن قلّت العينة (< MIN_N) أو غابت فئة؛ والتوصية تخص قاعدة «الشاحن = البائع + مدد» فقط. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.ASF = root.ASF || {}; root.ASF.calibration = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  const MIN_N = 10;
  const isIntl = (s) => s === 'confirmed' || s === 'likely';
  const truthOf = (o) => (o.userStatus === 'confirmed' || o.userStatus === 'likely') ? 'intl' : o.userStatus === 'local' ? 'local' : null;
  const predOf = (s) => isIntl(s) ? 'intl' : s === 'local' ? 'local' : 'unknown';
  const hasDur = (o) => (o.handlingMinDays !== null && o.handlingMinDays !== undefined) || (o.deliveryMinDays !== null && o.deliveryMinDays !== undefined);

  function summarize(rows) {   // rows: [{truth, pred}]
    const c = { tp: 0, fn_unknown: 0, fn_local: 0, tn: 0, fp: 0, tn_unknown: 0 };
    rows.forEach(r => {
      if (r.truth === 'intl') { if (r.pred === 'intl') c.tp++; else if (r.pred === 'local') c.fn_local++; else c.fn_unknown++; }
      else { if (r.pred === 'intl') c.fp++; else if (r.pred === 'local') c.tn++; else c.tn_unknown++; }
    });
    const n = rows.length, intl = c.tp + c.fn_local + c.fn_unknown, loc = c.fp + c.tn + c.tn_unknown;
    const decided = c.tp + c.fp + c.tn + c.fn_local;
    return Object.assign(c, {
      n, intl, local: loc,
      precision: c.tp + c.fp ? c.tp / (c.tp + c.fp) : null,          // من الذي قلنا عنه «دولي»، كم فعلًا دولي
      recall: intl ? c.tp / intl : null,                              // من الدولي الفعلي، كم التقطنا
      coverage: n ? decided / n : null,                               // نسبة ما أعطيناه حكمًا (غير «غير معلوم»)
      accuracy: n ? (c.tp + c.tn + c.tn_unknown) / n : null           // «غير معلوم» لغير الدولي يُحسب صحيحًا (لم نُعلّمه دوليًا)
    });
  }

  /** يعيد تقدير الحكم تحت عتبات بديلة من حقول العرض المخزّنة والأدلة غير المركّبة. */
  function predictWith(o, evidence, th) {
    const base = (evidence || []).filter(e => e.field !== 'combined');
    if (base.some(e => e.strength === 'confirmed')) return 'intl';
    if (base.some(e => e.strength === 'local')) return base.some(e => e.strength === 'likely') ? 'unknown' : 'local';
    if (base.some(e => e.strength === 'likely')) return 'intl';
    if (o.shipperType !== 'seller') return 'unknown';
    const hMin = o.handlingMinDays, hMax = o.handlingMaxDays, dMin = o.deliveryMinDays;
    const longH = hMin !== null && hMin !== undefined && hMin >= th.h;
    const longD = dMin !== null && dMin !== undefined && dMin >= th.d;
    const tr = (dMin !== null && dMin !== undefined && hMax !== null && hMax !== undefined) ? dMin - hMax : null;
    return (longH || longD || (tr !== null && tr >= th.t)) ? 'intl' : 'unknown';
  }

  /** offers: سجلات العروض (فيها userStatus)، evidence: كل سجلات الأدلة، settings: العتبات الحالية */
  function evaluate(offers, evidence, settings) {
    settings = settings || {};
    const evBy = new Map(); (evidence || []).forEach(e => { if (!evBy.has(e.offerKey)) evBy.set(e.offerKey, []); evBy.get(e.offerKey).push(e); });
    const labeled = offers.map(o => ({ o, truth: truthOf(o) })).filter(x => x.truth);
    const current = { h: Number(settings.intlMinHandlingDays) || 5, d: Number(settings.intlMinDeliveryDays) || 14, t: Number(settings.intlMinTransitDays) || 4 };
    const auto = summarize(labeled.map(x => ({ truth: x.truth, pred: predOf(x.o.shippingStatus) })));
    const out = { labeled: labeled.length, minN: MIN_N, current, auto, mismatches: [], recommendation: null, warnings: [] };
    labeled.forEach(x => {
      const p = predOf(x.o.shippingStatus);
      if ((x.truth === 'intl') !== (p === 'intl')) out.mismatches.push({ offerKey: x.o.offerKey, asin: x.o.asin, sellerName: x.o.sellerName || null, truth: x.truth, auto: x.o.shippingStatus || 'unknown',
        shipperType: x.o.shipperType || null, handling: [x.o.handlingMinDays, x.o.handlingMaxDays], delivery: [x.o.deliveryMinDays, x.o.deliveryMaxDays] });
    });
    if (labeled.length < MIN_N) out.warnings.push('العينة صغيرة (' + labeled.length + ' من ' + MIN_N + ' على الأقل): لا توصية بعتبات.');
    const nIntl = auto.intl, nLoc = auto.local;
    if (labeled.length && (!nIntl || !nLoc)) out.warnings.push('تنقص فئة (' + (!nIntl ? 'دولي' : 'غير دولي') + ') في عيّنتك؛ صنّف أمثلة من الفئتين.');
    const sellerRows = labeled.filter(x => x.o.shipperType === 'seller' && hasDur(x.o));
    if (labeled.length >= MIN_N && nIntl && nLoc) {
      if (sellerRows.length < 5) out.warnings.push('أمثلة «الشاحن = البائع» مع مدد قليلة (' + sellerRows.length + ' < 5): لا توصية بعتبات المدد.');
      else {
        const grid = [];
        for (let h = 3; h <= 10; h++) for (let d = 7; d <= 21; d++) for (let t = 2; t <= 8; t++) {
          const th = { h, d, t };
          const s = summarize(sellerRows.map(x => ({ truth: x.truth, pred: predictWith(x.o, evBy.get(x.o.offerKey), th) })));
          const dist = Math.abs(h - current.h) + Math.abs(d - current.d) + Math.abs(t - current.t);
          grid.push({ th, acc: s.accuracy, fp: s.fp, fn: s.fn_unknown + s.fn_local, dist });
        }
        // الأفضل: أعلى دقة، ثم أقل إيجابيات كاذبة، ثم الأقرب للعتبات الحالية (تفاديًا للإفراط في الملاءمة)
        grid.sort((a, b) => b.acc - a.acc || a.fp - b.fp || a.dist - b.dist);
        const cur = summarize(sellerRows.map(x => ({ truth: x.truth, pred: predictWith(x.o, evBy.get(x.o.offerKey), current) })));
        out.recommendation = { basedOn: sellerRows.length, currentAccuracy: cur.accuracy, best: grid[0], improvement: grid[0].acc - cur.accuracy };
        if (out.recommendation.improvement < 0.05) { out.recommendation.keepCurrent = true; out.warnings.push('لا تحسّن يُذكر (< 5%) من تغيير العتبات: أبقِ الحالية.'); }
        if (sellerRows.length < 20) out.warnings.push('العينة ما زالت صغيرة (' + sellerRows.length + '): اعتبر التوصية إرشادية وتحقق منها بأمثلة جديدة.');
      }
    }
    return out;
  }
  return { evaluate, summarize, predictWith, MIN_N };
});
