const test = require('node:test');
const assert = require('node:assert/strict');
const { JSDOM } = require('jsdom');
const { docFrom, newDb } = require('./helpers');
const seller = require('../extension/lib/seller.js');
const parser = require('../extension/lib/parser.js');
const ingest = require('../extension/lib/ingest.js');
const search = require('../extension/lib/search.js');
const rules = require('../extension/lib/rules.js');

// كل صفحات البائع هنا اصطناعية (SYNTHETIC FIXTURE): بنيتها مفترضة من تسميات شائعة، ولم تُتحقق على Amazon.sa الحقيقي.
const spPage = (body) => '<html><body>' + body + '</body></html>';
const EN_CN = spPage('<h3>Detailed Seller Information</h3><div><span>Business Name:</span><span>Foo Tech Co., Ltd.</span></div><div><span>Business Address:</span><span>Room 301</span><span>Futian District</span><span>Shenzhen</span><span>518000</span><span>CN</span></div><div><span>Phone number:</span><span>123</span></div>');
const AR_SA = spPage('<div><span>اسم النشاط التجاري:</span><span>متجر الرياض</span></div><div><span>عنوان النشاط التجاري:</span><span>شارع العليا</span><span>الرياض</span><span>SA</span></div>');
const AR_NAME = spPage('<div><span>عنوان العمل:</span><span>دبي، الإمارات</span></div>');
const INLINE = spPage('<div>Business Address: Dubai Silicon Oasis, Dubai, AE</div>');
const NOCODE = spPage('<div><span>Business Address:</span><span>Somewhere</span><span>ZZ</span></div>');
const NOADDR = spPage('<div><span>Business Name:</span><span>X</span></div>');

test('صفحة البائع: عنوان صيني (رمز CN) بصفوف منفصلة', () => {
  const p = seller.parseSellerProfile(docFrom(EN_CN));
  assert.equal(p.ok, true); assert.equal(p.countryCode, 'CN'); assert.equal(p.isForeign, true); assert.equal(p.isSaudi, false);
  assert.equal(p.businessName, 'Foo Tech Co., Ltd.'); assert.match(p.addressText, /Shenzhen/);
  assert.equal(p.evidence.label, 'business address'); assert.match(p.evidence.text, /Business Address:/);
});
test('صفحة البائع: عنوان سعودي عربي (SA) ليس أجنبيًا', () => {
  const p = seller.parseSellerProfile(docFrom(AR_SA));
  assert.equal(p.countryCode, 'SA'); assert.equal(p.isSaudi, true); assert.equal(p.isForeign, false);
});
test('صفحة البائع: اسم دولة عربي، وعنوان في سطر واحد برمز AE', () => {
  assert.equal(seller.parseSellerProfile(docFrom(AR_NAME)).countryCode, 'AE');
  const i = seller.parseSellerProfile(docFrom(INLINE));
  assert.equal(i.countryCode, 'AE'); assert.equal(i.isForeign, true);
});
test('رمز غير معروف أو غياب العنوان ⇒ بلا بلد (لا تخمين)', () => {
  const z = seller.parseSellerProfile(docFrom(NOCODE));
  assert.equal(z.ok, true); assert.equal(z.countryCode, null); assert.equal(z.isForeign, false); assert.equal(z.isSaudi, false);
  const n = seller.parseSellerProfile(docFrom(NOADDR));
  assert.equal(n.ok, false); assert.equal(n.reason, 'no_address');
});
test('اسم البائع أو نشاطه لا يُنتج بلدًا: «China Gadgets» كاسم نشاط بلا عنوان', () => {
  const p = seller.parseSellerProfile(docFrom(spPage('<div><span>Business Name:</span><span>China Gadgets Hub</span></div>')));
  assert.equal(p.ok, false); assert.equal(p.countryCode === undefined || p.countryCode === null, true);
});

