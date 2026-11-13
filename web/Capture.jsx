import React, { useEffect, useRef, useState } from 'react';
import { MonitorUp, ScanLine, MousePointer2, ShieldCheck, Play, Square, CircleHelp, CheckCheck, AlertTriangle, Crosshair, Package, Radio, Download, RotateCcw, Eye, Wifi, LoaderCircle } from 'lucide-react';
import { Button, Badge, Empty, ErrorMessage, SectionHead } from './components.jsx';
import { api, downloadJson } from './api.js';
import { CaptureMachine } from './capture-machine.js';

const CLIENT_KEY='clan-ledger-device';
const QUEUE_KEY='clan-ledger-pending';
const CALIBRATION_KEY='clan-ledger-calibration';
function stored(key,fallback){try{return JSON.parse(localStorage.getItem(key))??fallback;}catch{return fallback;}}

export default function Capture({data,refresh,notify,onHelp}){
 const [stream,setStream]=useState(null);
 const [selecting,setSelecting]=useState('row');
 const [boxes,setBoxes]=useState(stored(CALIBRATION_KEY,{}));
 const [draft,setDraft]=useState(null);
 const [phase,setPhase]=useState('idle');
 const [message,setMessage]=useState('Share the game tab or window to get started.');
 const [error,setError]=useState('');
 const [reading,setReading]=useState(null);
 const [events,setEvents]=useState([]);
 const [pending,setPending]=useState(stored(QUEUE_KEY,[]));
 const [progress,setProgress]=useState('');
 const video=useRef();const preview=useRef();const worker=useRef();const machine=useRef();const running=useRef(false);const busy=useRef(false);const loopTimer=useRef();const heartbeat=useRef();const session=useRef(null);const seq=useRef(1);const drag=useRef(null);const boxesRef=useRef(boxes);const flushBusy=useRef(false);const mounted=useRef(true);
 const clientId=useRef(localStorage.getItem(CLIENT_KEY)||crypto.randomUUID());
 localStorage.setItem(CLIENT_KEY,clientId.current);boxesRef.current=boxes;

 useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;running.current=false;clearTimeout(loopTimer.current);clearInterval(heartbeat.current);video.current?.srcObject?.getTracks().forEach(t=>t.stop());worker.current?.terminate();if(session.current)fetch('/api/capture/'+session.current+'/stop',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({clientId:clientId.current}),keepalive:true}).catch(()=>{});};},[]);
 useEffect(()=>{if(stream&&video.current){video.current.srcObject=stream;video.current.play().catch(()=>{});}},[stream]);
 useEffect(()=>{const unload=e=>{if(running.current||stored(QUEUE_KEY,[]).length){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',unload);return()=>window.removeEventListener('beforeunload',unload);},[]);

 async function share(){
  if(data.demo){notify('Open the live clan website to connect your game.');return;}
  setError('');
  try{
   if(!navigator.mediaDevices?.getDisplayMedia)throw new Error('Screen sharing is unavailable here. Open this website in Chrome on your laptop.');
   const media=await navigator.mediaDevices.getDisplayMedia({video:{frameRate:{ideal:8,max:15}},audio:false});
   media.getVideoTracks()[0].addEventListener('ended',()=>{stop(false);setStream(null);setMessage('Game sharing ended. Share the game again to reconnect.');});
   setStream(media);setPhase('calibrate');setMessage('Mark the top chest’s text and the total Gifts badge. Keep both visible while counting.');
  }catch(e){setError(e.name==='NotAllowedError'?'Screen sharing was cancelled. Click Share game when you are ready.':e.message);}
 }
 function position(e){const r=preview.current.getBoundingClientRect();return {x:Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),y:Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))};}
 function down(e){if(!selecting||running.current)return;e.preventDefault();drag.current=position(e);e.currentTarget.setPointerCapture(e.pointerId);setDraft({...drag.current,w:0,h:0});}
 function move(e){if(!drag.current)return;const p=position(e);setDraft({x:Math.min(p.x,drag.current.x),y:Math.min(p.y,drag.current.y),w:Math.abs(p.x-drag.current.x),h:Math.abs(p.y-drag.current.y)});}
 function up(e){if(!drag.current)return;const p=position(e),origin=drag.current;drag.current=null;const box={x:Math.min(p.x,origin.x),y:Math.min(p.y,origin.y),w:Math.abs(p.x-origin.x),h:Math.abs(p.y-origin.y)};setDraft(null);if(box.w<.008||box.h<.008)return;const next={...boxes,[selecting]:box};setBoxes(next);localStorage.setItem(CALIBRATION_KEY,JSON.stringify(next));setSelecting(selecting==='row'?'badge':null);}
 async function loadWorker(){
  if(worker.current)return worker.current;
  setProgress('Loading the on-device OCR reader…');
  const {createWorker}=await import('tesseract.js');
  const engine=await createWorker('eng',1,{workerPath:'/ocr/worker.min.js',corePath:'/ocr',langPath:'/ocr',workerBlobURL:false,logger:m=>{if(m.status==='recognizing text')return;setProgress(m.progress?`${m.status} · ${Math.round(m.progress*100)}%`:m.status);}});
  worker.current=engine;return engine;
 }
 function crop(frame,box,kind){
  const canvas=document.createElement('canvas');const scale=kind==='badge'?4:2;
  canvas.width=Math.max(1,Math.round(box.w*frame.width*scale));canvas.height=Math.max(1,Math.round(box.h*frame.height*scale));
  const context=canvas.getContext('2d',{willReadFrequently:true});context.drawImage(frame,box.x*frame.width,box.y*frame.height,box.w*frame.width,box.h*frame.height,0,0,canvas.width,canvas.height);
  if(kind==='evidence')return canvas;
  const pixels=context.getImageData(0,0,canvas.width,canvas.height);let sum=0;
  for(let i=0;i<pixels.data.length;i+=4)sum+=pixels.data[i]*.299+pixels.data[i+1]*.587+pixels.data[i+2]*.114;
  const invert=sum/(pixels.data.length/4)<125;
  for(let i=0;i<pixels.data.length;i+=4){let grey=pixels.data[i]*.299+pixels.data[i+1]*.587+pixels.data[i+2]*.114;if(invert)grey=255-grey;grey=Math.min(255,Math.max(0,(grey-128)*1.45+128));pixels.data[i]=pixels.data[i+1]=pixels.data[i+2]=grey;}
  context.putImageData(pixels,0,0);return canvas;
 }
 async function observe(){
  const element=video.current;if(!element?.videoWidth||!boxesRef.current.row||!boxesRef.current.badge)throw new Error('Wait for the game preview and mark both reading areas.');
  const frame=document.createElement('canvas');frame.width=element.videoWidth;frame.height=element.videoHeight;frame.getContext('2d').drawImage(element,0,0);
  const at=new Date().toISOString();const engine=await loadWorker();
  await engine.setParameters({tessedit_pageseg_mode:'7',tessedit_char_whitelist:'0123456789'});
  const count=(await engine.recognize(crop(frame,boxesRef.current.badge,'badge'))).data;
  await engine.setParameters({tessedit_pageseg_mode:'6',tessedit_char_whitelist:'',preserve_interword_spaces:'1'});
  const row=(await engine.recognize(crop(frame,boxesRef.current.row,'row'),{}, {blocks:true})).data;
  const wordScores=(row.blocks||[]).flatMap(b=>b.paragraphs||[]).flatMap(p=>p.lines||[]).flatMap(l=>l.words||[]).filter(w=>w.text?.trim()).map(w=>w.confidence);
  const rowConfidence=Math.min(row.confidence,...wordScores);
  const digits=count.text.trim();const badge=/^\d{1,5}$/.test(digits)?Number(digits):null;
  const original=crop(frame,boxesRef.current.row,'evidence');
  const result={badge,badgeConfidence:count.confidence,text:row.text,confidence:rowConfidence,evidence:original.toDataURL('image/jpeg',.75),capturedAt:at};
  setReading(result);return result;
 }
 async function flush(){
  if(flushBusy.current)return;flushBusy.current=true;
  try{
   let queue=stored(QUEUE_KEY,[]);
   while(queue.length){const item=queue[0];const result=await api(`/capture/${item.sessionId}/event`,{method:'POST',body:item.body});queue=stored(QUEUE_KEY,[]).filter(x=>x.body.id!==item.body.id);localStorage.setItem(QUEUE_KEY,JSON.stringify(queue));setPending(queue);setEvents(prev=>[{id:result.id,name:item.body.rawText.split('\n')[0],status:result.status,before:item.body.badgeBefore,after:item.body.badgeAfter},...prev].slice(0,15));await refresh();}
  }catch(e){running.current=false;if(machine.current)machine.current.paused=true;setPhase('paused');setError(e.message);setMessage('Your unsent reading is saved on this device. Retry it before starting another session.');throw e;}finally{flushBusy.current=false;}
 }
 function eventFound(event){
  const sequence=seq.current++;const id=`${session.current}:${sequence}`;
  const item={sessionId:session.current,body:{...event,id,seq:sequence,clientId:clientId.current}};
  const queue=[...stored(QUEUE_KEY,[]),item];
  try{localStorage.setItem(QUEUE_KEY,JSON.stringify(queue));setPending(queue);setMessage('Opening confirmed. Saving the chest…');flush().catch(()=>{});}catch(e){running.current=false;machine.current.paused=true;setPhase('paused');setError('Device storage is full. Download the current reading and add this chest manually.');downloadJson(item,'unsaved-chest-reading.json');}
 }
 async function loop(){
  if(!running.current||busy.current)return;busy.current=true;
  try{if(!navigator.onLine)throw new Error('Connection lost. Capture paused. Reconnect before opening more chests.');const sample=await observe();if(!running.current)return;if(sample.badge==null||sample.badgeConfidence<90)setMessage('The gifts count is not readable. Wait before opening another chest, or stop and adjust its box.');else if(sample.badge!==machine.current.badge)setMessage('Verifying the change in gift count…');machine.current.observe(sample);}catch(e){running.current=false;setPhase('paused');setError(e.message);}finally{busy.current=false;if(running.current)loopTimer.current=setTimeout(loop,750);}
 }
 async function start(){
  if(data.demo){notify('Live capture is available on your real clan website.');return;}
  if(stored(QUEUE_KEY,[]).length){setError('Retry or download and archive your pending readings first.');return;}
  if(!boxes.row||!boxes.badge){setError('Mark the chest text and gifts count areas first.');return;}
  setError('');setPhase('loading');setMessage('Checking a stable starting count. Do not open a chest yet.');
  try{
   if(session.current)await stop(false);
   await loadWorker();const first=await observe();const second=await observe();
   if(first.badge==null||first.badge!==second.badge||first.badgeConfidence<90||second.badgeConfidence<90)throw new Error('The gifts badge is not reading consistently. Adjust its box to include only the number.');
   const result=await api('/capture/start',{method:'POST',body:{clientId:clientId.current,badge:second.badge}});session.current=result.id;seq.current=result.nextSeq;
   machine.current=new CaptureMachine({initialBadge:second.badge,onEvent:eventFound,onPause:reason=>{running.current=false;setPhase('paused');setMessage(reason);notify('Capture paused. Check the reader before opening more chests.',true);},onBaseline:sample=>{setMessage(`Ready to open the top chest · ${sample.badge} gifts remaining`);}});
   machine.current.observe(first);machine.current.observe(second);running.current=true;setPhase('running');setProgress('');
   heartbeat.current=setInterval(()=>api('/capture/'+session.current+'/heartbeat',{method:'POST',body:{clientId:clientId.current}}).catch(e=>{running.current=false;setPhase('paused');setError(e.message);}),20000);
   loopTimer.current=setTimeout(loop,750);await refresh();
  }catch(e){setPhase('calibrate');setError(e.message);setProgress('');}
 }
 async function stop(update=true){running.current=false;clearTimeout(loopTimer.current);clearInterval(heartbeat.current);const id=session.current;session.current=null;if(id)try{await api('/capture/'+id+'/stop',{method:'POST',body:{clientId:clientId.current}});}catch{}if(update){setPhase(stream?'calibrate':'idle');setMessage('Capture stopped. Your saved chests are in the ledger.');refresh();}}
 const boxStyle=b=>({left:b.x*100+'%',top:b.y*100+'%',width:b.w*100+'%',height:b.h*100+'%'});
 return <>
  <div className="capture-intro"><div><ShieldCheck size={19}/><span><strong>Reads your screen. Respects your session.</strong> Recognition runs on your laptop. Only chest readings and cropped evidence go to your clan database.</span></div><button className="text-action" onClick={onHelp}>How it works <CircleHelp size={15}/></button></div>
  <div className="capture-layout"><section className="panel capture-main"><SectionHead title="Your game connection" subtitle="Open My Clan → Gifts in the game." action={<Badge variant={phase==='running'?'green':phase==='paused'?'amber':'neutral'}><span className={'status-dot '+(phase==='running'?'live':'')}/>{phase==='running'?'Reading live':phase==='paused'?'Paused':stream?'Game shared':'Not connected'}</Badge>}/>
    {!stream?<div className="share-placeholder"><div className="share-art"><MonitorUp size={45} strokeWidth={1}/><span><ScanLine size={20}/></span></div><h3>Bring your game into view.</h3><p>Share your Total Battle tab or window.<br/>The reader will watch while you open chests.</p><Button icon={MonitorUp} onClick={share}>Share game</Button><small>Chrome recommended · Safari where supported</small></div>:<><div className={'game-preview '+(selecting?'selecting':'')} ref={preview} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={()=>{drag.current=null;setDraft(null);}}><video ref={video} autoPlay playsInline muted/>{Object.entries(boxes).filter(([k])=>['row','badge'].includes(k)).map(([key,box])=><div key={key} className={'calibration-box '+key} style={boxStyle(box)}><span>{key==='row'?'CHEST TEXT':'GIFT COUNT'}</span></div>)}{draft&&<div className={'calibration-box draft '+selecting} style={boxStyle(draft)}/>}</div><div className="calibration-toolbar"><span>{selecting?<><Crosshair size={15}/>Drag a box around {selecting==='row'?'the top chest’s name, From, and Source lines':'only the total Gifts badge number'}.</>:'Both areas marked. Keep this game layout while counting.'}</span>{phase!=='running'&&<div><Button variant={selecting==='row'?'primary':'secondary'} icon={MousePointer2} onClick={()=>setSelecting('row')}>Chest text</Button><Button variant={selecting==='badge'?'primary':'secondary'} icon={Crosshair} onClick={()=>setSelecting('badge')}>Gifts count</Button></div>}</div></>}
    <div className={'reader-status '+(phase==='running'?'is-running':phase==='paused'?'is-paused':'')}><span className="reader-status-icon">{phase==='loading'?<LoaderCircle size={18} className="spin"/>:phase==='running'?<Radio size={18}/>:phase==='paused'?<AlertTriangle size={18}/>:<ScanLine size={18}/>}</span><div><strong>{phase==='loading'?progress||'Preparing reader':phase==='running'?'Live reader':phase==='paused'?'Needs your attention':'Capture status'}</strong><p>{message}</p></div></div>
    <ErrorMessage>{error}</ErrorMessage><div className="capture-footer"><span><ShieldCheck size={14}/>Manual opening · no game password</span>{phase==='paused'&&session.current&&<Button variant="secondary" icon={Square} onClick={()=>stop()}>Stop</Button>}{phase==='running'?<Button variant="secondary" icon={Square} onClick={()=>stop()}>Stop capture</Button>:<Button icon={Play} disabled={!stream||!boxes.row||!boxes.badge||phase==='loading'||busy.current} busy={phase==='loading'} onClick={start}>{phase==='paused'?'Recheck & resume':'Start reading'}</Button>}</div>
  </section>
  <div className="capture-side"><section className="panel capture-checklist"><SectionHead title="Before you start"/><div className="checklist-item"><span>1</span><div><strong>Open the Gifts tab</strong><p>Keep the total gifts number visible.</p></div>{stream&&<CheckCheck size={17}/>}</div><div className="checklist-item"><span>2</span><div><strong>Mark two reading areas</strong><p>Top chest text and total gifts badge.</p></div>{boxes.row&&boxes.badge&&<CheckCheck size={17}/>}</div><div className="checklist-item"><span>3</span><div><strong>Open one top chest at a time</strong><p>Wait for “Ready to open” between chests.</p></div></div><div className="small-note"><ShieldCheck size={17}/><p>A stuck chest doesn’t count again. Two identical chests count separately when the gifts total drops by one.</p></div></section>
  <section className="panel reader-details"><SectionHead title="Latest reading" action={<Eye size={16}/>}/>{reading?<><div className="reading-count"><span>Gifts remaining</span><strong>{reading.badge??'—'}</strong></div><pre>{reading.text||'Waiting for chest text…'}</pre><div className="reading-confidence"><span>Text confidence</span><Badge variant={reading.confidence>=90?'green':'amber'}>{Math.round(reading.confidence)}%</Badge></div><div className="reading-confidence"><span>Badge confidence</span><span>{Math.round(reading.badgeConfidence)}%</span></div></>:<p className="muted body-copy">The recognized chest text and gift count appear here once the reader starts.</p>}</section>
  </div></div>
  {pending.length>0&&<section className="panel pending-panel"><AlertTriangle size={23}/><div><h3>{pending.length} reading{pending.length===1?'':'s'} saved on this device</h3><p>Delivery has not been confirmed. Repeated delivery uses the same event ID and cannot create a second entry.</p></div><Button variant="secondary" icon={RotateCcw} onClick={()=>flush().then(()=>notify('Pending readings delivered. Recheck and resume capture.')).catch(()=>{})}>Retry delivery</Button><button className="text-action" onClick={()=>{downloadJson(stored(QUEUE_KEY,[]),'pending-chest-readings.json');}}>Download copy <Download size={14}/></button><button className="text-action" onClick={()=>{downloadJson(stored(QUEUE_KEY,[]),'archived-chest-readings.json');localStorage.setItem(QUEUE_KEY,'[]');setPending([]);stop();notify('Readings downloaded and archived. Check their event IDs in the ledger before adding them manually.');}}>Download & archive</button></section>}
  <section className="panel"><SectionHead title="This session" subtitle="Confirmed openings and their delivery status." action={<Badge variant="neutral">{events.length} delivered</Badge>}/>{events.length?<div className="session-events">{events.map(e=><div key={e.id}><span className="mini-chest"><Package size={16}/></span><strong>{e.name}</strong><span>{e.before} → {e.after} gifts</span><Badge variant={e.status==='confirmed'?'green':'amber'}>{e.status==='confirmed'?'Counted':'Needs review'}</Badge></div>)}</div>:<Empty icon={ScanLine} title="Ready for your first opening" text="Captured openings will appear here as they reach the website."/>}</section>
  <p className="footnote"><AlertTriangle size={14}/>If gifts arrive, multiple chests open between readings, or the layout changes, pause and check the baseline. Screen OCR has limits; review protects the totals.</p>
 </>;
}
