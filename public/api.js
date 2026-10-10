// Thin fetch wrapper around the JSON API.

import { staticApi } from './static-api.js';

async function request(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `${method} ${path}: HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** Query string from an object, skipping empty values. */
function qs(params) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  return q.toString();
}

/** Upload a file as the request body with progress (fetch has no upload progress). */
function upload(path, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else {
        const err = new Error(data.error || `upload: HTTP ${xhr.status}`);
        err.status = xhr.status;
        reject(err);
      }
    };
    xhr.onerror = () => reject(new Error('upload failed'));
    xhr.send(file);
  });
}

const serverApi = {
  me: () => request('GET', '/auth/me'),
  logout: () => request('POST', '/auth/logout'),
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

  gamesImports: () => request('GET', '/api/games/imports'),
  gamesImport: (file, { name, player, onProgress } = {}) => upload(`/api/games/import?${qs({ name, player })}`, file, onProgress),
  gamesImportUrl: (url, { player } = {}) => request('POST', '/api/games/import-url', { url, player }),
  gamesDeleteImport: (id) => request('DELETE', `/api/games/imports/${id}`),
  gamesShare: (id, shared) => request('POST', `/api/games/imports/${id}/share`, { shared }),
  gamesPositions: (epds, filter) => request('POST', '/api/games/positions', { epds, ...filter }),
  gamesPosition: (epd, filter) => request('GET', `/api/games/position?${qs({ epd, ...filter })}`),
  gamesOpenings: (by, filter, limit) => request('GET', `/api/games/openings?${qs({ by, limit, ...filter })}`),
  gamesList: (params) => request('GET', `/api/games?${qs(params)}`),
  game: (id) => request('GET', `/api/games/${id}`),

  exploreStatus: () => request('GET', '/api/explore'),
  workers: () => request('GET', '/api/workers'),
  publicWorkers: () => request('GET', '/api/public-workers'),
  publicWorkerJoin: (name) => request('POST', '/api/public-workers/join', { name }),
  exploreAdd: (job) => request('POST', '/api/explore/jobs', job),
  exploreRemove: (id) => request('DELETE', `/api/explore/jobs/${id}`),
  exploreStart: (opts) => request('POST', '/api/explore/start', opts || {}),
  exploreStop: () => request('POST', '/api/explore/stop'),
  exploreResults: (jobId) => request('GET', `/api/explore/results?${qs({ job: jobId })}`),
};

// The GitHub Pages build marks itself with this tag and has no server behind it.
const browserOnly = typeof document !== 'undefined' && Boolean(document.querySelector('meta[name="static-demo"]'));
export const api = browserOnly ? staticApi : serverApi;
