import seed from './seed.json' with { type: 'json' };
import { normalize, resolveReading, validateTransition, csvEscape, dateRange, calendarDays } from './domain.js';

const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
const enc = new TextEncoder();
const SESSION_SECONDS = 60 * 60 * 24 * 7;
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers } });
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
const clean = (value, max = 150) => String(value ?? '').trim().slice(0, max);
const integer = (value, min = 0, max = 10000000) => { const n = Number(value); if (!Number.isSafeInteger(n) || n < min || n > max) fail(400, `Enter a whole number between ${min} and ${max}.`); return n; };
const all = async (db, sql, ...params) => (await db.prepare(sql).bind(...params).all()).results;
const first = (db, sql, ...params) => db.prepare(sql).bind(...params).first();
const run = (db, sql, ...params) => db.prepare(sql).bind(...params).run();

async function body(request) {
  if (Number(request.headers.get('Content-Length')) > 260000) fail(413, 'This request is too large.');
  const raw = await request.text();
  if (raw.length > 260000) fail(413, 'This request is too large.');
  try { return JSON.parse(raw); } catch { fail(400, 'Invalid request data.'); }
}

async function digest(value) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(value))), x => x.toString(16).padStart(2, '0')).join('');
}
function randomToken() { return Array.from(crypto.getRandomValues(new Uint8Array(32)), x => x.toString(16).padStart(2, '0')).join(''); }
async function passwordHash(password, salt) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: enc.encode(salt), iterations: 100000, hash: 'SHA-256' }, key, 256);
  return Array.from(new Uint8Array(bits), x => x.toString(16).padStart(2, '0')).join('');
}
async function same(a, b) { return (await digest(String(a))) === (await digest(String(b))); }
function passwordValid(password) { if (typeof password !== 'string' || password.length < 12 || password.length > 200) fail(400, 'Use a password of 12–200 characters.'); }
function sessionCookie(token, request, age = SESSION_SECONDS) {
  return `clan_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${new URL(request.url).protocol === 'https:' ? '; Secure' : ''}`;
}
async function isAdmin(request, db) {
  const token = request.headers.get('Cookie')?.match(/(?:^|;\s*)clan_session=([a-f0-9]{64})/)?.[1];
  if (!token) return false;
  return !!(await first(db, 'SELECT token_hash FROM auth_sessions WHERE token_hash = ? AND expires_at > ?', await digest(token), Math.floor(Date.now() / 1000)));
}
async function createSession(db, request) {
  const token = randomToken();
  await db.batch([
    db.prepare('DELETE FROM auth_sessions WHERE expires_at < ?').bind(Math.floor(Date.now() / 1000)),
    db.prepare('INSERT INTO auth_sessions(token_hash, expires_at) VALUES(?,?)').bind(await digest(token), Math.floor(Date.now() / 1000) + SESSION_SECONDS),
  ]);
  return sessionCookie(token, request);
}
function auditStatement(db, action, entityId, detail) {
  return db.prepare('INSERT INTO audit_log(id, action, entity_id, detail, created_at) VALUES(?,?,?,?,?)').bind(uuid(), action, entityId, typeof detail === 'string' ? detail : JSON.stringify(detail), now());
}
async function throttle(db, request) {
  const ip = await digest(request.headers.get('CF-Connecting-IP') || 'local');
  const timestamp = Math.floor(Date.now() / 1000);
  await run(db, `INSERT INTO auth_attempts(ip, attempts, window_start) VALUES(?,1,?) ON CONFLICT(ip) DO UPDATE SET attempts=CASE WHEN window_start < ? THEN 1 ELSE attempts+1 END, window_start=CASE WHEN window_start < ? THEN ? ELSE window_start END`, ip, timestamp, timestamp - 900, timestamp - 900, timestamp);
  const attempts = await first(db, 'SELECT attempts FROM auth_attempts WHERE ip=?', ip);
  if (attempts.attempts > 12) fail(429, 'Too many sign-in attempts. Try again in 15 minutes.');
}

