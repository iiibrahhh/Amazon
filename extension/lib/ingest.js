/* إدخال النتائج المستخرجة إلى قاعدة البيانات: دمج بلا تكرار، سجل أسعار، أدلة الشحن، سجل الفحوصات. */
(function (root, factory) {
  const dep = (n) => (typeof module === 'object' && module.exports) ? require('./' + n + '.js') : root.ASF[n];
  const api = factory(dep('rules'), dep('classifier'));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.ASF = root.ASF || {}; root.ASF.ingest = api; }
})(typeof self !== 'undefined' ? self : this, function (rules, classifier) {

  const { STATUS } = rules;
  const isEmpty = (v) => v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length);

  /** يدمج الحقول الجديدة غير الفارغة فوق السجل القديم (لا تُمحى قيمة قديمة بقيمة فارغة). */
  function mergeDefined(oldRec, newRec) {
    const out = Object.assign({}, oldRec || {});
    for (const [k, v] of Object.entries(newRec)) if (!isEmpty(v)) out[k] = v;
    return out;
  }

  function slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9\u0621-\u064a]+/g, '-').replace(/^-|-$/g, '').slice(0, 60); }
  function offerKeyOf(asin, sellerId, sellerName) {
    return asin + '|' + (sellerId ? sellerId.toUpperCase() : (slug(sellerName) || 'unknown'));
  }

  /** الحالة الفعلية للعرض: تحقق المستخدم اليدوي إن وُجد، وإلا التصنيف الآلي. الحقلان يبقيان منفصلين دائمًا. */
  function effectiveStatus(o) { return (o && (o.userStatus || o.shippingStatus)) || 'unknown'; }

  function bestStatus(offers) {
    let best = null;
    for (const o of offers) {
      const s = STATUS[effectiveStatus(o)] || STATUS.unknown;
      if (!best || s.rank > best.rank) best = s;
    }
    return best ? best.key : 'unknown';
  }

  function classifierOpts(ctx, url) {
    const st = ctx.settings || {};
    return { source: ctx.source, url, now: ctx.now, importFeesAsConfirmed: !!st.importFeesAsConfirmed,
      intlMinHandlingDays: st.intlMinHandlingDays, intlMinDeliveryDays: st.intlMinDeliveryDays, intlMinTransitDays: st.intlMinTransitDays, sellerAddressAsConfirmed: !!st.sellerAddressAsConfirmed };
  }

  async function log(db, level, msg, ctx) {
    await db.add('logs', { at: new Date().toISOString(), level, msg, ctx: ctx || null });
    const n = await db.count('logs');
    if (n > 2500) { const all = await db.all('logs'); /* احتفظ بآخر 2000 */
      await db.clear('logs'); for (const r of all.slice(-2000)) await db.add('logs', r); }
  }

  async function startScan(db, type, extra) {
    return db.add('scans', Object.assign({ type, startedAt: new Date().toISOString(), finishedAt: null,
      processed: 0, newProducts: 0, errors: 0, status: 'running' }, extra || {}));
  }
  async function finishScan(db, id, patch) {
    const s = await db.get('scans', id);
    if (!s) return;
    await db.put('scans', Object.assign({}, s, patch, { finishedAt: new Date().toISOString() }));
  }

  async function writeOffer(db, asin, offerIn, classification, ctx, isBuybox) {
    const now = ctx.now;
    const key = offerKeyOf(asin, offerIn.sellerId, offerIn.sellerName);
    const old = await db.get('offers', key);
    const rec = mergeDefined(old, {
      offerKey: key, asin,
      sellerName: offerIn.sellerName, sellerId: offerIn.sellerId,
      price: offerIn.price, currency: offerIn.currency,
      listPrice: offerIn.listPrice, discountPct: offerIn.discountPct,
      availability: offerIn.availability, availabilityText: offerIn.availabilityText,
      shipsFrom: offerIn.shipsFrom, shipperName: offerIn.shipperName, deliveryLocation: offerIn.deliveryLocation,
      fulfillerText: offerIn.fulfillerText,
      deliveryText: offerIn.deliveryText, deliveryDate: offerIn.deliveryDate,
      shippingCost: offerIn.shippingCost, shippingCostText: offerIn.shippingCostText,
      importFees: offerIn.importFees, importFeesText: offerIn.importFeesText,
      numOffers: offerIn.numOffers,
      condition: offerIn.condition
    });
    // حقول مشتقة تُستبدل في كل فحص (لا تُدمج) كي لا تبقى مدد قديمة
    rec.shipperType = offerIn.shipperType || null;
    rec.shipperName = offerIn.shipperName || null;   // تُستبدل في كل فحص: ما لم يثبت الآن لا يُبقى قديمه
    rec.shipsFrom = offerIn.shipsFrom || null;
    rec.sellerProfile = offerIn.sellerProfile || null;   // عنوان نشاط البائع من صفحته (إن جُلبت)
    rec.extraction = offerIn.extraction || null;      // دليل الاستخراج (الطريقة/التسمية/النص) للبائع والشاحن والنوع
    rec.handlingMinDays = offerIn.handlingMinDays !== undefined ? offerIn.handlingMinDays : null;
    rec.handlingMaxDays = offerIn.handlingMaxDays !== undefined ? offerIn.handlingMaxDays : null;
    rec.deliveryMinDays = offerIn.deliveryMinDays !== undefined ? offerIn.deliveryMinDays : null;
    rec.deliveryMaxDays = offerIn.deliveryMaxDays !== undefined ? offerIn.deliveryMaxDays : null;
    rec.deliveryStart = offerIn.deliveryStart || null;
    rec.deliveryEnd = offerIn.deliveryEnd || null;
    rec.deliveryDaysAsOf = now;
    rec.shippingStatus = classification.status;
    rec.shippingOriginCountry = classification.originCountry || null;
    rec.shippingOriginNote = classification.originNote || null;
    rec.shippingNotes = classification.notes;
    rec.previousShippingStatus = old ? old.shippingStatus : null;
    rec.lastVerifiedAt = now;
    rec.lastCheckedAt = now;
    rec.firstSeenAt = old ? old.firstSeenAt : now;
    rec.isBuybox = isBuybox ? true : (old ? !!old.isBuybox : false);
    rec.dataSource = ctx.source || 'amazon.sa:product-page';
    await db.put('offers', rec);

    // سجل الأسعار — عند التغيّر فقط
    if (offerIn.price !== null && offerIn.price !== undefined && (!old || old.price !== offerIn.price)) {
      await db.add('priceHistory', { offerKey: key, asin, price: offerIn.price, currency: offerIn.currency || null, at: now, source: rec.dataSource });
    }
    // الأدلة: تستبدل أدلة العرض السابقة بأدلة آخر فحص
    await db.delByIndex('evidence', 'offerKey', key);
    for (const e of classification.evidence) {
      await db.add('evidence', Object.assign({ offerKey: key, asin }, e));
    }
    return rec;
  }

  /** يدخل نتيجة تحليل صفحة منتج كاملة. */
  async function ingestProduct(db, parsed, ctx) {
    ctx = Object.assign({ now: new Date().toISOString(), source: 'amazon.sa:product-page', settings: {} }, ctx || {});
    if (!parsed || !parsed.ok || !parsed.asin) throw new Error('لا توجد بيانات منتج صالحة (ASIN مفقود)');
    const asin = parsed.asin;
    const old = await db.get('products', asin);

    // صفحة البائع المخزّنة (إن وُجدت): عنوان نشاطه يدخل التصنيف كقرينة ويُحفظ مع العرض
    const sid = parsed.offer && parsed.offer.sellerId;
    const sp = sid ? await db.get('sources', 'seller:' + String(sid).toUpperCase()) : null;
    if (sp && sp.ok && sp.countryCode) {
      const info = { code: sp.countryCode, isSaudi: !!sp.isSaudi, isForeign: !!sp.isForeign, addressText: sp.addressText, url: sp.url, label: sp.evidence && sp.evidence.label, text: sp.evidence && sp.evidence.text, checkedAt: sp.checkedAt };
      parsed = Object.assign({}, parsed, { shippingFields: Object.assign({}, parsed.shippingFields, { sellerCountry: info }), offer: Object.assign({}, parsed.offer, { sellerProfile: info }) });
    }
    const cls = classifier.classifyShipping(parsed.shippingFields, classifierOpts(ctx, parsed.url));

    const prod = mergeDefined(old, {
      asin, url: parsed.url, title: parsed.title, brand: parsed.brand, categoryPath: parsed.categoryPath,
      description: parsed.description, modelNumber: parsed.modelNumber, gtin: parsed.gtin,
      imageUrl: parsed.imageUrl, rating: parsed.rating, reviewCount: parsed.reviewCount,
      bsrRank: parsed.bsrRank, bsrCategory: parsed.bsrCategory, bsrAll: parsed.bsrAll,
      numOffers: parsed.offer.numOffers, fieldsMissing: parsed.fieldsMissing
    });
    prod.firstSeenAt = old ? old.firstSeenAt : ctx.now;
    prod.lastCheckedAt = ctx.now;
    prod.detailScanned = true;
    prod.fieldsMissing = parsed.fieldsMissing;
    prod.sources = Array.from(new Set([].concat(old && old.sources || [], [ctx.source])));
    prod.shippingStatus = old ? old.shippingStatus : 'unknown';
    // الكتالوج: الأولوية لما حُدِّد عند الاكتشاف من قائمة، وإلا أول عنصر في مسار الفئة بصفحة المنتج
    prod.catalog = (old && old.catalog) || ctx.catalog || parsed.catalogTop || null;
    await db.put('products', prod);

    const offer = await writeOffer(db, asin, parsed.offer, cls, ctx, true);

    const offers = await db.byIndex('offers', 'asin', asin);
    prod.shippingStatus = bestStatus(offers);
    await db.put('products', prod);
    return { isNew: !old, asin, classification: cls, offer, product: prod };
  }

  /** يدخل العروض المنافسة (قائمة AOD). */
  async function ingestCompetitorOffers(db, asin, offers, ctx) {
    ctx = Object.assign({ now: new Date().toISOString(), source: 'amazon.sa:offers-list' }, ctx || {});
    let n = 0;
    for (const o of offers) {
      const cls = classifier.classifyShipping(o.shippingFields, classifierOpts(ctx, ctx.url));
      await writeOffer(db, asin, o, cls, ctx, false);
      n++;
    }
    const prod = await db.get('products', asin);
    if (prod) {
      const all = await db.byIndex('offers', 'asin', asin);
      prod.shippingStatus = bestStatus(all);
      prod.numOffers = Math.max(prod.numOffers || 0, all.length);
      await db.put('products', prod);
    }
    return n;
  }

  /** يدخل منتجات من صفحات القوائم (بيانات جزئية، بلا حكم على الشحن). */
  const RANKED_KINDS = new Set(['bestsellers', 'new-releases', 'movers', 'most-wished']);
  /** يسجل ترتيب المنتج: في قائمة قسم (ctx.listKey/listKind) أو في نتائج بحث (ctx.query). الإعلانات والعناصر بلا ترتيب لا تُسجَّل. */
  function applyRank(rec, old, it, ctx) {
    const rank = it.rank;
    rec.listRanks = Object.assign({}, old && old.listRanks); rec.searchRanks = Object.assign({}, old && old.searchRanks);
    if (rank !== null && rank !== undefined && rank > 0) {
      if (ctx.query) {
        rec.searchRanks[ctx.query] = { rank, at: ctx.now };
        const keys = Object.keys(rec.searchRanks).sort((a, b) => rec.searchRanks[b].at < rec.searchRanks[a].at ? -1 : 1);
        keys.slice(10).forEach(k => delete rec.searchRanks[k]);       // نحتفظ بآخر 10 عبارات بحث
      } else if (ctx.listKey && RANKED_KINDS.has(ctx.listKind)) {
        rec.listRanks[ctx.listKey] = { rank, kind: ctx.listKind, basis: it.rankBasis || null, at: ctx.now };
      }
    }
    // سجل الترتيب لكل قائمة/عبارة بحث، وسرعة التغيّر: move = ln(الترتيب السابق / الحالي) (موجب = تحسّن). الأكبر مطلقًا بين المفاتيح هو المعروض.
    rec.rankHistory = Object.assign({}, old && old.rankHistory);
    if (rank !== null && rank !== undefined && rank > 0 && (ctx.query || (ctx.listKey && RANKED_KINDS.has(ctx.listKind)))) {
      const key = ctx.query ? 'search:' + ctx.query : 'list:' + ctx.listKey;
      const h = (rec.rankHistory[key] || []).slice(), last = h[h.length - 1];
      if (!last || last.rank !== rank || Date.parse(ctx.now) - Date.parse(last.at) > 12 * 3600 * 1000) h.push({ rank, at: ctx.now });
      rec.rankHistory[key] = h.slice(-12);
      Object.keys(rec.rankHistory).sort((a, b) => { const la = rec.rankHistory[a].slice(-1)[0].at, lb = rec.rankHistory[b].slice(-1)[0].at; return la < lb ? 1 : -1; }).slice(20).forEach(k => delete rec.rankHistory[k]);
    }
    let best = null;
    Object.entries(rec.rankHistory).forEach(([k, h]) => {
      if (h.length < 2) return;
      const cur = h[h.length - 1], prev = h[h.length - 2], mv = Math.log(prev.rank / cur.rank);
      if (!best || Math.abs(mv) > Math.abs(best.mv)) best = { mv, k, prev: prev.rank, cur: cur.rank, at: cur.at };
    });
    rec.rankMove = best ? Math.round(best.mv * 1000) / 1000 : null;
    rec.rankMoveText = best ? 'من #' + best.prev + ' إلى #' + best.cur + ' (' + best.k.replace(/^(?:list|search):/, '') + ')' : null;
    rec.rankMoveAt = best ? best.at : null;
    const lr = Object.values(rec.listRanks).map(x => x.rank), sr = Object.entries(rec.searchRanks).sort((a, b) => a[1].at < b[1].at ? 1 : -1);
    rec.bestListRank = lr.length ? Math.min.apply(null, lr) : null;
    rec.bestListCatalog = lr.length ? Object.keys(rec.listRanks).find(k => rec.listRanks[k].rank === rec.bestListRank) : null;
    rec.latestSearchRank = sr.length ? sr[0][1].rank : null;
    rec.latestSearchQuery = sr.length ? sr[0][0] : null;
  }

  /** بيانات التاجر للمنتج (حالة المتابعة، ملاحظة، تكاليف). تُمرَّر منقّاة؛ null تحذفها. */
  /** خصوصية: يحذف اسم المستخدم من «اسم - المدينة» في العروض القديمة ويُبقي المدينة. يعيد عدد ما عُدّل. */
  async function scrubDeliveryLocations(db) {
    let n = 0;
    for (const o of await db.all('offers')) {
      const m = typeof o.deliveryLocation === 'string' && o.deliveryLocation.match(/^([^\d\-–—]{1,40}?)\s+[-–—]\s+(\S.*)$/);
      if (m && m[1].trim().split(/\s+/).length <= 3) { o.deliveryLocation = m[2].trim(); await db.put('offers', o); n++; }
    }
    return n;
  }
  /** مورد مقترح تلقائيًا (لا يمس المورد المعتمد من التاجر). null يحذفه. */
  async function setSupplierSuggestion(db, asin, s) {
    const p = await db.get('products', asin);
    if (!p) throw new Error('المنتج غير موجود: ' + asin);
    if (!s) delete p.supplierSuggestion; else p.supplierSuggestion = Object.assign({}, s, { fetchedAt: new Date().toISOString() });
    await db.put('products', p);
  }
  async function setMerchantData(db, asin, clean) {
    const p = await db.get('products', asin);
    if (!p) throw new Error('المنتج غير موجود: ' + asin);
    if (!clean) delete p.merchant; else p.merchant = Object.assign({}, clean, { updatedAt: new Date().toISOString() });
    await db.put('products', p);
    return p.merchant || null;
  }

  async function ingestListingItems(db, items, ctx) {
    ctx = Object.assign({ now: new Date().toISOString(), source: 'amazon.sa:listing-page' }, ctx || {});
    let created = 0;
    for (const it of items) {
      if (!it.asin) continue;
      const old = await db.get('products', it.asin);
      const rec = mergeDefined(old, {
        asin: it.asin, url: it.url, title: it.title, imageUrl: it.imageUrl,
        rating: it.rating, reviewCount: it.reviewCount, listingPrice: it.price, listingCurrency: it.currency
      });
      if (!old) {
        created++;
        rec.firstSeenAt = ctx.now; rec.detailScanned = false; rec.shippingStatus = 'unknown';
        rec.lastCheckedAt = null;
      }
      // لا نعدّل lastCheckedAt للمنتجات المفحوصة سابقًا — الفحص = صفحة المنتج فقط
      rec.sources = Array.from(new Set([].concat(old && old.sources || [], [ctx.source])));
      rec.lastSeenInListingAt = ctx.now;
      rec.catalog = (old && old.catalog) || ctx.catalog || null;
      applyRank(rec, old, it, ctx);
      await db.put('products', rec);
    }
    return created;
  }

  /** حذف منتجات وكل ما يتبعها. */
  async function deleteProducts(db, asins) {
    for (const asin of asins) {
      const offers = await db.byIndex('offers', 'asin', asin);
      for (const o of offers) { await db.del('offers', o.offerKey); }
      await db.delByIndex('evidence', 'asin', asin);
      await db.delByIndex('priceHistory', 'asin', asin);
      await db.del('products', asin);
      await db.del('queue', 'https://www.amazon.sa/dp/' + asin);
    }
  }

  const USER_STATUSES = ['confirmed', 'likely', 'local', 'unknown'];
  /** تحقق يدوي من المستخدم. يُشترط نص دليل للحالتين «مؤكد/مرجح». لا يمسّه أي فحص آلي لاحق. */
  async function setUserVerdict(db, offerKey, v) {
    const o = await db.get('offers', offerKey);
    if (!o) throw new Error('العرض غير موجود');
    if (!USER_STATUSES.includes(v.status)) throw new Error('حالة غير صالحة');
    const note = String(v.note || '').trim();
    if ((v.status === 'confirmed' || v.status === 'likely') && note.length < 5) throw new Error('اكتب دليلك (5 أحرف على الأقل): من أين عرفت أن الشحن دولي؟');
    o.userStatus = v.status; o.userCountry = String(v.country || '').trim() || null;
    o.userNote = note || null; o.userAt = v.now || new Date().toISOString();
    await db.put('offers', o);
    const p = await db.get('products', o.asin);
    if (p) { p.shippingStatus = bestStatus(await db.byIndex('offers', 'asin', o.asin)); await db.put('products', p); }
    return o;
  }
  async function clearUserVerdict(db, offerKey) {
    const o = await db.get('offers', offerKey); if (!o) return null;
    delete o.userStatus; delete o.userCountry; delete o.userNote; delete o.userAt;
    await db.put('offers', o);
    const p = await db.get('products', o.asin);
    if (p) { p.shippingStatus = bestStatus(await db.byIndex('offers', 'asin', o.asin)); await db.put('products', p); }
    return o;
  }

  return { setSupplierSuggestion, scrubDeliveryLocations, setMerchantData, effectiveStatus, setUserVerdict, clearUserVerdict, ingestProduct, ingestCompetitorOffers, ingestListingItems, deleteProducts, startScan, finishScan,
    log, mergeDefined, offerKeyOf, bestStatus };
});
