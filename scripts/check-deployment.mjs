import assert from 'node:assert/strict';
const origin='https://clan-ledger.sufiyanrazaq55.workers.dev';
const home=await fetch(origin);assert.equal(home.status,200);assert.match(await home.text(),/Clan Ledger/);
assert.match(home.headers.get('Content-Security-Policy')||'',/default-src 'self'/);
const health=await fetch(origin+'/api/health');assert.equal(health.status,200);assert.equal((await health.json()).ok,true);
for(const period of ['today','week','month','all']){
 const r=await fetch(origin+'/api/state?period='+period);const state=await r.json();assert.equal(r.status,200,JSON.stringify(state));assert.equal(state.admin,false);assert.equal(state.summary.chests,0);assert.equal(state.summary.points,0);assert.equal(state.configured,false);
}
assert.equal((await fetch(origin+'/api/backup')).status,401);
assert.equal((await fetch(origin+'/api/entries',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:'{}'})).status,401);
const assets=['/ocr/worker.min.js','/ocr/tesseract-core-simd-lstm.wasm.js','/ocr/tesseract-core-simd-lstm.wasm','/ocr/eng.traineddata.gz'];
for(const asset of assets){const r=await fetch(origin+asset,{method:'HEAD'});assert.equal(r.status,200,asset);}
console.log(JSON.stringify({origin,homepage:'200',database:'healthy',publicReports:'today/week/month/all OK',adminBoundary:'writes and backups return 401',ocrAssets:'all available',productionData:'empty; owner setup still required',csp:home.headers.get('Content-Security-Policy')}));
