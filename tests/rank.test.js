const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { docFrom, newDb } = require('./helpers');
const parser = require('../extension/lib/parser.js');
const ingest = require('../extension/lib/ingest.js');
const crawler = require('../extension/lib/crawler.js');
const search = require('../extension/lib/search.js');
const exporter = require('../extension/lib/export.js');
const rules = require('../extension/lib/rules.js');

// صفحات اصطناعية (SYNTHETIC FIXTURE) تحاكي قوائم الأكثر مبيعًا ونتائج البحث؛ لم تُتحقق شارات الترتيب على Amazon.sa الحقيقي.
const B = 'https://www.amazon.sa';
const asin = (n) => 'B0RANK' + String(n).padStart(4, '0');
const card = (n, o) => '<div data-asin="' + asin(n) + '"' + (o && o.sponsored ? ' class="AdHolder"' : '') + '>' + (o && o.badge ? '<span class="zg-bdg-text">#' + o.badge + '</span>' : '') +
  '<a href="/dp/' + asin(n) + '"><h2><span>Item ' + n + '</span></h2></a></div>';
const page = (cards) => '<html><body>' + cards.join('') + '</body></html>';
const parseHtml = (h) => new JSDOM(h).window.document;

test('قائمة: شارة الترتيب (#n) تُقرأ، وبغيابها يُستعمل موضع الظهور، والإعلان بلا ترتيب', () => {
  const withBadge = parser.parseListingDocument(docFrom(page([card(1, { badge: 1 }), card(2, { badge: 2 })])), B).items;
  assert.deepEqual(withBadge.map(i => [i.rank, i.rankBasis]), [[1, 'badge'], [2, 'badge']]);
  const noBadge = parser.parseListingDocument(docFrom(page([card(1), card(2, { sponsored: true }), card(3)])), B).items;
  assert.deepEqual(noBadge.map(i => [i.rank, i.rankBasis, i.sponsored]), [[1, 'position', false], [null, null, true], [2, 'position', false]]);
});

test('التخزين: ترتيب القائمة يُحفظ لقوائم الأكثر مبيعًا فقط، وأفضل ترتيب بين الأقسام هو الأصغر', async () => {
  const db = await newDb();
  const it = (n, rank) => ({ asin: asin(n), url: B + '/dp/' + asin(n), title: 't', rank, rankBasis: 'badge' });
  await ingest.ingestListingItems(db, [it(1, 7)], { listKind: 'bestsellers', listKey: 'إلكترونيات' });
  await ingest.ingestListingItems(db, [it(1, 3)], { listKind: 'bestsellers', listKey: 'ألعاب' });
  await ingest.ingestListingItems(db, [it(1, 1)], { listKind: 'other', listKey: 'عروض' });   // قائمة غير مرتبة: لا تُسجَّل
  const p = await db.get('products', asin(1));
  assert.equal(p.bestListRank, 3); assert.equal(p.bestListCatalog, 'ألعاب'); assert.deepEqual(Object.keys(p.listRanks).sort(), ['إلكترونيات', 'ألعاب'].sort());
  await ingest.ingestListingItems(db, [Object.assign(it(1, 9), { rank: null })], { listKind: 'bestsellers', listKey: 'ألعاب' });   // بلا ترتيب لا يمسح المسجّل
  assert.equal((await db.get('products', asin(1))).bestListRank, 3);
});

test('التخزين: ترتيب البحث لكل عبارة، وآخر بحث هو المعروض', async () => {
  const db = await newDb();
  const mk = (rank) => [{ asin: asin(2), url: B + '/dp/' + asin(2), title: 't', rank }];
  await ingest.ingestListingItems(db, mk(5), { query: 'kb', now: '2026-11-01T00:00:00Z' });
  await ingest.ingestListingItems(db, mk(2), { query: 'mouse', now: '2026-11-02T00:00:00Z' });
  const p = await db.get('products', asin(2));
  assert.equal(p.latestSearchRank, 2); assert.equal(p.latestSearchQuery, 'mouse'); assert.equal(p.searchRanks.kb.rank, 5);
});

