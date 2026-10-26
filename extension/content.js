/* سكربت المحتوى: يعمل داخل صفحات Amazon.sa التي تفتحها بنفسك.
   - يستخرج بيانات الصفحة الحالية عند الطلب (زر «فحص الصفحة الحالية»).
   - يلتقط الصفحة تلقائيًا أثناء تصفحك إذا كان «الالتقاط التلقائي» مفعّلًا. لا يرسل أي طلبات إضافية إلى Amazon. */
(function () {
  const parser = self.ASF && self.ASF.parser;
  if (!parser) return;

  function extract() {
    const url = location.href;
    const blk = parser.detectBlocked(document, url);
    if (blk.blocked) return { kind: 'blocked', reason: blk.reason };
    const asin = parser.extractAsin(url);
    if (asin && /\/(?:dp|gp\/product|gp\/aw\/d)\//.test(url)) {
      const parsed = parser.parseProductDocument(document, url);
      return parsed.ok ? { kind: 'product', parsed } : { kind: 'none' };
    }
    if (document.querySelector('[data-asin]')) {
      const res = parser.parseListingDocument(document, location.origin);
      return { kind: 'listing', items: res.items.map(i => { const c = Object.assign({}, i); delete c._href; return c; }) };
    }
    return { kind: 'none' };
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === 'extract') { try { sendResponse({ ok: true, result: extract() }); } catch (e) { sendResponse({ ok: false, error: e.message }); } }
    return false;
  });

  async function passiveCapture() {
    try {
      const { settings } = await chrome.storage.local.get('settings');
      if (settings && settings.autoCapture === false) return;
      const result = extract();
      if (result.kind === 'product') chrome.runtime.sendMessage({ type: 'capture-product', parsed: result.parsed });
      else if (result.kind === 'listing' && result.items.length) chrome.runtime.sendMessage({ type: 'capture-listing', items: result.items });
    } catch (e) { /* لا نزعج المستخدم */ }
  }
  setTimeout(passiveCapture, 2500);
})();