function validAliases(value) {
  if (!Array.isArray(value) || value.length > 40) fail(400, 'Use no more than 40 aliases.');
  return [...new Set(value.map(x => clean(x)).filter(Boolean))];
}

async function getState(db, url, admin) {
  const settings = await first(db, 'SELECT * FROM settings WHERE id=1');
  const period = ['today','week','month','all'].includes(url.searchParams.get('period')) ? url.searchParams.get('period') : 'week';
  const range = dateRange(period, settings.timezone);
  const days=calendarDays(period,settings.timezone);
  const [players, catalog, summary, leaderboard, daily, recent, reviews, activity, capture, reviewCount, distribution] = await Promise.all([
    all(db, 'SELECT * FROM players ORDER BY active DESC, name COLLATE NOCASE'),
    all(db, 'SELECT * FROM catalog ORDER BY active DESC, level, name COLLATE NOCASE'),
    first(db, `SELECT COALESCE(SUM(e.quantity),0) chests, COALESCE(SUM(e.points*e.quantity),0) points, COUNT(DISTINCT CASE WHEN p.active=1 THEN e.player_id END) contributors FROM entries e LEFT JOIN players p ON p.id=e.player_id WHERE e.status='confirmed' AND e.occurred_at>=?`, range.start),
    all(db, `SELECT p.id,p.name,p.role,p.active,COALESCE(SUM(e.quantity),0) chests,COALESCE(SUM(e.points*e.quantity),0) points,MAX(e.occurred_at) last_chest FROM players p LEFT JOIN entries e ON e.player_id=p.id AND e.status='confirmed' AND e.occurred_at>=? GROUP BY p.id ORDER BY points DESC,chests DESC,p.name COLLATE NOCASE`, range.start),
    all(db, `WITH bounds(day,starts,ends) AS (VALUES ${days.map(()=>'(?,?,?)').join(',')}) SELECT b.day,COALESCE(SUM(e.quantity),0) chests,COALESCE(SUM(e.points*e.quantity),0) points FROM bounds b LEFT JOIN entries e ON e.status='confirmed' AND e.occurred_at>=b.starts AND e.occurred_at<b.ends GROUP BY b.day ORDER BY b.day`,...days.flatMap(d=>[d.day,d.start,d.end])),
    all(db, `SELECT id,player_id,player_name,catalog_id,chest_name,source,level,points,quantity,status,origin,confidence,review_reason,occurred_at,updated_at FROM entries WHERE status='confirmed' AND occurred_at>=? ORDER BY occurred_at DESC LIMIT 12`, range.start),
    admin ? all(db, `SELECT id,player_name,chest_name,source,level,points,confidence,review_reason,raw_text,occurred_at FROM entries WHERE status='review' ORDER BY occurred_at DESC LIMIT 100`) : [],
    admin ? all(db, 'SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 60') : [],
    admin ? first(db, `SELECT id,status,last_badge,next_seq,started_at,lease_until FROM capture_sessions WHERE status='active' AND lease_until>? ORDER BY started_at DESC LIMIT 1`, Math.floor(Date.now()/1000)) : null,
    first(db, `SELECT COUNT(*) count FROM entries WHERE status='review'`),
    all(db, `SELECT source,SUM(quantity) chests,SUM(points*quantity) points FROM entries WHERE status='confirmed' AND occurred_at>=? GROUP BY source ORDER BY chests DESC LIMIT 6`, range.start),
  ]);
  return {
    settings: { clanName: settings.clan_name, clanTag: settings.clan_tag, timezone: settings.timezone, weeklyTarget: settings.weekly_target },
    admin, configured: !!settings.password_hash, period, rangeStart: range.start,
    players: players.map(p => ({...p, aliases: admin ? JSON.parse(p.aliases) : []})),
    catalog: catalog.map(c => ({...c, aliases: admin ? JSON.parse(c.aliases) : []})),
    summary: {...summary, members: players.filter(p=>p.active).length, reviews: admin ? reviewCount.count : 0},
    leaderboard, daily, recent, reviews, activity, capture,
    distribution, knownChests: admin ? seed.chestNames : [], legacyCount: admin ? seed.players.length : 0,
  };
}

