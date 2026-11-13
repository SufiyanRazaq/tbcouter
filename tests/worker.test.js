import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import worker from '../worker/index.js';

class D1 {
 constructor(){this.sqlite=new DatabaseSync(':memory:');this.sqlite.exec(readFileSync(new URL('../migrations/0001_initial.sql',import.meta.url),'utf8'));}
 prepare(sql){const db=this.sqlite;let args=[];return {bind(...params){args=params;return this;},async first(){return db.prepare(sql).get(...args)||null;},async all(){return {results:db.prepare(sql).all(...args)};},async run(){const r=db.prepare(sql).run(...args);return {success:true,meta:{changes:r.changes}};}};}
 async batch(statements){this.sqlite.exec('BEGIN');try{const result=[];for(const s of statements)result.push(await s.run());this.sqlite.exec('COMMIT');return result;}catch(e){this.sqlite.exec('ROLLBACK');throw e;}}
}
async function fixture(){
 const env={DB:new D1(),SETUP_TOKEN:'private-test-token',ASSETS:{fetch:()=>new Response('app')}};let cookie='';
 async function call(path,method='GET',payload,authenticated=true,extra={}){
  const headers={'Content-Type':'application/json',Origin:'https://clan.test',...(authenticated&&cookie?{Cookie:cookie}:{}),...extra};
  const response=await worker.fetch(new Request('https://clan.test/api'+path,{method,headers,...(payload===undefined?{}:{body:JSON.stringify(payload)})}),env);
  if(response.headers.get('Set-Cookie'))cookie=response.headers.get('Set-Cookie').split(';')[0];
  const content=response.headers.get('Content-Type')?.includes('application/json')?await response.json():await response.text();return {status:response.status,data:content,headers:response.headers};
 }
 const setup=await call('/auth/setup','POST',{token:env.SETUP_TOKEN,password:'test-password-long',clanName:'Test Clan',clanTag:'TC'});assert.equal(setup.status,200);
 const p=await call('/players','POST',{name:'Felharon',aliases:[],role:'Leader'});assert.equal(p.status,200);
 return {env,call,playerId:p.data.id};
}

