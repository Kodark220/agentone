// In production (Vercel), VITE_API_URL points to the backend server.
// In dev, it falls back to '' so the Vite proxy handles /api requests.
const BASE = import.meta.env.VITE_API_URL || '';
const API = `${BASE}/api`;

async function fetchJSON(path: string, options?: RequestInit) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
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
