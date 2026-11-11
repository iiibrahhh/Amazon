const test = require('node:test');
const assert = require('node:assert/strict');
const m = require('../extension/lib/matching.js');

const prod = { brand: 'Acme', modelNumber: 'XZ-200', title: 'Acme XZ-200 Portable Mini USB Fan', description: 'Portable mini USB fan with three speeds and rechargeable battery', categoryPath: 'Home > Fans & Air Coolers' };
const good = { title: 'Acme XZ-200 Portable Mini USB Fan Rechargeable', price: 12, url: 'g', category1: 'Home Appliances', category2: 'Fans', shopName: 'Acme Official Store', orders: 5 };
const bad = { title: 'Phone Case Silicone', price: 3, url: 'b', category1: 'Phones', orders: 99999 };

test('الاسم والوصف والنوع والبائع: المرشح الصحيح يتفوق على المختلف', () => {
  const r = m.rank(prod, [bad, good], { sellerName: 'Acme Official' });
  assert.equal(r[0].url, 'g');
  assert.ok(r[0].match > 70 && r[1].match < 30, r.map(x => x.match).join(','));
  assert.equal(m.seller('Acme Official', good), 100); assert.equal(m.seller('Other', good), 0);
});

test('معيار بلا بيانات = null ويُعاد توزيع الوزن (لا يُعاقَب ولا يُخمَّن)', () => {
  const r = m.combine({ name: 80, image: null, description: null, type: null, seller: null });
  assert.equal(r.score, 80); assert.equal(r.missing.length, 4);
  assert.equal(m.combine({}).score, null);
  assert.equal(m.seller(null, good), null);
  assert.equal(m.name({ title: 'مروحة صغيرة' }, good), null, 'عنوان عربي صرف: لا كلمات للمقارنة');
});

test('بصمة الصورة: متطابقة 100، معكوسة 0، وتدريج الدرجة', () => {
  const gray = Array.from({ length: 72 }, (_, i) => (i * 37) % 255);
  const h = m.dHash(gray);
  assert.equal(h.length, 64);
  assert.equal(m.hashSimilarity(h, h), 100);
  const inv = h.split('').map(c => c === '1' ? '0' : '1').join('');
  assert.equal(m.hashSimilarity(h, inv), 0);
  assert.equal(m.imageScore(50), 0); assert.equal(m.imageScore(100), 100); assert.equal(m.imageScore(null), null);
  assert.equal(m.dHash([1, 2]), null);
});

test('الصورة ترفع المرشح الأقرب بصريًا عند تساوي النص', () => {
  const a = { title: 'Mini USB Fan', price: 5, url: 'a' }, b = { title: 'Mini USB Fan', price: 5, url: 'b' };
  const r = m.rank({ title: 'Mini USB Fan' }, [a, b], { imageSimilarity: c => c.url === 'b' ? 95 : 55 });
  assert.equal(r[0].url, 'b');
  assert.match(r[0].matchExplain, /الصورة 90/);
});
