const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Installs the JCode IDE notice script next to the workbench bundle and loads it
// from workbench.html. The script is served from the code-server origin, which the
// workbench CSP (script-src 'self') allows. Fail the build if the anchor moves.
const root = process.argv[2] || '/usr/lib/code-server/lib/vscode';
const source = path.join(__dirname, 'workspace-notice.js');
const workbenchDir = path.join(root, 'out/vs/code/browser/workbench');
const htmlFile = path.join(workbenchDir, 'workbench.html');

const script = fs.readFileSync(source);
const stamp = crypto.createHash('sha256').update(script).digest('hex').slice(0, 16);
const html = fs.readFileSync(htmlFile, 'utf8');
if (html.includes('/jcode-notice.js')) throw new Error('Notice patch already applied');
const anchor = /<script type="module" src="\{\{WORKBENCH_WEB_BASE_URL\}\}\/out\/vs\/code\/browser\/workbench\/workbench\.js[^"]*"><\/script>/g;
const matches = html.match(anchor) || [];
if (matches.length !== 1) throw new Error('Unexpected workbench HTML script anchor');
const tag = `<script type="module" src="{{WORKBENCH_WEB_BASE_URL}}/out/vs/code/browser/workbench/jcode-notice.js?jcode-notice=${stamp}"></script>`;

fs.writeFileSync(path.join(workbenchDir, 'jcode-notice.js'), script);
fs.chmodSync(path.join(workbenchDir, 'jcode-notice.js'), 0o644);
fs.writeFileSync(htmlFile, html.replace(matches[0], `${matches[0]}\n\t${tag}`));
console.log('JCode IDE notice script installed:', stamp);
