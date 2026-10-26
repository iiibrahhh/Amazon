#!/usr/bin/env node
/* أداة P0: تشغّل المحلّل والمصنّف على ملفات HTML محفوظة (من زر «تشخيص صفحة منتج» أو «حفظ الصفحة باسم» في Chrome)
   وتطبع/تحفظ ما استُخرج بجانب أعمدة فارغة لتكتب فيها ما تراه فعليًا على Amazon.
   الاستخدام:  node scripts/p0-check.js <مجلد أو ملفات .html> [--out docs/p0_field_check.csv]
   لا تتصل بالإنترنت ولا تعدّل الملفات. */
const fs = require('fs'); const path = require('path');
const { JSDOM } = require('jsdom');
const parser = require('../extension/lib/parser.js');
const classifier = require('../extension/lib/classifier.js');

const args = process.argv.slice(2);
const oi = args.indexOf('--out'); const out = oi >= 0 ? args.splice(oi, 2)[1] : null;
if (!args.length) { console.error('أعطني مجلدًا أو ملفات HTML.'); process.exit(1); }
const files = args.flatMap(a => fs.statSync(a).isDirectory()
  ? fs.readdirSync(a).filter(f => /\.html?$/i.test(f)).map(f => path.join(a, f)) : [a]);

const FIELDS = (p, c) => [
  ['title', p.title], ['price', p.offer.price], ['currency', p.offer.currency],
  ['sellerName(يباع بواسطة)', p.offer.sellerName], ['shipperName(يشحن بواسطة)', p.offer.shipperName],
  ['shipsFrom(كما ظهر)', p.offer.shipsFrom], ['shippingCost', p.offer.shippingCost],
  ['importFees', p.offer.importFees], ['deliveryDate', p.offer.deliveryDate], ['deliveryText', p.offer.deliveryText],
  ['rating', p.rating], ['reviewCount', p.reviewCount], ['bsr', p.bsrRank],
  ['shippingStatus', c.status], ['originCountry', c.originCountry || c.originNote],
  ['evidence', c.evidence.map(e => `[${e.strength}] ${e.field}: ${e.text}`).join(' | ')]
];
const q = (v) => '"' + String(v === null || v === undefined ? '' : v).replace(/"/g, '""') + '"';
const rows = [['file', 'asin', 'field', 'extracted', 'shown_on_amazon (املأه يدويًا)', 'correct? (نعم/لا)', 'note']];
for (const f of files) {
  const html = fs.readFileSync(f, 'utf8');
  const doc = new JSDOM(html).window.document;
  const blk = parser.detectBlocked(doc, '');
  const asinGuess = (path.basename(f).match(/[A-Z0-9]{10}/) || [null])[0];
  const p = parser.parseProductDocument(doc, asinGuess ? 'https://www.amazon.sa/dp/' + asinGuess : '');
  console.log('\n== ' + f + (blk.blocked ? '  [صفحة تحقق/CAPTCHA — لا بيانات]' : ''));
  if (!p.ok) { console.log('  ليست صفحة منتج معروفة.'); rows.push([f, asinGuess, 'PAGE', 'not_product_page', '', '', '']); continue; }
  const c = classifier.classifyShipping(p.shippingFields, { url: p.url });
  for (const [k, v] of FIELDS(p, c)) {
    console.log('  ' + k.padEnd(28) + (v === null || v === undefined || v === '' ? '— (غير موجود)' : String(v).slice(0, 110)));
    rows.push([f, p.asin, k, v, '', '', '']);
  }
  console.log('  حقول ناقصة: ' + (p.fieldsMissing.join('، ') || 'لا شيء'));
}
if (out) { fs.writeFileSync(out, '\ufeff' + rows.map(r => r.map(q).join(',')).join('\r\n') + '\r\n'); console.log('\nحُفظ: ' + out); }
