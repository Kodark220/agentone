// In production (Vercel), set VITE_API_URL to your backend origin.
// Supports either:
// - https://your-backend.example.com
// - https://your-backend.example.com/api
const RAW_BASE = (import.meta.env.VITE_API_URL || '').trim().replace(/\/+$/, '');
const BASE = RAW_BASE.endsWith('/api') ? RAW_BASE.slice(0, -4) : RAW_BASE;
const API = BASE ? `${BASE}/api` : (import.meta.env.DEV ? '/api' : '');

if (!API && !import.meta.env.DEV) {
  console.error('[API] Missing VITE_API_URL in production. Set it in Vercel project environment variables.');
}

async function fetchJSON(path: string, options?: RequestInit) {
  const url = `${API}${path}`;
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) throw new Error(`API error: ${res.status} at ${url}`);

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    const text = await res.text();
    throw new Error(`API returned non-JSON at ${url}. First 120 chars: ${text.slice(0, 120)}`);
  }

  return res.json();
}

export function getSocketUrl(): string {
  return BASE || window.location.origin;
}

export const api = {
  getStatus: () => fetchJSON('/status'),
  getPerformance: () => fetchJSON('/performance'),

  getWatchlist: () => fetchJSON('/watchlist'),
  addToWatchlist: (symbol: string, chain: string, address?: string) =>
    fetchJSON('/watchlist', {
      method: 'POST',
      body: JSON.stringify({ symbol, chain, address }),
    }),
  removeFromWatchlist: (symbol: string, chain: string) =>
    fetchJSON(`/watchlist/${encodeURIComponent(symbol)}/${chain}`, { method: 'DELETE' }),

  getNews: () => fetchJSON('/news'),

  getPositions: () => fetchJSON('/positions'),
  closePosition: (id: string) =>
    fetchJSON(`/positions/close/${encodeURIComponent(id)}`, { method: 'POST' }),

  setAutoTrade: (enabled: boolean) =>
    fetchJSON('/settings/autotrade', {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    }),

  getMarketContext: () => fetchJSON('/context/market'),
  getMarkets: () => fetchJSON('/markets'),

  getFuturesSetups: () => fetchJSON('/futures/setups'),
  getFuturesSetupDetail: (id: string) => fetchJSON(`/futures/setups/${encodeURIComponent(id)}`),
  generateFuturesSetups: () => fetchJSON('/futures/generate', { method: 'POST' }),
};
