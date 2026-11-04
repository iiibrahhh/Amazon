/* صفحة البائع (/sp?seller=ID): قراءة «عنوان النشاط التجاري» وبلده كدليل على موقع البائع.
   - موقع البائع ليس مصدر الشحنة بالضرورة، لذا يُستخدم كقرينة («مرجح») إلا إذا فعّل المستخدم اعتباره دليلًا مؤكدًا.
   - الاستخراج بالتسميات النصية (عربي/إنجليزي) لا بمحدد HTML واحد، وما لم يثبت يبقى «غير معلوم».
   - البلد: رمز ISO من قائمة معروفة أو اسم دولة؛ لا يُخمَّن من اسم البائع ولا من اسم المدينة وحدها في غياب العنوان. */
(function (root, factory) {
  const dep = (n) => (typeof module === 'object' && module.exports) ? require('./' + n + '.js') : root.ASF[n];
  const api = factory(dep('rules'), dep('parser'));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.ASF = root.ASF || {}; root.ASF.seller = api; }
})(typeof self !== 'undefined' ? self : this, function (rules, parser) {
  const fold = rules.foldForMatch;
  const ADDR_LABELS = ['business address', 'registered business address', 'registered address', 'عنوان النشاط التجاري', 'عنوان العمل', 'العنوان التجاري', 'عنوان النشاط', 'عنوان المتجر'];
  const NAME_LABELS = ['business name', 'seller name', 'اسم النشاط التجاري', 'اسم العمل', 'اسم البائع'];
  const OTHER_LABELS = ['phone number', 'phone', 'email', 'vat number', 'vat', 'trade register number', 'detailed seller information', 'about seller', 'customer service address',
    'رقم الهاتف', 'الهاتف', 'البريد الالكتروني', 'الرقم الضريبي', 'السجل التجاري', 'معلومات البائع', 'عن البائع'];
  const ALL_LABELS = ADDR_LABELS.concat(NAME_LABELS, OTHER_LABELS).map(fold);
  const SAUDI_CODE = 'SA';
  const FOREIGN_CODES = new Set(rules.FOREIGN_COUNTRIES.map(c => c.code));
  const SAUDI_END_RE = /(?:saudi arabia|ksa|السعوديه|المملكه العربيه السعوديه)$/;

  function segments(doc) {
    const out = [];
    const body = doc.body || doc.documentElement; if (!body) return out;
    const w = doc.createTreeWalker(body, 4);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const p = n.parentElement; if (p && /^(?:script|style|noscript)$/i.test(p.tagName)) continue;
      const t = rules.normalizeText(n.nodeValue); if (t) out.push(t);
    }
    return out;
  }
  const stripColon = (s) => fold(s).replace(/[:：]\s*$/, '').trim();
  const labelOf = (seg, labels) => {
    const f = fold(seg);
    for (const l of labels) { const fl = fold(l); if (f === fl || f === fl + ':' || f === fl + ' :') return { label: l, inline: '' }; if (f.startsWith(fl + ':') || f.startsWith(fl + ' :')) return { label: l, inline: rules.normalizeText(seg.slice(seg.indexOf(':') + 1) || seg.slice(seg.indexOf('：') + 1)) }; }
    return null;
  };
  const isStop = (seg) => { const f = stripColon(seg); return ALL_LABELS.includes(f) || /[:：]\s*$/.test(seg.trim()); };

  function takeValue(segs, labels, max) {
    for (let i = 0; i < segs.length; i++) {
      const m = labelOf(segs[i], labels); if (!m) continue;
      const parts = m.inline ? [m.inline] : [];
      for (let j = i + 1; j < segs.length && parts.length < max; j++) { if (isStop(segs[j])) break; parts.push(segs[j]); }
      if (parts.length) return { label: m.label, parts, text: segs.slice(i, i + 1 + parts.length).join(' | ').slice(0, 300) };
    }
    return null;
  }

  function countryOf(rawParts) {
    const parts = [].concat(...rawParts.map(p => String(p).split(/\s*[,،]\s*/))).filter(Boolean);
    const last = (parts[parts.length - 1] || '').trim();
    if (/^[A-Z]{2}$/.test(last)) {
      if (last === SAUDI_CODE) return { code: 'SA', isSaudi: true, isForeign: false, basis: 'iso-code' };
      if (FOREIGN_CODES.has(last)) return { code: last, isSaudi: false, isForeign: true, basis: 'iso-code' };
      return null;   // رمز غير معروف: لا نخمّن
    }
    for (const part of [parts[parts.length - 1], parts[parts.length - 2]].filter(Boolean)) {
      if (SAUDI_END_RE.test(fold(part))) return { code: 'SA', isSaudi: true, isForeign: false, basis: 'country-name' };
      const c = rules.foreignCountryAtStart(part);
      if (c && fold(part).length <= c.name.length + 6) return { code: c.code, isSaudi: false, isForeign: true, basis: 'country-name' };
    }
    return null;
  }

  /** يحلل صفحة بائع. يعيد { ok, businessName, addressText, countryCode, isSaudi, isForeign, evidence } */
  function parseSellerProfile(doc) {
    const segs = segments(doc);
    const addr = takeValue(segs, ADDR_LABELS, 8);
    const name = takeValue(segs, NAME_LABELS, 1);
    if (!addr) return { ok: false, reason: 'no_address', businessName: name ? name.parts[0] : null };
    const c = countryOf(addr.parts);
    return {
      ok: true, businessName: name ? name.parts[0] : null, addressText: addr.parts.join(', '),
      countryCode: c ? c.code : null, isSaudi: !!(c && c.isSaudi), isForeign: !!(c && c.isForeign),
      evidence: { label: addr.label, text: addr.text, basis: c ? c.basis : null }
    };
  }

  const baseOf = (s) => ((s && s.baseUrl) || rules.DEFAULT_SETTINGS.baseUrl).replace(/\/+$/, '');
  const sellerUrl = (settings, id) => baseOf(settings) + '/sp?seller=' + encodeURIComponent(id);
  const cacheKey = (id) => 'seller:' + String(id).toUpperCase();
  async function getCached(db, id) { return id ? (await db.get('sources', cacheKey(id))) || null : null; }

  /** يجلب صفحة البائع إن لم تكن في الذاكرة (أو انتهت صلاحيتها) ويخزنها في مخزن sources. يرمي blocked/throttled. */
  async function ensureProfile(deps, sellerId) {
    const settings = deps.settings || {};
    const ttlMs = (settings.sellerProfileTtlDays === undefined ? 30 : Number(settings.sellerProfileTtlDays) || 0) * 86400000;
    const cached = await getCached(deps.db, sellerId);
    if (cached && ttlMs > 0 && Date.now() - Date.parse(cached.checkedAt) < ttlMs) return { profile: cached, fetched: false };
    if (deps.sleep && deps.delay) await deps.sleep(deps.delay());
    const url = sellerUrl(settings, sellerId);
    const resp = await deps.fetchHtml(url);
    if (resp.status === 429 || resp.status === 503) throw Object.assign(new Error('استجابة ' + resp.status + ' (تقييد مؤقت) عند جلب صفحة البائع'), { throttled: true });
    const rec = { id: cacheKey(sellerId), sellerId: String(sellerId).toUpperCase(), url, checkedAt: new Date().toISOString(), httpStatus: resp.status };
    if (resp.status >= 400) return { profile: Object.assign(rec, { ok: false, reason: 'http_' + resp.status }), fetched: true, store: false };
    const doc = deps.parseHtml(resp.html);
    const blk = parser.detectBlocked(doc, resp.url);
    if (blk.blocked) throw Object.assign(new Error('طلبت Amazon التحقق (' + blk.reason + ') عند جلب صفحة البائع'), { blocked: blk.reason });
    Object.assign(rec, parseSellerProfile(doc));
    await deps.db.put('sources', rec);
    return { profile: rec, fetched: true };
  }

  return { parseSellerProfile, ensureProfile, getCached, sellerUrl, cacheKey };
});
