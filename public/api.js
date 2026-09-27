// Thin fetch wrapper around the JSON API.

async function request(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${method} ${path}: HTTP ${res.status}`);
  return data;
}

export const api = {
  openings: () => request('GET', '/api/openings'),
  analysis: (epd) => request('GET', `/api/analysis?epd=${encodeURIComponent(epd)}`),
  analysisBatch: (epds) => request('POST', '/api/analysis/batch', { epds }),
  saveAnalysis: (record) => request('POST', '/api/analysis', record),
  stats: () => request('GET', '/api/analysis/stats'),
  eco: () => request('GET', '/api/eco'),
  deepenStatus: () => request('GET', '/api/deepen'),
  deepenStart: (opts) => request('POST', '/api/deepen/start', opts),
  deepenStop: () => request('POST', '/api/deepen/stop'),
  deepenConfigure: (opts) => request('POST', '/api/deepen/configure', opts),
  deepenPrioritize: (epds) => request('POST', '/api/deepen/prioritize', { epds }),
  deepenNext: (count, targetDepth) => request('GET', `/api/deepen/next?count=${count}&targetDepth=${targetDepth}`),
  studyList: () => request('GET', '/api/study'),
  studyAdd: (line) => request('POST', '/api/study', line),
  studyRemove: (id) => request('DELETE', `/api/study/${id}`),
  studyResult: (id, correct) => request('POST', `/api/study/${id}/result`, { correct }),
};