function entryFilters(url, admin) {
  const parts = []; const args = [];
  const status = url.searchParams.get('status') || 'confirmed';
  if (!admin || !['confirmed','review','void','all'].includes(status)) parts.push("e.status='confirmed'");
  else if (status !== 'all') { parts.push('e.status=?'); args.push(status); }
  const search = clean(url.searchParams.get('q'));
  if (search) { parts.push('(e.player_name LIKE ? ESCAPE \'\\\' OR e.chest_name LIKE ? ESCAPE \'\\\' OR e.source LIKE ? ESCAPE \'\\\')'); const term = `%${search.replace(/[\\%_]/g,'\\$&')}%`; args.push(term,term,term); }
  if (url.searchParams.get('player')) { parts.push('e.player_id=?'); args.push(clean(url.searchParams.get('player'))); }
  if (url.searchParams.get('start')) { const d = new Date(url.searchParams.get('start')); if (!Number.isFinite(+d)) fail(400,'Invalid start date.'); parts.push('e.occurred_at>=?'); args.push(d.toISOString()); }
  return { where: parts.length ? parts.join(' AND ') : '1=1', args };
}

async function manualFields(db, input) {
  const player = await first(db, 'SELECT * FROM players WHERE id=? AND active=1', clean(input.playerId));
  const rule = await first(db, 'SELECT * FROM catalog WHERE id=? AND active=1', clean(input.catalogId));
  if (!player) fail(400, 'Choose an active player.');
  if (!rule) fail(400, 'Choose an active points rule.');
  const at = input.occurredAt ? new Date(input.occurredAt) : new Date();
  if (!Number.isFinite(+at) || +at > Date.now() + 5*60000 || +at < Date.UTC(2000,0,1)) fail(400,'Enter a valid chest date.');
  return { player, rule, chestName: clean(input.chestName) || rule.name, quantity: integer(input.quantity ?? 1,1,100), occurredAt: at.toISOString() };
}