// ---- الجلب والتخزين المؤقت ----
const parseHtml = (h) => new JSDOM(h).window.document;
const B = 'https://www.amazon.sa';
function deps(db, routes, extra) {
  const calls = [];
  return Object.assign({ db, settings: Object.assign({}, rules.DEFAULT_SETTINGS, { searchMinDelayMs: 500 }), calls, parseHtml, sleep: async () => {}, random: () => 0.5,
    fetchHtml: async (url) => { calls.push(url); const r = routes[url]; return r === undefined ? { status: 404, url, html: '' } : typeof r === 'object' ? r : { status: 200, url, html: r }; } }, extra);
}
test('ensureProfile: يجلب ويخزن ثم يستعمل الذاكرة (بلا طلب ثانٍ)', async () => {
  const db = await newDb(); const d = deps(db, { [B + '/sp?seller=A1CNSELLER01']: EN_CN });
  const a = await seller.ensureProfile(d, 'A1CNSELLER01'); assert.equal(a.fetched, true); assert.equal(a.profile.countryCode, 'CN');
  const b = await seller.ensureProfile(d, 'a1cnseller01'); assert.equal(b.fetched, false);
  assert.equal(d.calls.length, 1);
  assert.equal((await seller.getCached(db, 'A1CNSELLER01')).countryCode, 'CN');
});
test('ensureProfile: الحجب يرمي blocked ولا يُخزَّن، و404 لا يُخزَّن', async () => {
  const db = await newDb();
  await assert.rejects(seller.ensureProfile(deps(db, { [B + '/sp?seller=A1B']: '<html><body><form action="/errors/validateCaptcha"></form>Enter the characters you see below</body></html>' }), 'A1B'), (e) => !!e.blocked);
  assert.equal(await seller.getCached(db, 'A1B'), null);
  const r = await seller.ensureProfile(deps(db, {}), 'A1MISSING'); assert.equal(r.profile.ok, false);
  assert.equal(await seller.getCached(db, 'A1MISSING'), null);
  await assert.rejects(seller.ensureProfile(deps(db, { [B + '/sp?seller=A1T']: { status: 503, url: '', html: '' } }), 'A1T'), (e) => !!e.throttled);
});

// ---- أثرها على التصنيف ----
const NOW = new Date('2026-10-26T08:00:00Z');
const LINK = (n, id) => '<a id="sellerProfileTriggerId" href="/sp?seller=' + id + '">' + n + '</a>';
const productHtml = (shipper, id, avail) => '<html><body><span id="productTitle">x</span><div id="tabular-buybox"><div tabular-attribute-name="Ships from"><span>Ships from</span><span>' + shipper + '</span></div><div tabular-attribute-name="Sold by"><span>Sold by</span>' + LINK('Foo', id) + '</div></div>' + (avail || '') + '</body></html>';
const parseProduct = (html, asin) => parser.parseProductDocument(docFrom(html), B + '/dp/' + asin, { now: NOW });
const put = (db, id, html) => db.put('sources', Object.assign({ id: 'seller:' + id, sellerId: id, url: B + '/sp?seller=' + id, checkedAt: NOW.toISOString() }, seller.parseSellerProfile(docFrom(html))));

test('بائع يشحن بنفسه + عنوانه الصيني (مدد قصيرة): «مرجح» بدليل من صفحة البائع، لا «مؤكد»، ولا بلد شحن', async () => {
  const db = await newDb(); await put(db, 'A1CNSELLER01', EN_CN);
  const r = await ingest.ingestProduct(db, parseProduct(productHtml('Foo', 'A1CNSELLER01'), 'B0SELLER01'), { now: '2026-10-26T10:00:00.000Z', settings: {} });
  assert.equal(r.classification.status, 'likely');
  const e = r.classification.evidence.find(x => x.signal === 'seller_business_address_foreign');
  assert.ok(e); assert.equal(e.field, 'sellerProfile'); assert.match(e.text, /CN/); assert.match(e.source, /seller-profile/);
  assert.equal(r.classification.originCountry, null, 'لا يُستنتج بلد الشحن من موقع البائع');
  const o = await db.get('offers', r.offer.offerKey); assert.equal(o.sellerProfile.code, 'CN');
});
test('الإعداد sellerAddressAsConfirmed يرفعه إلى «مؤكد»', async () => {
  const db = await newDb(); await put(db, 'A1CNSELLER01', EN_CN);
  const r = await ingest.ingestProduct(db, parseProduct(productHtml('Foo', 'A1CNSELLER01'), 'B0SELLER02'), { now: '2026-10-26T10:00:00.000Z', settings: { sellerAddressAsConfirmed: true } });
  assert.equal(r.classification.status, 'confirmed');
});
test('عنوان سعودي: لا يغيّر الحكم (غير معلوم) ويُسجَّل كملاحظة فقط', async () => {
  const db = await newDb(); await put(db, 'A1SASELLER01', AR_SA);
  const r = await ingest.ingestProduct(db, parseProduct(productHtml('Foo', 'A1SASELLER01'), 'B0SELLER03'), { now: '2026-10-26T10:00:00.000Z', settings: {} });
  assert.equal(r.classification.status, 'unknown'); assert.ok(r.classification.notes.some(n => /السعودية/.test(n)));
});
test('الشاحن أمازون: عنوان البائع الأجنبي لا يؤثر', async () => {
  const db = await newDb(); await put(db, 'A1CNSELLER01', EN_CN);
  const r = await ingest.ingestProduct(db, parseProduct(productHtml('Amazon', 'A1CNSELLER01'), 'B0SELLER04'), { now: '2026-10-26T10:00:00.000Z', settings: {} });
  assert.notEqual(r.classification.status, 'likely'); assert.notEqual(r.classification.status, 'confirmed');
  assert.ok(!r.classification.evidence.some(x => x.signal === 'seller_business_address_foreign'));
});
test('بلا صفحة بائع مخزّنة: السلوك السابق (غير معلوم) وsellerProfile=null', async () => {
  const db = await newDb();
  const r = await ingest.ingestProduct(db, parseProduct(productHtml('Foo', 'A1NONESELLER1'), 'B0SELLER05'), { now: '2026-10-26T10:00:00.000Z', settings: {} });
  assert.equal(r.classification.status, 'unknown'); assert.equal((await db.get('offers', r.offer.offerKey)).sellerProfile, null);
});

