// Koppelt die ?v=-Cache-Bust-Query in index.html an BUILD aus app.js.
// Vor jedem Commit ausfuehren: node scripts/sync-cachebust.js
// Ohne das serviert der Browser bei gleichbleibendem ?v= das alte Script aus dem Cache.
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');

const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const m = app.match(/const BUILD = 'v(\d+)'/);
if (!m) { console.error('BUILD nicht in app.js gefunden'); process.exit(1); }
const ver = m[1];

const htmlPath = path.join(root, 'index.html');
let html = fs.readFileSync(htmlPath, 'utf8');
const before = html;
html = html.replace(/\.(js|css)\?v=\d+/g, (s) => s.replace(/\d+$/, ver));

if (html !== before) {
  fs.writeFileSync(htmlPath, html);
  console.log('cache-bust -> ?v=' + ver + ' (synchronisiert mit BUILD v' + ver + ')');
} else {
  console.log('cache-bust bereits auf ?v=' + ver);
}