// ---- أولوية الطابور ----
const q = (rank, kind, extra) => Object.assign({ url: B + '/dp/B0Q' + Math.random().toString(36).slice(2, 9).toUpperCase().padEnd(7, 'X'), type: 'product', depth: 0, rank, rankKind: kind }, extra);
async function order(db, settings, n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const it = await crawler.nextPending(db, settings, i); if (!it) break;
    out.push(it); it.status = 'done'; await db.put('queue', it);
  }
  return out;
}
test('الطابور: الأعلى ترتيبًا أولًا عبر الأقسام (#1 في كل قسم قبل #2 في أي قسم)', async () => {
  const db = await newDb(); const S = Object.assign({}, rules.DEFAULT_SETTINGS, { rankMixEvery: 0 });
  for (const [r, c] of [[3, 'A'], [1, 'B'], [2, 'A'], [1, 'A'], [2, 'B']]) await crawler.enqueue(db, q(r, 'bestsellers', { catalog: c }));
  const got = await order(db, S, 5);
  assert.deepEqual(got.map(x => x.rank), [1, 1, 2, 2, 3]);
});
test('الطابور: منتجات بلا ترتيب وإصدارات جديدة لا تُهمَل (كل رابعة افتراضيًا) ولا تتقدم على رقم 1', async () => {
  const db = await newDb(); const S = Object.assign({}, rules.DEFAULT_SETTINGS, { rankMixEvery: 4 });
  for (let r = 1; r <= 8; r++) await crawler.enqueue(db, q(r, 'bestsellers', { catalog: 'A' }));
  await crawler.enqueue(db, q(null, null, { catalog: 'A', note: 'unranked' }));
  await crawler.enqueue(db, q(1, 'new-releases', { catalog: 'A', note: 'new' }));
  const got = await order(db, S, 10);
  assert.equal(got[0].rank, 1); assert.ok(!got[0].note, 'أول عنصر هو #1 المصنَّف');
  const idxDisc = got.map((x, i) => x.note ? i : -1).filter(i => i >= 0);
  assert.equal(idxDisc[0], 3, 'أول حصة اكتشاف عند الدور الرابع'); assert.equal(got.length, 10);
  assert.ok(got.some(x => x.note === 'unranked') && got.some(x => x.note === 'new'), 'يصل الاثنان');
});
test('الطابور: لا مصنَّف ⇒ يُخدَم الاكتشاف؛ rankMixEvery=0 ⇒ ترتيب صرف ثم الاكتشاف', async () => {
  const db = await newDb();
  await crawler.enqueue(db, q(null, null, { note: 'x' }));
  assert.equal((await crawler.nextPending(db, rules.DEFAULT_SETTINGS, 0)).note, 'x');
  const db2 = await newDb(); const S0 = Object.assign({}, rules.DEFAULT_SETTINGS, { rankMixEvery: 0 });
  await crawler.enqueue(db2, q(null, null, { note: 'u' })); await crawler.enqueue(db2, q(50, 'bestsellers'));
  assert.equal((await order(db2, S0, 2)).map(x => x.note || x.rank).join(), '50,u');
});
test('الطابور: ترتيب أفضل يرقّي عنصرًا معلّقًا ولا يضاعفه', async () => {
  const db = await newDb(); const u = B + '/dp/B0UPGRADE1';
  await crawler.enqueue(db, { url: u, type: 'product', asin: 'B0UPGRADE1', depth: 0, rank: 40, rankKind: 'bestsellers' });
  assert.equal(await crawler.enqueue(db, { url: u, type: 'product', depth: 0, rank: 5, rankKind: 'bestsellers' }), false);
  assert.equal((await db.get('queue', u)).rank, 5);
  await crawler.enqueue(db, { url: u, type: 'product', depth: 0, rank: 30, rankKind: 'bestsellers' });
  assert.equal((await db.get('queue', u)).rank, 5, 'الأسوأ لا يستبدل الأفضل');
});
test('أنواع القوائم من الرابط', () => {
  assert.equal(crawler.listKindOf(B + '/gp/bestsellers/electronics'), 'bestsellers');
  assert.equal(crawler.listKindOf(B + '/gp/new-releases'), 'new-releases');
  assert.equal(crawler.listKindOf(B + '/gp/movers-and-shakers'), 'movers');
  assert.equal(crawler.listKindOf(B + '/gp/most-wished-for'), 'most-wished');
  assert.equal(crawler.listKindOf(B + '/deals'), 'other');
});

