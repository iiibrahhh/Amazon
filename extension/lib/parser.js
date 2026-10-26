/* استخراج البيانات من مستند HTML لـ Amazon.sa.
   كل المحددات (selectors) مجمّعة هنا وفي قوائم بدائل، فإذا غيّرت Amazon البنية يكفي تعديل هذا الملف.
   الدوال تقبل كائن Document (من DOMParser في المتصفح أو jsdom في الاختبارات). */
(function (root, factory) {
  const dep = (n) => (typeof module === 'object' && module.exports) ? require('./' + n + '.js') : root.ASF[n];
  const api = factory(dep('rules'));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.ASF = root.ASF || {}; root.ASF.parser = api; }
})(typeof self !== 'undefined' ? self : this, function (rules) {

  const { normalizeText, foldForMatch } = rules;
  const BASE = 'https://www.amazon.sa';

  /* ---------- محددات قابلة للتعديل ---------- */
  const SEL = {
    title: ['#productTitle', 'h1#title span', 'h1#title', 'h1.a-size-large'],
    priceContainers: ['#corePrice_feature_div', '#corePriceDisplay_desktop_feature_div', '#apex_desktop', '#buybox', '#desktop_buybox'],
    priceInContainer: '.a-price:not(.a-text-price) .a-offscreen, .priceToPay .a-offscreen',
    listPriceInContainer: '.a-price.a-text-price .a-offscreen, .basisPrice .a-offscreen',
    priceFallback: ['#priceblock_ourprice', '#priceblock_dealprice', '#priceblock_saleprice', '#price_inside_buybox', '#tp_price_block_total_price_ww .a-offscreen'],
    listPriceFallback: ['#listPrice', '#priceblock_listprice'],
    savings: ['.savingsPercentage', '#dealprice_savings .a-color-price'],
    availability: ['#availability', '#outOfStock', '#availability_feature_div', '#availabilityInsideBuyBox_feature_div'],
    byline: ['#bylineInfo', '#brand'],
    rating: ['#acrPopover', '#averageCustomerReviews .a-icon-alt', 'span[data-hook="rating-out-of-text"]'],
    reviewCount: ['#acrCustomerReviewText', '#averageCustomerReviews #acrCustomerReviewText'],
    breadcrumbs: ['#wayfinding-breadcrumbs_feature_div a', '#wayfinding-breadcrumbs_container a'],
    image: ['#landingImage', '#imgTagWrapperId img', '#main-image'],
    bullets: ['#feature-bullets li span.a-list-item', '#feature-bullets li'],
    description: ['#productDescription'],
    detailRows: ['#productDetails_techSpec_section_1 tr', '#productDetails_techSpec_section_2 tr',
      '#productDetails_detailBullets_sections1 tr', 'table.prodDetTable tr'],
    detailBullets: ['#detailBullets_feature_div li', '#detailBulletsWrapper_feature_div li'],
    buyboxRoot: ['#tabular-buybox', '#desktop_buybox', '#buybox', '#rightCol'],
    fulfiller: ['#fulfillerInfoFeature_feature_div', '#merchant-info', '#shipsFromSoldByInsideBuyBox_feature_div'],
    merchant: ['#merchantInfoFeature_feature_div', '#merchant-info'],
    sellerLink: ['#sellerProfileTriggerId', '#merchant-info a', '#merchantInfoFeature_feature_div a'],
    delivery: ['#mir-layout-DELIVERY_BLOCK', '#deliveryBlockMessage', '#delivery-message', '#ddmDeliveryMessage'],
    badges: ['#globalStoreBadgePlaceHolder', '[id*="amazonGlobal"]', '[id*="amazonglobal"]', '[id*="globalStore"]'],
    offersSummary: ['#olp_feature_div', '#olpLinkWidget_feature_div'],
    deliveryLocation: ['#contextualIngressPtLabel_deliveryShortLine', '#glow-ingress-line2', '#nav-global-location-slot']
  };

  const LABELS = {
    shipsFrom: ['الشحن من قبل', 'يشحن من قبل', 'يتم الشحن من قبل', 'ships from', 'dispatches from', 'ships by', 'shipped by', 'dispatched by', 'shipper', 'يشحن من', 'الشحن من', 'يتم الشحن من', 'يرسل من', 'يشحن بواسطه', 'الشحن بواسطه', 'شحن بواسطه', 'الشاحن'],
    soldBy: ['يباع من قبل', 'يباع من', 'sold by', 'seller', 'يباع بواسطه', 'بيع بواسطه', 'البائع', 'المباع بواسطه']
  };

  /* ---------- أدوات صغيرة ---------- */
  const T = (el) => el ? normalizeText(el.textContent) : '';
  function q(doc, sels, scope) {
    for (const s of [].concat(sels)) {
      let el = null;
      try { el = (scope || doc).querySelector(s); } catch (e) { el = null; }
      if (el) return el;
    }
    return null;
  }
  function qa(doc, sels) {
    const out = [];
    for (const s of [].concat(sels)) {
      let list = [];
      try { list = doc.querySelectorAll(s); } catch (e) { list = []; }
      if (list.length) { list.forEach(x => out.push(x)); break; }
    }
    return out;
  }
  function metaContent(doc, name) {
    const el = doc.querySelector('meta[property="' + name + '"], meta[name="' + name + '"]');
    return el ? normalizeText(el.getAttribute('content')) : '';
  }

  function extractAsin(url) {
    if (!url) return null;
    const s = String(url);
    let m = s.match(/(?:\/dp\/|\/gp\/product\/|\/gp\/aw\/d\/|\/product\/|\/ASIN\/)([A-Za-z0-9]{10})(?=[/?#&]|$)/);
    if (m) return m[1].toUpperCase();
    m = s.match(/[?&]asin=([A-Za-z0-9]{10})(?=[&#]|$)/i);
    return m ? m[1].toUpperCase() : null;
  }
  function canonicalUrl(asin, base) { return (base || BASE) + '/dp/' + asin; }

  function parsePrice(text) {
    const t = normalizeText(text);
    if (!t) return { amount: null, currency: null };
    const currency = /\b(?:SAR|SR)\b|ر\.?\s?س|﷼|ريال/i.test(t) ? 'SAR' : null;
    const m = t.match(/\d[\d.,]*/);
    if (!m) return { amount: null, currency };
    let s = m[0].replace(/[.,]+$/, '');
    const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
    if (lastDot >= 0 && lastComma >= 0) {
      if (lastDot > lastComma) s = s.replace(/,/g, '');
      else s = s.replace(/\./g, '').replace(',', '.');
    } else if (lastComma >= 0) {
      s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
    } else if (lastDot >= 0) {
      if ((s.match(/\./g) || []).length > 1) s = s.replace(/\./g, '');
    }
    const n = parseFloat(s);
    return { amount: isFinite(n) ? n : null, currency };
  }
  function parseCount(text) {
    const m = normalizeText(text).match(/(\d[\d,]*(?:\.\d+)?)\s*(k|m|ألف|الف)?/i);
    if (!m) return null;
    let n = parseFloat(m[1].replace(/,/g, ''));
    if (m[2]) n = /m/i.test(m[2]) ? n * 1e6 : n * 1000;
    return isFinite(n) ? Math.round(n) : null;
  }
  /** أفضل رابط صورة: الصور الكسولة تحمل الرابط في data-src/srcset لا src (وقد يكون src بيانات base64). */
  function pickImage(img) {
    if (!img) return null;
    const ok = (u) => u && !/^data:/.test(u) ? u : null;
    let u = ok(img.getAttribute('data-old-hires')) || ok(img.getAttribute('data-src'));
    if (!u) { const dyn = img.getAttribute('data-a-dynamic-image'); if (dyn) { try { u = ok(Object.keys(JSON.parse(dyn))[0]); } catch (e) {} } }
    if (!u) { const ss = img.getAttribute('srcset') || img.getAttribute('data-srcset'); if (ss) u = ok(ss.split(',')[0].trim().split(/\s+/)[0]); }
    return u || ok(img.getAttribute('src'));
  }
  function parseRating(text) {
    const m = normalizeText(text).match(/(\d(?:\.\d)?)/);
    if (!m) return null;
    const n = parseFloat(m[1]);
    return n >= 0 && n <= 5 ? n : null;
  }

  function stripLabel(text, labels) {
    const t = normalizeText(text);
    const f = foldForMatch(t);
    for (const l of labels) {
      if (f.startsWith(l)) return normalizeText(t.slice(l.length)).replace(/^[:：\-–]\s*/, '');
    }
    return t;
  }

  function detailMap(doc) {
    const map = {};
    qa(doc, SEL.detailRows).forEach(tr => {
      const th = tr.querySelector('th'), td = tr.querySelector('td');
      if (th && td) map[foldForMatch(T(th)).replace(/:$/, '')] = T(td);
    });
    qa(doc, SEL.detailBullets).forEach(li => {
      const key = li.querySelector('.a-text-bold');
      if (!key) return;
      const k = foldForMatch(T(key)).replace(/[:\s]+$/, '');
      const full = T(li);
      const kRaw = T(key);
      map[k] = normalizeText(full.slice(full.indexOf(kRaw) + kRaw.length)).replace(/^[:\s]+/, '');
    });
    return map;
  }
  function kvFind(map, needles) {
    for (const k of Object.keys(map)) {
      if (needles.some(n => k.includes(n))) return map[k];
    }
    return null;
  }

  function parseBsr(text) {
    const out = [];
    const t = normalizeText(text);
    const re = /(?:#|رقم\s*)(\d[\d,]*)\s*(?:in|في)\s+([^()#]+?)(?=\s*(?:\(|#|رقم\s*\d|$))/gi;
    let m;
    while ((m = re.exec(t))) {
      out.push({ rank: parseInt(m[1].replace(/,/g, ''), 10), category: normalizeText(m[2]) });
    }
    return out;
  }

  const MONTHS = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*|يناير|فبراير|مارس|ابريل|أبريل|مايو|يونيو|يوليو|اغسطس|أغسطس|سبتمبر|اكتوبر|أكتوبر|نوفمبر|ديسمبر';
  function parseDeliveryDate(el, text) {
    if (el) {
      const b = el.querySelector('.a-text-bold, [data-csa-c-delivery-time]');
      if (b) { const v = T(b); if (v) return v; }
    }
    const re = new RegExp('(\\d{1,2}(?:\\s*[-–]\\s*\\d{1,2})?\\s+(?:' + MONTHS + '))|((?:' + MONTHS + ')\\s+\\d{1,2}(?:\\s*[-–]\\s*\\d{1,2})?)', 'i');
    const m = normalizeText(text).match(re);
    return m ? normalizeText(m[0]) : null;
  }
  function parseShippingCost(text) {
    const t = normalizeText(text);
    if (!t) return null;
    if (/free (?:delivery|shipping)|توصيل مجاني|شحن مجاني|مجانا/i.test(t)) return { amount: 0, text: 'FREE' };
    let m = t.match(/(?:SAR|SR|ر\.?\s?س\.?|﷼)\s*(\d[\d.,]*)\s*(?:delivery|shipping|توصيل|شحن)/i)
      || t.match(/(?:delivery|shipping|توصيل|شحن)[^\d]{0,25}(?:SAR|SR|ر\.?\s?س\.?|﷼)\s*(\d[\d.,]*)/i)
      || t.match(/(\d[\d.,]*)\s*(?:SAR|SR|ر\.?\s?س\.?|﷼)\s*(?:delivery|shipping|توصيل|شحن)/i);
    if (m) { const p = parsePrice(m[1]); return { amount: p.amount, text: normalizeText(m[0]) }; }
    return null;
  }
  function parseImportFees(text) {
    const t = normalizeText(text);
    // تقسيم الجمل عند «نقطة + مسافة» فقط، حتى لا تُقطع الفاصلة العشرية (45.00)
    const sentence = t.split(/(?<=[.!؟])\s+|\s+\|\s+/).find(x => /import fees?|customs|رسوم الاستيراد|رسوم الجمارك/i.test(x));
    if (!sentence) return null;
    // الصيغة الحقيقية على Amazon.sa: «السلعة: 122.73 ريال رسوم الاستيراد المقدرة: 41.32 ريال المجموع: 164.05 ريال».
    // المبلغ الصحيح هو المكتوب بعد «رسوم الاستيراد المقدرة / Estimated import fees» تحديدًا، لا أول مبلغ في الجملة (قد يكون السعر أو المجموع).
    const est = sentence.match(/(?:رسوم الاستيراد المقدرة|الرسوم الجمركية المقدرة|estimated (?:import fees?|customs(?: duties| fees)?)|import fees? estimate[d]?)\s*[:：]?\s*(?:(?:SAR|SR|ر\.?\s?س\.?|﷼|ريال)\s*(\d[\d.,]*)|(\d[\d.,]*)\s*(?:SAR|SR|ر\.?\s?س\.?|﷼|ريال))/i);
    if (est) return { text: sentence, amount: parsePrice(est[1] || est[2]).amount, amountKind: 'estimated' };
    const amt = sentence.match(/(?:SAR|SR|ر\.?\s?س\.?|﷼)\s*(\d[\d.,]*)|(\d[\d.,]*)\s*(?:SAR|SR|ر\.?\s?س\.?|﷼)/i);
    return { text: sentence, amount: amt ? parsePrice(amt[1] || amt[2]).amount : null };
  }

  /* ---------- كشف الحجب (لا نتجاوزه) ---------- */
  function detectBlocked(doc, url) {
    if (url && /\/ap\/(?:signin|cvf)|\/errors\/validateCaptcha/.test(url)) return { blocked: true, reason: 'login_or_captcha' };
    if (!doc) return { blocked: false };
    if (doc.querySelector('form[action*="validateCaptcha"]')) return { blocked: true, reason: 'captcha' };
    const body = foldForMatch(doc.body ? doc.body.textContent : '');
    if (/enter the characters you see below|not a robot|api-services-support@amazon\.com|type the characters you see/.test(body)) return { blocked: true, reason: 'captcha' };
    if (/اكتب الاحرف|لست روبوت|لسنا روبوت/.test(body)) return { blocked: true, reason: 'captcha' };
    return { blocked: false };
  }

  /* الصف المدمج «الشاحن / البائع» (Amazon.sa) أو «Shipper / Seller» أو «Ships from and sold by» */
  const COMBINED_LABEL_RE = /(?:shipper|ships?(?: from)?|الشاحن|يشحن(?: من)?|الشحن)\s*(?:\/|&|and|,|،|و)\s*(?:seller|sold by|البائع|يباع بواسطه|المباع بواسطه)/;
  const COMBINED_TEXT_RE = /(?:shipper|الشاحن)\s*\/\s*(?:seller|البائع)\s*[:：]?\s*(.+?)(?=\s+(?:shipper|seller|sold by|ships from)\b|\s+(?:الشاحن|البائع|يشحن|يباع)|\s*\||$)/i;

  /** يزيل التكرار الحرفي «X X» → «X» (تظهر أحيانًا لأن الصفحة تكرر النص في نافذة منبثقة مخفية). */
  function collapseDup(s) {
    const t = normalizeText(s);
    const w = t.split(' ');
    if (w.length % 2 === 0 && w.length >= 2) {
      const n = w.length / 2;
      if (w.slice(0, n).join(' ') === w.slice(n).join(' ')) return w.slice(0, n).join(' ');
    }
    return t;
  }
  /** النص الحقيقي يتكرر بنمط «التسمية القيمة القيمة التسمية القيمة»: نقطع عند تكرار التسمية نفسها ثم نزيل تكرار القيمة. */
  function cleanValue(raw, label) {
    let t = normalizeText(raw);
    if (label) {
      const i = t.toLowerCase().indexOf(normalizeText(label).toLowerCase());
      if (i > 0) t = t.slice(0, i).trim();
    }
    return collapseDup(t);
  }
  const isAmazonLike = (n) => rules.shipperTypeOf(n, '') === 'amazon';

  /* ---------- صفحة المنتج ---------- */
  function extractShippingFields(doc, scope, now) {
    const root = scope || doc;
    const attrs = {};
    root.querySelectorAll('[tabular-attribute-name]').forEach(el => {
      const name = foldForMatch(el.getAttribute('tabular-attribute-name'));
      attrs[name] = stripLabel(T(el), [name].concat(LABELS.shipsFrom, LABELS.soldBy));
    });
    // بنية صندوق الشراء الحديثة: تسمية + نص
    const featureRows = [];
    root.querySelectorAll('.offer-display-feature').forEach(el => {
      const l = el.querySelector('.offer-display-feature-label'), v = el.querySelector('.offer-display-feature-text');
      if (l && v && T(v)) featureRows.push({ label: foldForMatch(T(l)).replace(/[:：]\s*$/, ''), value: collapseDup(T(v)) });
    });
    featureRows.forEach(r => { if (!(r.label in attrs)) attrs[r.label] = r.value; });

    const pick = (labels) => { for (const l of labels) if (attrs[l]) { const v = attrs[l], fv = foldForMatch(v); const i = fv.length === v.length ? fv.indexOf(l) : -1; return cleanValue(i > 0 ? v.slice(0, i) : v); } return null; };
    let shipsFrom = pick(LABELS.shipsFrom);
    let soldBy = pick(LABELS.soldBy);
    let shipsFromIsName = !!shipsFrom && /^(?:shipper|الشاحن|الشحن من قبل|يشحن من قبل|يتم الشحن من قبل|يشحن بواسطه|الشحن بواسطه|شحن بواسطه|shipped by|dispatched by|ships by)$/.test(Object.keys(attrs).find(k => LABELS.shipsFrom.includes(k) && attrs[k]) || '');
    let combinedSeller = null;
    for (const k of Object.keys(attrs)) {
      if (COMBINED_LABEL_RE.test(k) && attrs[k]) { combinedSeller = collapseDup(attrs[k]); break; }
    }

    const fulfillerEl = q(doc, SEL.fulfiller, root);
    const merchantEl = q(doc, SEL.merchant, root);
    const fulfillerText = [T(fulfillerEl), T(merchantEl)].filter(Boolean)
      .filter((v, i, a) => a.indexOf(v) === i).join(' | ');

    if (!combinedSeller && fulfillerText) {
      const cm = fulfillerText.match(COMBINED_TEXT_RE);
      if (cm) combinedSeller = collapseDup(cm[1]);
    }
    if (combinedSeller) {                       // «الشاحن / البائع X»: الجهة نفسها تشحن وتبيع
      if (!shipsFrom) { shipsFrom = combinedSeller; shipsFromIsName = true; }
      if (!soldBy) soldBy = combinedSeller;
    }
    if (!shipsFrom && fulfillerText) {
      const comb = fulfillerText.match(/ships? from and sold by\s+(.+?)(?:\.|\s*\||$)|يشحن ويباع بواسط[ةه]\s+(.+?)(?:\.|\s*\||$)/i);
      if (comb) { combinedSeller = normalizeText(comb[1] || comb[2]); shipsFrom = combinedSeller; shipsFromIsName = true; if (!soldBy) soldBy = combinedSeller; }
    }
    if (!shipsFrom && fulfillerText) {   // «الشاحن X | البائع Y» كنص عادي (بلا سمات tabular)
      const sm = fulfillerText.match(/(?:^|\|\s*)(الشاحن|shipper|(?:الشحن|يشحن|يتم الشحن) من قبل)\s*[:：]?\s*([^|]+?)(?=\s*\||$)/i);
      if (sm && !/^[\/]/.test(sm[2].trim())) { shipsFrom = cleanValue(sm[2], sm[1]); shipsFromIsName = true; }
    }
    if (!soldBy && fulfillerText) {
      const bm = fulfillerText.match(/(?:^|\|\s*)(البائع|seller|sold by|يباع من(?: قبل)?)\s*[:：]?\s*([^|]+?)(?=\s*\||$)/i);
      if (bm && !/^[\/]/.test(bm[2].trim())) soldBy = cleanValue(bm[2], bm[1]);
    }
    if (!shipsFrom && fulfillerText) {
      const m = fulfillerText.match(/ships? from\s+(.{1,60}?)(?=\s+(?:and\s+)?(?:sold|\|)|$)|يشحن من\s+(.{1,60}?)(?=\s+(?:و?يباع|\|)|$)/i);
      if (m) shipsFrom = normalizeText(m[1] || m[2]);
    }
    const sellerEl = q(doc, SEL.sellerLink, root);
    // نص رابط البائع هو الأنظف: يحل محل نص ملتقط من كتلة مكررة إن كان يحتويه
    if (sellerEl && T(sellerEl) && (!soldBy || foldForMatch(soldBy).includes(foldForMatch(T(sellerEl))))) soldBy = T(sellerEl);
    let sellerId = null;
    if (sellerEl) {
      const m = (sellerEl.getAttribute('href') || '').match(/[?&](?:seller|merchant|smid)=([A-Z0-9]{8,16})/i);
      if (m) sellerId = m[1].toUpperCase();
    }
    if (!sellerId) {
      const hid = doc.querySelector('input#merchantID, input[name="merchantID"]');
      if (hid && hid.value) sellerId = hid.value.toUpperCase();
    }

    // اسم الشاحن = الجهة الظاهرة في «يشحن بواسطة/من»، وليس بالضرورة البائع. إن كانت القيمة مكانًا (دولة/«الخارج») لا نعدّها اسم شاحن.
    let shipperName = null;
    if (shipsFrom) {
      const f = foldForMatch(shipsFrom);
      const place = (!shipsFromIsName && rules.foreignCountryAtStart(shipsFrom) && shipsFrom.split(/\s+/).length <= 3) || /^(?:abroad|overseas|الخارج|خارج)/.test(f);
      shipperName = place ? null : shipsFrom;
    }
    const deliveryEl = q(doc, SEL.delivery, root) || q(doc, SEL.delivery);
    const deliveryText = T(deliveryEl).slice(0, 500);
    const deliveryDateText = parseDeliveryDate(deliveryEl, deliveryText);
    const deliveryWindow = rules.parseDeliveryWindow(deliveryDateText || deliveryText, now) || rules.parseDeliveryWindow(deliveryText, now);
    // مدة التجهيز: نص التوفر («يتم شحنه عادة خلال 9 إلى 10 أيام»)
    const availTexts = [];
    SEL.availability.forEach(sel => { try { root.querySelectorAll(sel).forEach(e => { const t = T(e); if (t && !availTexts.includes(t)) availTexts.push(t); }); } catch (e) {} });
    const handling = rules.parseHandlingDays(availTexts.join(' | '));
    const shipperType = rules.shipperTypeOf(shipperName, fulfillerText);
    const shipperIsSeller = !!(shipperName && soldBy && foldForMatch(collapseDup(shipperName)) === foldForMatch(collapseDup(soldBy)));
    const badges = [];
    SEL.badges.forEach(s => { try { root.querySelectorAll(s).forEach(e => { const t = T(e); if (t && !badges.includes(t)) badges.push(t.slice(0, 200)); }); } catch (e) {} });

    const buyEl = q(doc, SEL.buyboxRoot);
    const blockText = T(buyEl).slice(0, 1500);
    const imp = parseImportFees([deliveryText, badges.join(' '), blockText].join(' . '));
    return {
      shipsFrom, shipsFromIsName, shipperName, shipperType, shipperIsSeller, soldBy, sellerId, fulfillerText, deliveryText,
      handling, deliveryWindow,
      deliveryDate: deliveryDateText,
      shippingCost: parseShippingCost(deliveryText),
      importFees: imp, importFeesText: imp ? imp.text : '',
      badges, blockText
    };
  }

  function parseProductDocument(doc, url, opts) {
    opts = opts || {};
    const base = opts.baseUrl || BASE;
    const canonical = doc.querySelector('link[rel="canonical"]');
    const asin = extractAsin(url) || extractAsin(canonical && canonical.getAttribute('href'))
      || (doc.querySelector('input#ASIN') && doc.querySelector('input#ASIN').value) || null;

    let title = T(q(doc, SEL.title));
    if (!title) title = metaContent(doc, 'og:title').replace(/\s*[:|\-–]\s*amazon\.sa.*$/i, '');
    if (!asin && !title) return { ok: false, reason: 'not_product_page' };

    // السعر
    let price = { amount: null, currency: null };
    for (const c of SEL.priceContainers) {
      const cont = doc.querySelector(c);
      if (!cont) continue;
      const el = cont.querySelector('.priceToPay .a-offscreen') || cont.querySelector(SEL.priceInContainer);
      if (el && T(el)) { price = parsePrice(T(el)); if (price.amount !== null) break; }
    }
    if (price.amount === null) {
      const el = q(doc, SEL.priceFallback);
      if (el) price = parsePrice(T(el));
    }
    let list = { amount: null, currency: null };
    for (const c of SEL.priceContainers) {
      const cont = doc.querySelector(c);
      const el = cont && cont.querySelector(SEL.listPriceInContainer);
      if (el && T(el)) { list = parsePrice(T(el)); if (list.amount !== null) break; }
    }
    if (list.amount === null) { const el = q(doc, SEL.listPriceFallback); if (el) list = parsePrice(T(el)); }
    let discountPct = null;
    const sv = q(doc, SEL.savings);
    if (sv) { const m = T(sv).match(/(\d{1,2})\s*%/); if (m) discountPct = parseInt(m[1], 10); }
    if (discountPct === null && list.amount && price.amount && list.amount > price.amount) {
      discountPct = Math.round((1 - price.amount / list.amount) * 100);
    }
    if (list.amount !== null && price.amount !== null && list.amount <= price.amount) list = { amount: null, currency: null };

    // التوفر
    let availabilityText = T(q(doc, SEL.availability));
    let availability = null;
    const af = foldForMatch(availabilityText);
    if (doc.querySelector('#outOfStock') || /غير متوفر|غير متاح|out of stock|currently unavailable|unavailable/.test(af)) availability = 'out_of_stock';
    else if (/in stock|متوفر|only \d+ left|يتبقى|متبقي/.test(af)) availability = 'in_stock';

    // الماركة
    let brand = null;
    const by = T(q(doc, SEL.byline));
    if (by) {
      brand = by.replace(/^(?:visit the|brand:|قم بزيارة متجر|زيارة متجر|العلامه التجاريه:|العلامة التجارية:)\s*/i, '')
        .replace(/\s*store$/i, '').trim() || null;
    }
    const kv = detailMap(doc);
    if (!brand) brand = kvFind(kv, ['brand', 'العلامه التجاريه', 'manufacturer', 'الشركه المصنعه']);

    // التقييم
    let rating = null;
    const rEl = q(doc, SEL.rating);
    if (rEl) rating = parseRating(rEl.getAttribute('title') || T(rEl));
    const rcEl = q(doc, SEL.reviewCount);
    const reviewCount = rcEl ? parseCount(T(rcEl)) : null;

    // التصنيف + BSR
    const categoryPath = qa(doc, SEL.breadcrumbs).map(T).filter(Boolean).join(' › ') || null;
    const bsrRaw = kvFind(kv, ['best sellers rank', 'افضل مبيعا']);
    const bsrAll = bsrRaw ? parseBsr(bsrRaw) : [];

    // الصورة والوصف
    const imgEl = q(doc, SEL.image);
    let imageUrl = null;
    if (imgEl) imageUrl = pickImage(imgEl);
    if (!imageUrl) imageUrl = metaContent(doc, 'og:image') || null;
    const bullets = qa(doc, SEL.bullets).map(T).filter(Boolean);
    let description = bullets.join(' • ');
    if (!description) description = T(q(doc, SEL.description)) || metaContent(doc, 'description');
    description = description ? description.slice(0, 600) : null;

    // الموديل / GTIN
    const model = kvFind(kv, ['model', 'موديل', 'طراز']);
    const gtinRaw = kvFind(kv, ['gtin', 'ean', 'upc', 'barcode', 'باركود']);
    const gm = gtinRaw ? normalizeText(gtinRaw).match(/\b\d{8,14}\b/) : null;

    // العرض + الشحن
    const ship = extractShippingFields(doc, undefined, opts.now);
    let numOffers = null;
    const olp = T(q(doc, SEL.offersSummary));
    if (olp) {
      const m = olp.match(/\((\d+)\)/) || olp.match(/(\d+)\s*(?:new|offers|عروض|جديد)/i);
      if (m) numOffers = parseInt(m[1], 10);
    }

    const locEl = q(doc, SEL.deliveryLocation);
    const deliveryLocation = locEl ? (T(locEl).replace(/^(?:deliver to|التوصيل الى|التوصيل إلى|توصيل الى|توصيل إلى)\s*/i, '') || null) : null;
    const catalogTop = (qa(doc, SEL.breadcrumbs).map(T).filter(Boolean)[0]) || null;

    const result = {
      ok: true, catalogTop,
      asin, url: asin ? canonicalUrl(asin, base) : url,
      title: title || null, brand: brand || null,
      categoryPath, description,
      modelNumber: model || null, gtin: gm ? gm[0] : null,
      imageUrl: imageUrl || null,
      rating, reviewCount,
      bsrRank: bsrAll.length ? bsrAll[0].rank : null,
      bsrCategory: bsrAll.length ? bsrAll[0].category : null,
      bsrAll,
      offer: {
        price: price.amount, currency: price.currency,
        listPrice: list.amount, discountPct,
        availability, availabilityText: availabilityText || null,
        sellerName: ship.soldBy || null, sellerId: ship.sellerId || null,
        shipsFrom: ship.shipsFrom || null,
        shipperName: ship.shipperName || null,
        shipperType: ship.shipperType || null,
        handlingMinDays: ship.handling ? ship.handling.minDays : null,
        handlingMaxDays: ship.handling ? ship.handling.maxDays : null,
        deliveryMinDays: ship.deliveryWindow ? ship.deliveryWindow.minDays : null,
        deliveryMaxDays: ship.deliveryWindow ? ship.deliveryWindow.maxDays : null,
        deliveryStart: ship.deliveryWindow ? ship.deliveryWindow.startDate : null,
        deliveryEnd: ship.deliveryWindow ? ship.deliveryWindow.endDate : null,
        deliveryLocation,
        fulfillerText: ship.fulfillerText || null,
        deliveryText: ship.deliveryText || null,
        deliveryDate: ship.deliveryDate,
        shippingCost: ship.shippingCost ? ship.shippingCost.amount : null,
        shippingCostText: ship.shippingCost ? ship.shippingCost.text : null,
        importFees: ship.importFees ? ship.importFees.amount : null,
        importFeesText: ship.importFeesText || null,
        numOffers
      },
      shippingFields: ship
    };
    const required = { title: result.title, price: result.offer.price, brand: result.brand, imageUrl: result.imageUrl,
      rating: result.rating, reviewCount: result.reviewCount, bsr: result.bsrRank,
      shipsFrom: result.offer.shipsFrom, soldBy: result.offer.sellerName, deliveryText: result.offer.deliveryText };
    result.fieldsMissing = Object.keys(required).filter(k => required[k] === null || required[k] === undefined || required[k] === '');
    return result;
  }

  /* ---------- روابط ---------- */
  function absUrl(href, base, keepQuery) {
    try {
      const u = new URL(href, (base || BASE) + '/');
      if (!/(^|\.)amazon\.sa$/.test(u.hostname)) return null;
      u.hash = '';
      u.pathname = u.pathname.replace(/\/ref=[^/]*$/, '');
      if (!keepQuery) {
        const node = u.searchParams.get('node');
        u.search = node ? '?node=' + node : '';
      }
      return u.toString();
    } catch (e) { return null; }
  }

  const LISTING_PATH = /\/(?:gp\/)?(?:bestsellers|best-sellers|new-releases|movers-and-shakers|most-wished-for|gift-ideas)(?:\/|$)|\/b\/?\?node=\d+|^\/b$/;

  function isListingUrl(u) {
    try { const x = new URL(u); return LISTING_PATH.test(x.pathname + x.search); } catch (e) { return false; }
  }

  function parseListingDocument(doc, baseUrl) {
    const base = baseUrl || BASE;
    const items = new Map();
    doc.querySelectorAll('[data-asin]').forEach(el => {
      const asin = (el.getAttribute('data-asin') || '').toUpperCase();
      if (!/^[A-Z0-9]{10}$/.test(asin) || items.has(asin)) return;
      const a = el.querySelector('a[href*="/dp/"], a[href*="/gp/product/"]');
      const img = el.querySelector('img.s-image, img.p13n-product-image, img');
      const titleEl = el.querySelector('h2 span, h2, [class*="line-clamp"], .p13n-sc-truncate-desktop-type2');
      const priceEl = q(doc, ['.a-price:not(.a-text-price) .a-offscreen', '.a-price .a-offscreen', '[class*="p13n-sc-price"]', '.a-color-price', '[class*="price"]'], el);
      const price = parsePrice(T(priceEl));
      const ratingEl = el.querySelector('.a-icon-alt');
      // عدد المراجعات: نتجاهل نص النجوم (.a-icon-alt) وإلا التُقط التقييم نفسه عددًا
      let reviewCount = null;
      const revSpans = [].slice.call(el.querySelectorAll('span.s-underline-text, a[href*="customerReviews"] span, a[href*="product-reviews"] span, a[href*="#customerReviews"] span'));
      for (const sp of revSpans) {
        if (sp.classList.contains('a-icon-alt') || sp.closest('.a-icon-alt')) continue;
        const t = T(sp);
        if (!t || /stars?|نجوم|نجمه|out of|من\s*5/i.test(t)) continue;
        const c = parseCount(t.replace(/[()]/g, ''));
        if (c !== null) { reviewCount = c; break; }
      }
      items.set(asin, {
        asin, url: canonicalUrl(asin, base),
        title: T(titleEl) || (img && normalizeText(img.getAttribute('alt'))) || null,
        price: price.amount, currency: price.currency,
        rating: ratingEl ? parseRating(T(ratingEl)) : null,
        reviewCount,
        imageUrl: pickImage(img),
        _href: a ? a.getAttribute('href') : null
      });
    });
    const productLinks = new Set(items.keys());
    const categoryLinks = new Set();
    const catNames = new Map();
    doc.querySelectorAll('a[href]').forEach(a => {
      const href = a.getAttribute('href');
      const asin = extractAsin(href);
      if (asin && !items.has(asin) && !/\/(?:product-reviews|customerReviews)/.test(href)) {
        productLinks.add(asin);
        items.set(asin, { asin, url: canonicalUrl(asin, base), title: null, price: null, currency: null,
          rating: null, reviewCount: null, imageUrl: null });
      }
      const u = absUrl(href, base, false);
      if (u && !asin && isListingUrl(u)) { categoryLinks.add(u); const nm = T(a); if (nm && !catNames.has(u)) catNames.set(u, nm); }
    });
    let nextPage = null;
    const next = doc.querySelector('a.s-pagination-next:not(.s-pagination-disabled), li.a-last:not(.a-disabled) a');
    if (next) nextPage = absUrl(next.getAttribute('href'), base, true);
    const pageTitle = T(q(doc, ['#zg_banner_text', '#zg-banner-text', 'h1'])) || null;
    return { items: Array.from(items.values()), categoryLinks: Array.from(categoryLinks),
      categories: Array.from(categoryLinks).map(u => ({ url: u, name: catNames.get(u) || null })), pageTitle, nextPage };
  }

  /* ---------- قائمة العروض (AOD) ---------- */
  function parseOffersDocument(doc) {
    const out = [];
    doc.querySelectorAll('#aod-pinned-offer, #aod-offer, [id="aod-offer"]').forEach(el => {
      const price = parsePrice(T(el.querySelector('.a-price .a-offscreen')));
      // q() يحترم ترتيب البدائل (querySelector بقائمة مفصولة بفواصل يعيد أول عنصر بترتيب المستند لا بترتيب المحددات)
      const sfEl = q(doc, ['#aod-offer-shipsFrom .a-col-right', '#aod-offer-shipsFrom'], el);
      const sbEl = q(doc, ['#aod-offer-soldBy .a-col-right a', '#aod-offer-soldBy a', '#aod-offer-soldBy .a-col-right', '#aod-offer-soldBy'], el);
      const delEl = q(doc, ['#mir-layout-DELIVERY_BLOCK', '[id^="aod-delivery"]', '.aod-delivery-promise'], el);
      const href = (sbEl && sbEl.getAttribute && sbEl.getAttribute('href')) || '';
      const idm = href.match(/[?&]seller=([A-Z0-9]{8,16})/i);
      const f = {
        shipsFrom: stripLabel(T(sfEl), LABELS.shipsFrom) || null,
        shipperName: null,
        soldBy: stripLabel(T(sbEl), LABELS.soldBy) || null,
        fulfillerText: T(el.querySelector('#aod-offer-shipsFrom, #aod-offer-soldBy')) || '',
        deliveryText: T(delEl).slice(0, 500),
        importFeesText: '', badges: [], blockText: T(el).slice(0, 800)
      };
      const imp = parseImportFees(f.deliveryText + ' . ' + f.blockText);
      if (imp) f.importFeesText = imp.text;
      f.shipperName = (f.shipsFrom && !rules.foreignCountryAtStart(f.shipsFrom)) ? f.shipsFrom : null;
      f.shipperType = rules.shipperTypeOf(f.shipperName, f.fulfillerText);
      out.push({
        price: price.amount, currency: price.currency,
        sellerName: f.soldBy, sellerId: idm ? idm[1].toUpperCase() : null,
        shipsFrom: f.shipsFrom, shipperName: f.shipperName, shipperType: f.shipperType, deliveryText: f.deliveryText || null,
        deliveryDate: parseDeliveryDate(delEl, f.deliveryText),
        condition: T(el.querySelector('#aod-offer-heading')) || null,
        shippingFields: f
      });
    });
    return out;
  }

  return { SEL, pickImage, extractAsin, canonicalUrl, parsePrice, parseCount, parseRating, parseBsr,
    parseProductDocument, parseListingDocument, parseOffersDocument, extractShippingFields,
    detectBlocked, absUrl, isListingUrl, parseShippingCost, parseImportFees };
});
