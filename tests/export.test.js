const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { spawnSync } = require('child_process');
const { fixtureDoc, newDb } = require('./helpers');
const parser = require('../extension/lib/parser.js');
const ingest = require('../extension/lib/ingest.js');
const ex = require('../extension/lib/export.js');

async function seededRows() {
  const db = await newDb();
  for (const [f, a] of [['product_intl_confirmed.html', 'B0TEST0001'], ['product_arabic_no_price.html', 'B0TEST0004'], ['product_shuffled_arabic_abroad.html', 'B0TEST0005']])
    await ingest.ingestProduct(db, parser.parseProductDocument(fixtureDoc(f), 'https://www.amazon.sa/dp/' + a), { now: '2026-10-22T08:00:00.000Z' });
  const rows = ex.buildRows(await db.all('products'), await db.all('offers'), await db.all('evidence'));
  return { db, rows };
}

test('CSV عربي: BOM وUTF-8 وترويسة عربية، ولا أرقام وهمية للبيانات المفقودة', async () => {
  const { rows } = await seededRows();
  const csv = ex.toCSV(rows);
  assert.equal(csv.charCodeAt(0), 0xFEFF);
  const buf = Buffer.from(csv, 'utf8');
  assert.deepEqual([...buf.slice(0, 3)], [0xEF, 0xBB, 0xBF]);
  const table = ex.parseCSV(csv);
  assert.deepEqual(table[0].slice(0, 3), ['ASIN', 'اسم المنتج', 'العلامة التجارية']);
  const iTitle = table[0].indexOf('اسم المنتج'), iPrice = table[0].indexOf('السعر'), iAsin = 0, iStatus = table[0].indexOf('حالة الشحن الدولي'), iEv = table[0].indexOf('دليل التصنيف');
  const arabic = table.find(r => r[iAsin] === 'B0TEST0004');
  assert.equal(arabic[iTitle], 'سماعة رأس لاسلكية للألعاب – إصدار محدود');
  assert.equal(arabic[iPrice], '', 'منتج بلا سعر = خلية فارغة وليس 0');
  assert.equal(arabic[iStatus], 'غير معلوم');
  const abroad = table.find(r => r[iAsin] === 'B0TEST0005');
  assert.equal(abroad[iStatus], 'مؤكد');
  assert.match(abroad[iEv], /يشحن من الخارج/);
  const conf = table.find(r => r[iAsin] === 'B0TEST0001');
  assert.equal(conf[iPrice], '299');
  assert.ok(table[0].includes('رابط المنتج') && table[0].includes('مصدر البيانات') && table[0].includes('آخر فحص') && table[0].includes('العملة'));
});

test('CSV: علامات الاقتباس والفواصل والأسطر الجديدة تُحفظ، وحقن الصيغ يُعطَّل', () => {
  const cols = [{ key: 'a', label: 'ع' }, { key: 'b', label: 'ب' }];
  const rows = [{ a: 'قال "مرحبا", ثم\nسطر', b: '=HYPERLINK("http://x")' }, { a: '-5 كرتون', b: '+1' }];
  const csv = ex.toCSV(rows, cols);
  const back = ex.parseCSV(csv);
  assert.equal(back[1][0], 'قال "مرحبا", ثم\nسطر');
  assert.equal(back[1][1].startsWith("'="), true);
  assert.equal(back[2][1].startsWith("'+"), true);
});

test('XLSX: ملف صالح يفتحه Excel/openpyxl، عربي، RTL، والمفقود فارغ', async (t) => {
  const { rows } = await seededRows();
  const bytes = ex.buildXlsx(rows);
  assert.deepEqual([...bytes.slice(0, 4)], [0x50, 0x4B, 0x03, 0x04]);
  const file = path.join(os.tmpdir(), 'asf_test_' + Date.now() + '.xlsx');
  fs.writeFileSync(file, bytes);
  const py = `
import sys, zipfile, openpyxl
z = zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None
wb = openpyxl.load_workbook(sys.argv[1]); ws = wb.active
hdr = [c.value for c in ws[1]]
print(ws.title, ws.sheet_view.rightToLeft, ws.max_row, ws.freeze_panes)
rows = {r[0].value: r for r in ws.iter_rows(min_row=2)}
r = rows['B0TEST0004']
print(r[hdr.index('اسم المنتج')].value)
print(repr(r[hdr.index('السعر')].value))
print(repr(rows['B0TEST0001'][hdr.index('السعر')].value), type(rows['B0TEST0001'][hdr.index('السعر')].value).__name__)
print(rows['B0TEST0005'][hdr.index('حالة الشحن الدولي')].value)
`;
  const r = spawnSync('python3', ['-c', py, file], { encoding: 'utf8' });
  if (r.error || /No module named/.test(r.stderr || '')) return t.skip('python3/openpyxl غير متاحين');
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines[0], 'المنتجات True 4 A2');
  assert.equal(lines[1], 'سماعة رأس لاسلكية للألعاب – إصدار محدود');
  assert.equal(lines[2], 'None');
  assert.equal(lines[3], '299 int');
  assert.equal(lines[4], 'مؤكد');
  fs.unlinkSync(file);
});

test('استيراد CSV: جولة كاملة بلا تكرار، وتخفيض «مؤكد» بلا دليل، وتخطي ASIN غير صالح', async () => {
  const { rows } = await seededRows();
  const csv = ex.toCSV(rows);
  const fresh = await newDb();
  const parsed = ex.recordsFromCsv(csv);
  assert.equal(parsed.records.length, 3); assert.equal(parsed.skipped.length, 0);
  const r1 = await ex.importRecords(fresh, parsed.records);
  assert.equal(r1.added, 3);
  const r2 = await ex.importRecords(fresh, parsed.records);   // إعادة الاستيراد لا تكرر
  assert.equal(r2.added, 0); assert.equal(r2.updated, 3);
  assert.equal(await fresh.count('products'), 3);
  assert.equal(await fresh.count('offers'), 2, 'المنتج بلا بائع في الملف لا ينتج عنه عرض');
  assert.equal((await fresh.get('products', 'B0TEST0005')).shippingStatus, 'confirmed', 'الدليل النصي موجود في الملف');

  const bad = 'ASIN,السعر,البائع,حالة الشحن الدولي\nB0BADSTAT1,10,Shop,مؤكد\nNOTANASIN,5,Shop,مؤكد\n';
  const db2 = await newDb();
  const p2 = ex.recordsFromCsv(bad);
  assert.equal(p2.skipped.length, 1);
  const r3 = await ex.importRecords(db2, p2.records);
  assert.equal(r3.downgraded, 1);
  assert.equal((await db2.get('products', 'B0BADSTAT1')).shippingStatus, 'unknown');
});
