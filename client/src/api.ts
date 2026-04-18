// In production (Vercel), VITE_API_URL points to the backend server (Railway/Render).
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
  analyseToken: (symbol: string, chain = 'any') =>
    fetchJSON(`/analyse/${encodeURIComponent(symbol)}?chain=${chain}`),
  searchTokens: (query: string) => fetchJSON(`/search/${encodeURIComponent(query)}`),
  getTrending: () => fetchJSON('/trending'),

  getWatchlist: () => fetchJSON('/watchlist'),
  addToWatchlist: (symbol: string, chain: string, address?: string) =>
    fetchJSON('/watchlist', {
      method: 'POST',
      body: JSON.stringify({ symbol, chain, address }),
    }),
  removeFromWatchlist: (symbol: string, chain: string) =>
    fetchJSON(`/watchlist/${encodeURIComponent(symbol)}/${chain}`, { method: 'DELETE' }),

  getNews: () => fetchJSON('/news'),
  getSentiment: (symbol: string) => fetchJSON(`/news/sentiment/${encodeURIComponent(symbol)}`),

  getWallets: () => fetchJSON('/wallets'),
  addWallet: (address: string, label?: string) =>
    fetchJSON('/wallets', { method: 'POST', body: JSON.stringify({ address, label }) }),
  removeWallet: (address: string) =>
    fetchJSON(`/wallets/${encodeURIComponent(address)}`, { method: 'DELETE' }),
  scanWallets: () => fetchJSON('/wallets/scan'),
  discoverWhales: () => fetchJSON('/wallets/discover', { method: 'POST' }),

  getPositions: () => fetchJSON('/positions'),
  closePosition: (id: string) =>
    fetchJSON(`/positions/close/${encodeURIComponent(id)}`, { method: 'POST' }),

  getSignals: () => fetchJSON('/signals'),
  runPipeline: () => fetchJSON('/pipeline/run', { method: 'POST' }),
  setAutoTrade: (enabled: boolean) =>
    fetchJSON('/settings/autotrade', {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    }),

  // Futures setups
  getFuturesSetups: () => fetchJSON('/futures/setups'),
  getFuturesSetupDetail: (id: string) => fetchJSON(`/futures/setups/${encodeURIComponent(id)}`),
  generateFuturesSetups: () => fetchJSON('/futures/generate', { method: 'POST' }),

  // Sol trenches
  getTrenches: () => fetchJSON('/trenches'),
  getTrenchTokenDetail: (address: string) => fetchJSON(`/trenches/${encodeURIComponent(address)}`),
  scanTrenches: () => fetchJSON('/trenches/scan', { method: 'POST' }),
  trackTrenchToken: (address: string) =>
    fetchJSON('/trenches/track', { method: 'POST', body: JSON.stringify({ address }) }),
  removeTrenchToken: (address: string) =>
    fetchJSON(`/trenches/${encodeURIComponent(address)}`, { method: 'DELETE' }),
  refreshTrenches: () => fetchJSON('/trenches/refresh', { method: 'POST' }),
};
