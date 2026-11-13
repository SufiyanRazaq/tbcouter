export const normalize = (value) => String(value ?? '').normalize('NFKC').toLocaleLowerCase('en').replace(/[‘’`]/g, "'").replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');

export function parseReading(text) {
  const lines = String(text).replace(/;/g, ':').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const from = lines.find(x => /^from\s*:/i.test(x));
  const source = lines.find(x => /^source\s*:/i.test(x));
  const chest = lines.find(x => !/^(from|source|time left|open|clan)\b\s*:?/i.test(x));
  const sourceText = (source?.replace(/^source\s*:\s*/i, '') ?? '').replace(/[.]+$/, '');
  const match = sourceText.match(/(?:level|l)\s*[-:.]?\s*(\d{1,3})(?!\d)/i);
  return {
    playerName: (from?.replace(/^from\s*:\s*/i, '') ?? '').replace(/[.,:;]+$/, '').trim(),
    chestName: (chest ?? '').replace(/[.]+$/, ''),
    source: sourceText,
    level: match ? Number(match[1]) : 0,
  };
}

function aliases(record) {
  try { return Array.isArray(record.aliases) ? record.aliases : JSON.parse(record.aliases || '[]'); }
  catch { return []; }
}

export function resolveReading(input, players, catalog, chestNames = []) {
  const reading = parseReading(input.rawText);
  const playerKey = normalize(reading.playerName);
  const candidates = players.filter(p => p.active && [p.name, ...aliases(p)].some(n => normalize(n) === playerKey));
  const sourceKey = normalize(reading.source);
  const chestKey = normalize(reading.chestName);
  const sourceMatches = catalog.filter(c => c.active && [c.source, ...aliases(c)].some(s => normalize(s) === sourceKey) && sourceKey && Number(c.level) === reading.level);
  const chestMatches = catalog.filter(c => c.active && [c.name, ...aliases(c)].some(s => normalize(s) === chestKey) && Number(c.level) === reading.level);
  const rules = sourceMatches.length ? sourceMatches : chestMatches;
  const knownChest = [...chestNames, ...catalog.map(c => c.name)].find(n => normalize(n) === chestKey);
  const reasons = [];
  if (candidates.length !== 1) reasons.push(candidates.length > 1 ? 'Player name matches multiple aliases' : 'Player is missing or not in the active roster');
  if (rules.length !== 1) reasons.push(rules.length > 1 ? 'More than one scoring rule matches' : 'No exact scoring rule for this source and level');
  if (!knownChest) reasons.push('Chest name needs confirmation');
  if (!reading.source) reasons.push('Chest source was not read');
  if (Number(input.confidence) < 90) reasons.push('OCR confidence is below 90%');
  if (Number(input.consensus) < 2) reasons.push('Reading was not confirmed in two frames');
  if (input.ambiguous) reasons.push('The row changed before its reading was stable');
  return {
    ...reading, chestName: knownChest || reading.chestName || 'Unread chest',
    playerId: candidates.length === 1 ? candidates[0].id : null,
    playerName: candidates.length === 1 ? candidates[0].name : reading.playerName || 'Unknown player',
    catalogId: rules.length === 1 ? rules[0].id : null,
    points: rules.length === 1 ? rules[0].points : 0,
    status: reasons.length ? 'review' : 'confirmed',
    reviewReason: reasons.join('. '),
  };
}

export function validateTransition(before, after) {
  return Number.isInteger(before) && Number.isInteger(after) && before > 0 && after >= 0 && before - after === 1;
}

export function csvEscape(value) {
  let text = String(value ?? '');
  if (/^[\s]*[=+@-]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

function localParts(date, timezone) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date).map(p => [p.type, p.value]));
}
function offsetAt(date, timezone) {
  const p=localParts(date,timezone);
  return Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second)-Math.floor(+date/1000)*1000;
}
function utcForLocal(localDate, timezone) {
  let result=new Date(localDate);
  for(let i=0;i<3;i++)result=new Date(+localDate-offsetAt(result,timezone));
  return result;
}
export function dateRange(period = 'week', timezone = 'Asia/Karachi', now = new Date()) {
  const parts=localParts(now,timezone);
  const offset=offsetAt(now,timezone);
  const start = new Date(Date.UTC(+parts.year, +parts.month - 1, +parts.day));
  if (period === 'week') start.setUTCDate(start.getUTCDate() - ((start.getUTCDay() + 6) % 7));
  else if (period === 'month') start.setUTCDate(1);
  else if (period === 'all') return { start: '2000-01-01T00:00:00.000Z', offsetMinutes: Math.round(offset / 60000) };
  else if (period !== 'today') throw new Error('Invalid date range');
  return { start: utcForLocal(start,timezone).toISOString(), offsetMinutes: Math.round(offset / 60000) };
}

export function calendarDays(period,timezone,now=new Date()) {
  const p=localParts(now,timezone);
  const last=new Date(Date.UTC(+p.year,+p.month-1,+p.day));
  let first;
  if(period==='all')first=new Date(+last-29*86400000);
  else{const start=localParts(new Date(dateRange(period,timezone,now).start),timezone);first=new Date(Date.UTC(+start.year,+start.month-1,+start.day));}
  const result=[];
  for(let d=first;+d<=+last;d=new Date(+d+86400000))result.push({day:d.toISOString().slice(0,10),start:utcForLocal(d,timezone).toISOString(),end:utcForLocal(new Date(+d+86400000),timezone).toISOString()});
  return result;
}
