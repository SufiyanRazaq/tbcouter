import test from 'node:test';
import assert from 'node:assert/strict';
import {normalize,parseReading,resolveReading,validateTransition,csvEscape,dateRange,calendarDays} from '../worker/domain.js';
import {CaptureMachine} from '../web/capture-machine.js';

const text="Orc Chest\nFrom: Felharon\nSource: Level 15 Crypt";
const player={id:'p1',name:'Felharon',aliases:['Felhar0n'],active:1};
const rule={id:'r1',name:'Common Crypt',source:'Common Crypt L-15',level:15,points:75,aliases:['Level 15 Crypt'],active:1};
const sample=(badge=178,raw=text)=>({badge,badgeConfidence:99,text:raw,confidence:98,evidence:'row',capturedAt:new Date().toISOString()});

test('parses the supplied game screenshot row without substring player matches',()=>{
 assert.deepEqual(parseReading(text),{chestName:'Orc Chest',playerName:'Felharon',source:'Level 15 Crypt',level:15});
 assert.equal(normalize('Ancient’s Chest'),normalize("Ancient's Chest"));
});
test('exact roster aliases and source levels award the configured points',()=>{
 const r=resolveReading({rawText:text.replace('Felharon','Felhar0n'),confidence:98,consensus:2},[player],[rule],['Orc Chest']);
 assert.equal(r.status,'confirmed');assert.equal(r.playerId,'p1');assert.equal(r.points,75);
});
test('similar names and unfamiliar levels go to review, never guessed into totals',()=>{
 const r=resolveReading({rawText:text.replace('Felharon','Felharom').replace('15','16'),confidence:98,consensus:2},[player],[rule],['Orc Chest']);
 assert.equal(r.status,'review');assert.equal(r.playerId,null);assert.equal(r.catalogId,null);
});
test('low confidence, missing consensus, unknown chests, and ambiguous aliases require review',()=>{
 for(const input of [{confidence:89,consensus:2},{confidence:98,consensus:1},{confidence:98,consensus:2,ambiguous:true}])assert.equal(resolveReading({rawText:text,...input},[player],[rule],['Orc Chest']).status,'review');
 assert.equal(resolveReading({rawText:text,confidence:98,consensus:2},[player],[rule],[]).status,'review');
 assert.equal(resolveReading({rawText:text,confidence:98,consensus:2},[player,{...player,id:'p2'}],[rule],['Orc Chest']).status,'review');
});
test('a stuck chest never counts, even after arbitrarily many frames',()=>{
 const events=[];const m=new CaptureMachine({initialBadge:178,onEvent:e=>events.push(e)});
 for(let i=0;i<100;i++)m.observe(sample());
 assert.equal(events.length,0);
});
test('two identical chests from one player count as separate openings',()=>{
 const events=[];const m=new CaptureMachine({initialBadge:178,onEvent:e=>events.push(e)});
 m.observe(sample());m.observe(sample());m.observe(sample(177));m.observe(sample(177));
 m.observe(sample(177));m.observe(sample(177));m.observe(sample(176));m.observe(sample(176));
 assert.equal(events.length,2);assert.equal(events[0].rawText,events[1].rawText);assert.deepEqual(events.map(e=>[e.badgeBefore,e.badgeAfter]),[[178,177],[177,176]]);
});
test('a transient incorrect badge does not count',()=>{
 const events=[];const m=new CaptureMachine({initialBadge:178,onEvent:e=>events.push(e)});m.observe(sample());m.observe(sample());m.observe(sample(177));m.observe(sample());assert.equal(events.length,0);
});
test('missed openings, arriving gifts, and opening without a stable row pause capture',()=>{
 for(const next of [176,179]){let reason='';const m=new CaptureMachine({initialBadge:178,onEvent:()=>assert.fail(),onPause:r=>reason=r});m.observe(sample());m.observe(sample());m.observe(sample(next));m.observe(sample(next));assert.equal(m.paused,true);assert.ok(reason);}
 const m=new CaptureMachine({initialBadge:178,onEvent:()=>assert.fail()});m.observe(sample(177));m.observe(sample(177));assert.equal(m.paused,true);
});
test('a missing badge never creates an event, a one-gift transition is valid at zero',()=>{
 assert.ok(validateTransition(1,0));for(const [a,b]of [[1,1],[1,-1],[3,1],['2',1],[0,0]])assert.equal(validateTransition(a,b),false);
 const m=new CaptureMachine({initialBadge:178,onEvent:()=>assert.fail()});m.observe({...sample(),badge:null});assert.equal(m.badge,178);
});
test('CSV prevents spreadsheet formula execution and escapes quotes',()=>{assert.equal(csvEscape('=HYPERLINK("x")'),'"\'=HYPERLINK(""x"")"');assert.equal(csvEscape('A,B'),'"A,B"');});
test('weekly boundaries follow clan timezone and Monday at midnight',()=>{
 assert.equal(dateRange('week','Asia/Karachi',new Date('2026-11-13T12:00:00Z')).start,'2026-11-08T19:00:00.000Z');
 assert.equal(dateRange('today','America/New_York',new Date('2026-11-13T12:00:00Z')).start,'2026-11-13T05:00:00.000Z');
 assert.equal(dateRange('month','America/New_York',new Date('2026-11-13T12:00:00Z')).start,'2026-11-01T04:00:00.000Z');
 const day=calendarDays('month','America/New_York',new Date('2026-11-13T12:00:00Z'))[0];assert.equal(day.end,'2026-11-02T05:00:00.000Z');assert.equal(new Date(day.end)-new Date(day.start),25*3600000);
});
