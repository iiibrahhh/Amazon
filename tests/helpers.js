const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { IDBFactory, IDBKeyRange } = require('fake-indexeddb');
globalThis.IDBKeyRange = IDBKeyRange;
const dbLib = require('../extension/lib/db.js');

const fx = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const docFrom = (html) => new JSDOM(html).window.document;
const fixtureDoc = (name) => docFrom(fx(name));
let n = 0;
const newDb = () => dbLib.open('test_' + (++n), new IDBFactory());
module.exports = { fx, docFrom, fixtureDoc, newDb };
