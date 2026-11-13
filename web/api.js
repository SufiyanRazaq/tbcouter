export async function api(path, options = {}) {
  const response = await fetch('/api' + path, { credentials: 'same-origin', ...options, headers: { 'Content-Type': 'application/json', ...options.headers }, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.error || 'The request failed.'); error.status = response.status; throw error; }
  return data;
}
export const format = n => new Intl.NumberFormat('en').format(n || 0);
export const compact = n => new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n || 0);
export function localDate(value, timezone, detailed = false) {
  return new Intl.DateTimeFormat('en', { timeZone: timezone, month: 'short', day: 'numeric', ...(detailed ? {hour:'numeric',minute:'2-digit'} : {}) }).format(new Date(value));
}
export function downloadJson(data, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