test('الزاحف: صفحة قائمة الأكثر مبيعًا تُدخل منتجاتها بترتيبها، والصفحة الثانية تكمل الترقيم', async () => {
  const db = await newDb();
  const html = page([card(1), card(2), card(3)]);
  const calls = [];
  const runner = crawler.createRunner({ db, settings: Object.assign({}, rules.DEFAULT_SETTINGS, { maxPagesPerRun: 1, maxCategoryDepth: 0, minDelayMs: 1, maxDelayMs: 2 }), parseHtml, sleep: async () => {}, random: () => 0,
    fetchHtml: async (url) => { calls.push(url); return { status: 200, url, html }; } });
  await crawler.enqueue(db, { url: B + '/gp/bestsellers', type: 'listing', depth: 0, origin: 'seed', catalog: 'الأكثر مبيعًا' });
  await runner.run();
  const items = (await db.all('queue')).filter(x => x.type === 'product').sort((a, b) => a.rank - b.rank);
  assert.deepEqual(items.map(x => [x.asin, x.rank, x.rankKind]), [[asin(1), 1, 'bestsellers'], [asin(2), 2, 'bestsellers'], [asin(3), 3, 'bestsellers']]);
  assert.equal((await db.get('products', asin(2))).bestListRank, 2);
});
test('الزاحف: قائمة غير مرتبة (عروض) لا تُسجَّل ترتيبًا', async () => {
  const db = await newDb();
  const runner = crawler.createRunner({ db, settings: Object.assign({}, rules.DEFAULT_SETTINGS, { maxPagesPerRun: 1, maxCategoryDepth: 0, minDelayMs: 1, maxDelayMs: 2 }), parseHtml, sleep: async () => {}, random: () => 0,
    fetchHtml: async (url) => ({ status: 200, url, html: page([card(1), card(2)]) }) });
  await crawler.enqueue(db, { url: B + '/deals', type: 'listing', depth: 0, origin: 'seed' });
  await runner.run();
  assert.ok((await db.all('queue')).filter(x => x.type === 'product').every(x => x.rank === null));
  assert.equal((await db.get('products', asin(1))).bestListRank, null);
});

// ---- البحث ----
const srp = (cards) => '<html><body>' + cards.map(c => c).join('') + '</body></html>';
const sr = (n, sponsored) => '<div data-component-type="s-search-result" data-asin="' + asin(n) + '"' + (sponsored ? ' class="AdHolder"' : '') + '><a href="/dp/' + asin(n) + '"><h2><span>Item ' + n + '</span></h2></a><span class="a-price"><span class="a-offscreen">ريال100</span></span></div>';
test('البحث: ترتيب عضوي بلا إعلانات، يتراكم عبر الصفحات، وما لم يُفحص يدخل الطابور بترتيبه', async () => {
  const db = await newDb();
  const next = '<a class="s-pagination-next" href="/s?k=kb&page=2">next</a>';
  const routes = {
    [B + '/s?k=kb']: srp([sr(1), sr(2, true), sr(3)]) + next,
    [B + '/s?k=kb&page=2']: srp([sr(4), sr(5)])
  };
  const deps = { db, settings: Object.assign({}, rules.DEFAULT_SETTINGS, { fetchSellerProfile: false }), parseHtml, sleep: async () => {}, random: () => 0,
    fetchHtml: async (url) => (url in routes ? { status: 200, url, html: routes[url] } : { status: 404, url, html: '' }) };
  const res = await search.runSearch(deps, 'kb', { pages: 2, deepScan: 0 });
  assert.equal(res.found, 5);
  const r = async (n) => (await db.get('products', asin(n))).latestSearchRank;
  assert.deepEqual([await r(1), await r(2), await r(3), await r(4), await r(5)], [1, null, 2, 3, 4], 'الإعلان بلا ترتيب والصفحة 2 تكمل');
  assert.equal(res.queuedRemainder, 5);
  const queued = (await db.all('queue')).filter(x => x.origin === 'search:kb');
  assert.equal(queued.length, 5); assert.equal(queued.find(x => x.asin === asin(3)).rank, 2); assert.equal(queued.find(x => x.asin === asin(2)).rank, null);
  const picked = await crawler.nextPending(db, Object.assign({}, rules.DEFAULT_SETTINGS, { catalogScope: [{ name: 'أخرى', url: 'u' }] }), 0);
  assert.ok(picked && picked.origin === 'search:kb', 'عناصر البحث لا تُستبعد بنطاق كتالوج محدد');
});

// ---- التصدير ----
test('التصدير: أعمدة الترتيب تظهر للمنتجات غير المفحوصة أيضًا (الفلترة لا تقتصر على ما زُرته)', () => {
  const products = [{ asin: asin(7), title: 't', url: 'u', detailScanned: false, bestListRank: 12, bestListCatalog: 'ألعاب', latestSearchRank: 4, latestSearchQuery: 'kb' }];
  const rows = exporter.buildRows(products, [], []);
  assert.equal(rows[0].bestListRank, 12); assert.equal(rows[0].latestSearchRank, 4);
  assert.match(exporter.toCSV(rows), /ترتيب القائمة[\s\S]*ترتيب البحث/);
});
