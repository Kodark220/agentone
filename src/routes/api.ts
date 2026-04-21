// ============================================
// API ROUTES
// Futures-focused dashboard endpoints
// ============================================

import { Router, Request, Response } from 'express';
import { NewsSentimentEngine } from '../services/newsSentiment';
import { PerpsTrader } from '../services/perpsTrader';
import { MarketContextCoordinator } from '../services/marketContext';
import { logger } from '../utils/logger';

interface WatchlistItem {
  symbol: string;
  chain: string;
  address?: string;
}

export function createRouter(
  newsEngine: NewsSentimentEngine,
  perpsTrader: PerpsTrader,
  marketContext: MarketContextCoordinator,
  getAutoTrade: () => boolean,
  setAutoTrade: (enabled: boolean) => void,
  getWatchlist: () => WatchlistItem[],
  setWatchlist: (items: WatchlistItem[]) => void
): Router {
  const router = Router();

  router.get('/status', async (_req: Request, res: Response) => {
    const balance = await perpsTrader.getBalance();
    res.json({
      isRunning: true,
      autoTrade: getAutoTrade(),
      exchangeConnected: perpsTrader.isReady(),
      balance,
      openPositions: perpsTrader.getOpenPositions().length,
      totalPnL: perpsTrader.getTotalPnL(),
      watchlistSize: getWatchlist().length,
    });
  });

  router.get('/watchlist', (_req: Request, res: Response) => {
    res.json({ watchlist: getWatchlist() });
  });

  router.post('/watchlist', (req: Request, res: Response) => {
    const { symbol, chain, address } = req.body;
    if (!symbol) {
      res.status(400).json({ error: 'symbol required' });
      return;
    }
    const next = [...getWatchlist()];
    const normalized = String(symbol).toUpperCase();
    if (!next.some((i) => i.symbol === normalized)) {
      next.push({ symbol: normalized, chain: chain || 'any', address });
      setWatchlist(next);
    }
    res.json({ ok: true, watchlist: getWatchlist() });
  });

  router.delete('/watchlist/:symbol/:chain', (req: Request, res: Response) => {
    const symbol = String(req.params.symbol || '').toUpperCase();
    const chain = String(req.params.chain || 'any');
    const next = getWatchlist().filter((i) => !(i.symbol === symbol && i.chain === chain));
    setWatchlist(next);
    res.json({ ok: true, watchlist: getWatchlist() });
  });

  router.get('/news', async (_req: Request, res: Response) => {
    const signals = await newsEngine.scanForSignals();
    const news = newsEngine.getCachedNews();
    res.json({ news, signals });
  });

  router.get('/positions', (_req: Request, res: Response) => {
    res.json({
      open: perpsTrader.getOpenPositions(),
      all: perpsTrader.getAllPositions(),
      totalPnL: perpsTrader.getTotalPnL(),
    });
  });

  router.post('/positions/close/:id', async (req: Request, res: Response) => {
    const success = await perpsTrader.closePosition(req.params.id as string);
    res.json({ ok: success, positions: perpsTrader.getOpenPositions() });
  });

  router.post('/settings/autotrade', (req: Request, res: Response) => {
    const { enabled } = req.body;
    setAutoTrade(!!enabled);
    res.json({ autoTrade: getAutoTrade() });
  });

  router.get('/markets', async (_req: Request, res: Response) => {
    const markets = await perpsTrader.getAvailableMarkets();
    res.json({ markets: markets.slice(0, 200) });
  });

  router.get('/context/market', (_req: Request, res: Response) => {
    res.json({ context: marketContext.getContext() });
  });

  router.get('/futures/setups', (_req: Request, res: Response) => {
    res.json({ setups: perpsTrader.getFuturesSetups() });
  });

  router.get('/futures/setups/:id', (req: Request, res: Response) => {
    const setup = perpsTrader.getFuturesSetupById(req.params.id as string);
    if (!setup) {
      res.status(404).json({ error: 'Setup not found' });
      return;
    }
    res.json({ setup });
  });

  router.post('/futures/generate', async (_req: Request, res: Response) => {
    try {
      const setups = await perpsTrader.scanFuturesMarkets();
      res.json({ setups, count: setups.length });
    } catch (err: any) {
      logger.error(`Futures scan failed: ${err.message}`);
      res.status(500).json({ error: 'Failed to scan futures markets' });
    }
  });

  return router;
}
