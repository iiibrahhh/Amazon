const test = require('node:test');
const assert = require('node:assert/strict');
const exporter = require('../extension/lib/export.js');

const R = (shipperName, shipperType) => ({ shipperName, shipperType });
const rows = [R('Amazon.sa', 'amazon'), R('MahzuzStores', 'seller'), R('Shopglobalstore - KSA', 'seller'), R('Amazon Global', 'amazon_global'), R(null, null)];
const names = (cond) => rows.filter(r => exporter.matchShipper(r, cond)).map(r => r.shipperName);

test('فلتر نوع الشاحن', () => {
  assert.equal(names({ type: 'all' }).length, 5);
  assert.deepEqual(names({ type: 'amazon' }), ['Amazon.sa']);
  assert.deepEqual(names({ type: 'seller' }), ['MahzuzStores', 'Shopglobalstore - KSA']);
  assert.deepEqual(names({ type: 'amazon_global' }), ['Amazon Global']);
  assert.deepEqual(names({ type: 'none' }), [null]);
});

test('فلتر اسم الشاحن: احتواء بلا حساسية لحالة الحروف، وعدة كلمات (أيٌّ منها)، واستبعاد', () => {
  assert.deepEqual(names({ name: 'mahzuz' }), ['MahzuzStores']);
  assert.deepEqual(names({ name: 'mahzuz, shopglobal' }), ['MahzuzStores', 'Shopglobalstore - KSA']);
  assert.deepEqual(names({ name: 'mahzuz، global' }), ['MahzuzStores', 'Shopglobalstore - KSA', 'Amazon Global'], 'فاصلة عربية');
  assert.deepEqual(names({ name: '-amazon' }), ['MahzuzStores', 'Shopglobalstore - KSA', null], 'استبعاد فقط');
  assert.deepEqual(names({ name: 'global, -amazon' }), ['Shopglobalstore - KSA']);
  assert.equal(names({ name: '   ' }).length, 5, 'نص فارغ = بلا شرط');
});

test('الشرطان معًا، والاسم العربي يُطابق مع طي الهمزات', () => {
  assert.deepEqual(names({ type: 'seller', name: 'ksa' }), ['Shopglobalstore - KSA']);
  assert.deepEqual(names({ type: 'amazon', name: 'mahzuz' }), []);
  assert.equal(exporter.matchShipper({ shipperName: 'متجر أحمد للإلكترونيات', shipperType: 'seller' }, { name: 'احمد' }), true);
});
