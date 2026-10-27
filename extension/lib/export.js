/* التصدير (CSV / XLSX) والاستيراد (CSV). لا تبعيات خارجية: كاتب XLSX مدمج (ZIP بدون ضغط). */
(function (root, factory) {
  const dep = (n) => (typeof module === 'object' && module.exports) ? require('./' + n + '.js') : root.ASF[n];
  const api = factory(dep('rules'), dep('ingest'));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.ASF = root.ASF || {}; root.ASF.exporter = api; }
})(typeof self !== 'undefined' ? self : this, function (rules, ingest) {

  const STATUS_AR = { confirmed: 'مؤكد', likely: 'مرجح', unknown: 'غير معلوم', local: 'محلي / غير دولي' };
  const STATUS_FROM_AR = Object.fromEntries(Object.entries(STATUS_AR).map(([k, v]) => [v, k]));
  const STRENGTH_AR = { confirmed: 'مؤكد', likely: 'مرجح', local: 'محلي' };

  /* key, عنوان عربي، النوع (text|number), العرض */
  const COLUMNS = [
    { key: 'asin', label: 'ASIN', type: 'text', w: 14 },
    { key: 'title', label: 'اسم المنتج', type: 'text', w: 50 },
    { key: 'brand', label: 'العلامة التجارية', type: 'text', w: 18 },
    { key: 'categoryPath', label: 'الفئة', type: 'text', w: 30 },
    { key: 'url', label: 'رابط المنتج', type: 'text', w: 34 },
    { key: 'imageUrl', label: 'رابط الصورة', type: 'text', w: 30 },
    { key: 'price', label: 'السعر', type: 'number', w: 10 },
    { key: 'currency', label: 'العملة', type: 'text', w: 8 },
    { key: 'listPrice', label: 'السعر السابق', type: 'number', w: 12 },
    { key: 'discountPct', label: 'الخصم %', type: 'number', w: 9 },
    { key: 'catalog', label: 'الكتالوج', type: 'text', w: 22 },
    { key: 'sellerName', label: 'اسم البائع (يباع بواسطة)', type: 'text', w: 24 },
    { key: 'sellerId', label: 'معرف البائع', type: 'text', w: 16 },
    { key: 'shipperName', label: 'اسم الشاحن (يشحن بواسطة)', type: 'text', w: 24 },
    { key: 'sellerIsShipper', label: 'الشاحن هو البائع', type: 'text', w: 12 },
    { key: 'shipperTypeAr', label: 'نوع الشاحن', type: 'text', w: 16 },
    { key: 'handlingMinDays', label: 'مدة التجهيز - من (يوم)', type: 'number', w: 13 },
    { key: 'handlingMaxDays', label: 'مدة التجهيز - إلى (يوم)', type: 'number', w: 13 },
    { key: 'deliveryMinDays', label: 'التوصيل بعد - من (يوم من الفحص)', type: 'number', w: 17 },
    { key: 'deliveryMaxDays', label: 'التوصيل بعد - إلى (يوم من الفحص)', type: 'number', w: 17 },
    { key: 'shipsFrom', label: 'يشحن من (كما ظهر)', type: 'text', w: 20 },
    { key: 'shippingStatusAr', label: 'حالة الشحن الدولي', type: 'text', w: 16 },
    { key: 'shippingOrigin', label: 'بلد الشحن (إن ثبت)', type: 'text', w: 16 },
    { key: 'statusSource', label: 'مصدر الحالة', type: 'text', w: 16 },
    { key: 'userStatusAr', label: 'تصنيف المستخدم اليدوي', type: 'text', w: 16 },
    { key: 'userCountry', label: 'بلد الشحن (يدوي)', type: 'text', w: 14 },
    { key: 'userNote', label: 'دليل المستخدم اليدوي', type: 'text', w: 40 },
    { key: 'userAt', label: 'تاريخ التحقق اليدوي', type: 'text', w: 20 },
    { key: 'evidenceText', label: 'دليل التصنيف', type: 'text', w: 60 },
    { key: 'evidenceSource', label: 'مصدر الدليل', type: 'text', w: 22 },
    { key: 'verifiedAt', label: 'تاريخ التحقق', type: 'text', w: 22 },
    { key: 'deliveryText', label: 'نص التوصيل', type: 'text', w: 40 },
    { key: 'deliveryDate', label: 'موعد التوصيل', type: 'text', w: 18 },
    { key: 'deliveryLocation', label: 'عنوان التوصيل المعتمد', type: 'text', w: 20 },
    { key: 'shippingCost', label: 'سعر الشحن', type: 'number', w: 11 },
    { key: 'importFees', label: 'رسوم الاستيراد المقدرة', type: 'number', w: 14 },
    { key: 'availability', label: 'التوفر', type: 'text', w: 12 },
    { key: 'numOffers', label: 'عدد العروض', type: 'number', w: 10 },
    { key: 'rating', label: 'التقييم', type: 'number', w: 9 },
    { key: 'reviewCount', label: 'عدد المراجعات', type: 'number', w: 12 },
    { key: 'bsrRank', label: 'ترتيب BSR', type: 'number', w: 11 },
    { key: 'bsrCategory', label: 'فئة BSR', type: 'text', w: 24 },
    { key: 'modelNumber', label: 'رقم الموديل', type: 'text', w: 16 },
    { key: 'gtin', label: 'GTIN / الباركود', type: 'text', w: 16 },
    { key: 'dataSource', label: 'مصدر البيانات', type: 'text', w: 22 },
    { key: 'firstSeenAt', label: 'أول اكتشاف', type: 'text', w: 22 },
    { key: 'lastCheckedAt', label: 'آخر فحص', type: 'text', w: 22 },
    { key: 'isBuybox', label: 'عرض الشراء الرئيسي', type: 'text', w: 12 }
  ];
  const COUNTRY_AR = { US: 'الولايات المتحدة', CN: 'الصين', HK: 'هونغ كونغ', AE: 'الإمارات', GB: 'بريطانيا', DE: 'ألمانيا', FR: 'فرنسا', IT: 'إيطاليا', ES: 'إسبانيا', NL: 'هولندا', PL: 'بولندا', SE: 'السويد', CH: 'سويسرا', IN: 'الهند', PK: 'باكستان', JP: 'اليابان', KR: 'كوريا', TW: 'تايوان', SG: 'سنغافورة', MY: 'ماليزيا', TH: 'تايلاند', VN: 'فيتنام', TR: 'تركيا', CA: 'كندا', AU: 'أستراليا', EG: 'مصر', KW: 'الكويت', BH: 'البحرين', QA: 'قطر', OM: 'عمان', JO: 'الأردن' };
  const AVAIL_AR = { in_stock: 'متوفر', out_of_stock: 'غير متوفر' };
  const SHIPPER_TYPE_AR = { amazon: 'أمازون', amazon_global: 'أمازون العالمي', seller: 'البائع (ليس أمازون)' };
  const rangeOf = (a, b) => (a === null || a === undefined) ? null : rules.rangeText(a, b);

  /** صف واحد لكل عرض؛ المنتج بلا عروض (اكتُشف من قائمة فقط) يظهر بصف واحد. */
  function buildRows(products, offers, evidence) {
    const byAsin = new Map(); offers.forEach(o => { if (!byAsin.has(o.asin)) byAsin.set(o.asin, []); byAsin.get(o.asin).push(o); });
    const evByOffer = new Map(); (evidence || []).forEach(e => { if (!evByOffer.has(e.offerKey)) evByOffer.set(e.offerKey, []); evByOffer.get(e.offerKey).push(e); });
    const rows = [];
    for (const p of products) {
      const list = byAsin.get(p.asin) || [null];
      for (const o of list) {
        const ev = o ? (evByOffer.get(o.offerKey) || []) : [];
        const st = o ? (o.userStatus || o.shippingStatus) : p.shippingStatus;
        const isUser = !!(o && o.userStatus);
        const evText = ev.map(e => '[' + (STRENGTH_AR[e.strength] || e.strength) + '] ' + e.field + ': ' + e.text).join(' | ');
        const origin = o ? ((o.shippingOriginCountry && (COUNTRY_AR[o.shippingOriginCountry] || o.shippingOriginCountry)) || o.shippingOriginNote) : null;
        rows.push({
          _asin: p.asin, _offerKey: o ? o.offerKey : null, _evidence: ev,
          asin: p.asin, title: p.title, brand: p.brand, categoryPath: p.categoryPath,
          url: p.url, imageUrl: p.imageUrl,
          price: o ? o.price : (p.listingPrice !== undefined ? p.listingPrice : null),
          currency: o ? o.currency : (p.listingCurrency || null),
          listPrice: o ? o.listPrice : null, discountPct: o ? o.discountPct : null,
          catalog: p.catalog || null,
          sellerName: o ? o.sellerName : null, sellerId: o ? o.sellerId : null, shipsFrom: o ? o.shipsFrom : null,
          shipperName: o ? o.shipperName || null : null,
          sellerIsShipper: o && o.shipperName && o.sellerName ? (rules.foldForMatch(o.shipperName) === rules.foldForMatch(o.sellerName) ? 'نعم' : 'لا') : null,
          deliveryLocation: o ? o.deliveryLocation || null : null,
          shipperType: o ? o.shipperType || null : null,
          shipperTypeAr: o && o.shipperType ? SHIPPER_TYPE_AR[o.shipperType] || o.shipperType : null,
          handlingMinDays: o && o.handlingMinDays !== undefined ? o.handlingMinDays : null,
          handlingMaxDays: o && o.handlingMaxDays !== undefined ? o.handlingMaxDays : null,
          deliveryMinDays: o && o.deliveryMinDays !== undefined ? o.deliveryMinDays : null,
          deliveryMaxDays: o && o.deliveryMaxDays !== undefined ? o.deliveryMaxDays : null,
          handlingText: o ? rangeOf(o.handlingMinDays, o.handlingMaxDays) : null,
          deliveryDaysText: o ? rangeOf(o.deliveryMinDays, o.deliveryMaxDays) : null,
          shippingStatus: st || 'unknown',
          autoStatus: o ? (o.shippingStatus || 'unknown') : null,
          statusSource: o ? (isUser ? 'يدوي من المستخدم' : 'آلي (بالأدلة)') : null,
          userStatusAr: isUser ? STATUS_AR[o.userStatus] : null,
          userCountry: o ? o.userCountry || null : null, userNote: o ? o.userNote || null : null, userAt: o ? o.userAt || null : null,
          shippingStatusAr: p.detailScanned === false && !o ? 'غير معلوم (لم تُفحص صفحة المنتج)' : (STATUS_AR[st] || STATUS_AR.unknown),
          shippingOrigin: origin || null,
          evidenceText: evText || null,
          evidenceSource: ev.length ? Array.from(new Set(ev.map(e => e.source))).join(' | ') : null,
          verifiedAt: o ? o.lastVerifiedAt : null,
          deliveryText: o ? o.deliveryText : null, deliveryDate: o ? o.deliveryDate : null,
          shippingCost: o ? (o.shippingCost === 0 ? 'مجاني' : (o.shippingCost === undefined ? null : o.shippingCost)) : null,
          shippingCostAmount: o ? o.shippingCost : null,
          importFees: o ? o.importFees : null,
          availability: o && o.availability ? (AVAIL_AR[o.availability] || o.availability) : null,
          numOffers: p.numOffers !== undefined ? p.numOffers : null,
          rating: p.rating, reviewCount: p.reviewCount, bsrRank: p.bsrRank, bsrCategory: p.bsrCategory,
          modelNumber: p.modelNumber, gtin: p.gtin,
          dataSource: o ? o.dataSource : (p.sources || []).join(' | '),
          firstSeenAt: p.firstSeenAt, lastCheckedAt: o ? o.lastCheckedAt : p.lastCheckedAt,
          isBuybox: o ? (o.isBuybox ? 'نعم' : 'لا') : null,
          detailScanned: p.detailScanned
        });
      }
    }
    return rows;
  }

  /** شروط الشاحن: نوعه (all|amazon|seller|amazon_global|none) واسمه (كلمات مفصولة بفاصلة = أيٌّ منها؛ «-كلمة» = استبعاد). */
  function parseNameTerms(text) {
    const inc = [], exc = [];
    String(text || '').split(/[,،;\n]+/).map(t => rules.foldForMatch(t)).filter(Boolean).forEach(t => {
      if (t.startsWith('-') && t.length > 1) exc.push(t.slice(1).trim()); else inc.push(t);
    });
    return { inc, exc };
  }
  function matchShipper(row, cond) {
    cond = cond || {};
    const type = cond.type || 'all';
    if (type !== 'all') {
      const t = row.shipperType || null;
      if (type === 'none' ? t !== null : t !== type) return false;
    }
    const { inc, exc } = parseNameTerms(cond.name);
    if (inc.length || exc.length) {
      const name = rules.foldForMatch(row.shipperName || '');
      if (inc.length && !inc.some(t => name.includes(t))) return false;
      if (exc.some(t => name.includes(t))) return false;
    }
    return true;
  }

  /** خلاصة الشحن بالعربية لصف واحد: ما الشاحن؟ كم يومًا؟ هل الشحن دولي؟ (للوحة التفاصيل). */
  function shippingVerdict(row) {
    const st = row.shippingStatus || 'unknown';
    const origin = row.shippingOrigin ? ' (' + row.shippingOrigin + ')' : '';
    const headline = {
      confirmed: 'شحن دولي مؤكد' + origin,
      likely: 'شحن دولي مرجح — غير مؤكد (Amazon.sa لا تذكر بلد الشحن)',
      local: 'تنفيذ محلي — غير دولي',
      unknown: 'غير معلوم — لا قرائن كافية'
    }[st] || 'غير معلوم';
    const lines = [];
    if (row.shipperName || row.shipperTypeAr) lines.push(['الشاحن', (row.shipperName || '—') + (row.shipperTypeAr ? ' — ' + row.shipperTypeAr : '') + (row.sellerIsShipper === 'نعم' ? ' · هو البائع نفسه' : '')]);
    if (row.sellerName && row.sellerIsShipper !== 'نعم') lines.push(['البائع', row.sellerName]);
    if (row.handlingText) lines.push(['مدة التجهيز', row.handlingText + ' يوم']);
    if (row.deliveryDate || row.deliveryDaysText) lines.push(['التوصيل', (row.deliveryDate || '—') + (row.deliveryDaysText ? ' — بعد ' + row.deliveryDaysText + ' يومًا من الفحص' : '')]);
    if (row.shippingCost !== null && row.shippingCost !== undefined) lines.push(['سعر الشحن', row.shippingCost]);
    return { status: st, headline, lines };
  }

  /* ---------------- CSV ---------------- */
  function csvCell(v, type) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return isFinite(v) ? String(v) : '';
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s) && type !== 'number' && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s; // منع حقن الصيغ
    if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }
  function toCSV(rows, columns) {
    columns = columns || COLUMNS;
    const lines = [columns.map(c => csvCell(c.label)).join(',')];
    for (const r of rows) lines.push(columns.map(c => csvCell(r[c.key], c.type)).join(','));
    return '\ufeff' + lines.join('\r\n') + '\r\n';
  }

  function parseCSV(text) {
    let t = String(text || '').replace(/^\ufeff/, '');
    const firstLine = t.split(/\r?\n/)[0] || '';
    const delim = (firstLine.match(/;/g) || []).length > (firstLine.match(/,/g) || []).length ? ';' : (firstLine.includes('\t') && !firstLine.includes(',') ? '\t' : ',');
    const rows = []; let row = []; let cell = ''; let inQ = false;
    for (let i = 0; i < t.length; i++) {
      const ch = t[i];
      if (inQ) {
        if (ch === '"') { if (t[i + 1] === '"') { cell += '"'; i++; } else inQ = false; }
        else cell += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === delim) { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && t[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.length > 1 || row[0] !== '') rows.push(row); row = []; }
      else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }

  const LABEL_TO_KEY = Object.assign(Object.fromEntries(COLUMNS.map(c => [c.label, c.key])), { 'البائع': 'sellerName', 'اسم البائع': 'sellerName', 'تكلفة الشحن': 'shippingCost' });
  const NUM_KEYS = new Set(COLUMNS.filter(c => c.type === 'number').map(c => c.key));

  /** يحوّل نص CSV (مُصدَّر من هذه الأداة أو بأعمدة بالأسماء الإنجليزية/العربية) إلى سجلات. */
  function recordsFromCsv(text) {
    const table = parseCSV(text);
    if (!table.length) return { records: [], skipped: [] };
    const header = table[0].map(h => rules.normalizeText(h));
    const keys = header.map(h => LABEL_TO_KEY[h] || (COLUMNS.find(c => c.key.toLowerCase() === h.toLowerCase()) || {}).key || null);
    const records = [], skipped = [];
    for (let i = 1; i < table.length; i++) {
      const rec = {};
      table[i].forEach((v, j) => {
        const k = keys[j]; if (!k) return;
        let val = String(v).replace(/^'(?=[=+\-@])/, '').trim();
        if (val === '') return;
        if (k === 'shippingCost' && val === 'مجاني') { rec[k] = 0; return; }
        if (NUM_KEYS.has(k)) { const n = parseFloat(rules.normalizeText(val).replace(/,/g, '')); if (!isFinite(n)) return; rec[k] = n; }
        else rec[k] = val;
      });
      const asin = (rec.asin || '').toUpperCase();
      if (!/^[A-Z0-9]{10}$/.test(asin)) { skipped.push({ line: i + 1, reason: 'ASIN غير صالح أو مفقود' }); continue; }
      rec.asin = asin;
      records.push(rec);
    }
    return { records, skipped };
  }

  /** يستورد سجلات CSV: الحالة «مؤكد/مرجح» لا تُقبل بلا نص دليل؛ تُخفَّض إلى «غير معلوم». */
  async function importRecords(db, records) {
    const now = new Date().toISOString();
    let added = 0, updated = 0, downgraded = 0;
    for (const r of records) {
      const old = await db.get('products', r.asin);
      const prod = ingest.mergeDefined(old, {
        asin: r.asin, url: r.url || 'https://www.amazon.sa/dp/' + r.asin, title: r.title, brand: r.brand,
        categoryPath: r.categoryPath, catalog: r.catalog, imageUrl: r.imageUrl, rating: r.rating, reviewCount: r.reviewCount,
        bsrRank: r.bsrRank, bsrCategory: r.bsrCategory, modelNumber: r.modelNumber, gtin: r.gtin,
        listingPrice: r.price, listingCurrency: r.currency
      });
      prod.firstSeenAt = old ? old.firstSeenAt : now;
      prod.detailScanned = old ? old.detailScanned : false;
      prod.shippingStatus = old ? old.shippingStatus : 'unknown';
      prod.sources = Array.from(new Set([].concat(old && old.sources || [], ['csv-import'])));
      await db.put('products', prod);
      old ? updated++ : added++;

      if (r.sellerName || r.sellerId) {
        const key = ingest.offerKeyOf(r.asin, r.sellerId, r.sellerName);
        const oldOffer = await db.get('offers', key);
        let st = STATUS_FROM_AR[r.shippingStatusAr] || 'unknown';
        const manualRow = /^يدوي/.test(r.statusSource || '');   // الحالة المصدَّرة يدوية: لا تُقرأ تصنيفًا آليًا
        if (manualRow) st = 'unknown';
        const hasEvidence = !!r.evidenceText;
        if ((st === 'confirmed' || st === 'likely') && !hasEvidence) { st = 'unknown'; downgraded++; }
        const offer = ingest.mergeDefined(oldOffer, {
          offerKey: key, asin: r.asin, sellerName: r.sellerName, sellerId: r.sellerId, shipperName: r.shipperName, price: r.price, currency: r.currency,
          listPrice: r.listPrice, discountPct: r.discountPct, shipsFrom: r.shipsFrom,
          deliveryText: r.deliveryText, deliveryDate: r.deliveryDate, shippingCost: r.shippingCost, importFees: r.importFees
        });
        offer.shippingStatus = manualRow ? ((oldOffer && oldOffer.shippingStatus) || 'unknown') : (oldOffer && (STATUS_FROM_AR[r.shippingStatusAr] === undefined) ? oldOffer.shippingStatus : st);
        const uSt = STATUS_FROM_AR[r.userStatusAr];
        if (uSt) {
          if ((uSt === 'confirmed' || uSt === 'likely') && String(r.userNote || '').trim().length < 5) downgraded++;   // لا تحقق يدوي بلا دليل
          else { offer.userStatus = uSt; offer.userCountry = r.userCountry || null; offer.userNote = r.userNote || null; offer.userAt = r.userAt || now; }
        }
        offer.shippingNotes = ['مستورد من CSV'];
        offer.firstSeenAt = oldOffer ? oldOffer.firstSeenAt : now;
        offer.lastCheckedAt = now; offer.lastVerifiedAt = r.verifiedAt || now;
        offer.dataSource = 'csv-import'; offer.isBuybox = false;
        await db.put('offers', offer);
        if (hasEvidence && (st === 'confirmed' || st === 'likely')) {
          await db.delByIndex('evidence', 'offerKey', key);
          await db.add('evidence', { offerKey: key, asin: r.asin, signal: 'csv_import_claim',
            strength: st, field: 'csv', text: r.evidenceText, source: 'csv-import', url: null, checkedAt: now });
        }
        const all = await db.byIndex('offers', 'asin', r.asin);
        prod.shippingStatus = ingest.bestStatus(all);
        await db.put('products', prod);
      }
    }
    return { added, updated, downgraded };
  }

  /* ---------------- XLSX (ZIP بدون ضغط) ---------------- */
  const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

  function zipStore(files) { // files: [{name, data:Uint8Array}]
    const enc = new TextEncoder();
    const chunks = []; const central = []; let offset = 0;
    const dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1, dosTime = 0;
    for (const f of files) {
      const name = enc.encode(f.name); const crc = crc32(f.data); const size = f.data.length;
      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 0, true);
      lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true); lh.setUint32(14, crc, true);
      lh.setUint32(18, size, true); lh.setUint32(22, size, true); lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
      chunks.push(new Uint8Array(lh.buffer), name, f.data);
      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true); ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true); ch.setUint32(16, crc, true);
      ch.setUint32(20, size, true); ch.setUint32(24, size, true); ch.setUint16(28, name.length, true);
      ch.setUint32(42, offset, true);
      central.push(new Uint8Array(ch.buffer), name);
      offset += 30 + name.length + size;
    }
    let csize = 0; central.forEach(c => csize += c.length);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
    end.setUint32(12, csize, true); end.setUint32(16, offset, true);
    const all = chunks.concat(central, [new Uint8Array(end.buffer)]);
    let total = 0; all.forEach(c => total += c.length);
    const out = new Uint8Array(total); let p = 0; all.forEach(c => { out.set(c, p); p += c.length; });
    return out;
  }

  const xmlEsc = (s) => String(s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  function colName(i) { let s = ''; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }

  function buildXlsx(rows, columns, sheetName) {
    columns = columns || COLUMNS;
    const enc = new TextEncoder();
    const cellStr = (ref, v, style) => '<c r="' + ref + '" t="inlineStr"' + (style ? ' s="' + style + '"' : '') + '><is><t xml:space="preserve">' + xmlEsc(v) + '</t></is></c>';
    let sheetRows = '<row r="1">' + columns.map((c, i) => cellStr(colName(i) + '1', c.label, 1)).join('') + '</row>';
    rows.forEach((r, ri) => {
      const n = ri + 2;
      let cells = '';
      columns.forEach((c, ci) => {
        const v = r[c.key]; const ref = colName(ci) + n;
        if (v === null || v === undefined || v === '') return;       // لا نكتب قيمًا وهمية للبيانات المفقودة
        if (typeof v === 'number' && isFinite(v)) cells += '<c r="' + ref + '"><v>' + v + '</v></c>';
        else cells += cellStr(ref, v);
      });
      sheetRows += '<row r="' + n + '">' + cells + '</row>';
    });
    const lastCol = colName(columns.length - 1);
    const sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetViews><sheetView rightToLeft="1" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
      '<sheetFormatPr defaultRowHeight="15"/>' +
      '<cols>' + columns.map((c, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + (c.w || 14) + '" customWidth="1"/>').join('') + '</cols>' +
      '<sheetData>' + sheetRows + '</sheetData>' +
      '<autoFilter ref="A1:' + lastCol + (rows.length + 1) + '"/></worksheet>';
    const styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
      '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFDCE9E6"/><bgColor indexed="64"/></patternFill></fill></fills>' +
      '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"><alignment horizontal="right"/></xf></cellXfs>' +
      '</styleSheet>';
    const files = [
      { name: '[Content_Types].xml', data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>') },
      { name: '_rels/.rels', data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>') },
      { name: 'xl/workbook.xml', data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="' + xmlEsc((sheetName || 'المنتجات').slice(0, 31)) + '" sheetId="1" r:id="rId1"/></sheets></workbook>') },
      { name: 'xl/_rels/workbook.xml.rels', data: enc.encode('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>') },
      { name: 'xl/styles.xml', data: enc.encode(styles) },
      { name: 'xl/worksheets/sheet1.xml', data: enc.encode(sheet) }
    ];
    return zipStore(files);
  }

  return { matchShipper, parseNameTerms, shippingVerdict, COLUMNS, SHIPPER_TYPE_AR, STATUS_AR, STATUS_FROM_AR, buildRows, toCSV, parseCSV, recordsFromCsv, importRecords, buildXlsx, csvCell };
});
