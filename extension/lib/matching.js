/* مطابقة منتج Amazon مع نتيجة AliExpress بخمسة معايير: الاسم، الصورة، الوصف، النوع (الفئة)، اسم البائع.
   كل معيار يعطي 0–100 أو null إن تعذّر (لا بيانات/لا كلمات لاتينية). الدرجة النهائية تُعيد توزيع الأوزان على المتاح فقط.
   الأوزان اجتهادية غير معايرة، والدرجة مؤشر ترتيب وليست ضمانًا بأن المنتج هو نفسه. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.ASF = root.ASF || {}; root.ASF.matching = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  const MIN_ACCEPT = 50;   // أقل درجة تُقترح تلقائيًا كمورد؛ دونها يُعرض المرشح للمراجعة فقط
  const alnum = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const WEIGHTS = { name: 35, image: 30, description: 15, type: 10, seller: 10 };
  const LABELS = { name: 'الاسم', image: 'الصورة', description: 'الوصف', type: 'النوع', seller: 'البائع' };
  const STOP = new Set(['the', 'and', 'for', 'with', 'of', 'in', 'to', 'a', 'an', 'new', 'by', 'from', 'pcs', 'pc', 'set', 'item']);
  const toks = (s) => new Set(String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 2 && !STOP.has(w)));
  const overlap = (a, b) => { if (!a.size || !b.size) return null; let h = 0; a.forEach(w => { if (b.has(w)) h++; }); return Math.round(h / a.size * 100); };

  const name = (prod, c) => overlap(toks([prod.brand, prod.modelNumber, prod.title].join(' ')), toks(c.title));
  const description = (prod, c) => { const a = toks(prod.description); return a.size < 3 ? null : overlap(toks(c.title), a) === null ? null : Math.min(100, Math.round(overlap(toks(c.title), a) * 2.5)); };
  // النوع: كلمات فئة Amazon اللاتينية مقابل فئة AliExpress وعنوانها
  const type = (prod, c) => overlap(toks(prod.categoryPath), toks([c.category1, c.category2, c.title].join(' ')));
  // البائع: تشابه اسم بائع Amazon مع اسم متجر AliExpress (بعد إزالة الفواصل). مفيد حين يكون البائع مصنّعًا/علامة.
  const seller = (sellerName, c) => {
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    const a = norm(sellerName), b = norm(c.shopName); if (a.length < 3 || b.length < 3) return null;
    return (a === b || a.includes(b) || b.includes(a)) ? 100 : 0;
  };

  /** بصمة dHash من 72 قيمة رمادية (9×8). تعيد 64 بتًا كسلسلة 0/1. */
  function dHash(gray72) {
    if (!gray72 || gray72.length !== 72) return null;
    let s = '';
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) s += gray72[y * 9 + x] > gray72[y * 9 + x + 1] ? '1' : '0';
    return s;
  }
  /** تشابه البصمتين 0–100 (100 = متطابقتان). */
  function hashSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return null;
    let d = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
    return Math.round((1 - d / a.length) * 100);
  }
  // بصمات الصور المختلفة عشوائيًا تتشابه ~50%: نعيد تدريج 50→0 و100→100
  const imageScore = (sim) => sim === null || sim === undefined ? null : Math.max(0, Math.round((sim - 50) * 2));

  /** parts: {name,image,description,type,seller} قيم 0–100 أو null. */
  function combine(parts) {
    let sum = 0, w = 0; const used = [], missing = [];
    Object.keys(WEIGHTS).forEach(k => { const v = parts[k]; if (v === null || v === undefined) missing.push(LABELS[k]); else { sum += v * WEIGHTS[k]; w += WEIGHTS[k]; used.push(k); } });
    return { score: w ? Math.round(sum / w) : null, parts, missing, coverage: Math.round(w) };
  }
  function explain(r) {
    return Object.keys(WEIGHTS).map(k => LABELS[k] + ' ' + (r.parts[k] === null || r.parts[k] === undefined ? '—' : r.parts[k])).join(' · ');
  }

  /** يرتب المرشحين. opts: {sellerName, imageSimilarity: (cand)=>0..100|null} */
  function rank(prod, cands, opts) {
    opts = opts || {};
    return (cands || []).filter(c => c.price !== null && c.url).map(c => {
      const parts = { name: name(prod, c), description: description(prod, c), type: type(prod, c), seller: seller(opts.sellerName, c),
        image: imageScore(opts.imageSimilarity ? opts.imageSimilarity(c) : null) };
      const m = combine(parts);
      // بوابة الموديل: إن كان لمنتج Amazon رقم موديل ولم يرد في عنوان المرشح، فالمرشح غالبًا منتج آخر بنفس الماركة
      const model = alnum(prod.modelNumber), noModel = model.length >= 4 && !alnum(c.title).includes(model);
      const score = m.score === null ? 0 : (noModel ? Math.min(m.score, 40) : m.score);
      if (noModel) m.missing = m.missing.concat(['رقم الموديل غير مذكور في عنوان المرشح']);
      return Object.assign({}, c, { match: score, modelInTitle: !noModel, matchParts: parts, matchMissing: m.missing, matchExplain: explain(m) });
    }).sort((x, y) => (y.match - x.match) || ((y.orders || 0) - (x.orders || 0)));
  }
  return { MIN_ACCEPT, WEIGHTS, dHash, hashSimilarity, imageScore, combine, explain, rank, name, description, type, seller };
});
