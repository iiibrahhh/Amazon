const test = require('node:test');
const assert = require('node:assert/strict');
const { docFrom } = require('./helpers');
const ap = require('../extension/lib/aliparse.js');

// SYNTHETIC: مبني على بنية نص صفحة حقيقية أرسلها المستخدم، وليس HTML حقيقيًا من AliExpress.
const HTML = `<body><div id="list">
<div class="card"><a href="//www.aliexpress.com/item/1005006111111111.html?spm=a2g0o&x=1"><img src="//ae01.alicdn.com/a.jpg" alt="">
 <h3>شاشة UPERFECT USteam E6 Pro مقاس 18.5 بوصة شاشة محمولة تعمل باللمس 1080Pشاشة UPERFECT USteam E6 Pro مقاس 18.5 بوصة شاشة محمولة تعمل باللمس 1080P</h3></a>
 <div>1920×1080 · Uperfect</div><div>81 مباعة</div><div>4.4</div><div>674.39ر.س.</div><div>شحن مجاني</div></div>
<div class="card"><a href="/item/1005007222222222.html"><img data-src="https://ae01.alicdn.com/b.jpg" alt="">
 <span>وصلات شعر لاصقة 26 بوصة</span></a><div>+1 ألف مباعة</div><div>4.9</div><div>٨٢٫١٧ر.س.</div><div>إعلان</div></div>
<div class="card"><a href="/item/1005008333333333.html" title="Portable Monitor 18.5 inch"><img src="//ae01.alicdn.com/c.jpg"></a><div>SAR 343.39</div><div>14 sold</div></div>
</div></body>`;

test('بطاقات AliExpress (اصطناعية): رابط صفحة المنتج الصريح بلا معاملات تتبع', () => {
  const l = ap.parseSearchDocument(docFrom(HTML), 'https://www.aliexpress.com/wholesale?SearchText=x');
  assert.equal(l.length, 3);
  assert.equal(l[0].url, 'https://www.aliexpress.com/item/1005006111111111.html');
  assert.equal(l[0].price, 674.39); assert.equal(l[0].orders, 81); assert.equal(l[0].rating, 4.4);
  assert.ok(!/(.{20,}).*\1/.test(l[0].title) || l[0].title.length < 120, 'العنوان المكرر يُختصر');
  assert.equal(l[0].image, 'https://ae01.alicdn.com/a.jpg');
  assert.equal(l[1].orders, 1000); assert.equal(l[1].sponsored, true); assert.equal(l[1].image, 'https://ae01.alicdn.com/b.jpg');
  assert.equal(l[2].title, 'Portable Monitor 18.5 inch'); assert.equal(l[2].price, 343.39); assert.equal(l[2].orders, 14);
});

test('الحاجز: صفحة تحقق بلا بطاقات تُعرف، والصفحة ذات البطاقات لا', () => {
  assert.equal(ap.isBlocked(docFrom('<body>Please slide to verify</body>')), true);
  assert.equal(ap.isBlocked(docFrom(HTML)), false);
  assert.deepEqual(ap.parseSearchDocument(docFrom('<body>لا شيء</body>')), []);
});

test('مساعدات: عدد المبيعات والسعر', () => {
  assert.equal(ap.parseOrders('+1 ألف مباعة'), 1000); assert.equal(ap.parseOrders('53 مباعة'), 53); assert.equal(ap.parseOrders('1.5k sold'), 1500);
  assert.equal(ap.parsePrice('10.22ر.س. للواحد'), 10.22); assert.equal(ap.parsePrice('abc'), null);
});
