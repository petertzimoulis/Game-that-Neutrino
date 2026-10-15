import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
fs.mkdirSync(path.join(root, 'dist'), {recursive: true});
const assets = {};
for (const [name, type] of [['index.html','text/html; charset=utf-8'],['about-me.html','text/html; charset=utf-8'],['4.0.html','text/html; charset=utf-8'],['app.js','text/javascript; charset=utf-8'],['accounts.js','text/javascript; charset=utf-8'],['endless.js','text/javascript; charset=utf-8'],['site-config.js','text/javascript; charset=utf-8'],['styles.css','text/css; charset=utf-8'],['coin.png','image/png'],['peter-tzimoulis.jpg','image/jpeg']]) {
  assets['/' + name] = { type, body: fs.readFileSync(path.join(root,name)).toString('base64') };
  fs.copyFileSync(path.join(root, name), path.join(root, 'dist', name));
}
// Rebuild the packaged media tree so retired clips cannot remain in a release.
fs.rmSync(path.join(root, 'dist/videos'), {recursive: true, force: true});
fs.cpSync(path.join(root, 'videos'), path.join(root, 'dist/videos'), {
  recursive: true, filter: file => path.basename(file) !== '.DS_Store',
});
for(const group of fs.readdirSync(path.join(root,'videos'),{withFileTypes:true}).filter(entry=>entry.isDirectory())) {
  for(const name of fs.readdirSync(path.join(root,'videos',group.name)).filter(name=>name.endsWith('Manifest.csv') || name === 'manifest.csv')) {
    assets['/videos/' + group.name + '/' + name] = {type:'text/csv; charset=utf-8',body:fs.readFileSync(path.join(root,'videos',group.name,name)).toString('base64')};
  }
}
let worker = fs.readFileSync(path.join(root,'worker/index.js'),'utf8');
worker = 'const PRESENTATION_ASSETS = ' + JSON.stringify(assets) + ';\n' + worker;
worker = worker.replace('function fetchRepositoryAsset(request, pathname) {', `function fetchRepositoryAsset(request, pathname) {
  const asset = PRESENTATION_ASSETS[decodeURIComponent(buildPackagedAssetPath(pathname))];
  if (asset) {
    const bytes = Uint8Array.from(atob(asset.body), character => character.charCodeAt(0));
    return Promise.resolve(new Response(request.method === 'HEAD' ? null : bytes, {headers: {'Content-Type':asset.type,'Cache-Control':'no-cache'}}));
  }`);
worker = worker.replace('headers: accept ? { Accept: accept } : undefined,', `headers: { ...(accept ? { Accept: accept } : {}), ...(request.headers.has('range') ? { Range: request.headers.get('range') } : {}) },`);
fs.mkdirSync(path.join(root,'dist/server'),{recursive:true});
fs.writeFileSync(path.join(root,'dist/server/index.js'),worker);
console.log('Built presentation assets and preserved research API routes.');
