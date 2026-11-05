const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { newDb } = require('./helpers');
const ingest = require('../extension/lib/ingest.js');
const crawler = require('../extension/lib/crawler.js');
const exporter = require('../extension/lib/export.js');
const rules = require('../extension/lib/rules.js');

// بيانات اصطناعية (SYNTHETIC): تختبر منطق سرعة تغيّر الترتيب فقط، لا ترتيبات حقيقية من Amazon.sa.
const B = 'https://www.amazon.sa';
const A = 'B0MOVE0001';
const it = (rank) => [{ asin: A, url: B + '/dp/' + A, title: 't', rank, rankBasis: 'badge' }];
const ctx = (day, extra) => Object.assign({ listKind: 'bestsellers', listKey: 'ألعاب', now: '2026-11-0' + day + 'T10:00:00.000Z' }, extra || {});
const parseHtml = (h) => new JSDOM(h).window.document;

test('سجل الترتيب: تحسّن 90 → 20 ⇒ move موجب بنص «من #90 إلى #20»، وملاحظة واحدة لا تعطي move', async () => {
  const db = await newDb();
  await ingest.ingestListingItems(db, it(90), ctx(1));
  assert.equal((await db.get('products', A)).rankMove, null);
  await ingest.ingestListingItems(db, it(20), ctx(3));
  const p = await db.get('products', A);
  assert.equal(p.rankMove, Math.round(Math.log(90 / 20) * 1000) / 1000); assert.ok(p.rankMove > 1.5);
  assert.match(p.rankMoveText, /^من #90 إلى #20/);
  assert.equal(p.bestListRank, 20);
});
test('سجل الترتيب: تراجع ⇒ move سالب، وتكرار الترتيب نفسه خلال 12 ساعة لا يضيف ملاحظة', async () => {
  const db = await newDb();
  await ingest.ingestListingItems(db, it(10), ctx(1));
  await ingest.ingestListingItems(db, it(10), Object.assign(ctx(1), { now: '2026-11-01T14:00:00.000Z' }));
  assert.equal((await db.get('products', A)).rankHistory['list:ألعاب'].length, 1);
  await ingest.ingestListingItems(db, it(40), ctx(2));
  const p = await db.get('products', A);
  assert.ok(p.rankMove < 0); assert.match(p.rankMoveText, /^من #10 إلى #40/);
});
test('سجل الترتيب: لكل قائمة/عبارة بحث سجل مستقل، والأكبر تغيّرًا مطلقًا هو المعروض', async () => {
  const db = await newDb();
  await ingest.ingestListingItems(db, it(50), ctx(1)); await ingest.ingestListingItems(db, it(45), ctx(2));                        // تغيّر طفيف
  await ingest.ingestListingItems(db, it(30), { query: 'kb', now: '2026-11-01T10:00:00.000Z' }); await ingest.ingestListingItems(db, it(3), { query: 'kb', now: '2026-11-02T10:00:00.000Z' });
  const p = await db.get('products', A);
  assert.match(p.rankMoveText, /\(kb\)/); assert.ok(p.rankMove > 2);
});

const S = (extra) => Object.assign({}, rules.DEFAULT_SETTINGS, { maxPagesPerRun: 1, maxCategoryDepth: 0, minDelayMs: 1, maxDelayMs: 2 }, extra || {});
const listHtml = (rank) => '<html><body><div data-asin="' + A + '"><span class="zg-bdg-text">#' + rank + '</span><a href="/dp/' + A + '"><h2><span>t</span></h2></a></div></body></html>';
async function crawlList(db, rank, settings) {
  const runner = crawler.createRunner({ db, settings, parseHtml, sleep: async () => {}, random: () => 0, fetchHtml: async (url) => ({ status: 200, url, html: listHtml(rank) }) });
  await crawler.enqueue(db, { url: B + '/gp/bestsellers', type: 'listing', depth: 0, origin: 'seed', catalog: 'ألعاب' });
  const old = await db.get('queue', B + '/gp/bestsellers'); if (old && old.status !== 'pending') await db.put('queue', Object.assign({}, old, { status: 'pending' }));
  return runner.run();
}
test('الزاحف: منتج مفحوص تغيّر ترتيبه بسرعة يُعاد إلى الطابور بعلامة move (ولا يُعاد إن فُحص حديثًا)', async () => {
  const db = await newDb(); const key = B + '/dp/' + A;
  await ingest.ingestListingItems(db, it(90), ctx(1, { now: '2026-10-01T10:00:00.000Z' }));
  const p0 = await db.get('products', A); await db.put('products', Object.assign(p0, { detailScanned: true, lastCheckedAt: '2026-10-01T10:00:00.000Z' }));
  await db.put('queue', { url: key, type: 'product', asin: A, status: 'done', attempts: 1, depth: 0, addedAt: '2026-10-01T10:00:00.000Z', origin: 'x' });
  await ingest.ingestListingItems(db, it(20), { listKind: 'bestsellers', listKey: 'ألعاب', now: new Date().toISOString() });
  // سجل قديم + ملاحظة حديثة: التغيّر ضمن آخر 14 يومًا؟ نجعل rankMoveAt حديثًا
  const run = await crawlList(db, 20, S({ maxPagesPerRun: 1 }));
  const q = await db.get('queue', key);
  assert.equal(q.status, 'pending'); assert.equal(q.origin, 'rank-move'); assert.ok(q.move > 1);
  assert.equal(run.requeuedMoving, 1);
});
test('الزاحف: rankMoveThreshold=0 يعطّل الأولوية والإعادة', async () => {
  const db = await newDb(); const key = B + '/dp/' + A;
  await ingest.ingestListingItems(db, it(90), ctx(1, { now: '2026-10-01T10:00:00.000Z' }));
  await db.put('products', Object.assign(await db.get('products', A), { detailScanned: true, lastCheckedAt: '2026-10-01T10:00:00.000Z' }));
  await db.put('queue', { url: key, type: 'product', asin: A, status: 'done', attempts: 1, depth: 0, addedAt: '2026-10-01T10:00:00.000Z', origin: 'x' });
  await ingest.ingestListingItems(db, it(20), { listKind: 'bestsellers', listKey: 'ألعاب', now: new Date().toISOString() });
  await crawlList(db, 20, S({ rankMoveThreshold: 0 }));
  assert.equal((await db.get('queue', key)).status, 'done');
});
test('الطابور: السريعة التغيّر تُخدم في أول حصة اكتشاف، ثم الاكتشاف في الثانية', async () => {
  const db = await newDb(); const set = Object.assign({}, rules.DEFAULT_SETTINGS, { rankMixEvery: 4 });
  for (let r = 1; r <= 12; r++) await crawler.enqueue(db, { url: B + '/dp/B0QUEUE' + String(r).padStart(3, '0'), type: 'product', depth: 0, rank: r, rankKind: 'bestsellers' });
  await crawler.enqueue(db, { url: B + '/dp/B0MOVER001', type: 'product', depth: 0, rank: 95, rankKind: 'bestsellers', move: 1.6 });
  await crawler.enqueue(db, { url: B + '/dp/B0DISC0001', type: 'product', depth: 0, rank: null, rankKind: null });
  const got = [];
  for (let n = 0; n < 9; n++) { const x = await crawler.nextPending(db, set, n); got.push(x.url.split('/').pop()); x.status = 'done'; await db.put('queue', x); }
  assert.equal(got[3], 'B0MOVER001', 'أول حصة (الدور 4) للأسرع تغيّرًا');
  assert.equal(got[7], 'B0DISC0001', 'الحصة الثانية (الدور 8) لمنتج الاكتشاف');
  assert.equal(got[0], 'B0QUEUE001');
});
test('التصدير: عمود تغيّر الترتيب ونص التغيّر', () => {
  const rows = exporter.buildRows([{ asin: A, title: 't', url: 'u', detailScanned: false, rankMove: 1.5, rankMoveText: 'من #90 إلى #20 (ألعاب)' }], [], []);
  assert.equal(rows[0].rankMoveText, 'من #90 إلى #20 (ألعاب)');
  assert.match(exporter.toCSV(rows), /تغيّر الترتيب بين فحصين/);
});
