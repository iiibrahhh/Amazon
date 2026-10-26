/* البحث عن منتج في Amazon.sa وجلب بياناته وتحليل شحنه.
   مدخلات مقبولة: كلمة بحث | رابط منتج amazon.sa | ASIN.
   - طلب واحد في كل مرة مع تأخير بين الطلبات، ويتوقف عند CAPTCHA/تسجيل دخول/تقييد (429/503) دون تجاوزه.
   - الاعتماديات (fetchHtml, parseHtml, sleep) تُحقن لتسهيل الاختبار. */
(function (root, factory) {
  const dep = (n) => (typeof module === 'object' && module.exports) ? require('./' + n + '.js') : root.ASF[n];
  const api = factory(dep('rules'), dep('parser'), dep('ingest'));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.ASF = root.ASF || {}; root.ASF.search = api; }
})(typeof self !== 'undefined' ? self : this, function (rules, parser, ingest) {

  const ASIN_RE = /^(?:B0[A-Z0-9]{8}|\d{9}[\dX])$/i;
  const baseOf = (settings) => (settings && settings.baseUrl) || rules.DEFAULT_SETTINGS.baseUrl;

  function withLanguage(url, settings) {
    if (!settings || !settings.language) return url;
    try { const u = new URL(url); u.searchParams.set('language', settings.language); return u.toString(); } catch (e) { return url; }
  }

  /** يصنّف مدخل المستخدم. */
  function parseQuery(input) {
    const t = rules.normalizeText(input);
    if (!t) return { kind: 'empty' };
    if (/^https?:\/\//i.test(t)) {
      let host = '';
      try { host = new URL(t).hostname; } catch (e) { return { kind: 'bad-url' }; }
      if (!/(^|\.)amazon\.sa$/.test(host)) return { kind: 'foreign-url', host };
      const asin = parser.extractAsin(t);
      if (asin) return { kind: 'asin', asin, from: 'url' };
      try { const k = new URL(t).searchParams.get('k'); if (k) return { kind: 'keyword', keyword: rules.normalizeText(k) }; } catch (e) { /* تجاهل */ }
      return { kind: 'bad-url' };
    }
    if (ASIN_RE.test(t)) return { kind: 'asin', asin: t.toUpperCase(), from: 'asin' };
    return { kind: 'keyword', keyword: t.slice(0, 200) };
  }

  function searchUrl(settings, keyword, page) {
    const u = new URL(baseOf(settings) + '/s');
    u.searchParams.set('k', keyword);
    if (page && page > 1) u.searchParams.set('page', String(page));
    return withLanguage(u.toString(), settings);
  }

  /** نتائج صفحة البحث: نكتفي ببطاقات النتائج الفعلية إن وُجدت (لا شرائح اللافتات والتوصيات). */
  function parseSearchDocument(doc, base) {
    const res = parser.parseListingDocument(doc, base);
    const real = new Set();
    doc.querySelectorAll('[data-component-type="s-search-result"][data-asin]').forEach(el => {
      const a = (el.getAttribute('data-asin') || '').toUpperCase();
      if (/^[A-Z0-9]{10}$/.test(a)) real.add(a);
    });
    const items = real.size ? res.items.filter(i => real.has(i.asin)) : res.items.filter(i => i.title || i.price !== null);
    return { items: items.map(i => { const c = Object.assign({}, i); delete c._href; return c; }), nextPage: res.nextPage };
  }

  function httpError(resp) {
    if (resp.status === 429 || resp.status === 503) return Object.assign(new Error('استجابة ' + resp.status + ' (تقييد مؤقت من Amazon)'), { throttled: true });
    if (resp.status === 404) return Object.assign(new Error('الصفحة غير متاحة (404)'), { permanent: true });
    if (resp.status >= 400) return new Error('استجابة HTTP ' + resp.status);
    return null;
  }

  /** يجلب صفحة منتج ويحللها ويخزنها. يرمي: blocked / throttled / permanent / خطأ عام. */
  async function fetchProduct(deps, asin, ctx) {
    const settings = deps.settings;
    const url = baseOf(settings) + '/dp/' + asin;
    const resp = await deps.fetchHtml(withLanguage(url, settings));
    const err = httpError(resp); if (err) throw err;
    const doc = deps.parseHtml(resp.html);
    const blk = parser.detectBlocked(doc, resp.url);
    if (blk.blocked) throw Object.assign(new Error('طلبت Amazon التحقق (' + blk.reason + ')'), { blocked: blk.reason });
    const parsed = parser.parseProductDocument(doc, resp.url || url, { baseUrl: baseOf(settings), now: new Date() });
    if (!parsed.ok) throw Object.assign(new Error('الصفحة ليست صفحة منتج صالحة'), { permanent: true });
    return ingest.ingestProduct(deps.db, parsed, { settings, source: (ctx && ctx.source) || 'amazon.sa:search-detail', catalog: ctx && ctx.catalog || null });
  }

  /**
   * @param deps { db, settings, fetchHtml(url)->{status,url,html}, parseHtml(html)->Document, sleep(ms), onProgress(p), isStopped()->bool, random() }
   * @param opts { pages (1..5), deepScan (0..100) }
   */
  async function runSearch(deps, input, opts) {
    opts = opts || {};
    const settings = deps.settings;
    const sleep = deps.sleep || ((ms) => new Promise(r => setTimeout(r, ms)));
    const rnd = deps.random || Math.random;
    const stopped = () => !!(deps.isStopped && deps.isStopped());
    const progress = (p) => deps.onProgress && deps.onProgress(p);
    // البحث التفاعلي أسرع من الجمع الآلي: 1.5–3 ثوانٍ افتراضيًا (قابل للتعديل)، وطلب واحد في كل مرة
    const dMin = Math.max(500, Number(settings.searchMinDelayMs) || 1500);
    const dMax = Math.max(dMin, Number(settings.searchMaxDelayMs) || 3000);
    const delay = () => dMin + rnd() * (dMax - dMin);
    const freshMs = (settings.skipFreshHours === undefined ? 6 : Number(settings.skipFreshHours) || 0) * 3600 * 1000;

    const q = parseQuery(input);
    const out = { kind: q.kind, keyword: q.keyword || null, asin: q.asin || null, found: 0, newProducts: 0, scanned: 0, errors: 0,
      asins: [], skippedFresh: 0, stoppedBecause: null, error: null, offerKey: null, classification: null };
    if (q.kind === 'empty') { out.error = 'اكتب اسم منتج أو الصق رابطه أو ASIN.'; return out; }
    if (q.kind === 'foreign-url') { out.error = 'الرابط ليس من amazon.sa (' + q.host + ').'; return out; }
    if (q.kind === 'bad-url') { out.error = 'تعذر التعرف على رابط المنتج. الصق رابط صفحة منتج على amazon.sa أو ASIN.'; return out; }

    const scanAsin = async (asin, catalog) => {
      try {
        const r = await fetchProduct(deps, asin, { catalog });
        out.scanned++;
        if (r.isNew) out.newProducts++;
        out.offerKey = r.offer.offerKey; out.classification = r.classification;
        return { ok: true };
      } catch (e) {
        out.errors++;
        await ingest.log(deps.db, e.blocked ? 'warn' : 'error', 'بحث: ' + e.message, { url: baseOf(settings) + '/dp/' + asin, asin });
        if (e.blocked) { out.stoppedBecause = 'blocked'; out.error = e.message; return { stop: true }; }
        if (e.throttled) { out.stoppedBecause = 'throttled'; out.error = e.message; return { stop: true }; }
        out.error = e.message;
        return { ok: false };
      }
    };

    // --- منتج واحد (ASIN أو رابط) ---
    if (q.kind === 'asin') {
      progress({ phase: 'detail', done: 0, total: 1 });
      out.asins = [q.asin];
      const r = await scanAsin(q.asin, null);
      out.found = out.scanned ? 1 : 0;
      if (r.ok) out.error = null;
      progress({ phase: 'detail', done: 1, total: 1 });
      return out;
    }

    // --- بحث بكلمات ---
    const catalog = 'بحث: ' + q.keyword;
    const pages = Math.min(5, Math.max(1, parseInt(opts.pages, 10) || 1));
    const seen = new Set();
    for (let p = 1; p <= pages; p++) {
      if (stopped()) { out.stoppedBecause = 'user_stop'; break; }
      progress({ phase: 'search', page: p, pages, found: seen.size });
      let resp;
      try {
        resp = await deps.fetchHtml(searchUrl(settings, q.keyword, p));
        const err = httpError(resp); if (err) throw err;
        const doc = deps.parseHtml(resp.html);
        const blk = parser.detectBlocked(doc, resp.url);
        if (blk.blocked) throw Object.assign(new Error('طلبت Amazon التحقق (' + blk.reason + ')'), { blocked: blk.reason });
        const res = parseSearchDocument(doc, baseOf(settings));
        const fresh = res.items.filter(i => !seen.has(i.asin));
        fresh.forEach(i => { seen.add(i.asin); out.asins.push(i.asin); });
        out.newProducts += await ingest.ingestListingItems(deps.db, fresh, { source: 'amazon.sa:search', catalog });
        if (!res.items.length || !res.nextPage) break;
      } catch (e) {
        out.errors++; out.error = e.message;
        await ingest.log(deps.db, e.blocked ? 'warn' : 'error', 'بحث «' + q.keyword + '»: ' + e.message, { url: searchUrl(settings, q.keyword, p) });
        if (e.blocked || e.throttled) { out.stoppedBecause = e.blocked ? 'blocked' : 'throttled'; break; }
        break;
      }
      if (p < pages && !stopped()) await sleep(delay());
    }
    out.found = out.asins.length;

    // --- فحص تفاصيل أول N نتيجة ---
    const deep = Math.min(100, Math.max(0, parseInt(opts.deepScan, 10) || 0));
    const targets = out.asins.slice(0, deep);
    if (!out.stoppedBecause && targets.length) {
      let requested = 0;
      for (let i = 0; i < targets.length; i++) {
        if (stopped()) { out.stoppedBecause = 'user_stop'; break; }
        progress({ phase: 'detail', done: i, total: targets.length, found: out.found });
        if (freshMs > 0) {   // فُحص حديثًا؟ لا حاجة لطلب جديد
          const prev = await deps.db.get('products', targets[i]);
          if (prev && prev.detailScanned && prev.lastCheckedAt && (Date.now() - Date.parse(prev.lastCheckedAt)) < freshMs) { out.skippedFresh++; continue; }
        }
        if (requested > 0) await sleep(delay());     // لا انتظار قبل أول طلب
        if (stopped()) { out.stoppedBecause = 'user_stop'; break; }
        requested++;
        const r = await scanAsin(targets[i], catalog);
        if (r.stop) break;
      }
      progress({ phase: 'detail', done: out.scanned, total: targets.length, found: out.found });
    }
    if (!out.stoppedBecause) out.stoppedBecause = 'done';
    return out;
  }

  return { parseQuery, searchUrl, parseSearchDocument, fetchProduct, runSearch, withLanguage };
});
