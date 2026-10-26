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
      intlMinHandlingDays: st.intlMinHandlingDays, intlMinDeliveryDays: st.intlMinDeliveryDays };
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

  return { effectiveStatus, setUserVerdict, clearUserVerdict, ingestProduct, ingestCompetitorOffers, ingestListingItems, deleteProducts, startScan, finishScan,
    log, mergeDefined, offerKeyOf, bestStatus };
});