test('public viewers see confirmed data but cannot modify it or access evidence',async()=>{
 const {call}=await fixture();
 const state=await call('/state','GET',undefined,false);assert.equal(state.status,200);assert.equal(state.data.admin,false);assert.equal(state.data.settings.clanName,'Test Clan');assert.equal(state.data.catalog.length,46);assert.equal(state.data.activity.length,0);
 assert.equal((await call('/players','POST',{name:'Injected'},false)).status,401);
 assert.equal((await call('/backup','GET',undefined,false)).status,401);
 assert.equal((await call('/entries/nope/evidence','GET',undefined,false)).status,401);
 assert.equal((await call('/players','POST',{name:'X'},true,{Origin:'https://other.test'})).status,403);
});
test('setup is one-time, requires its private token, and login issues an HttpOnly session',async()=>{
 const {call}=await fixture();
 assert.equal((await call('/auth/setup','POST',{token:'wrong',password:'another-long-password'})).status,403);
 assert.equal((await call('/auth/setup','POST',{token:'private-test-token',password:'another-long-password'})).status,409);
 await call('/auth/logout','POST',{});
 assert.equal((await call('/auth/login','POST',{password:'wrong'})).status,401);
 const login=await call('/auth/login','POST',{password:'test-password-long'});assert.equal(login.status,200);assert.match(login.headers.get('Set-Cookie'),/HttpOnly; SameSite=Strict/);assert.match(login.headers.get('Set-Cookie'),/Secure/);
});
test('manual retries count once; historical points survive rule changes and player archival',async()=>{
 const {call,playerId}=await fixture();
 const scoring=(await call('/state')).data.catalog.find(r=>r.name==='Common Crypt'&&r.level===15);
 const input={id:'manual-event-0001',playerId,catalogId:scoring.id,chestName:'Orc Chest',quantity:2};
 const created=await call('/entries','POST',input);assert.equal(created.status,200,JSON.stringify(created.data));
 assert.equal((await call('/entries','POST',input)).data.duplicate,true);
 let state=(await call('/state?period=all')).data;assert.equal(state.summary.chests,2);const original=state.summary.points;assert.equal(original,150);
 const rule=state.catalog.find(x=>x.id===input.catalogId);await call('/catalog/'+rule.id,'PUT',{...rule,points:999});
 await call('/players/'+playerId,'PUT',{name:'Felharon',active:false,aliases:[],role:'Leader'});
 state=(await call('/state?period=all')).data;assert.equal(state.summary.chests,2);assert.equal(state.summary.points,original);assert.equal(state.summary.members,0);assert.equal(state.summary.contributors,0);
});
test('capture retries and identical rows are idempotent by session and sequence',async()=>{
 const {call}=await fixture();
 const start=await call('/capture/start','POST',{clientId:'laptop',badge:178});assert.equal(start.status,200);const id=start.data.id;
 assert.equal((await call('/capture/start','POST',{clientId:'other-laptop',badge:178})).status,409);
 const event={clientId:'laptop',seq:1,badgeBefore:178,badgeAfter:177,rawText:'Orc Chest\nFrom: Felharon\nSource: Level 15 Crypt',confidence:98,consensus:2,evidence:'data:image/jpeg;base64,YWJj',occurredAt:new Date().toISOString()};
 const first=await call(`/capture/${id}/event`,'POST',event);assert.equal(first.status,200,JSON.stringify(first.data));assert.equal(first.data.status,'confirmed');
 const repeated=await call(`/capture/${id}/event`,'POST',event);assert.equal(repeated.status,200);assert.equal(repeated.data.duplicate,true);
 const second=await call(`/capture/${id}/event`,'POST',{...event,seq:2,badgeBefore:177,badgeAfter:176});assert.equal(second.status,200,JSON.stringify(second.data));assert.notEqual(first.data.id,second.data.id);
 const invalid=await call(`/capture/${id}/event`,'POST',{...event,seq:3,badgeBefore:176,badgeAfter:176});assert.equal(invalid.status,400);
 const state=(await call('/state?period=all')).data;assert.equal(state.summary.chests,2);assert.equal(state.summary.points,150);
 const evidence=await call('/entries/'+first.data.id+'/evidence');assert.equal(evidence.data.badgeBefore,178);
 await call(`/capture/${id}/stop`,'POST',{clientId:'laptop'});
 assert.equal((await call(`/capture/${id}/event`,'POST',event)).data.duplicate,true);
});
test('uncertain OCR is excluded until reviewed and voiding or restoring updates totals',async()=>{
 const {call,playerId}=await fixture();const start=await call('/capture/start','POST',{clientId:'laptop',badge:10});
 const event={clientId:'laptop',seq:1,badgeBefore:10,badgeAfter:9,rawText:'Orc Chest\nFrom: Felharom\nSource: Level 15 Crypt',confidence:82,consensus:2,evidence:'data:image/jpeg;base64,YWJj',occurredAt:new Date().toISOString()};
 const result=await call(`/capture/${start.data.id}/event`,'POST',event);assert.equal(result.status,200,JSON.stringify(result.data));assert.equal(result.data.status,'review');
 let state=(await call('/state?period=all')).data;assert.equal(state.summary.chests,0);assert.equal(state.summary.reviews,1);
 const entry=(await call('/entries/'+result.data.id)).data;const rule=state.catalog.find(x=>x.name==='Common Crypt'&&x.level===15);
 const approved=await call('/entries/'+entry.id,'PUT',{playerId,catalogId:rule.id,chestName:'Orc Chest',quantity:1,occurredAt:entry.occurred_at,updatedAt:entry.updated_at,reason:'Verified screenshot against player roster'});assert.equal(approved.status,200,JSON.stringify(approved.data));
 state=(await call('/state?period=all')).data;assert.equal(state.summary.chests,1);assert.equal(state.summary.points,75);
 await call('/entries/'+entry.id+'/void','POST',{reason:'Accidental duplicate manual correction'});assert.equal((await call('/state?period=all')).data.summary.chests,0);
 await call('/entries/'+entry.id+'/restore','POST',{reason:'Verified original was valid'});assert.equal((await call('/state?period=all')).data.summary.chests,1);
 assert.equal((await call('/entries/'+entry.id,'PUT',{playerId,catalogId:rule.id,chestName:'Orc Chest',quantity:1,occurredAt:entry.occurred_at,updatedAt:'old',reason:'stale update'})).status,409);
});
test('search, pagination, export, and aliases enforce the real data boundary',async()=>{
 const {call,playerId}=await fixture();
 await call('/entries','POST',{id:'manual-event-0002',playerId,catalogId:'rule-9',chestName:'Orc Chest',quantity:1});
 const search=await call('/entries?q=Felharon');assert.equal(search.status,200,JSON.stringify(search.data));assert.equal(search.data.total,1);
 assert.equal((await call('/entries?q=%25')).data.total,0);
 const csv=await call('/export');assert.equal(csv.status,200);assert.match(csv.data,/Orc Chest/);
 assert.equal((await call('/players','POST',{name:'Felharon II',aliases:['Felharon']})).status,409);
 const backup=await call('/backup');assert.equal(backup.status,200);assert.equal(backup.data.version,1);assert.equal(backup.data.entries.length,1);assert.equal(backup.data.players.length,1);assert.ok(backup.data.auditLog.length>0);assert.equal(backup.data.settings.password_hash,undefined);
});