async function handle(request, env) {
  const db = env.DB;
  if (!db) fail(503, 'The clan database has not been connected.');
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  if (!['GET','HEAD'].includes(method)) {
    const origin = request.headers.get('Origin');
    if (origin && origin !== url.origin) fail(403,'This request must come from your clan website.');
    if (request.headers.get('Sec-Fetch-Site') === 'cross-site') fail(403,'Cross-site requests are not allowed.');
    if (!request.headers.get('Content-Type')?.includes('application/json')) fail(415,'Send JSON data.');
  }
  if (path === '/api/health') { await first(db,'SELECT id FROM settings LIMIT 1'); return json({ok:true,service:'clan-ledger'}); }
  const admin = await isAdmin(request, db);
  if (path === '/api/auth/status') { const s = await first(db, 'SELECT password_hash FROM settings WHERE id=1'); return json({admin,configured:!!s.password_hash}); }
  if (path === '/api/auth/setup' && method === 'POST') {
    await throttle(db,request);
    const input=await body(request);
    if (!env.SETUP_TOKEN || !await same(input.token || '',env.SETUP_TOKEN)) fail(403,'Use your private owner setup link to create the admin account.');
    passwordValid(input.password);
    const salt=randomToken();
    const hash=await passwordHash(input.password,salt);
    await seedCatalog(db);
    const result=await run(db, 'UPDATE settings SET password_hash=?,password_salt=?,clan_name=?,clan_tag=? WHERE id=1 AND password_hash IS NULL',hash,salt,clean(input.clanName)||'My Clan',(clean(input.clanTag,8)||'CLAN').toUpperCase());
    if (!result.meta.changes) fail(409,'The admin account is already set up. Sign in instead.');
    await auditStatement(db,'clan.created','1','Admin account created').run();
    return json({ok:true},200,{'Set-Cookie':await createSession(db,request)});
  }
  if (path === '/api/auth/login' && method === 'POST') {
    await throttle(db,request);
    const input=await body(request);
    const s=await first(db,'SELECT password_hash,password_salt FROM settings WHERE id=1');
    if (!s.password_hash || typeof input.password!=='string' || input.password.length>200 || !await same(await passwordHash(input.password,s.password_salt),s.password_hash)) fail(401,'That admin password is incorrect.');
    return json({ok:true},200,{'Set-Cookie':await createSession(db,request)});
  }
  if (path === '/api/auth/logout' && method === 'POST') {
    const token=request.headers.get('Cookie')?.match(/clan_session=([a-f0-9]{64})/)?.[1];
    if (token) await run(db,'DELETE FROM auth_sessions WHERE token_hash=?',await digest(token));
    return json({ok:true},200,{'Set-Cookie':sessionCookie('',request,0)});
  }
  if (path === '/api/state' && method === 'GET') return json(await getState(db,url,admin));
  if (path === '/api/entries' && method === 'GET') {
    const {where,args}=entryFilters(url,admin);
    const page=integer(url.searchParams.get('page')||1,1,100000);
    const [entries,count]=await Promise.all([
      all(db,`SELECT e.id,e.player_id,e.player_name,e.catalog_id,e.chest_name,e.source,e.level,e.points,e.quantity,e.status,e.origin,e.confidence,e.review_reason,e.occurred_at,e.updated_at FROM entries e WHERE ${where} ORDER BY e.occurred_at DESC,e.id DESC LIMIT 40 OFFSET ?`,...args,(page-1)*40),
      first(db,`SELECT COUNT(*) total FROM entries e WHERE ${where}`,...args),
    ]);
    return json({entries,total:count.total,page,pages:Math.ceil(count.total/40)});
  }
  if (path === '/api/export' && method === 'GET') {
    const {where,args}=entryFilters(url,admin);
    const rows=await all(db,`SELECT occurred_at,player_name,chest_name,source,level,points,quantity,points*quantity total_points,status,origin,id FROM entries e WHERE ${where} ORDER BY occurred_at DESC LIMIT 50001`,...args);
    if (rows.length>50000) fail(400,'Narrow the date range to export fewer than 50,000 entries.');
    const keys=['occurred_at','player_name','chest_name','source','level','points','quantity','total_points','status','origin','id'];
    return new Response('\ufeff'+[keys.join(','),...rows.map(r=>keys.map(k=>csvEscape(r[k])).join(','))].join('\r\n'),{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="clan-chests.csv"','Cache-Control':'no-store'}});
  }
  if (!admin) fail(401,'Sign in as admin to manage your clan.');

  if (path === '/api/settings' && method === 'PUT') {
    const input=await body(request);
    const clanName=clean(input.clanName,80); if (!clanName) fail(400,'Enter your clan name.');
    const timezone=clean(input.timezone,80); try { new Intl.DateTimeFormat('en',{timeZone:timezone}).format(); } catch { fail(400,'Choose a valid timezone.'); }
    await db.batch([db.prepare('UPDATE settings SET clan_name=?,clan_tag=?,timezone=?,weekly_target=? WHERE id=1').bind(clanName,(clean(input.clanTag,8)||'CLAN').toUpperCase(),timezone,integer(input.weeklyTarget)),auditStatement(db,'settings.updated','1','Updated clan details and weekly goal')]);
    return json({ok:true});
  }
  if (path === '/api/auth/password' && method === 'PUT') {
    const input=await body(request); passwordValid(input.password);
    const s=await first(db,'SELECT password_hash,password_salt FROM settings WHERE id=1');
    if (typeof input.currentPassword!=='string' || !await same(await passwordHash(input.currentPassword,s.password_salt),s.password_hash)) fail(400,'The current password is incorrect.');
    const salt=randomToken();
    await db.batch([db.prepare('UPDATE settings SET password_hash=?,password_salt=? WHERE id=1').bind(await passwordHash(input.password,salt),salt),db.prepare('DELETE FROM auth_sessions'),auditStatement(db,'password.changed','1','Changed password and signed out other sessions')]);
    return json({ok:true},200,{'Set-Cookie':await createSession(db,request)});
  }
  if (path === '/api/players/legacy' && method === 'POST') {
    const timestamp=now();
    for (let i=0;i<seed.players.length;i+=40) await db.batch(seed.players.slice(i,i+40).map(p=>db.prepare('INSERT OR IGNORE INTO players(id,name,normalized_name,aliases,role,active,created_at) VALUES(?,?,?,?,?,1,?)').bind(uuid(),p.name,normalize(p.name),JSON.stringify(p.aliases),'Member',timestamp)));
    await auditStatement(db,'players.imported',null,`Imported legacy roster (${seed.players.length} names; existing names retained)`).run();
    return json({ok:true});
  }
  if (path === '/api/players' && method === 'POST' || /^\/api\/players\/[^/]+$/.test(path) && method === 'PUT') {
    const input=await body(request); const id=method==='POST'?uuid():path.split('/').pop();
    const name=clean(input.name,80); if (!name) fail(400,'Enter a player name.');
    const playerAliases=validAliases(input.aliases||[]);
    const keys=[name,...playerAliases].map(normalize);
    const others=await all(db,'SELECT * FROM players WHERE id!=?',id);
    if (others.some(p=>[p.name,...JSON.parse(p.aliases)].some(a=>keys.includes(normalize(a))))) fail(409,'That name or alias already belongs to another player.');
    const role=['Leader','Officer','Member'].includes(input.role)?input.role:'Member';
    if (method==='PUT' && !await first(db,'SELECT id FROM players WHERE id=?',id)) fail(404,'Player not found.');
    const statement=method==='POST'?db.prepare('INSERT INTO players(id,name,normalized_name,aliases,role,active,created_at) VALUES(?,?,?,?,?,?,?)').bind(id,name,normalize(name),JSON.stringify(playerAliases),role,1,now()):db.prepare('UPDATE players SET name=?,normalized_name=?,aliases=?,role=?,active=? WHERE id=?').bind(name,normalize(name),JSON.stringify(playerAliases),role,input.active===false||input.active===0?0:1,id);
    await db.batch([statement,auditStatement(db,method==='POST'?'player.added':'player.updated',id,`${name} · ${role}${input.active===false?' · archived':''}`)]);
    return json({ok:true,id});
  }
  if (path === '/api/catalog' && method === 'POST' || /^\/api\/catalog\/[^/]+$/.test(path) && method === 'PUT') {
    const input=await body(request); const id=method==='POST'?uuid():path.split('/').pop();
    const name=clean(input.name,100); if (!name) fail(400,'Enter a chest or source name.');
    const level=integer(input.level,0,999); const points=integer(input.points);
    const source=clean(input.source)||name;
    const ruleAliases=validAliases(input.aliases||[]);
    const statement=method==='POST'?db.prepare('INSERT INTO catalog(id,name,source,level,points,aliases,active) VALUES(?,?,?,?,?,?,1)').bind(id,name,source,level,points,JSON.stringify(ruleAliases)):db.prepare('UPDATE catalog SET name=?,source=?,level=?,points=?,aliases=?,active=? WHERE id=?').bind(name,source,level,points,JSON.stringify(ruleAliases),input.active===false||input.active===0?0:1,id);
    await db.batch([statement,auditStatement(db,method==='POST'?'rule.added':'rule.updated',id,`${name} · level ${level} · ${points} points; existing entries keep their awarded points`)]);
    return json({ok:true,id});
  }
  if (path === '/api/entries' && method === 'POST') {
    const input=await body(request); const id=clean(input.id)||uuid();
    if (!/^[a-zA-Z0-9:_-]{8,150}$/.test(id)) fail(400,'Invalid entry identifier.');
    const existing=await first(db,'SELECT id FROM entries WHERE id=?',id); if (existing) return json({ok:true,id,duplicate:true});
    const {player,rule,chestName,quantity,occurredAt}=await manualFields(db,input); const timestamp=now();
    const result=await db.batch([
      db.prepare(`INSERT OR IGNORE INTO entries(id,player_id,player_name,catalog_id,chest_name,source,level,points,quantity,status,origin,occurred_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'confirmed','manual',?,?,?)`).bind(id,player.id,player.name,rule.id,chestName,rule.source,rule.level,rule.points,quantity,occurredAt,timestamp,timestamp),
      auditStatement(db,'entry.added',id,`${quantity} × ${chestName} from ${player.name}; ${rule.points*quantity} points`),
    ]);
    return json({ok:true,id,duplicate:!result[0].meta.changes});
  }
  const entryMatch=path.match(/^\/api\/entries\/([^/]+)(?:\/(evidence|void|restore))?$/);
  if (entryMatch) {
    const [,id,action]=entryMatch; const existing=await first(db,'SELECT * FROM entries WHERE id=?',id); if (!existing) fail(404,'Chest entry not found.');
    if (!action && method==='GET') { const {evidence,...entry}=existing; return json(entry); }
    if (action==='evidence' && method==='GET') return json({evidence:existing.evidence,rawText:existing.raw_text,badgeBefore:existing.badge_before,badgeAfter:existing.badge_after,reason:existing.review_reason});
    if (['void','restore'].includes(action) && method==='POST') {
      const input=await body(request); const reason=clean(input.reason,400); if (!reason) fail(400,'Add a reason for this change.');
      if (action==='restore' && !existing.player_id) fail(400,'Edit and resolve this entry before restoring it.');
      const status=action==='void'?'void':(existing.review_reason?'review':'confirmed');
      await db.batch([db.prepare('UPDATE entries SET status=?,updated_at=? WHERE id=?').bind(status,now(),id),auditStatement(db,`entry.${action}`,id,reason)]); return json({ok:true});
    }
    if (!action && method==='PUT') {
      const input=await body(request); const reason=clean(input.reason,400); if (!reason) fail(400,'Add a reason for the correction.');
      const {player,rule,chestName,quantity,occurredAt}=await manualFields(db,input);
      const points=existing.catalog_id===rule.id && existing.status!=='review' ? existing.points : rule.points;
      if (input.updatedAt!==existing.updated_at) fail(409,'This entry changed in another window. Refresh before editing.');
      const result=await run(db,`UPDATE entries SET player_id=?,player_name=?,catalog_id=?,chest_name=?,source=?,level=?,points=?,quantity=?,status='confirmed',review_reason='',occurred_at=?,updated_at=? WHERE id=? AND updated_at=?`,player.id,player.name,rule.id,chestName,rule.source,rule.level,points,quantity,occurredAt,now(),id,existing.updated_at);
      if (!result.meta.changes) fail(409,'This entry changed in another window. Refresh before editing.');
      await auditStatement(db,'entry.corrected',id,{reason,before:{player:existing.player_name,chest:existing.chest_name,points:existing.points,status:existing.status},after:{player:player.name,chest:chestName,points,status:'confirmed'}}).run();
      return json({ok:true});
    }
  }
  if (path === '/api/capture/start' && method === 'POST') {
    const input=await body(request); const id=uuid(); const clientId=clean(input.clientId,100); if (!clientId) fail(400,'Missing capture device identifier.');
    const badge=integer(input.badge,0,99999); const seconds=Math.floor(Date.now()/1000);
    await run(db,`UPDATE capture_sessions SET status='closed',ended_at=? WHERE status='active' AND lease_until<=?`,now(),seconds);
    const result=await run(db,`INSERT INTO capture_sessions(id,client_id,last_badge,lease_until,started_at) SELECT ?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM capture_sessions WHERE status='active')`,id,clientId,badge,seconds+90,now());
    if (!result.meta.changes) fail(409,'Another capture session is running. Stop it or wait 90 seconds before connecting here.');
    await auditStatement(db,'capture.started',id,`Capture connected with ${badge} gifts remaining`).run();
    return json({ok:true,id,nextSeq:1});
  }
  const captureMatch=path.match(/^\/api\/capture\/([^/]+)\/(heartbeat|stop|event)$/);
  if (captureMatch && method==='POST') {
    const [,sessionId,action]=captureMatch; const input=await body(request);
    const session=await first(db,'SELECT * FROM capture_sessions WHERE id=?',sessionId);
    if (!session || session.client_id!==input.clientId) fail(409,'Capture session not found on this device.');
    if (action==='stop') { await run(db,`UPDATE capture_sessions SET status='closed',ended_at=? WHERE id=?`,now(),sessionId); return json({ok:true}); }
    if (action==='heartbeat') {
      if (session.status!=='active'||session.lease_until<Math.floor(Date.now()/1000)) fail(409,'The capture session expired. Reconnect the game.');
      await run(db,'UPDATE capture_sessions SET lease_until=? WHERE id=?',Math.floor(Date.now()/1000)+90,sessionId); return json({ok:true});
    }
    const seq=integer(input.seq,1,1000000); const id=`${sessionId}:${seq}`;
    const duplicate=await first(db,'SELECT id,status FROM entries WHERE id=?',id); if (duplicate) return json({ok:true,...duplicate,duplicate:true});
    if (session.status!=='active'||session.lease_until<Math.floor(Date.now()/1000)) fail(409,'Capture session expired. Your pending chest is saved on this device for manual recovery.');
    if (!validateTransition(input.badgeBefore,input.badgeAfter)) fail(400,'A chest requires a confirmed gift count decrease of exactly one.');
    if (seq!==session.next_seq||input.badgeBefore!==session.last_badge) fail(409,'The capture sequence is out of sync. Pause and review before reconnecting.');
    if (!Number.isFinite(input.confidence)||input.confidence<0||input.confidence>100) fail(400,'Invalid reading confidence.');
    const [players,catalog]=await Promise.all([all(db,'SELECT * FROM players WHERE active=1'),all(db,'SELECT * FROM catalog WHERE active=1')]);
    const rawText=clean(input.rawText,5000); const resolved=resolveReading({...input,rawText},players,catalog,seed.chestNames);
    const evidence=typeof input.evidence==='string'&&/^data:image\/jpeg;base64,[a-zA-Z0-9+/=]+$/.test(input.evidence)&&input.evidence.length<=180000?input.evidence:null;
    if (!evidence) { resolved.status='review'; resolved.reviewReason=[resolved.reviewReason,'No readable screenshot evidence'].filter(Boolean).join('. '); }
    const occurredAt=new Date(input.occurredAt); if (!Number.isFinite(+occurredAt)||+occurredAt>Date.now()+300000||+occurredAt<new Date(session.started_at).getTime()-60000) fail(400,'Invalid capture timestamp.');
    const timestamp=now();
    const result=await db.batch([
      db.prepare(`INSERT OR IGNORE INTO entries(id,player_id,player_name,catalog_id,chest_name,source,level,points,quantity,status,origin,confidence,raw_text,evidence,review_reason,capture_session_id,capture_seq,badge_before,badge_after,occurred_at,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,1,?,'capture',?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM capture_sessions WHERE id=? AND status='active' AND next_seq=? AND last_badge=? AND lease_until>?)`).bind(id,resolved.playerId,resolved.playerName,resolved.catalogId,resolved.chestName,resolved.source,resolved.level,resolved.points,resolved.status,input.confidence,rawText,evidence,resolved.reviewReason,sessionId,seq,input.badgeBefore,input.badgeAfter,occurredAt.toISOString(),timestamp,timestamp,sessionId,seq,input.badgeBefore,Math.floor(Date.now()/1000)),
      db.prepare(`UPDATE capture_sessions SET last_badge=?,next_seq=next_seq+1,lease_until=? WHERE id=? AND next_seq=? AND EXISTS(SELECT 1 FROM entries WHERE id=?)`).bind(input.badgeAfter,Math.floor(Date.now()/1000)+90,sessionId,seq,id),
    ]);
    if (!result[0].meta.changes) { const saved=await first(db,'SELECT status FROM entries WHERE id=?',id); if (saved) return json({ok:true,id,status:saved.status,duplicate:true}); fail(409,'The capture changed in another window. Pause and reconnect.'); }
    return json({ok:true,id,status:resolved.status,reviewReason:resolved.reviewReason});
  }
  if (path === '/api/backup' && method === 'GET') {
    const [settings,players,catalog]=await Promise.all([first(db,'SELECT clan_name,clan_tag,timezone,weekly_target FROM settings WHERE id=1'),all(db,'SELECT * FROM players'),all(db,'SELECT * FROM catalog')]);
    const exportedAt=now();
    async function* chunks(){
      yield JSON.stringify({version:1,exportedAt,settings,players,catalog}).slice(0,-1)+',"entries":[';
      let cursor='';let separator='';
      while(true){const rows=await all(db,'SELECT * FROM entries WHERE id>? AND created_at<=? ORDER BY id LIMIT 30',cursor,exportedAt);if(!rows.length)break;yield separator+rows.map(r=>JSON.stringify(r)).join(',');separator=',';cursor=rows.at(-1).id;}
      yield '],"auditLog":[';cursor='';separator='';
      while(true){const rows=await all(db,'SELECT * FROM audit_log WHERE id>? AND created_at<=? ORDER BY id LIMIT 200',cursor,exportedAt);if(!rows.length)break;yield separator+rows.map(r=>JSON.stringify(r)).join(',');separator=',';cursor=rows.at(-1).id;}
      yield ']}';
    }
    const iterator=chunks();
    return new Response(new ReadableStream({async pull(controller){try{const next=await iterator.next();if(next.done)controller.close();else controller.enqueue(enc.encode(next.value));}catch(e){controller.error(e);}},cancel(){iterator.return();}}),{headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','Content-Disposition':`attachment; filename="clan-ledger-backup-${exportedAt.slice(0,10)}.json"`}});
  }
  fail(404,'This endpoint was not found.');
}

async function seedCatalog(db) {
  for(let i=0;i<seed.rules.length;i+=40) await db.batch(seed.rules.slice(i,i+40).map(r=>db.prepare('INSERT OR IGNORE INTO catalog(id,name,source,level,points,aliases,active) VALUES(?,?,?,?,?,?,1)').bind(r.id,r.name,r.source,r.level,r.points,JSON.stringify(r.aliases))));
}

export default {
  async fetch(request,env) {
    let response;
    try {
      if (new URL(request.url).pathname.startsWith('/api/')) response=await handle(request,env);
      else response=await env.ASSETS.fetch(request);
    } catch(error) {
      if (!error.status) console.error('Request failed',error.message);
      const message=error.status?error.message:/UNIQUE constraint/.test(error.message)?'That name and level already exist. Edit the existing record.':'Something went wrong. Please try again.';
      response=json({error:message},error.status||(/UNIQUE constraint/.test(error.message)?409:500));
    }
    const headers=new Headers(response.headers);
    headers.set('X-Content-Type-Options','nosniff');
    headers.set('Referrer-Policy','same-origin');
    headers.set('X-Frame-Options','DENY');
    headers.set('Permissions-Policy','camera=(), microphone=(), geolocation=()');
    headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
    return new Response(response.body,{status:response.status,statusText:response.statusText,headers});
  },
};
