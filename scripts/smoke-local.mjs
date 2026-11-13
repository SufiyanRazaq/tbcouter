// This script creates disposable QA records only on the local preview server.
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const base='http://127.0.0.1:8787/api';
const token=readFileSync(new URL('../.dev.vars',import.meta.url),'utf8').match(/^SETUP_TOKEN=(.+)$/m)?.[1];
let cookie='';
async function call(path,method='GET',payload,auth=true){
 const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json',Origin:'http://127.0.0.1:8787',...(auth&&cookie?{Cookie:cookie}:{})},...(payload===undefined?{}:{body:JSON.stringify(payload)})});
 if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];
 const data=await r.json();if(!r.ok)throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(data)}`);return data;
}
const status=await call('/auth/status');
if(!status.configured)await call('/auth/setup','POST',{token,password:'local-qa-password-2026',clanName:'QA Test Clan',clanTag:'QA'});
else await call('/auth/login','POST',{password:'local-qa-password-2026'});
let state=await call('/state?period=all');
let member=state.players.find(p=>p.name==='Felharon');
if(!member){const r=await call('/players','POST',{name:'Felharon',role:'Leader',aliases:[]});member={id:r.id};}
const rule=state.catalog.find(r=>r.name==='Common Crypt'&&r.level===15);
assert.ok(rule,'Scoring rules seeded');
const id='local-smoke-manual-v1';
await call('/entries','POST',{id,playerId:member.id,catalogId:rule.id,chestName:'Orc Chest',quantity:1});
assert.equal((await call('/entries','POST',{id,playerId:member.id,catalogId:rule.id,chestName:'Orc Chest',quantity:1})).duplicate,true);
const start=await call('/capture/start','POST',{clientId:'local-smoke-device',badge:178});
const event={clientId:'local-smoke-device',seq:1,badgeBefore:178,badgeAfter:177,rawText:'Orc Chest\nFrom: Felharon\nSource: Level 15 Crypt',confidence:93,consensus:2,evidence:'data:image/jpeg;base64,'+readFileSync('/tmp/clan-ledger-ocr/row1.png').toString('base64'),occurredAt:new Date().toISOString()};
const captured=await call(`/capture/${start.id}/event`,'POST',event);assert.equal(captured.status,'confirmed');
assert.equal((await call(`/capture/${start.id}/event`,'POST',event)).duplicate,true);
await call(`/capture/${start.id}/event`,'POST',{...event,seq:2,badgeBefore:177,badgeAfter:176});
await call(`/capture/${start.id}/event`,'POST',{...event,seq:3,badgeBefore:176,badgeAfter:175,confidence:82,rawText:event.rawText.replace('Felharon','Felharom')});
await call(`/capture/${start.id}/stop`,'POST',{clientId:'local-smoke-device'});
state=await call('/state?period=all');assert.ok(state.summary.chests>=3);assert.ok(state.summary.reviews>=1);
const guest=await call('/state?period=all','GET',undefined,false);assert.equal(guest.admin,false);assert.equal(guest.reviews.length,0);
for(const period of ['today','week','month','all']){const report=await call('/state?period='+period);assert.ok(report.daily.length>=1);}
console.log(JSON.stringify({runtime:'Wrangler local / actual D1',checks:'Owner setup, authentication, player creation, scoring, manual retry, identical capture events, retry protection, OCR review, public visibility',confirmedChests:state.summary.chests,reviewCount:state.summary.reviews}));
