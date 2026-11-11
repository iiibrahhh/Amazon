/* جلب مصادر مقترحة من AliExpress عبر واجهة الشركاء الرسمية (Affiliate API) بمفتاح التاجر نفسه.
   تنبيهات صريحة:
   - كُتب هذا الجزء من وثائق عامة ولم يُجرَّب على الواجهة الحقيقية (يحتاج مفتاح تاجر)؛ أسماء الحقول يُتسامح فيها وأي رد غير متوقع يُعرض كخطأ واضح.
   - واجهة الشركاء تعطي السعر والرابط والتقييم والمبيعات، ولا تعطي «يدعم الدروب شيبينج»؛ هذا يحتاج واجهة الدروب شيبينج (تفويض OAuth) وغير منفّذ.
   - التطابق مع منتجك لا يُضمن: السعر المعروض لمنتج مقترح وليس تكلفة نهائية، ولا يشمل الشحن إلى السعودية. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.ASF = root.ASF || {}; root.ASF.sourcing = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  const ENDPOINT = 'https://api-sg.aliexpress.com/sync';
  const METHOD = 'aliexpress.affiliate.product.query';
  const ORIGIN_PATTERN = 'https://api-sg.aliexpress.com/*';
  const hex = (buf) => Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();

  /** توقيع HMAC-SHA256: ترتيب المفاتيح أبجديًا ثم دمج «مفتاح+قيمة» بلا فواصل، والمخرج حروف كبيرة. */
  async function sign(params, secret, subtle) {
    const base = Object.keys(params).filter(k => k !== 'sign' && params[k] !== undefined && params[k] !== null && params[k] !== '').sort().map(k => k + params[k]).join('');
    const enc = new TextEncoder();
    const key = await subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    return hex(await subtle.sign('HMAC', key, enc.encode(base)));
  }

  async function buildRequest(cfg, query, opts) {
    opts = opts || {};
    if (!cfg || !cfg.aliAppKey || !cfg.aliAppSecret) throw new Error('أدخل مفتاح AliExpress وسره في «الإعدادات» أولًا.');
    const params = {
      app_key: cfg.aliAppKey, timestamp: String(opts.now || Date.now()), sign_method: 'sha256', method: METHOD,
      keywords: query, page_no: '1', page_size: String(opts.pageSize || 10), sort: 'LAST_VOLUME_DESC',
      target_currency: cfg.aliCurrency || 'SAR', target_language: cfg.aliLanguage || 'EN', ship_to_country: cfg.aliShipTo || 'SA',
      tracking_id: cfg.aliTrackingId || ''
    };
    params.sign = await sign(params, cfg.aliAppSecret, opts.subtle || (globalThis.crypto && globalThis.crypto.subtle));
    const qs = Object.keys(params).filter(k => params[k] !== '').map(k => encodeURIComponent(k) + '=' + encodeURIComponent(params[k])).join('&');
    return ENDPOINT + '?' + qs;
  }

  const n = (v) => { const x = parseFloat(String(v === undefined || v === null ? '' : v).replace(/[^\d.]/g, '')); return isNaN(x) ? null : x; };

  /** يحوّل رد الواجهة إلى مرشحين. يرمي خطأً مفهومًا عند رد خطأ أو بنية غير متوقعة. */
  function parseResponse(json) {
    if (!json || typeof json !== 'object') throw new Error('رد غير مفهوم من AliExpress.');
    const err = json.error_response;
    if (err) throw new Error('AliExpress رفض الطلب: ' + (err.msg || err.sub_msg || err.code || 'خطأ') + (err.sub_msg && err.sub_msg !== err.msg ? ' (' + err.sub_msg + ')' : ''));
    const key = Object.keys(json).find(k => /_response$/.test(k));
    const body = key ? json[key] : json;
    const res = body && body.resp_result;
    if (res && res.resp_code !== undefined && Number(res.resp_code) !== 200) throw new Error('AliExpress: ' + (res.resp_msg || ('رمز ' + res.resp_code)));
    const list = res && res.result && res.result.products && (res.result.products.product || res.result.products);
    if (!Array.isArray(list)) {
      if (res && res.result && Number(res.result.total_record_count) === 0) return [];
      throw new Error('بنية الرد غير متوقعة (لا قائمة منتجات). قد تكون الواجهة تغيّرت أو المفتاح بلا صلاحية.');
    }
    return list.map(p => ({
      id: String(p.product_id || ''), title: p.product_title || '', url: p.promotion_link || p.product_detail_url || '',
      image: p.product_main_image_url || '', currency: p.target_sale_price_currency || p.target_app_sale_price_currency || '',
      price: n(p.target_sale_price !== undefined ? p.target_sale_price : p.target_app_sale_price),
      originalPrice: n(p.target_original_price), rating: n(p.evaluate_rate), orders: n(p.lastest_volume), shop: p.shop_url || '', shopName: p.shop_name || ''
    })).filter(c => c.id || c.url);
  }

  const toks = (s) => new Set(String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 2));
  /** أقرب نتيجة لعبارة البحث: تقاطع الكلمات اللاتينية ثم عدد الطلبات. يعيد null إن لم توجد نتيجة بسعر. التطابق تقدير وليس يقينًا. */
  function pickBest(query, list) {
    const q = toks(query); let best = null, bs = -1;
    (list || []).filter(c => c.price !== null && c.url).forEach(c => {
      const t = toks(c.title); let hit = 0; q.forEach(w => { if (t.has(w)) hit++; });
      const sc = (q.size ? hit / q.size : 0) * 1000 + Math.log10((c.orders || 0) + 1);
      if (sc > bs) { bs = sc; best = Object.assign({}, c, { match: q.size ? Math.round(hit / q.size * 100) : 0 }); }
    });
    return best;
  }
  async function searchAliExpress(cfg, query, opts) {
    opts = opts || {};
    const url = await buildRequest(cfg, query, opts);
    const f = opts.fetch || fetch;
    let r;
    try { r = await f(url); } catch (e) { throw new Error('تعذر الاتصال بـAliExpress (صلاحية الوصول أو الشبكة): ' + e.message); }
    if (!r.ok) throw new Error('AliExpress أعاد HTTP ' + r.status);
    let j; try { j = await r.json(); } catch (e) { throw new Error('رد AliExpress ليس JSON صالحًا.'); }
    return parseResponse(j);
  }
  return { pickBest, sign, buildRequest, parseResponse, searchAliExpress, ENDPOINT, METHOD, ORIGIN_PATTERN };
});
