/* طبقة تخزين محلية فوق IndexedDB (تعمل في صفحات الإضافة والـ service worker، وفي الاختبارات عبر fake-indexeddb). */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else { root.ASF = root.ASF || {}; root.ASF.db = api; }
})(typeof self !== 'undefined' ? self : this, function () {

  const VERSION = 1;
  const STORES = {
    products:     { keyPath: 'asin', indexes: [['status', 'shippingStatus'], ['checked', 'lastCheckedAt']] },
    offers:       { keyPath: 'offerKey', indexes: [['asin', 'asin'], ['status', 'shippingStatus']] },
    evidence:     { autoIncrement: true, indexes: [['offerKey', 'offerKey'], ['asin', 'asin']] },
    priceHistory: { autoIncrement: true, indexes: [['offerKey', 'offerKey'], ['asin', 'asin']] },
    scans:        { autoIncrement: true, indexes: [] },
    sources:      { keyPath: 'id', indexes: [] },
    queue:        { keyPath: 'url', indexes: [['status', 'status'], ['type', 'type']] },
    logs:         { autoIncrement: true, indexes: [] },
    settings:     { keyPath: 'key', indexes: [] }
  };

  const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  function open(name, factory) {
    const idb = factory || (typeof indexedDB !== 'undefined' ? indexedDB : null);
    if (!idb) return Promise.reject(new Error('IndexedDB غير متاح'));
    return new Promise((resolve, reject) => {
      const r = idb.open(name || 'amazon_sa_finder', VERSION);
      r.onupgradeneeded = () => {
        const d = r.result;
        for (const [n, def] of Object.entries(STORES)) {
          if (d.objectStoreNames.contains(n)) continue;
          const s = d.createObjectStore(n, def.keyPath ? { keyPath: def.keyPath } : { autoIncrement: true });
          def.indexes.forEach(([iname, path]) => s.createIndex(iname, path));
        }
      };
      r.onerror = () => reject(r.error);
      r.onsuccess = () => resolve(wrap(r.result));
    });
  }

  function wrap(d) {
    const store = (n, mode) => d.transaction(n, mode || 'readonly').objectStore(n);
    return {
      raw: d,
      get: (n, k) => req(store(n).get(k)),
      put: (n, v) => req(store(n, 'readwrite').put(v)),
      add: (n, v) => req(store(n, 'readwrite').add(v)),
      del: (n, k) => req(store(n, 'readwrite').delete(k)),
      all: (n) => req(store(n).getAll()),
      count: (n) => req(store(n).count()),
      clear: (n) => req(store(n, 'readwrite').clear()),
      byIndex: (n, idx, key) => req(store(n).index(idx).getAll(key)),
      delByIndex: (n, idx, key) => new Promise((res, rej) => {
        const t = d.transaction(n, 'readwrite');
        const c = t.objectStore(n).index(idx).openKeyCursor(IDBKeyRange.only(key));
        const pk = [];
        c.onsuccess = () => { const cur = c.result; if (cur) { pk.push(cur.primaryKey); cur.continue(); } else { pk.forEach(k => t.objectStore(n).delete(k)); } };
        t.oncomplete = () => res(pk.length);
        t.onerror = () => rej(t.error);
      }),
      close: () => d.close()
    };
  }

  return { open, STORES, VERSION };
});
