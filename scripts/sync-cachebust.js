// Couples the ?v= cache-bust query in index.html to BUILD in app.js.
// Run before every commit: node scripts/sync-cachebust.js
// Without it the browser serves the old script from cache when ?v= stays the same.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const m = app.match(/const BUILD = 'v(\d+)'/);
if (!m) { console.error('BUILD not found in app.js'); process.exit(1); }
const ver = m[1];

const htmlPath = path.join(root, 'index.html');
let html = fs.readFileSync(htmlPath, 'utf8');
const before = html;
html = html.replace(/\.(js|css)\?v=\d+/g, (s) => s.replace(/\d+$/, ver));

if (html !== before) {
  fs.writeFileSync(htmlPath, html);
  console.log('cache-bust -> ?v=' + ver + ' (synced with BUILD v' + ver + ')');
} else {
  console.log('cache-bust already at ?v=' + ver);
}
