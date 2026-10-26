/* قواعد التصنيف والنصوص — قابلة للتعديل دون المساس ببقية الكود.
   كل الأنماط العربية مكتوبة بصيغة "مطبَّعة" (بدون همزات/تشكيل: أ→ا، ة→ه، ى→ي). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.ASF = root.ASF || {}; root.ASF.rules = api; }
})(typeof self !== 'undefined' ? self : this, function () {

  const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
  const FA_DIGITS = '۰۱۲۳۴۵۶۷۸۹';

  /** تطبيع خفيف: أرقام لاتينية، إزالة علامات الاتجاه، ضغط المسافات. يحافظ على الحروف العربية. */
  function normalizeText(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/[٠-٩]/g, d => AR_DIGITS.indexOf(d))
      .replace(/[۰-۹]/g, d => FA_DIGITS.indexOf(d))
      .replace(/٫/g, '.').replace(/٬/g, ',')
      .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\u061c\ufeff]/g, '')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** تطبيع للمطابقة: حروف صغيرة + طي الحروف العربية + إزالة التشكيل والتطويل. */
  function foldForMatch(s) {
    return normalizeText(s).toLowerCase()
      .replace(/[\u064b-\u065f\u0670\u0640]/g, '')
      .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه');
  }

  const SAUDI_NAMES = ['saudi arabia', 'saudi', 'ksa', 'riyadh', 'jeddah', 'dammam', 'khobar',
    'المملكه العربيه السعوديه', 'السعوديه', 'المملكه', 'الرياض', 'جده', 'الدمام', 'الخبر'];

  const FOREIGN_COUNTRIES = [
    { code: 'US', en: ['united states', 'usa', 'u.s.a', 'u.s.', 'america'], ar: ['الولايات المتحده', 'امريكا'] },
    { code: 'CN', en: ['china', 'shenzhen', 'guangzhou'], ar: ['الصين'] },
    { code: 'HK', en: ['hong kong'], ar: ['هونج كونج', 'هونغ كونغ'] },
    { code: 'AE', en: ['united arab emirates', 'uae', 'dubai', 'abu dhabi', 'sharjah'], ar: ['الامارات', 'دبي', 'ابوظبي', 'الشارقه'] },
    { code: 'GB', en: ['united kingdom', 'uk', 'britain', 'england'], ar: ['بريطانيا', 'المملكه المتحده'] },
    { code: 'DE', en: ['germany'], ar: ['المانيا'] },
    { code: 'FR', en: ['france'], ar: ['فرنسا'] },
    { code: 'IT', en: ['italy'], ar: ['ايطاليا'] },
    { code: 'ES', en: ['spain'], ar: ['اسبانيا'] },
    { code: 'NL', en: ['netherlands'], ar: ['هولندا'] },
    { code: 'PL', en: ['poland'], ar: ['بولندا'] },
    { code: 'SE', en: ['sweden'], ar: ['السويد'] },
    { code: 'CH', en: ['switzerland'], ar: ['سويسرا'] },
    { code: 'IN', en: ['india'], ar: ['الهند'] },
    { code: 'PK', en: ['pakistan'], ar: ['باكستان'] },
    { code: 'JP', en: ['japan'], ar: ['اليابان'] },
    { code: 'KR', en: ['south korea', 'korea'], ar: ['كوريا'] },
    { code: 'TW', en: ['taiwan'], ar: ['تايوان'] },
    { code: 'SG', en: ['singapore'], ar: ['سنغافوره'] },
    { code: 'MY', en: ['malaysia'], ar: ['ماليزيا'] },
    { code: 'TH', en: ['thailand'], ar: ['تايلاند'] },
    { code: 'VN', en: ['vietnam'], ar: ['فيتنام'] },
    { code: 'TR', en: ['turkey', 'turkiye'], ar: ['تركيا'] },
    { code: 'CA', en: ['canada'], ar: ['كندا'] },
    { code: 'AU', en: ['australia'], ar: ['استراليا'] },
    { code: 'EG', en: ['egypt'], ar: ['مصر'] },
    { code: 'KW', en: ['kuwait'], ar: ['الكويت'] },
    { code: 'BH', en: ['bahrain'], ar: ['البحرين'] },
    { code: 'QA', en: ['qatar'], ar: ['قطر'] },
    { code: 'OM', en: ['oman'], ar: ['عمان'] },
    { code: 'JO', en: ['jordan'], ar: ['الاردن'] }
  ];

  function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

  const COUNTRY_INDEX = [];
  FOREIGN_COUNTRIES.forEach(c => c.en.concat(c.ar).forEach(n => COUNTRY_INDEX.push({ code: c.code, name: n })));
  COUNTRY_INDEX.sort((a, b) => b.name.length - a.name.length);

  /** يعيد الدولة الأجنبية إذا بدأ النص باسم دولة أجنبية (ولا يعتمد على بقية الجملة). */
  function foreignCountryAtStart(text) {
    const t = foldForMatch(text).replace(/^(the|ال)\s+/, '').trim();
    for (const c of COUNTRY_INDEX) {
      const re = new RegExp('^' + escapeRe(c.name) + '(?![a-z\\u0621-\\u064a])');
      if (re.test(t)) return { code: c.code, name: c.name };
    }
    return null;
  }
  function isSaudiAtStart(text) {
    const t = foldForMatch(text).replace(/^(the|ال)\s+/, '').trim();
    return SAUDI_NAMES.some(n => new RegExp('^' + escapeRe(n) + '(?![a-z\\u0621-\\u064a])').test(t));
  }

  /* أنماط الإشارات. strength: confirmed | likely | local */
  const PATTERNS = [
    // --- مؤكد: نص صريح يفيد بالشحن من خارج السعودية ---
    { id: 'ships_from_abroad_en', strength: 'confirmed',
      re: /\b(?:ships?|shipped|dispatch(?:es|ed)?|sent|delivered)\s+from\s+(?:abroad|overseas|outside\s+(?:of\s+)?(?:the\s+)?(?:saudi(?:\s+arabia)?|ksa|kingdom))\b/ },
    { id: 'ships_from_abroad_ar', strength: 'confirmed',
      re: /(?:يشحن|تشحن|شحن|يتم الشحن|يرسل|ارسال|يتم الارسال)\s*(?:من)\s*(?:الخارج|خارج\s+(?:المملكه|السعوديه))/ },
    { id: 'item_shipped_internationally_en', strength: 'confirmed',
      re: /\bthis item (?:is|will be) (?:shipped|sent|dispatched) (?:internationally|from (?:abroad|overseas))\b/ },

    // --- مرجح: قرائن لا تثبت بلد الشحن وحدها ---
    { id: 'amazon_global_en', strength: 'likely', re: /\bamazon\s*global\b|\bglobal store\b/ },
    { id: 'amazon_global_ar', strength: 'likely', re: /امازون\s*العالمي|المتجر العالمي|متجر امازون العالمي/ },
    { id: 'import_fees_en', strength: 'likely', re: /\bimport fees?(?: deposit)?\b|\bcustoms (?:duties|fees|charges)\b|\bduties and taxes\b/ },
    { id: 'import_fees_ar', strength: 'likely', re: /رسوم الاستيراد|وديعه رسوم الاستيراد|رسوم الجمارك|الرسوم الجمركيه/ },
    { id: 'international_shipping_en', strength: 'likely', re: /\binternational(?:ly)?\s+(?:shipping|shipment|delivery|shipped)\b|\bcross[- ]border\b|\bshipped internationally\b/ },
    { id: 'international_shipping_ar', strength: 'likely', re: /شحن دولي|شحن عالمي|توصيل دولي|عابر للحدود|يشحن دوليا|يتم الشحن دوليا/ },

    // --- محلي: دليل على التنفيذ داخل السعودية ---
    { id: 'fulfilled_by_amazon_en', strength: 'local', re: /\bfulfil+ed by amazon\b|\bships? from amazon(?!\s*global|\.com|\.ae|\.eg|\.co|\.de|\.in|\.sg)\b/ },
    { id: 'fulfilled_by_amazon_ar', strength: 'local', re: /تنفيذ(?:\s+من)?(?:\s+قبل)?\s+امازون|يشحن من امازون(?!\s*العالمي)/ },
    { id: 'ships_from_saudi_en', strength: 'local', re: /\bships?\s+from\s+(?:saudi(?:\s+arabia)?|ksa|riyadh|jeddah|dammam)\b/ },
    { id: 'ships_from_saudi_ar', strength: 'local', re: /يشحن\s+من\s+(?:المملكه العربيه السعوديه|السعوديه|الرياض|جده|الدمام)/ }
  ];

  /* عبارات "يشحن من <دولة>" — يُستخرج اسم الدولة ثم يُفحص */
  const SHIPS_FROM_COUNTRY_RES = [
    /\b(?:ships?|shipped|dispatch(?:es|ed)?|sent)\s+from\s+(?:the\s+)?([a-z.' -]{2,40})/g,
    /(?:يشحن|تشحن|شحن|يتم الشحن|يرسل|ارسال|يتم الارسال)\s*(?:من|عبر)\s+([\u0621-\u064a ]{2,40})/g
  ];

  /* ما لا يُعتبر دليلًا بمفرده إطلاقًا — يُوثّق هنا ويُختبر.
     (موعد التوصيل الطويل يُستخدم فقط كقرينة مساندة مع «الشاحن = البائع» — انظر classifier.js) */
  const NON_EVIDENCE = ['seller_name', 'seller_country', 'brand_country', 'delivery_date', 'delivery_duration'];

  /* ---------- الشاحن: أمازون أم البائع؟ ---------- */
  const AMAZON_SHIPPER_RE = /^(?:amazon(?:\.sa)?|amazon sa|امازون(?:\.sa)?|امازون السعوديه)$/;
  const AMAZON_GLOBAL_RE = /amazon\s*global|amazon\.(?:com|ae|eg|co\.uk|de|in)|امازون\s*العالمي/;
  const FBA_TEXT_RE = /\bfulfil+ed by amazon\b|\bships? from amazon(?!\s*global|\.com|\.ae|\.eg|\.co|\.de|\.in)\b|تنفيذ(?:\s+من)?(?:\s+قبل)?\s+امازون|يشحن من امازون(?!\s*العالمي)/;
  /** 'amazon' | 'amazon_global' | 'seller' | null */
  function shipperTypeOf(shipperName, fulfillerText) {
    const n = foldForMatch(shipperName).replace(/\s+/g, ' ').trim();
    if (n) {
      if (AMAZON_GLOBAL_RE.test(n)) return 'amazon_global';
      if (AMAZON_SHIPPER_RE.test(n)) return 'amazon';
      return 'seller';
    }
    const f = foldForMatch(fulfillerText);
    if (f && FBA_TEXT_RE.test(f)) return 'amazon';
    return null;
  }

  /* ---------- مدد الشحن ---------- */
  const MONTH_NUM = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
    'يناير': 1, 'فبراير': 2, 'مارس': 3, 'ابريل': 4, 'مايو': 5, 'يونيو': 6, 'يوليو': 7, 'اغسطس': 8, 'سبتمبر': 9, 'اكتوبر': 10, 'نوفمبر': 11, 'ديسمبر': 12 };
  const MONTH_ALT = '(?:january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\\b|(?:يناير|فبراير|مارس|ابريل|مايو|يونيو|يوليو|اغسطس|سبتمبر|اكتوبر|نوفمبر|ديسمبر)(?![\\u0621-\\u064a])';
  function monthOf(s) {
    const t = foldForMatch(s);
    return /^[a-z]/.test(t) ? (MONTH_NUM[t.slice(0, 3)] || null) : (MONTH_NUM[t] || null);
  }
  const rangeText = (a, b) => (b !== null && b !== undefined && b !== a) ? a + '–' + b : String(a);

  /** «يتم شحنه عادة خلال 9 إلى 10 أيام» / «Usually ships within 2 to 3 days» → {minDays,maxDays}. يُطبَّق على نص التوفر فقط. */
  function parseHandlingDays(text) {
    const t = foldForMatch(text);
    if (!t) return null;
    const mult = (u) => /week|اسبوع|اسابيع/.test(u) ? 7 : 1;
    let m = t.match(/\b(?:ships?|shipped|dispatch(?:es|ed)?|sent)\b[^.]{0,40}?\b(?:within|in)\s+(\d+)(?:\s*(?:to|-|–|or)\s*(\d+))?\s*(day|week)s?\b/);
    if (!m) m = t.match(/(?:شحن|ارسال|تجهيز)\S*[^.]{0,30}?(?:خلال|في)\s+(\d+)(?:\s*(?:الي|الى|او|-|–)\s*(\d+))?\s*(يوم|ايام|يوما|اسبوع|اسابيع)/);
    if (m) {
      const k = mult(m[3]), a = parseInt(m[1], 10) * k, b = m[2] ? parseInt(m[2], 10) * k : a;
      return { minDays: Math.min(a, b), maxDays: Math.max(a, b), text: rangeText(Math.min(a, b), Math.max(a, b)) + ' يوم' };
    }
    if (/(?:شحن|ارسال)\S*[^.]{0,30}?(?:خلال|في)\s+اسبوعين/.test(t)) return { minDays: 14, maxDays: 14, text: '14 يوم' };
    return null;
  }

  /** نافذة التوصيل من نص مثل «نوفمبر 11 - 15» أو «15 - 25 نوفمبر» أو «30 December - 15 January» → أيام من تاريخ الفحص. */
  function parseDeliveryWindow(text, now) {
    const t = foldForMatch(text);
    if (!t) return null;
    const ref = (now instanceof Date && !isNaN(now)) ? now : (now ? new Date(now) : new Date());
    const base = isNaN(ref) ? new Date() : ref;
    const today = Date.UTC(base.getFullYear(), base.getMonth(), base.getDate());
    const D = '(\\d{1,2})', M = '(' + MONTH_ALT + ')', SEP = '\\s*(?:-|–|—|الي|الى|to)\\s*';
    const specs = [   // الترتيب = أولوية عند تساوي الموضع
      { re: new RegExp(D + '\\s+' + M + SEP + D + '\\s+' + M), pick: (m) => [m[2], m[1], m[4], m[3]] },
      { re: new RegExp(M + '\\s+' + D + SEP + M + '\\s+' + D), pick: (m) => [m[1], m[2], m[3], m[4]] },
      { re: new RegExp(D + SEP + D + '\\s+' + M), pick: (m) => [m[3], m[1], m[3], m[2]] },
      { re: new RegExp(M + '\\s+' + D + SEP + D + '(?!\\s*' + MONTH_ALT + ')'), pick: (m) => [m[1], m[2], m[1], m[3]] },
      { re: new RegExp(D + '\\s+' + M), pick: (m) => [m[2], m[1], m[2], m[1]] },
      { re: new RegExp(M + '\\s+' + D), pick: (m) => [m[1], m[2], m[1], m[2]] }
    ];
    let best = null;
    for (const s of specs) {
      const m = t.match(s.re);
      if (m && (best === null || m.index < best.index)) best = { index: m.index, parts: s.pick(m) };
    }
    if (!best) {
      if (/\btomorrow\b|(?:^|\s)غدا(?![ء-ي])/.test(t)) return { startDate: null, endDate: null, minDays: 1, maxDays: 1 };
      return null;
    }
    const [m1, d1, m2, d2] = [monthOf(best.parts[0]), parseInt(best.parts[1], 10), monthOf(best.parts[2]), parseInt(best.parts[3], 10)];
    if (!m1 || !m2 || d1 < 1 || d1 > 31 || d2 < 1 || d2 > 31) return null;
    let y = base.getFullYear();
    let start = Date.UTC(y, m1 - 1, d1);
    if (start < today - 45 * 86400000) { y++; start = Date.UTC(y, m1 - 1, d1); }
    let end = Date.UTC(y, m2 - 1, d2);
    if (end < start) end = Date.UTC(y + 1, m2 - 1, d2);
    const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
    return { startDate: iso(start), endDate: iso(end), minDays: Math.round((start - today) / 86400000), maxDays: Math.round((end - today) / 86400000) };
  }

  const DEFAULT_SETTINGS = {
    baseUrl: 'https://www.amazon.sa',
    language: '',               // '' = بدون تغيير | 'en_AE' | 'ar_AE'
    minDelayMs: 4000,
    maxDelayMs: 9000,
    maxPagesPerRun: 300,
    maxCategoryDepth: 2,
    maxAttempts: 2,
    stopAfterBlocks: 3,         // توقف بعد عدد من أخطاء 429/503 المتتالية
    fetchCompetitorOffers: false,
    autoCapture: true,          // التقاط الصفحات التي تفتحها بنفسك
    importFeesAsConfirmed: false,
    intlMinHandlingDays: 5,     // شاحن = البائع + مهلة تجهيز ≥ هذا العدد من الأيام ⇒ قرينة شحن دولي (مرجح)
    intlMinDeliveryDays: 14,    // شاحن = البائع + أقرب موعد توصيل بعد ≥ هذا العدد من الأيام ⇒ قرينة (مرجح)
    searchPages: 1,             // عدد صفحات نتائج البحث التي تُجلب
    searchDeepScan: 10,         // عدد نتائج البحث التي تُفحص صفحاتها بالكامل (0 = بلا فحص)
    extraSeeds: [],             // روابط بدء اختيارية (قوائم/فئات)
    catalogScope: [],           // [{name,url}] كتالوجات محددة للجمع؛ فارغ = كل الكتالوجات
    knownCatalogs: []           // [{name,url}] نتيجة «اكتشاف الكتالوجات»
  };

  const SEED_PATHS = [
    '/gp/bestsellers', '/gp/new-releases', '/gp/movers-and-shakers',
    '/gp/most-wished-for', '/gp/gift-ideas', '/deals'
  ];

  const STATUS = {
    confirmed: { key: 'confirmed', ar: 'مؤكد', rank: 4 },
    likely: { key: 'likely', ar: 'مرجح', rank: 3 },
    unknown: { key: 'unknown', ar: 'غير معلوم', rank: 2 },
    local: { key: 'local', ar: 'محلي / غير دولي', rank: 1 }
  };

  return { normalizeText, foldForMatch, foreignCountryAtStart, isSaudiAtStart, PATTERNS,
    SHIPS_FROM_COUNTRY_RES, NON_EVIDENCE, DEFAULT_SETTINGS, SEED_PATHS, STATUS, FOREIGN_COUNTRIES,
    shipperTypeOf, parseHandlingDays, parseDeliveryWindow, rangeText };
});