// ---- التكامل في البحث ----
test('البحث: يجلب صفحة المنتج ثم صفحة البائع مرة واحدة، ويصنّف «مرجحًا»', async () => {
  const db = await newDb();
  const d = deps(db, { [B + '/dp/B0SELLER06']: productHtml('Foo', 'A1CNSELLER01'), [B + '/sp?seller=A1CNSELLER01']: EN_CN }, { settings: Object.assign({}, rules.DEFAULT_SETTINGS, { fetchSellerProfile: true }) });
  const res = await search.runSearch(d, 'B0SELLER06', {});
  assert.deepEqual(d.calls, [B + '/dp/B0SELLER06', B + '/sp?seller=A1CNSELLER01']);
  assert.equal(res.classification.status, 'likely');
  const again = await search.runSearch(d, 'B0SELLER06', {});
  assert.equal(d.calls.length, 3, 'الإعادة تطلب صفحة المنتج فقط: البائع في الذاكرة');
  assert.equal(again.classification.status, 'likely');
});
test('البحث: fetchSellerProfile=false ⇒ لا طلب لصفحة البائع', async () => {
  const db = await newDb();
  const d = deps(db, { [B + '/dp/B0SELLER07']: productHtml('Foo', 'A1CNSELLER01') }, { settings: Object.assign({}, rules.DEFAULT_SETTINGS, { fetchSellerProfile: false }) });
  await search.runSearch(d, 'B0SELLER07', {});
  assert.deepEqual(d.calls, [B + '/dp/B0SELLER07']);
});
test('البحث: الشاحن أمازون ⇒ لا طلب لصفحة البائع', async () => {
  const db = await newDb();
  const d = deps(db, { [B + '/dp/B0SELLER08']: productHtml('Amazon', 'A1CNSELLER01') }, { settings: Object.assign({}, rules.DEFAULT_SETTINGS, { fetchSellerProfile: true }) });
  await search.runSearch(d, 'B0SELLER08', {});
  assert.deepEqual(d.calls, [B + '/dp/B0SELLER08']);
});
test('البحث: صفحة البائع تطلب CAPTCHA ⇒ يتوقف (blocked) لكن المنتج يُحفظ', async () => {
  const db = await newDb();
  const d = deps(db, { [B + '/dp/B0SELLER09']: productHtml('Foo', 'A1CNSELLER01'), [B + '/sp?seller=A1CNSELLER01']: '<html><body><form action="/errors/validateCaptcha"></form>Enter the characters you see below</body></html>' },
    { settings: Object.assign({}, rules.DEFAULT_SETTINGS, { fetchSellerProfile: true }) });
  const res = await search.runSearch(d, 'B0SELLER09', {});
  assert.equal(res.stoppedBecause, 'blocked');
  assert.equal((await db.get('products', 'B0SELLER09')).detailScanned, true);
});
