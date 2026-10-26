/* لوحة التحكم — تعمل كصفحة إضافة، وتشغّل الزاحف مباشرة (يجب إبقاء التبويب مفتوحًا أثناء الجمع). */
(function () {
  const { rules, parser, db: dbLib, ingest, exporter, crawler, search } = self.ASF;
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = (iso) => { if (!iso) return '—'; const d = new Date(iso); return isNaN(d) ? '—' : d.toLocaleString('ar-SA-u-nu-latn', { dateStyle: 'short', timeStyle: 'short' }); };
  const fmtNum = (n) => (n === null || n === undefined) ? '—' : Number(n).toLocaleString('en-US');
  const STATUS_AR = exporter.STATUS_AR;

  const state = {
    db: null, settings: Object.assign({}, rules.DEFAULT_SETTINGS), products: [], offers: [], rows: [], view: [],
    sort: { key: 'checked', dir: 'desc' }, page: 1, perPage: 50, selected: new Set(), active: null, runner: null, wake: null, lastRefresh: 0, focus: null, focusLabel: '', searching: false, searchStop: false
  };

  /* ---------------- إعدادات ---------------- */
  async function loadSettings() {
    const { settings } = await chrome.storage.local.get('settings');
    state.settings = Object.assign({}, rules.DEFAULT_SETTINGS, settings || {});
  }
  async function saveSettings(s) { state.settings = s; await chrome.storage.local.set({ settings: s }); }

  /* ---------------- بيانات ---------------- */
  const rowKey = (r) => r._offerKey || r._asin;
  async function reload() {
    state.products = await state.db.all('products');
    state.offers = await state.db.all('offers');
    state.rows = exporter.buildRows(state.products, state.offers, []);
    refreshCatalogFilter();
    applyView();
    renderStats();
  }

  function applyView() {
    const q = rules.foldForMatch($('search').value);
    const st = $('filter-status').value;
    let rows = state.rows;
    if (state.focus) rows = rows.filter(r => state.focus.has(r._asin));
    if (st === 'unscanned') rows = rows.filter(r => r.detailScanned === false && !r._offerKey);
    else if (st !== 'all') rows = rows.filter(r => r.shippingStatus === st && (r._offerKey || r.detailScanned !== false));
    const cat = $('filter-catalog').value;
    if (cat !== 'all') rows = rows.filter(r => (r.catalog || '') === cat);
    if (q) rows = rows.filter(r => rules.foldForMatch([r.title, r.asin, r.brand, r.sellerName].join(' ')).includes(q));
    const { key, dir } = state.sort; const m = dir === 'asc' ? 1 : -1;
    const val = (r) => key === 'status' ? (rules.STATUS[r.shippingStatus] || rules.STATUS.unknown).rank
      : key === 'checked' ? (r.lastCheckedAt || '') : key === 'price' ? r.price : key === 'rating' ? r.rating
      : key === 'handling' ? r.handlingMinDays : key === 'delivery' ? r.deliveryMinDays
      : key === 'catalog' ? rules.foldForMatch(r.catalog || '')
      : key === 'title' ? rules.foldForMatch(r.title || '') : (r.asin || '');
    rows = rows.slice().sort((a, b) => {
      const x = val(a), y = val(b);
      const nx = x === null || x === undefined || x === '', ny = y === null || y === undefined || y === '';
      if (nx && ny) return 0; if (nx) return 1; if (ny) return -1;   // المفقود دائمًا في النهاية
      return (x < y ? -1 : x > y ? 1 : 0) * m;
    });
    state.view = rows;
    const pages = Math.max(1, Math.ceil(rows.length / state.perPage));
    if (state.page > pages) state.page = pages;
    renderTable();
  }

  /* ---------------- الكتالوج ---------------- */
  function refreshCatalogFilter() {
    const sel = $('filter-catalog'); const cur = sel.value;
    const names = Array.from(new Set(state.products.map(p => p.catalog).filter(Boolean))).sort((a, b) => a.localeCompare(b, 'ar'));
    sel.innerHTML = '<option value="all">كل الكتالوجات</option>' + names.map(n => '<option value="' + esc(n) + '">' + esc(n) + '</option>').join('');
    sel.value = names.includes(cur) ? cur : 'all';
  }
  function renderScope() {
    const known = state.settings.knownCatalogs || [], chosen = new Set((state.settings.catalogScope || []).map(c => c.url));
    $('scope-list').innerHTML = known.length ? known.map(c => '<label><input type="checkbox" data-url="' + esc(c.url) + '" data-name="' + esc(c.name) + '"' + (chosen.has(c.url) ? ' checked' : '') + '> ' + esc(c.name) + '</label>').join('')
      : '<span class="muted">لم تُكتشف كتالوجات بعد. اضغط «اكتشاف الكتالوجات».</span>';
    const n = chosen.size;
    $('scope-summary').textContent = 'نطاق الجمع: ' + (n ? n + ' كتالوج محدد (' + state.settings.catalogScope.map(c => c.name).join('، ') + ')' : 'كل الكتالوجات');
  }

  /* ---------------- عرض ---------------- */
  function badge(st, unscanned, manual) {
    if (manual) return '<span class="badge ' + esc(st) + '" title="تحقق يدوي من المستخدم، وليس تصنيفًا آليًا">' + esc(STATUS_AR[st] || STATUS_AR.unknown) + ' (يدوي)</span>';
    if (unscanned) return '<span class="badge unknown" title="لم تُفحص صفحة المنتج بعد">غير معلوم — لم يُفحص</span>';
    return '<span class="badge ' + esc(st) + '">' + esc(STATUS_AR[st] || STATUS_AR.unknown) + '</span>';
  }
  function renderStats() {
    const p = state.products;
    const c = (k) => p.filter(x => x.shippingStatus === k).length;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const scannedToday = p.filter(x => x.lastCheckedAt && new Date(x.lastCheckedAt) >= today).length;
    const last = p.reduce((m, x) => (x.lastCheckedAt && x.lastCheckedAt > m ? x.lastCheckedAt : m), '');
    const unscanned = p.filter(x => x.detailScanned === false).length;
    const cells = [
      [fmtNum(p.length), 'إجمالي المنتجات المكتشفة'],
      [fmtNum(c('confirmed')), 'شحن دولي مؤكد'],
      [fmtNum(c('likely')), 'شحن دولي مرجح'],
      [fmtNum(p.filter(x => x.shippingStatus === 'unknown' && x.detailScanned !== false).length), 'لا تتوفر معلومات كافية'],
      [fmtNum(unscanned), 'لم تُفحص صفحاتها بعد'],
      [fmtNum(scannedToday), 'فُحصت اليوم'],
      [last ? fmtDate(last) : '—', 'آخر تحديث للبيانات']
    ];
    $('stats').innerHTML = cells.map(([n, l]) => '<div class="s"><div class="n' + (String(n).length > 8 ? '" style="font-size:16px' : '') + '">' + esc(n) + '</div><div class="l">' + esc(l) + '</div></div>').join('');
  }
  function renderTable() {
    const start = (state.page - 1) * state.perPage;
    const slice = state.view.slice(start, start + state.perPage);
    $('tbody').innerHTML = slice.map(r => {
      const k = rowKey(r);
      const unscanned = r.detailScanned === false && !r._offerKey;
      return '<tr class="row' + (state.active === k ? ' active' : '') + '" data-k="' + esc(k) + '">' +
        '<td class="chk"><input type="checkbox" class="sel" data-k="' + esc(k) + '"' + (state.selected.has(k) ? ' checked' : '') + ' aria-label="تحديد"></td>' +
        '<td>' + (r.imageUrl ? '<img loading="lazy" referrerpolicy="no-referrer" alt="" src="' + esc(r.imageUrl) + '">' : '') + '</td>' +
        '<td class="title"><div class="t">' + esc(r.title || '— (بلا اسم)') + '</div></td>' +
        '<td><span class="ltr">' + esc(r.asin) + '</span></td>' +
        '<td>' + esc(r.catalog || '—') + '</td>' +
        '<td class="num">' + (r.price !== null && r.price !== undefined ? fmtNum(r.price) + ' <span class="muted">' + esc(r.currency || '') + '</span>' : '<span class="muted">—</span>') + '</td>' +
        '<td>' + esc(r.sellerName || '—') + '</td>' +
        '<td>' + esc(r.shipperName || '—') + (r.sellerIsShipper === 'نعم' ? ' <span class="muted">(هو البائع)</span>' : '') + '</td>' +
        '<td>' + esc(r.shipperTypeAr || '—') + '</td>' +
        '<td class="num">' + (r.handlingText ? '<span class="ltr">' + esc(r.handlingText) + '</span>' : '—') + '</td>' +
        '<td class="num">' + (r.deliveryDaysText ? '<span class="ltr">' + esc(r.deliveryDaysText) + '</span>' : '—') + '</td>' +
        '<td>' + esc(r.shippingOrigin || '—') + '</td>' +
        '<td>' + badge(r.shippingStatus, unscanned, !!(r.statusSource && /^يدوي/.test(r.statusSource))) + '</td>' +
        '<td class="num">' + (r.shippingCost === 'مجاني' ? 'مجاني' : (r.shippingCost !== null && r.shippingCost !== undefined ? fmtNum(r.shippingCost) : '<span class="muted">—</span>')) + '</td>' +
        '<td class="num">' + (r.importFees !== null && r.importFees !== undefined ? fmtNum(r.importFees) : '<span class="muted">—</span>') + '</td>' +
        '<td>' + esc(r.deliveryDate || '—') + (r.deliveryLocation ? '<br><span class="muted">إلى: ' + esc(r.deliveryLocation) + '</span>' : '') + '</td>' +
        '<td class="num">' + (r.rating !== null && r.rating !== undefined ? esc(r.rating) + ' <span class="muted">(' + fmtNum(r.reviewCount) + ')</span>' : '<span class="muted">—</span>') + '</td>' +
        '<td class="muted">' + esc(r.dataSource || '—') + '</td>' +
        '<td class="muted">' + esc(fmtDate(r.lastCheckedAt)) + '</td>' +
        '<td><button data-act="open" data-url="' + esc(r.url) + '">فتح</button> <button data-act="copy" data-url="' + esc(r.url) + '">نسخ</button></td></tr>';
    }).join('');
    const empty = $('empty');
    empty.hidden = state.view.length > 0;
    if (!state.view.length) empty.textContent = state.products.length ? 'لا توجد نتائج مطابقة للبحث أو التصفية.' : 'لا توجد منتجات بعد. ابحث عن منتج من الأعلى، أو اضغط «بدء الجمع»، أو افتح صفحة منتج على Amazon.sa لتُلتقط تلقائيًا.';
    const pages = Math.max(1, Math.ceil(state.view.length / state.perPage));
    $('pager').innerHTML = '<button id="pg-prev"' + (state.page <= 1 ? ' disabled' : '') + '>السابق</button>' +
      '<span>صفحة ' + state.page + ' من ' + pages + ' — ' + fmtNum(state.view.length) + ' صف</span>' +
      '<button id="pg-next"' + (state.page >= pages ? ' disabled' : '') + '>التالي</button>' +
      '<select id="pg-size" aria-label="عدد الصفوف في الصفحة">' + [25, 50, 100, 200].map(n => '<option' + (n === state.perPage ? ' selected' : '') + '>' + n + '</option>').join('') + '</select>';
    document.querySelectorAll('th.sortable').forEach(th => {
      if (th.dataset.sort === state.sort.key) th.setAttribute('aria-sort', state.sort.dir === 'asc' ? 'ascending' : 'descending'); else th.removeAttribute('aria-sort');
    });
    $('chk-all').checked = slice.length > 0 && slice.every(r => state.selected.has(rowKey(r)));
  }

  const ltrRanges = (html) => html.replace(/\d+–\d+/g, '<bdi dir="ltr">$&</bdi>');   // النطاق 9–10 لا يُعكس داخل النص العربي
  function verdictHtml(r, unscanned) {
    if (unscanned) return '';
    const v = exporter.shippingVerdict(r);
    return '<div class="verdict ' + esc(v.status) + '"><div class="h">' + esc(v.headline) + '</div>' +
      v.lines.map(([a, b]) => '<div class="r"><b>' + esc(a) + '</b><span>' + ltrRanges(esc(b)) + '</span></div>').join('') + '</div>';
  }
  function userVerdictForm(o) {
    const opt = (v, t) => '<option value="' + v + '"' + (o.userStatus === v ? ' selected' : '') + '>' + t + '</option>';
    return '<h3>تحقق يدوي (من عندك)</h3><div class="uv">' +
      '<p class="muted">إن كنت متأكدًا من مصدر الشحن لسبب لا تعرضه الصفحة، سجّله هنا. يُعرض كحالة «يدوية» منفصلة عن التصنيف الآلي ولا تمحوه إعادة الفحص.</p>' +
      '<label>الحالة <select id="uv-status">' + '<option value="">— بلا تحقق يدوي —</option>' + opt('confirmed', 'مؤكد: شحن دولي') + opt('likely', 'مرجح: شحن دولي') + opt('local', 'محلي / غير دولي') + opt('unknown', 'غير معلوم') + '</select></label>' +
      '<label>بلد الشحن (اختياري) <input id="uv-country" type="text" value="' + esc(o.userCountry || '') + '" placeholder="مثال: الصين"></label>' +
      '<label>الدليل (مطلوب للمؤكد/المرجح) <textarea id="uv-note" rows="3" placeholder="مثال: عنوان نشاط البائع في الإمارات حسب صفحة البائع؛ أو وصل طلب سابق شُحن من ...">' + esc(o.userNote || '') + '</textarea></label>' +
      '<div class="scope-actions"><button id="uv-save" class="primary" data-k="' + esc(o.offerKey) + '">حفظ التحقق اليدوي</button><button id="uv-clear" data-k="' + esc(o.offerKey) + '">إزالته</button></div>' +
      (o.userAt ? '<p class="muted">آخر تحقق يدوي: ' + esc(fmtDate(o.userAt)) + '</p>' : '') + '</div>';
  }

  async function showDetail(k) {
    state.active = k;
    const r = state.rows.find(x => rowKey(x) === k);
    if (!r) { $('detail').hidden = true; document.querySelector('.layout').classList.remove('with-detail'); return; }
    const evidence = r._offerKey ? await state.db.byIndex('evidence', 'offerKey', r._offerKey) : [];
    const hist = await state.db.byIndex('priceHistory', 'asin', r._asin);
    const offer = r._offerKey ? state.offers.find(o => o.offerKey === r._offerKey) : null;
    const prod = state.products.find(p => p.asin === r._asin) || {};
    const others = state.offers.filter(o => o.asin === r._asin && o.offerKey !== r._offerKey);
    const dl = (pairs) => '<dl>' + pairs.filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k2, v]) => '<dt>' + esc(k2) + '</dt><dd>' + esc(v) + '</dd>').join('') + '</dl>';
    const unscanned = r.detailScanned === false && !r._offerKey;
    $('detail').innerHTML =
      '<button class="close" id="detail-close">إغلاق</button>' +
      '<h2>' + esc(r.title || r.asin) + '</h2>' +
      '<p>' + badge(r.shippingStatus, unscanned, !!(r.statusSource && /^يدوي/.test(r.statusSource))) + (r.shippingOrigin ? ' <span class="muted">— بلد الشحن: ' + esc(r.shippingOrigin) + '</span>' : '') + '</p>' +
      ((r.statusSource && /^يدوي/.test(r.statusSource)) ? '<p class="muted">هذه الحالة <b>يدوية من المستخدم</b> ولا تعني أن Amazon.sa أثبتتها. التصنيف الآلي لهذا العرض: <b>' + esc(STATUS_AR[r.autoStatus] || STATUS_AR.unknown) + '</b>.</p>' : '') +
      verdictHtml(r, unscanned) +
      (offer ? userVerdictForm(offer) : '') +
      '<h3>دليل التصنيف</h3>' +
      (evidence.length ? evidence.map(e => '<div class="ev"><div class="meta">' + esc({ confirmed: 'مؤكد', likely: 'مرجح', local: 'محلي' }[e.strength] || e.strength) + ' · الحقل: ' + esc(e.field) + ' · ' + esc(e.signal) + '<br>المصدر: ' + esc(e.source) + ' · التحقق: ' + esc(fmtDate(e.checkedAt)) + '</div><q>' + esc(e.text) + '</q></div>').join('')
        : '<p class="muted">' + (unscanned ? 'لم تُفحص صفحة هذا المنتج بعد، فلا يوجد دليل.' : 'لا يوجد نص دليل في المصدر؛ التصنيف «غير معلوم».') + '</p>') +
      (offer && offer.shippingNotes && offer.shippingNotes.length ? '<p class="muted">' + offer.shippingNotes.map(esc).join('<br>') + '</p>' : '') +
      '<h3>المنتج</h3>' + dl([['ASIN', r.asin], ['الكتالوج', prod.catalog], ['العلامة التجارية', prod.brand], ['الفئة', prod.categoryPath], ['رقم الموديل', prod.modelNumber], ['GTIN', prod.gtin],
        ['التقييم', prod.rating], ['عدد المراجعات', prod.reviewCount], ['ترتيب BSR', prod.bsrRank ? prod.bsrRank + ' في ' + (prod.bsrCategory || '') : null],
        ['الوصف', prod.description], ['أول اكتشاف', fmtDate(prod.firstSeenAt)], ['آخر فحص', fmtDate(prod.lastCheckedAt)],
        ['حقول لم تتوفر', (prod.fieldsMissing || []).join('، ')]]) +
      (offer ? '<h3>العرض</h3>' + dl([['السعر', offer.price !== null && offer.price !== undefined ? offer.price + ' ' + (offer.currency || '') : null], ['السعر السابق', offer.listPrice], ['الخصم %', offer.discountPct],
        ['اسم البائع (يباع بواسطة)', offer.sellerName], ['معرف البائع', offer.sellerId], ['اسم الشاحن (يشحن بواسطة)', offer.shipperName], ['الشاحن هو البائع؟', r.sellerIsShipper], ['نوع الشاحن', r.shipperTypeAr], ['مدة التجهيز (أيام)', r.handlingText], ['التوصيل بعد (أيام من الفحص)', r.deliveryDaysText],
        ['يشحن من (كما ظهر)', offer.shipsFrom], ['بلد الشحن (إن ثبت)', r.shippingOrigin], ['نص التنفيذ', offer.fulfillerText],
        ['نص التوصيل', offer.deliveryText], ['موعد التوصيل', offer.deliveryDate], ['عنوان التوصيل المعتمد', offer.deliveryLocation],
        ['سعر الشحن', offer.shippingCost === 0 ? 'مجاني' : offer.shippingCost], ['رسوم الاستيراد المقدرة', offer.importFees],
        ['التوفر', offer.availabilityText], ['المصدر', offer.dataSource], ['تاريخ التحقق', fmtDate(offer.lastVerifiedAt)]]) : '') +
      (others.length ? '<h3>عروض أخرى لنفس المنتج (' + others.length + ')</h3>' + others.map(o => '<p>' + esc(o.sellerName || 'بائع غير معروف') + ' — ' + esc(o.price !== undefined ? o.price : '—') + ' ' + esc(o.currency || '') + ' — ' + badge(o.shippingStatus) + '</p>').join('') : '') +
      (hist.length ? '<h3>سجل الأسعار</h3>' + hist.slice(-10).map(h => '<div class="muted">' + esc(fmtDate(h.at)) + ': ' + esc(h.price) + ' ' + esc(h.currency || '') + '</div>').join('') : '');
    $('detail').hidden = false;
    document.querySelector('.layout').classList.add('with-detail');
    renderTable();
  }

  async function renderLog() {
    const logs = (await state.db.all('logs')).slice(-60).reverse();
    $('log').textContent = logs.length ? logs.map(l => l.at + ' [' + l.level + '] ' + l.msg + (l.ctx && l.ctx.url ? ' — ' + l.ctx.url : '')).join('\n') : '—';
  }
  function setStatus(msg, warn) { const el = $('runstatus'); el.textContent = msg; el.classList.toggle('warn', !!warn); }

  /* ---------------- الجمع ---------------- */
  const STOP_MSG = {
    queue_empty: ['اكتمل الطابور الحالي. اضغط «بدء الجمع» للبدء بدورة اكتشاف جديدة، أو «تحديث بيانات المنتجات».', false],
    max_pages: ['وصلت الدورة إلى الحد الأقصى للصفحات. اضغط «استكمال الجمع» للمتابعة من حيث توقفت.', false],
    user_stop: ['أوقفت الجمع. التقدم محفوظ، ويمكنك الضغط على «استكمال الجمع».', false],
    blocked: ['توقف الجمع لأن Amazon طلبت التحقق (CAPTCHA أو تسجيل دخول). لا تحاول الأداة تجاوز ذلك. افتح Amazon.sa في تبويب عادي وأكمل التحقق بنفسك إن رغبت، ثم اضغط «استكمال الجمع» لاحقًا.', true],
    throttled: ['توقف الجمع لأن Amazon أعادت أخطاء تقييد متتالية (429/503). انتظر بعض الوقت وزِد التأخير بين الطلبات من الإعدادات.', true]
  };
  const sleep = (ms) => new Promise(r => { state.wake = r; setTimeout(r, ms); });
  async function fetchHtml(url) {
    const r = await fetch(url, { credentials: 'include', redirect: 'follow', headers: { 'Accept': 'text/html' } });
    return { status: r.status, url: r.url, html: await r.text() };
  }
  const parseHtml = (html) => new DOMParser().parseFromString(html, 'text/html');

  function setRunning(on) {
    ['btn-start', 'btn-resume', 'btn-refresh', 'btn-search'].forEach(id => $(id).disabled = on);
    $('btn-stop').disabled = !on;
  }
  async function runCrawl() {
    if (state.runner && state.runner.running) return;
    setRunning(true);
    state.runner = crawler.createRunner({
      db: state.db, settings: state.settings, fetchHtml, parseHtml, sleep,
      onProgress: (s) => {
        setStatus('جارٍ الجمع… عولجت ' + s.processed + ' صفحة، منتجات مفحوصة: ' + s.products + '، منتجات جديدة: ' + s.newProducts + '، أخطاء: ' + s.errors);
        if (Date.now() - state.lastRefresh > 2500) { state.lastRefresh = Date.now(); reload(); }
      }
    });
    try {
      const s = await state.runner.run();
      const m = STOP_MSG[s.stoppedBecause] || ['انتهت الدورة.', false];
      const q = await crawler.queueStats(state.db);
      const errs = (await state.db.all('logs')).filter(l => l.level === 'error').slice(-2).map(l => l.msg);
      setStatus(m[0] + ' — عولجت ' + s.processed + '، منتجات مفحوصة ' + s.products + '، أخطاء ' + s.errors + '، المتبقي في الطابور ' + q.pending +
        (s.products === 0 && s.processed > 0 ? ' — تنبيه: لم تُفحص أي صفحة منتج؛ جرّب «تشخيص صفحة منتج».' : '') + (errs.length ? ' — آخر الأخطاء: ' + errs.join(' | ') : ''), m[1] || (s.products === 0 && s.processed > 0));
    } catch (e) {
      setStatus('حدث خطأ غير متوقع: ' + e.message, true);
      await ingest.log(state.db, 'error', 'فشل تشغيل الزاحف: ' + e.message);
    } finally { setRunning(false); await reload(); await renderLog(); }
  }
  async function startFresh() {
    for (const it of crawler.seedItems(state.settings)) {
      const old = await state.db.get('queue', it.url);
      if (old) { old.status = 'pending'; old.attempts = 0; old.error = null; old.catalog = it.catalog; await state.db.put('queue', old); }
      else await crawler.enqueue(state.db, it);
    }
    await runCrawl();
  }

  /* ---------------- البحث عن منتج ---------------- */
  function setFocus(asins, label) {
    state.focus = asins && asins.length ? new Set(asins) : null; state.focusLabel = label || '';
    $('focus-banner').hidden = !state.focus;
    $('focus-text').textContent = state.focus ? 'يُعرض الآن: ' + state.focusLabel + ' (' + state.focus.size + ' منتج)' : '';
    state.page = 1;
  }
  const SEARCH_STOP_MSG = {
    blocked: 'توقف البحث لأن Amazon طلبت التحقق (CAPTCHA أو تسجيل دخول). لا تحاول الأداة تجاوز ذلك؛ افتح Amazon.sa في تبويب عادي وأكمل التحقق ثم أعد المحاولة.',
    throttled: 'توقف البحث لأن Amazon أعادت خطأ تقييد (429/503). انتظر قليلًا وزِد التأخير من الإعدادات.',
    user_stop: 'أوقفت البحث؛ ما اكتمل منه محفوظ.'
  };
  async function doSearch() {
    const input = $('q-amazon').value.trim();
    if (!input) return setStatus('اكتب اسم منتج، أو الصق رابطه أو ASIN.', true);
    if (state.searching || (state.runner && state.runner.running)) return;
    state.searching = true; state.searchStop = false; setRunning(true);
    try {
      const res = await search.runSearch({
        db: state.db, settings: state.settings, fetchHtml, parseHtml, sleep,
        isStopped: () => state.searchStop,
        onProgress: (p) => setStatus(p.phase === 'search'
          ? 'جارٍ البحث… صفحة النتائج ' + p.page + ' من ' + p.pages + (p.found ? ' — وُجد ' + p.found + ' منتجًا' : '')
          : 'جارٍ فحص تفاصيل المنتجات… ' + p.done + ' من ' + p.total + ' (يأخذ بضع ثوانٍ لكل منتج لتفادي الحظر)')
      }, input, { pages: $('q-pages').value, deepScan: $('q-deep').value });
      await reload();
      if (res.kind === 'asin') {
        setFocus(res.asins, 'المنتج ' + res.asins[0]);
        if (res.offerKey) {
          await reload(); await showDetail(res.offerKey);
          const row = state.rows.find(x => rowKey(x) === res.offerKey);
          const v = row ? exporter.shippingVerdict(row) : null;
          setStatus('فُحص المنتج ' + res.asins[0] + (v ? ' — ' + v.headline : '') + '.');
        } else setStatus('تعذر فحص المنتج: ' + (res.error || 'سبب غير معروف') + (SEARCH_STOP_MSG[res.stoppedBecause] ? ' — ' + SEARCH_STOP_MSG[res.stoppedBecause] : ''), true);
      } else if (res.kind === 'keyword') {
        if (res.found) setFocus(res.asins, 'نتائج البحث عن «' + res.keyword + '»'); else setFocus(null);
        const prods = state.products.filter(p => res.asins.includes(p.asin));
        const c = (k) => prods.filter(p => p.detailScanned !== false && p.shippingStatus === k).length;
        const tail = res.found
          ? 'وُجد ' + res.found + ' منتجًا (' + res.newProducts + ' جديد)، فُحصت صفحات ' + res.scanned + ' منها: مؤكد ' + c('confirmed') + ' · مرجح ' + c('likely') + ' · غير معلوم ' + c('unknown') + ' · محلي ' + c('local') + (res.found > res.scanned ? ' — البقية لم تُفحص بعد (اضغط على صف ثم «فحص» أو ارفع عدد الفحص).' : '.')
          : 'لم تُستخرج نتائج. قد تكون بنية صفحة البحث تغيّرت أو طلبت Amazon تحققًا — جرّب «تشخيص صفحة منتج» أو افتح البحث في Amazon.sa بنفسك مع «الالتقاط التلقائي».';
        setStatus((SEARCH_STOP_MSG[res.stoppedBecause] ? SEARCH_STOP_MSG[res.stoppedBecause] + ' — ' : '') + tail + (res.errors ? ' (أخطاء: ' + res.errors + (res.error ? ' — ' + res.error : '') + ')' : ''), !!SEARCH_STOP_MSG[res.stoppedBecause] && res.stoppedBecause !== 'user_stop' || !res.found);
      } else setStatus(res.error || 'مدخل غير صالح.', true);
    } catch (e) {
      setStatus('فشل البحث: ' + e.message, true); await ingest.log(state.db, 'error', 'فشل البحث: ' + e.message);
    } finally { state.searching = false; setRunning(false); await reload(); await renderLog(); }
  }

  /* ---------------- تشخيص ---------------- */
  async function diagnose() {
    // المنتج المستهدف: الصف المفتوح في التفاصيل، أو صف واحد محدد، وإلا يُسأل المستخدم (ASIN أو رابط) — لا نختار منتجًا عشوائيًا
    let asin = null;
    const row = state.active && state.rows.find(r => rowKey(r) === state.active);
    if (row) asin = row._asin;
    else if (state.selected.size === 1) { const r1 = state.rows.find(r => rowKey(r) === Array.from(state.selected)[0]); asin = r1 && r1._asin; }
    if (!asin) {
      const inp = (prompt('أدخل ASIN أو رابط المنتج على Amazon.sa (أو اضغط على صف المنتج أولًا ثم أعد الضغط):') || '').trim();
      asin = parser.extractAsin(inp) || (/^[A-Za-z0-9]{10}$/.test(inp) ? inp.toUpperCase() : null);
    }
    if (!asin || !/^[A-Z0-9]{10}$/.test(asin)) return setStatus('ASIN غير صالح أو لم يُحدَّد منتج.', true);
    setStatus('تشخيص: جلب صفحة ' + asin + '…');
    try {
      const url = (state.settings.baseUrl || rules.DEFAULT_SETTINGS.baseUrl) + '/dp/' + asin;
      const resp = await fetchHtml(crawler.withLanguage(url, state.settings));
      const doc = parseHtml(resp.html);
      const blk = parser.detectBlocked(doc, resp.url);
      const p = parser.parseProductDocument(doc, resp.url);
      const lines = ['HTTP ' + resp.status + ' | الرابط النهائي: ' + resp.url + ' | الحجم: ' + resp.html.length + ' حرفًا | عنوان الصفحة: ' + ((doc.title || '').slice(0, 80) || '—'),
        blk.blocked ? 'محجوبة: ' + blk.reason + ' (طلبت Amazon التحقق؛ لن تُجاوَز).' : 'لا حجب ظاهر.',
        p.ok ? 'استُخرج: العنوان=' + (p.title ? 'نعم' : 'لا') + '، السعر=' + (p.offer.price !== null ? p.offer.price : 'لا') + '، يشحن من=' + (p.offer.shipsFrom || 'لا') + '، البائع=' + (p.offer.sellerName || 'لا') + '، التوصيل=' + (p.offer.deliveryText ? 'نعم' : 'لا') + '. الناقص: ' + p.fieldsMissing.join('، ')
          : 'لم يُتعرَّف على الصفحة كصفحة منتج.'];
      await ingest.log(state.db, 'info', 'تشخيص ' + asin + ': ' + lines.join(' || '));
      const clean = resp.html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
      download('diagnostic-' + asin + '.html', clean, 'text/html;charset=utf-8');
      setStatus(lines.join('  ■  ') + '  ■  نُزِّلت نسخة منقّحة (بلا سكربتات) باسم diagnostic-' + asin + '.html؛ راجعها قبل مشاركتها فقد تتضمن عنوان توصيلك.', blk.blocked || !p.ok);
      await renderLog();
    } catch (e) { setStatus('فشل التشخيص: ' + e.message, true); }
  }

  /* ---------------- فحص الصفحة الحالية ---------------- */
  async function scanCurrent() {
    try {
      const tabs = await chrome.tabs.query({ url: ['https://www.amazon.sa/*', 'https://amazon.sa/*'] });
      if (!tabs.length) return setStatus('لا يوجد تبويب مفتوح على Amazon.sa. افتح صفحة منتج ثم أعد المحاولة.', true);
      tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
      let resp;
      try { resp = await chrome.tabs.sendMessage(tabs[0].id, { type: 'extract' }); }
      catch (e) { return setStatus('تعذر الاتصال بالصفحة. أعد تحميل صفحة Amazon.sa ثم حاول مجددًا.', true); }
      if (!resp || !resp.ok) return setStatus('تعذر الفحص: ' + ((resp && resp.error) || 'لا استجابة'), true);
      const r = resp.result;
      if (r.kind === 'blocked') return setStatus('الصفحة المفتوحة تطلب تحققًا (' + r.reason + ')؛ لم يُفحص شيء.', true);
      if (r.kind === 'product') {
        const out = await ingest.ingestProduct(state.db, r.parsed, { settings: state.settings, source: 'amazon.sa:browsed-page' });
        setStatus('فُحصت الصفحة: ' + (r.parsed.title || r.parsed.asin) + ' — حالة الشحن: ' + STATUS_AR[out.classification.status]);
        await reload(); await showDetail(out.offer.offerKey);
      } else if (r.kind === 'listing') {
        const n = await ingest.ingestListingItems(state.db, r.items, { source: 'amazon.sa:browsed-listing' });
        setStatus('التُقطت ' + r.items.length + ' منتجًا من القائمة (' + n + ' جديد). لم تُفحص صفحاتها بعد؛ سيفحصها «بدء الجمع».');
        await reload();
      } else setStatus('الصفحة المفتوحة ليست صفحة منتج ولا قائمة منتجات.', true);
    } catch (e) { setStatus('فشل الفحص: ' + e.message, true); }
  }

  /* ---------------- تصدير / استيراد ---------------- */
  function download(name, data, mime) {
    const blob = new Blob([data], { type: mime });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }
  async function exportRows() {
    const evidence = await state.db.all('evidence');
    const all = exporter.buildRows(state.products, state.offers, evidence);
    const keys = state.selected.size ? state.selected : new Set(state.view.map(rowKey));
    return all.filter(r => keys.has(rowKey(r)));
  }
  const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  async function doExport(kind) {
    const rows = await exportRows();
    if (!rows.length) return setStatus('لا توجد صفوف للتصدير.', true);
    if (kind === 'csv') download('amazon-sa-products-' + stamp() + '.csv', exporter.toCSV(rows), 'text/csv;charset=utf-8');
    else download('amazon-sa-products-' + stamp() + '.xlsx', exporter.buildXlsx(rows), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    setStatus('صُدّر ' + rows.length + ' صفًا (' + (state.selected.size ? 'المحدد' : 'حسب التصفية الحالية') + ').');
  }
  async function doImport(file) {
    const text = await file.text();
    const { records, skipped } = exporter.recordsFromCsv(text);
    const r = await exporter.importRecords(state.db, records);
    setStatus('الاستيراد: ' + r.added + ' جديد، ' + r.updated + ' محدّث، ' + skipped.length + ' صف تم تخطيه' + (r.downgraded ? '، ' + r.downgraded + ' صف خُفّضت حالة شحنه إلى «غير معلوم» لعدم وجود نص دليل' : '') + '.');
    await reload();
  }

  /* ---------------- أحداث ---------------- */
  function selectedUrls() {
    const keys = state.selected.size ? Array.from(state.selected) : (state.active ? [state.active] : []);
    return Array.from(new Set(keys.map(k => (state.rows.find(r => rowKey(r) === k) || {}).url).filter(Boolean)));
  }
  function bind() {
    $('btn-start').onclick = () => { if (confirm('سيبدأ اكتشاف المنتجات تلقائيًا من صفحات الفئات والأكثر مبيعًا وغيرها، مع تأخير بين الطلبات. أبقِ هذا التبويب مفتوحًا أثناء الجمع. المتابعة؟')) startFresh(); };
    $('btn-resume').onclick = () => runCrawl();
    $('btn-search').onclick = doSearch;
    $('q-amazon').addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });
    $('btn-unfocus').onclick = () => { setFocus(null); applyView(); };
    $('btn-stop').onclick = () => { state.searchStop = true; if (state.runner) state.runner.stop(); if (state.wake) state.wake(); setStatus('جارٍ الإيقاف بعد إنهاء الطلب الحالي…'); };
    $('btn-refresh').onclick = async () => { const n = await crawler.enqueueRefresh(state.db, state.settings); setStatus('أُضيف ' + n + ' منتجًا إلى طابور التحديث.'); await runCrawl(); };
    $('btn-scan-current').onclick = scanCurrent;
    $('btn-diagnose').onclick = diagnose;
    $('filter-catalog').onchange = () => { state.page = 1; applyView(); };
    $('btn-discover').onclick = async () => {
      setStatus('جارٍ اكتشاف الكتالوجات…');
      try {
        const list = await crawler.discoverCatalogs({ settings: state.settings, fetchHtml, parseHtml });
        if (!list.length) return setStatus('لم تُستخرج أقسام من الصفحة (قد تكون بنية الصفحة تغيّرت). يمكنك إضافة روابط أقسام يدويًا في «روابط بدء إضافية» بالإعدادات.', true);
        await saveSettings(Object.assign({}, state.settings, { knownCatalogs: list }));
        renderScope(); $('scope-panel').open = true; setStatus('اكتُشف ' + list.length + ' كتالوجًا. حدّد ما تريد الجمع منه أو اتركها لكل الكتالوجات.');
      } catch (e) { setStatus('تعذر اكتشاف الكتالوجات: ' + e.message, true); await ingest.log(state.db, 'error', 'اكتشاف الكتالوجات: ' + e.message); await renderLog(); }
    };
    $('btn-scope-all').onclick = async () => { await saveSettings(Object.assign({}, state.settings, { catalogScope: [] })); renderScope(); setStatus('النطاق: كل الكتالوجات.'); };
    $('scope-list').addEventListener('change', async () => {
      const scope = Array.from($('scope-list').querySelectorAll('input:checked')).map(i => ({ name: i.dataset.name, url: i.dataset.url }));
      await saveSettings(Object.assign({}, state.settings, { catalogScope: scope })); renderScope();
    });
    $('btn-csv').onclick = () => doExport('csv');
    $('btn-xlsx').onclick = () => doExport('xlsx');
    $('btn-import').onclick = () => $('file-import').click();
    $('file-import').onchange = async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) { try { await doImport(f); } catch (err) { setStatus('فشل الاستيراد: ' + err.message, true); } } };
    $('btn-copy').onclick = async () => { const u = selectedUrls(); if (!u.length) return setStatus('حدّد منتجًا أو اضغط على صف أولًا.', true); await navigator.clipboard.writeText(u.join('\n')); setStatus('نُسخ ' + u.length + ' رابطًا.'); };
    $('btn-open').onclick = () => { const u = selectedUrls().slice(0, 5); if (!u.length) return setStatus('حدّد منتجًا أو اضغط على صف أولًا.', true); u.forEach(x => window.open(x, '_blank', 'noopener')); };
    $('btn-delete').onclick = async () => {
      const asins = Array.from(new Set(Array.from(state.selected).map(k => (state.rows.find(r => rowKey(r) === k) || {})._asin).filter(Boolean)));
      if (!asins.length) return setStatus('حدّد صفوفًا للحذف أولًا.', true);
      if (!confirm('سيُحذف ' + asins.length + ' منتجًا مع كل عروضه وأدلته وسجل أسعاره من هذا الجهاز. المتابعة؟')) return;
      await ingest.deleteProducts(state.db, asins); state.selected.clear(); state.active = null;
      $('detail').hidden = true; document.querySelector('.layout').classList.remove('with-detail');
      await reload(); setStatus('حُذف ' + asins.length + ' منتجًا.');
    };
    $('search').oninput = () => { state.page = 1; applyView(); };
    $('filter-status').onchange = () => { state.page = 1; applyView(); };
    $('chk-all').onchange = (e) => {
      const slice = state.view.slice((state.page - 1) * state.perPage, state.page * state.perPage);
      slice.forEach(r => e.target.checked ? state.selected.add(rowKey(r)) : state.selected.delete(rowKey(r))); renderTable();
    };
    document.querySelector('thead').addEventListener('click', (e) => {
      const th = e.target.closest('th.sortable'); if (!th) return;
      const k = th.dataset.sort; state.sort = { key: k, dir: state.sort.key === k && state.sort.dir === 'asc' ? 'desc' : 'asc' }; applyView();
    });
    $('tbody').addEventListener('click', (e) => {
      const act = e.target.closest('button[data-act]');
      if (act) { e.stopPropagation(); if (act.dataset.act === 'open') window.open(act.dataset.url, '_blank', 'noopener'); else navigator.clipboard.writeText(act.dataset.url).then(() => setStatus('نُسخ الرابط.')); return; }
      const sel = e.target.closest('input.sel');
      if (sel) { sel.checked ? state.selected.add(sel.dataset.k) : state.selected.delete(sel.dataset.k); return; }
      const tr = e.target.closest('tr.row'); if (tr) showDetail(tr.dataset.k);
    });
    $('pager').addEventListener('click', (e) => { if (e.target.id === 'pg-prev') { state.page--; renderTable(); } if (e.target.id === 'pg-next') { state.page++; renderTable(); } });
    $('pager').addEventListener('change', (e) => { if (e.target.id === 'pg-size') { state.perPage = parseInt(e.target.value, 10); state.page = 1; applyView(); } });
    $('detail').addEventListener('click', async (e) => {
      const k = e.target.dataset && e.target.dataset.k;
      if (e.target.id === 'uv-save') {
        const status = $('uv-status').value;
        try {
          if (!status) await ingest.clearUserVerdict(state.db, k);
          else await ingest.setUserVerdict(state.db, k, { status, country: $('uv-country').value, note: $('uv-note').value });
          setStatus(status ? 'حُفظ التحقق اليدوي.' : 'أُزيل التحقق اليدوي.'); await reload(); await showDetail(k);
        } catch (err) { setStatus(err.message, true); }
      } else if (e.target.id === 'uv-clear') {
        await ingest.clearUserVerdict(state.db, k); setStatus('أُزيل التحقق اليدوي.'); await reload(); await showDetail(k);
      }
    });
    $('detail').addEventListener('click', (e) => { if (e.target.id === 'detail-close') { state.active = null; $('detail').hidden = true; document.querySelector('.layout').classList.remove('with-detail'); renderTable(); } });

    // الإعدادات
    const form = $('settings-form');
    $('btn-settings').onclick = () => {
      const s = state.settings;
      form.minDelay.value = s.minDelayMs / 1000; form.maxDelay.value = s.maxDelayMs / 1000; form.maxPages.value = s.maxPagesPerRun;
      form.depth.value = s.maxCategoryDepth; form.language.value = s.language || '';
      form.autoCapture.checked = !!s.autoCapture; form.competitors.checked = !!s.fetchCompetitorOffers; form.importAsConfirmed.checked = !!s.importFeesAsConfirmed;
      form.intlHandling.value = s.intlMinHandlingDays; form.intlDelivery.value = s.intlMinDeliveryDays;
      form.seeds.value = (s.extraSeeds || []).join('\n'); $('settings-dialog').showModal();
    };
    $('settings-save').onclick = async () => {
      const seeds = form.seeds.value.split(/\n+/).map(x => x.trim()).filter(x => /^https:\/\/(?:www\.)?amazon\.sa\//.test(x));
      const minD = Math.max(2, parseFloat(form.minDelay.value) || 4), maxD = Math.max(minD, parseFloat(form.maxDelay.value) || 9);
      await saveSettings(Object.assign({}, state.settings, {
        minDelayMs: minD * 1000, maxDelayMs: maxD * 1000, maxPagesPerRun: Math.max(1, parseInt(form.maxPages.value, 10) || 300),
        maxCategoryDepth: Math.min(4, Math.max(0, parseInt(form.depth.value, 10) || 0)), language: form.language.value,
        autoCapture: form.autoCapture.checked, fetchCompetitorOffers: form.competitors.checked, importFeesAsConfirmed: form.importAsConfirmed.checked, extraSeeds: seeds,
        intlMinHandlingDays: Math.max(1, parseInt(form.intlHandling.value, 10) || 5), intlMinDeliveryDays: Math.max(1, parseInt(form.intlDelivery.value, 10) || 14)
      }));
      setStatus('حُفظت الإعدادات.');
    };
  }

  (async function init() {
    bind();
    try {
      state.db = await dbLib.open('amazon_sa_finder');
      await loadSettings();
      await crawler.resetInFlight(state.db);
      renderScope();
      await reload(); await renderLog();
      const q = await crawler.queueStats(state.db);
      setStatus(q.pending ? 'الحالة: متوقف. في الطابور ' + q.pending + ' عنصرًا قابلًا للاستكمال.' : 'الحالة: متوقف. اضغط «بدء الجمع» لاكتشاف المنتجات تلقائيًا.');
    } catch (e) { setStatus('تعذر فتح قاعدة البيانات المحلية: ' + e.message, true); }
  })();
})();
