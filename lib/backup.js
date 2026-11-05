/* نسخ احتياطي واستعادة كاملة لبياناتك المحلية (JSON). الاستعادة تستبدل البيانات الحالية بمحتوى الملف. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.ASF = root.ASF || {}; root.ASF.backup = api; }
})(typeof self !== 'undefined' ? self : this, function () {
  const FORMAT = 'amazon-sa-finder-backup';
  const STORES = ['products', 'offers', 'evidence', 'priceHistory', 'sources', 'queue', 'scans'];   // السجلات (logs) لا تُحفظ

  async function exportAll(db, settings, appVersion) {
    const stores = {};
    for (const s of STORES) stores[s] = await db.all(s);
    return { format: FORMAT, version: 1, appVersion: appVersion || null, createdAt: new Date().toISOString(), settings: settings || {}, stores };
  }

  function validate(obj) {
    if (!obj || typeof obj !== 'object' || obj.format !== FORMAT) throw new Error('الملف ليس نسخة احتياطية من هذه الأداة.');
    if (obj.version !== 1) throw new Error('إصدار النسخة الاحتياطية غير مدعوم (' + obj.version + ').');
    if (!obj.stores || typeof obj.stores !== 'object') throw new Error('النسخة الاحتياطية تالفة: لا بيانات.');
    for (const s of STORES) if (obj.stores[s] !== undefined && !Array.isArray(obj.stores[s])) throw new Error('النسخة الاحتياطية تالفة عند «' + s + '».');
    (obj.stores.products || []).forEach(p => { if (!p || !p.asin) throw new Error('النسخة الاحتياطية تالفة: منتج بلا ASIN.'); });
    (obj.stores.offers || []).forEach(o => { if (!o || !o.offerKey) throw new Error('النسخة الاحتياطية تالفة: عرض بلا مفتاح.'); });
    (obj.stores.queue || []).forEach(q => { if (!q || !q.url) throw new Error('النسخة الاحتياطية تالفة: عنصر طابور بلا رابط.'); });
    (obj.stores.sources || []).forEach(x => { if (!x || !x.id) throw new Error('النسخة الاحتياطية تالفة: مصدر بلا معرّف.'); });
  }

  /** يتحقق أولًا (دون لمس البيانات)، ثم يستبدل المحتوى. يعيد أعداد السجلات المستعادة. */
  async function importAll(db, obj) {
    validate(obj);
    const counts = {};
    for (const s of STORES) {
      await db.clear(s);
      const rows = obj.stores[s] || [];
      for (const r of rows) { if (['evidence', 'priceHistory', 'scans'].includes(s)) await db.add(s, r); else await db.put(s, r); }
      counts[s] = rows.length;
    }
    return { counts, settings: obj.settings || {}, createdAt: obj.createdAt };
  }
  return { exportAll, importAll, validate, STORES, FORMAT };
});
