const fs = require('node:fs');
const path = require('node:path');

// This patch is deliberately tied to the pinned code-server bundle. Fail the
// image build if an upstream update changes any enforcement point.
function jcodeAiExtension(extension) {
  if (!extension || typeof extension !== 'object') return false;
  const manifest = extension.manifest || extension;
  const id = String(extension.identifier?.id || extension.id ||
    `${manifest.publisher || ''}.${manifest.name || ''}`).toLowerCase();
  const known = /^(github\.copilot(?:-chat)?|continue\.continue|saoudrizwan\.claude-dev|rooveterinaryinc\.roo-cline|kilocode\.kilo-code|openai\.|anthropic\.|codeium\.|tabnine\.|amazonwebservices\.amazon-q-vscode)/i;
  if (known.test(id)) return true;
  const metadata = [id, manifest.displayName, manifest.description,
    ...(Array.isArray(manifest.keywords) ? manifest.keywords : []),
    ...(Array.isArray(manifest.tags) ? manifest.tags : []),
    ...(Array.isArray(manifest.categories) ? manifest.categories : [])]
    .filter(value => typeof value === 'string').join(' ').normalize('NFKC');
  if (/(?:\b(?:ai|llm|llms|copilot|chatgpt|codex|claude|cline|codeium|windsurf|tabnine|codewhisperer|openai|anthropic)\b|artificial[ -]+intelligence|generative[ -]+(?:ai|assistant)|roo[ -]+code|amazon[ -]+q|인공지능|생성형\s*AI)/iu.test(metadata)) return true;
  // Language tools can expose optional tool adapters without being an AI
  // assistant. Block chat providers/participants, not languageModelTools alone.
  const contributes = manifest.contributes || {};
  return ['chatParticipants', 'languageModelChatProviders', 'chatAgents'].some(key =>
    Array.isArray(contributes[key]) ? contributes[key].length > 0 :
      contributes[key] && Object.keys(contributes[key]).length > 0);
}

function jcodeRequireExtension(extension) {
  if (jcodeAiExtension(extension)) {
    throw new Error('JCode does not allow AI assistant extensions. Choose a non-AI extension.');
  }
}

const root = process.argv[2] || '/usr/lib/code-server/lib/vscode';
const target = path.join(root, 'out/server-main.js');
let source = fs.readFileSync(target, 'utf8');
if (source.includes('function jcodeAiExtension(')) throw new Error('Policy patch already applied');
const replacements = [
  ['async installGalleryExtensions(e){if(!this.galleryService.isEnabled())',
    'async installGalleryExtensions(e){for(const item of e)jcodeRequireExtension(item.extension);if(!this.galleryService.isEnabled())'],
  ['async installExtensions(e){let n=new Map',
    'async installExtensions(e){for(const item of e)jcodeRequireExtension(item.manifest);let n=new Map'],
  ['let h=this.createInstallExtensionTask(c,u,p),v=',
    'jcodeRequireExtension(c);let h=this.createInstallExtensionTask(c,u,p),v='],
  ['async addExtensionsToProfile(e,n,o){let i=[],s=[];',
    'async addExtensionsToProfile(e,n,o){for(const [item] of e)jcodeRequireExtension(item);let i=[],s=[];'],
  ['async applyScanOptions(e,n,o={}){return o.includeAllVersions',
    'async applyScanOptions(e,n,o={}){e=e.filter(item=>!jcodeAiExtension(item));return o.includeAllVersions'],
];
for (const [before, after] of replacements) {
  if (source.split(before).length !== 2) throw new Error(`Unexpected code-server enforcement anchor: ${before}`);
  source = source.replace(before, after);
}
source = `${jcodeAiExtension.toString()}\n${jcodeRequireExtension.toString()}\n${source}`;
fs.writeFileSync(target, source);
fs.chmodSync(target, 0o644);
console.log('JCode extension keyword policy applied to installation, dependencies, profiles and scanning.');

const webReplacements = [
  ['isAllowed(e){if(!this._allowedExtensionsConfigValue)',
    'isAllowed(e){if(jcodeAiExtension(e))return {value:"AI assistant extensions are not allowed in JCode."};if(!this._allowedExtensionsConfigValue)'],
  ['async installGalleryExtensions(e){if(!this.galleryService.isEnabled())',
    'async installGalleryExtensions(e){for(const item of e)jcodeRequireExtension(item.extension);if(!this.galleryService.isEnabled())'],
  ['async installExtensions(e){let t=new Map',
    'async installExtensions(e){for(const item of e)jcodeRequireExtension(item.manifest);let t=new Map'],
  ['this.createInstallExtensionTask(l,u,p)',
    '(jcodeRequireExtension(l),this.createInstallExtensionTask(l,u,p))'],
  ['async addExtensionsToProfile(e,t,i){',
    'async addExtensionsToProfile(e,t,i){for(const [item] of e)jcodeRequireExtension(item);'],
  ['async applyScanOptions(e,t,i={}){',
    'async applyScanOptions(e,t,i={}){e=e.filter(item=>!jcodeAiExtension(item));'],
  ['for(let a of r)i.set(a.identifier.id.toLowerCase(),a);return[...i.values()]}',
    'for(let a of r)i.set(a.identifier.id.toLowerCase(),a);return[...i.values()].filter(item=>!jcodeAiExtension(item))}'],
  ['r=await this.toScannedExtension(n,!1);return await this.addToInstalledExtensions([n],i),r}',
    'r=await this.toScannedExtension(n,!1);jcodeRequireExtension(r);return await this.addToInstalledExtensions([n],i),r}'],
];
for (const relative of ['out/vs/code/browser/workbench/workbench.js', 'out/vs/workbench/workbench.web.main.internal.js']) {
  const file = path.join(root, relative);
  let web = fs.readFileSync(file, 'utf8');
  for (const [before, after] of webReplacements) {
    if (web.split(before).length !== 2) throw new Error(`Unexpected ${relative} anchor: ${before}`);
    web = web.replace(before, after);
  }
  fs.writeFileSync(file, `${jcodeAiExtension.toString()}\n${jcodeRequireExtension.toString()}\n${web}`);
}

// Browser assets otherwise keep the upstream URL despite a changed policy.
const stamp = require('node:crypto').createHash('sha256').update(fs.readFileSync(__filename)).digest('hex').slice(0,16);
const htmlFile = path.join(root, 'out/vs/code/browser/workbench/workbench.html');
const html = fs.readFileSync(htmlFile, 'utf8');
const scriptUrl = '/out/vs/code/browser/workbench/workbench.js"';
if (html.split(scriptUrl).length !== 2) throw new Error('Unexpected workbench HTML script URL');
fs.writeFileSync(htmlFile, html.replace(scriptUrl, `/out/vs/code/browser/workbench/workbench.js?jcode-policy=${stamp}"`));
console.log('Browser extension policy and cache revision applied:', stamp);
