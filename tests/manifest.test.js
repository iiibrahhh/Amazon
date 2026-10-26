const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'); const path = require('path');
const root = path.join(__dirname, '..', 'extension');
const m = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

test('manifest: MV3 وكل الملفات المشار إليها موجودة', () => {
  assert.equal(m.manifest_version, 3);
  const files = [m.background.service_worker, ...Object.values(m.icons), ...m.content_scripts.flatMap(c => c.js)];
  for (const f of files) assert.ok(fs.existsSync(path.join(root, f)), f);
  const html = fs.readFileSync(path.join(root, 'dashboard.html'), 'utf8');
  for (const [, src] of html.matchAll(/<script src="([^"]+)"/g)) assert.ok(fs.existsSync(path.join(root, src)), src);
  assert.match(html, /dir="rtl"/); assert.match(html, /lang="ar"/);
});
test('manifest: صلاحيات أضيق ما يمكن (amazon.sa فقط، بلا مضيفين آخرين)', () => {
  assert.ok(m.host_permissions.every(h => /amazon\.sa/.test(h)));
  assert.ok(!m.permissions.includes('tabs') && !m.permissions.includes('cookies'));
});
test('لا مفاتيح API أو كلمات مرور داخل المصدر', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  for (const f of walk(root).filter(f => /\.(js|json|html)$/.test(f)))
    assert.ok(!/AKIA[0-9A-Z]{12,}|secret[_-]?key\s*[:=]|password\s*[:=]/i.test(fs.readFileSync(f, 'utf8')), f);
});
