/* الزاحف: اكتشاف المنتجات دون كلمات بحث، عبر صفحات الفئات/الأكثر مبيعًا/الجديد/الأكثر طلبًا ثم فحص صفحات المنتجات.
   - طابور محفوظ في IndexedDB (إيقاف/استكمال بلا فقدان).
   - طلب واحد في كل مرة، مع تأخير عشوائي بين الطلبات.
   - عند ظهور CAPTCHA أو طلب تسجيل دخول: يتوقف فورًا ولا يحاول تجاوزه.
   الاعتماديات (fetchHtml, parseHtml, sleep) تُحقن لتسهيل الاختبار. */
(function (root, factory) {
  const dep = (n) => (typeof module === 'object' && module.exports) ? require('./' + n + '.js') : root.ASF[n];
  const api = factory(dep('rules'), dep('parser'), dep('ingest'));
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.ASF = root.ASF || {}; root.ASF.crawler = api; }
})(typeof self !== 'undefined' ? self : this, function (rules, parser, ingest) {

  // صفحات المنتجات أولًا: كل ما اكتُشف يُفحص قبل التوسع في قوائم/فئات جديدة (وإلا استُهلك حد الصفحات في القوائم وحدها)
  const PRIORITY = { product: 1, listing: 2 };

  function withLanguage(url, settings) {
    if (!settings.language) return url;
    try { const u = new URL(url); u.searchParams.set('language', settings.language); return u.toString(); } catch (e) { return url; }
  }

  const scopeOf = (settings) => (settings.catalogScope || []).filter(c => c && c.url);

  function seedUrls(settings) {
    const base = settings.baseUrl || rules.DEFAULT_SETTINGS.baseUrl;
    const scope = scopeOf(settings);
    if (scope.length) return scope.map(c => c.url).concat(settings.extraSeeds || []);
    return rules.SEED_PATHS.map(p => base + p).concat(settings.extraSeeds || []);
  }
  /** عناصر البدء مع اسم الكتالوج عند تحديد نطاق. */
  function seedItems(settings) {
    const scope = scopeOf(settings);
    const byUrl = new Map(scope.map(c => [c.url, c.name]));
    return seedUrls(settings).map(u => ({ url: u, type: 'listing', depth: 0, origin: 'seed', catalog: byUrl.get(u) || null }));
  }
  /** هل الرابط تحت أحد الكتالوجات المحددة؟ (مقارنة المسار) */
  function inScope(url, settings) {
    const scope = scopeOf(settings);
    if (!scope.length) return true;
    let path; try { path = new URL(url).pathname.replace(/\/$/, ''); } catch (e) { return false; }
    return scope.some(c => { try { const root = new URL(c.url).pathname.replace(/\/$/, ''); return path === root || path.startsWith(root + '/'); } catch (e) { return false; } });
  }

  let seqCounter = 0;
  async function enqueue(db, item) {
    const old = await db.get('queue', item.url);
    if (old) return false; // لا نكرر العنصر نفسه
    // seq يحفظ ترتيب الإضافة داخل الميلي‌ثانية نفسها (وإلا رُتّبت البذور أبجديًا بدل ترتيبها الأصلي)
    await db.put('queue', Object.assign({ status: 'pending', attempts: 0, depth: 0, addedAt: new Date().toISOString(), seq: ++seqCounter }, item));
    return true;
  }

  async function seedQueue(db, settings) {
    let n = 0;
    for (const it of seedItems(settings)) if (await enqueue(db, it)) n++;
    return n;
  }

  /** يعيد الطابور إلى حالة قابلة للاستكمال: ما كان "قيد التنفيذ" يعود "معلّقًا". */
  async function resetInFlight(db) {
    const rows = await db.all('queue');
    for (const r of rows) if (r.status === 'running') { r.status = 'pending'; await db.put('queue', r); }
  }

  /** إعادة جدولة تحديث لكل المنتجات المعروفة (صفحات المنتجات فقط). */
  async function enqueueRefresh(db, settings) {
    const base = settings.baseUrl || rules.DEFAULT_SETTINGS.baseUrl;
    const prods = await db.all('products');
    let n = 0;
    for (const p of prods) {
      const url = base + '/dp/' + p.asin;
      const old = await db.get('queue', url);
      if (old) { old.status = 'pending'; old.attempts = 0; old.error = null; await db.put('queue', old); n++; }
      else { await enqueue(db, { url, type: 'product', asin: p.asin, depth: 0, origin: 'refresh' }); n++; }
    }
    return n;
  }

  async function nextPending(db, settings) {
    let rows = (await db.byIndex('queue', 'status', 'pending'));
    const scope = scopeOf(settings || {});
    if (scope.length) {   // ضمن النطاق فقط: عناصر الكتالوجات المحددة، أو عناصر بلا كتالوج وليست بذور عامة
      const names = new Set(scope.map(c => c.name));
      rows = rows.filter(it => it.catalog ? names.has(it.catalog) : it.origin !== 'seed');
    }
    if (!rows.length) return null;
    rows.sort((a, b) => (PRIORITY[a.type] - PRIORITY[b.type]) || (a.depth - b.depth) || (a.addedAt < b.addedAt ? -1 : a.addedAt > b.addedAt ? 1 : ((a.seq || 0) - (b.seq || 0)) || (a.url < b.url ? -1 : 1)));
    // نفضّل صفحات المنتجات غير المفحوصة أولًا لتحقيق هدف الأداة، لكن نُبقي القوائم تتقدم تدريجيًا
    return rows[0];
  }

  async function queueStats(db) {
    const rows = await db.all('queue');
    const s = { total: rows.length, pending: 0, running: 0, done: 0, error: 0, listings: 0, products: 0 };
    rows.forEach(r => { s[r.status] = (s[r.status] || 0) + 1; if (r.type === 'listing') s.listings++; else s.products++; });
    return s;
  }

  /**
   * يشغّل دورة جمع. يتوقف عند: stop() / الحد الأقصى للصفحات / حجب / انتهاء الطابور.
   * @param deps { db, settings, fetchHtml(url)->{status,url,html}, parseHtml(html)->Document, sleep(ms), onProgress(stats), random() }
   */
  function createRunner(deps) {
    const { db, settings } = deps;
    const sleep = deps.sleep || ((ms) => new Promise(r => setTimeout(r, ms)));
    const rnd = deps.random || Math.random;
    let stopRequested = false;
    let running = false;

    const stats = { processed: 0, products: 0, newProducts: 0, listings: 0, errors: 0, blocked: null, stoppedBecause: null };
    const emit = () => deps.onProgress && deps.onProgress(Object.assign({}, stats, { running }));

    async function handleListing(item, doc) {
      const res = parser.parseListingDocument(doc, settings.baseUrl);
      const created = await ingest.ingestListingItems(db, res.items, { source: 'amazon.sa:listing-page', catalog: item.catalog || null });
      stats.newProducts += created;
      stats.listings++;
      for (const it of res.items) {
        await enqueue(db, { url: it.url, type: 'product', asin: it.asin, depth: item.depth, origin: item.url, catalog: item.catalog || null });
      }
      if (res.nextPage && item.depth < settings.maxCategoryDepth + 3 && (item.page || 1) < 3) {
        await enqueue(db, { url: res.nextPage, type: 'listing', depth: item.depth, page: (item.page || 1) + 1, origin: item.url, catalog: item.catalog || null });
      }
      if (item.depth < settings.maxCategoryDepth) {
        for (const c of res.categories) {
          if (!inScope(c.url, settings)) continue;     // عند تحديد كتالوجات: لا نخرج من نطاقها
          await enqueue(db, { url: c.url, type: 'listing', depth: item.depth + 1, origin: item.url, catalog: item.catalog || c.name || null });
        }
      }
      return { items: res.items.length, categories: res.categoryLinks.length };
    }

    async function handleProduct(item, doc, finalUrl) {
      const parsed = parser.parseProductDocument(doc, finalUrl || item.url, { baseUrl: settings.baseUrl });
      if (!parsed.ok) throw Object.assign(new Error('الصفحة ليست صفحة منتج صالحة'), { permanent: true });
      const r = await ingest.ingestProduct(db, parsed, { settings, source: 'amazon.sa:product-page', catalog: item.catalog || null });
      if (r.isNew) stats.newProducts++;
      stats.products++;
      if (settings.fetchCompetitorOffers) {           // تجريبي: طلب إضافي لقائمة العروض
        try {
          await sleep(settings.minDelayMs);
          const base = settings.baseUrl || rules.DEFAULT_SETTINGS.baseUrl;
          const aod = await deps.fetchHtml(base + '/gp/product/ajax/aodAjaxMain/ref=dp_aod_ALL_mbc?asin=' + parsed.asin + '&pc=dp');
          if (aod.status === 200) {
            const offers = parser.parseOffersDocument(deps.parseHtml(aod.html));
            if (offers.length) await ingest.ingestCompetitorOffers(db, parsed.asin, offers, { settings, url: aod.url });
          }
        } catch (e) { await ingest.log(db, 'warn', 'تعذر جلب العروض المنافسة: ' + e.message, { url: item.url }); }
      }
      return r;
    }

    async function processOne(item) {
      item.status = 'running'; await db.put('queue', item);
      let consecutiveBlocks = 0;
      try {
        const resp = await deps.fetchHtml(withLanguage(item.url, settings));
        if (resp.status === 429 || resp.status === 503) {
          const e = new Error('استجابة ' + resp.status + ' (تقييد مؤقت)'); e.throttled = true; throw e;
        }
        if (resp.status === 404) { const e = new Error('الصفحة غير متاحة (404)'); e.permanent = true; throw e; }
        if (resp.status >= 400) throw new Error('استجابة HTTP ' + resp.status);
        const doc = deps.parseHtml(resp.html);
        const blk = parser.detectBlocked(doc, resp.url);
        if (blk.blocked) { const e = new Error('طلبت Amazon التحقق (' + blk.reason + ')'); e.blocked = blk.reason; throw e; }
        if (item.type === 'listing') await handleListing(item, doc);
        else await handleProduct(item, doc, resp.url);
        item.status = 'done'; item.error = null; item.finishedAt = new Date().toISOString();
        await db.put('queue', item);
        stats.processed++;
        return { ok: true };
      } catch (e) {
        item.attempts = (item.attempts || 0) + 1;
        item.error = e.message;
        if (e.blocked) { item.status = 'pending'; item.attempts--; await db.put('queue', item); stats.blocked = e.blocked; }
        else if (e.permanent || item.attempts >= settings.maxAttempts) { item.status = 'error'; await db.put('queue', item); stats.errors++; stats.processed++; }
        else { item.status = 'pending'; item.addedAt = new Date().toISOString(); await db.put('queue', item); }
        await ingest.log(db, e.blocked ? 'warn' : 'error', e.message, { url: item.url, type: item.type, attempts: item.attempts });
        return { ok: false, blocked: e.blocked || null, throttled: !!e.throttled };
      }
    }

    async function run() {
      if (running) return stats;
      running = true; stopRequested = false;
      stats.stoppedBecause = null; stats.blocked = null;
      const scanId = await ingest.startScan(db, 'crawl');
      await resetInFlight(db);
      if ((await queueStats(db)).total === 0) await seedQueue(db, settings);
      let throttles = 0; let n = 0;
      emit();
      while (!stopRequested) {
        if (n >= settings.maxPagesPerRun) { stats.stoppedBecause = 'max_pages'; break; }
        const item = await nextPending(db, settings);
        if (!item) { stats.stoppedBecause = 'queue_empty'; break; }
        const r = await processOne(item);
        n++;
        emit();
        if (r.blocked) { stats.stoppedBecause = 'blocked'; break; }
        if (r.throttled) { throttles++; if (throttles >= settings.stopAfterBlocks) { stats.stoppedBecause = 'throttled'; break; } await sleep(settings.maxDelayMs * 3); }
        else throttles = 0;
        const wait = settings.minDelayMs + rnd() * Math.max(0, settings.maxDelayMs - settings.minDelayMs);
        if (!stopRequested) await sleep(wait);
      }
      if (stopRequested && !stats.stoppedBecause) stats.stoppedBecause = 'user_stop';
      running = false;
      await ingest.finishScan(db, scanId, { processed: stats.processed, newProducts: stats.newProducts,
        errors: stats.errors, status: stats.stoppedBecause });
      emit();
      return stats;
    }

    return { run, stop: () => { stopRequested = true; }, get running() { return running; }, stats };
  }

  /** يجلب أقسام الكتالوج الرئيسية من صفحة الأكثر مبيعًا (تلقائيًا، بلا كلمات بحث). */
  async function discoverCatalogs(deps) {
    const settings = deps.settings; const base = settings.baseUrl || rules.DEFAULT_SETTINGS.baseUrl;
    const resp = await deps.fetchHtml(withLanguage(base + '/gp/bestsellers', settings));
    if (resp.status >= 400) throw new Error('تعذر جلب صفحة الأكثر مبيعًا (HTTP ' + resp.status + ')');
    const doc = deps.parseHtml(resp.html);
    const blk = parser.detectBlocked(doc, resp.url);
    if (blk.blocked) throw new Error('طلبت Amazon التحقق (' + blk.reason + ')؛ لا يمكن اكتشاف الكتالوجات الآن.');
    const res = parser.parseListingDocument(doc, base);
    const seen = new Set(); const out = [];
    for (const c of res.categories) {
      let p; try { p = new URL(c.url).pathname.replace(/\/$/, ''); } catch (e) { continue; }
      if (!/^(?:\/-\/[a-z]{2})?\/gp\/bestsellers\/[^/]+$/.test(p) || seen.has(p) || !c.name) continue;
      seen.add(p); out.push({ name: c.name, url: c.url });
    }
    return out;
  }

  return { discoverCatalogs, seedItems, inScope, createRunner, seedQueue, enqueue, enqueueRefresh, queueStats, seedUrls, resetInFlight, nextPending, withLanguage };
});
