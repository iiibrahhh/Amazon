/* قراءة بطاقات نتائج بحث AliExpress من صفحة مفتوحة في متصفحك (بلا مفتاح API) واستخراج رابط صفحة المنتج نفسه.
   مبني على بنية نص صفحة حقيقية أرسلها المستخدم (عنوان، مواصفات، «N مباعة»، تقييم، «70.5ر.س.»، «إعلان») لكن دون HTML حقيقي:
   الاستخراج قائم على الروابط /item/ID.html وأقرب حاوية لها، ومتسامح، ولم يُجرَّب على DOM حقيقي. فشله يظهر كـ«لا بطاقات» لا كنتيجة مختلقة. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.ASF = root.ASF || {}; root.ASF.aliparse = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  const ITEM = /\/item\/(?:[^\/?#]*\/)?(\d{6,})\.html/;
  const AR = '٠١٢٣٤٥٦٧٨٩';
  const norm = (s) => String(s || '').replace(/[٠-٩]/g, d => AR.indexOf(d)).replace(/ /g, ' ');
  const clean = (s) => norm(s).replace(/\s+/g, ' ').trim();

  /** إذا تكرر العنوان نفسه متتاليًا (كما في الصفحة الحقيقية) يُختصر إلى واحد. */
  function dedupeRepeat(t) {
    t = clean(t); const n = t.length;
    for (let k = 2; k <= 8; k++) { if (n % k === 0) { const u = t.slice(0, n / k); if (u.repeat(k) === t) return u; } }
    const h = t.slice(0, Math.floor(n / 2)).trim(); if (h.length > 10 && t.indexOf(h, h.length) >= 0 && t.startsWith(h + h.slice(0, 0))) { /* لا شيء */ }
    return t;
  }
  function parseOrders(text) {
    const m = norm(text).match(/(\+)?\s*([\d.,]+)\s*(ألف|الف|k)?\s*مباع/i) || norm(text).match(/([\d.,]+)\s*(k)?\+?\s*sold/i);
    if (!m) return null;
    const isAr = /مباع/.test(m[0]); const num = parseFloat((isAr ? m[2] : m[1]).replace(/,/g, ''));
    const k = isAr ? m[3] : m[2];
    return isNaN(num) ? null : Math.round(num * (k ? 1000 : 1));
  }
  function parsePrice(text) {
    const t = norm(text);
    const m = t.match(/(\d[\d,]*\.?\d*)\s*(?:ر\.?\s*س\.?|SAR|SR)/i) || t.match(/(?:SAR|SR|ر\.?\s*س\.?)\s*(\d[\d,]*\.?\d*)/i);
    if (!m) return null; const v = parseFloat(m[1].replace(/,/g, '')); return isNaN(v) ? null : v;
  }
  function parseRating(lines) {
    for (const l of lines) { if (/^[0-5](\.\d)?$/.test(l)) return parseFloat(l); }
    return null;
  }
  const absUrl = (u, base) => { try { return new URL(u, base || 'https://www.aliexpress.com').href; } catch (e) { return ''; } };
  const productUrl = (id) => 'https://www.aliexpress.com/item/' + id + '.html';

  /** نص البطاقة سطرًا لكل عقدة نصية (يعمل في المتصفح وفي jsdom، فلا تلتصق الأرقام ببعضها). */
  function textOf(el) {
    const out = [], w = el.ownerDocument.createTreeWalker(el, 4 /* SHOW_TEXT */); let n;
    while ((n = w.nextNode())) { const t = n.nodeValue; if (t && t.trim() && !/^(SCRIPT|STYLE)$/.test(n.parentNode.nodeName)) out.push(t.trim()); }
    return out.join('\n');
  }
  function cardOf(a) {
    let el = a, best = a;
    while (el.parentElement && el.parentElement !== el.ownerDocument.body) {
      const p = el.parentElement, ids = new Set();
      p.querySelectorAll('a[href]').forEach(x => { const m = (x.getAttribute('href') || '').match(ITEM); if (m) ids.add(m[1]); });
      if (ids.size > 1) break; best = p; el = p;
    }
    return best;
  }

  function parseSearchDocument(doc, base) {
    const seen = new Map();
    doc.querySelectorAll('a[href]').forEach(a => {
      const m = (a.getAttribute('href') || '').match(ITEM); if (!m || seen.has(m[1])) return;
      const card = cardOf(a);
      const text = textOf(card);
      const lines = String(text || '').split(/\n+/).map(clean).filter(Boolean);
      const img = card.querySelector('img'); let src = img && (img.getAttribute('src') || img.getAttribute('data-src') || '');
      let title = clean(a.getAttribute('title') || (img && img.getAttribute('alt')) || '');
      if (title.length < 8) title = dedupeRepeat(lines.slice().sort((x, y) => y.length - x.length)[0] || '');
      const whole = lines.join(' | ');
      seen.set(m[1], { id: m[1], title: dedupeRepeat(title), url: productUrl(m[1]), image: src ? absUrl(src, base) : '', price: parsePrice(whole), currency: 'SAR',
        rating: parseRating(lines), orders: parseOrders(whole), sponsored: lines.some(l => /^(إعلان|ad|sponsored)$/i.test(l)), shopName: '', category1: '', category2: '' });
    });
    return Array.from(seen.values()).filter(c => c.title);
  }

  /** حاجز التحقق (CAPTCHA/تسجيل دخول) بدل بطاقات. */
  function isBlocked(doc) {
    const t = norm((doc.body && (doc.body.innerText || doc.body.textContent)) || '').toLowerCase();
    return /captcha|slide to verify|unusual traffic|punish|تحقق|اسحب/.test(t.slice(0, 4000)) && !doc.querySelector('a[href*="/item/"]');
  }
  return { parseSearchDocument, isBlocked, parseOrders, parsePrice, dedupeRepeat, productUrl };
});
