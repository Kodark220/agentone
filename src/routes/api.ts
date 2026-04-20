// ============================================
// API ROUTES
// REST endpoints for the dashboard
// ============================================

import { Router, Request, Response } from 'express';
import { TokenAnalyser } from '../services/tokenAnalyser';
import { NewsSentimentEngine } from '../services/newsSentiment';
import { SolanaWalletTracker } from '../services/walletTracker';
import { PerpsTrader } from '../services/perpsTrader';
import { SignalAggregator } from '../services/signalAggregator';
import { SolTrenchesService } from '../services/solTrenches';
import { MarketContextCoordinator } from '../services/marketContext';
import { Chain } from '../types';
import { logger } from '../utils/logger';

export function createRouter(
  tokenAnalyser: TokenAnalyser,
  newsEngine: NewsSentimentEngine,
  walletTracker: SolanaWalletTracker,
  perpsTrader: PerpsTrader,
  signalAggregator: SignalAggregator,
  solTrenches: SolTrenchesService,
  marketContext: MarketContextCoordinator
): Router {
  const router = Router();

  // ---- Agent Status ----
  router.get('/status', async (_req: Request, res: Response) => {
    const balance = await perpsTrader.getBalance();
    res.json({
      isRunning: true,
      autoTrade: signalAggregator.isAutoTradeEnabled(),
      exchangeConnected: perpsTrader.isReady(),
      balance,
      openPositions: perpsTrader.getOpenPositions().length,
      totalPnL: perpsTrader.getTotalPnL(),
      watchlistSize: tokenAnalyser.getWatchlist().length,
      trackedWallets: walletTracker.getTrackedWallets().length,
    });
  });

  // ---- Token Analysis ----
  router.get('/analyse/:symbol', async (req: Request, res: Response) => {
    const symbol = req.params.symbol as string;
    const chain = (req.query.chain as Chain) || 'any';
    const address = req.query.address as string | undefined;
    const analysis = await tokenAnalyser.analyseToken(symbol, chain, address);
    if (!analysis) {
      res.status(404).json({ error: `Token ${symbol} not found` });
      return;
    }
    const signal = tokenAnalyser.generateSignalFromAnalysis(analysis);
    res.json({ analysis, signal });
  });

  router.get('/search/:query', async (req: Request, res: Response) => {
    const pairs = await tokenAnalyser.searchTokens(req.params.query as string);
    res.json({ pairs: pairs.slice(0, 20) });
  });

  router.get('/trending', async (_req: Request, res: Response) => {
    const signals = await tokenAnalyser.scanTrending();
    res.json({ signals });
  });

  // ---- Watchlist ----
  router.get('/watchlist', (_req: Request, res: Response) => {
    res.json({ watchlist: tokenAnalyser.getWatchlist() });
  });

  router.post('/watchlist', (req: Request, res: Response) => {
    const { symbol, chain, address } = req.body;
    if (!symbol) {
      res.status(400).json({ error: 'symbol required' });
      return;
    }
    tokenAnalyser.addToWatchlist(symbol.toUpperCase(), chain || 'any', address);
    res.json({ ok: true, watchlist: tokenAnalyser.getWatchlist() });
  });

  router.delete('/watchlist/:symbol/:chain', (req: Request, res: Response) => {
    tokenAnalyser.removeFromWatchlist(req.params.symbol as string, req.params.chain as Chain);
    res.json({ ok: true, watchlist: tokenAnalyser.getWatchlist() });
  });

  // ---- News ----
  router.get('/news', async (_req: Request, res: Response) => {
    const signals = await newsEngine.scanForSignals();
    const news = newsEngine.getCachedNews();
    res.json({ news, signals });
  });

  router.get('/news/sentiment/:symbol', async (req: Request, res: Response) => {
    const data = await newsEngine.fetchLunarCrushData(req.params.symbol as string);
    res.json(data);
  });

  // ---- Wallet Tracker ----
  router.get('/wallets', (_req: Request, res: Response) => {
    res.json({
      wallets: walletTracker.getTrackedWallets(),
      walletDetails: walletTracker.getWalletDetails(),
      recentActivity: walletTracker.getRecentActivities(),
    });
  });

  router.post('/wallets', (req: Request, res: Response) => {
    const { address, label } = req.body;
    if (!address || typeof address !== 'string' || address.length < 32) {
      res.status(400).json({ error: 'Valid Solana address required' });
      return;
    }
    walletTracker.addWallet(address, label);
    res.json({ ok: true, wallets: walletTracker.getTrackedWallets(), walletDetails: walletTracker.getWalletDetails() });
  });

  router.delete('/wallets/:address', (req: Request, res: Response) => {
    walletTracker.removeWallet(req.params.address as string);
    res.json({ ok: true, wallets: walletTracker.getTrackedWallets() });
  });

  router.get('/wallets/scan', async (_req: Request, res: Response) => {
    const signals = await walletTracker.detectAccumulationSignals();
    res.json({ signals });
  });

  router.post('/wallets/discover', async (_req: Request, res: Response) => {
    const discovered = await walletTracker.autoDiscoverWhales();
    res.json({ discovered, walletDetails: walletTracker.getWalletDetails() });
  });

  // ---- Positions ----
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

  // ---- Signals ----
  router.get('/signals', (_req: Request, res: Response) => {
    res.json({
      recent: signalAggregator.getRecentSignals(),
      aggregated: signalAggregator.getAggregatedSignals(),
    });
  });

  // ---- Pipeline ----
  router.post('/pipeline/run', async (_req: Request, res: Response) => {
    try {
      const result = await signalAggregator.runPipeline();
      res.json(result);
    } catch (err: any) {
      logger.error(`Pipeline run failed: ${err.message}`);
      res.status(500).json({ error: 'Pipeline failed' });
    }
  });

  // ---- Settings ----
  router.post('/settings/autotrade', (req: Request, res: Response) => {
    const { enabled } = req.body;
    signalAggregator.setAutoTrade(!!enabled);
    res.json({ autoTrade: signalAggregator.isAutoTradeEnabled() });
  });

  router.get('/markets', async (_req: Request, res: Response) => {
    const markets = await perpsTrader.getAvailableMarkets();
    res.json({ markets: markets.slice(0, 200) });
  });

  // ---- Global Market Context ----
  router.get('/context/market', (_req: Request, res: Response) => {
    res.json({ context: marketContext.getContext() });
  });

  // ---- Futures Trading Setups ----
  router.get('/futures/setups', (_req: Request, res: Response) => {
    const setups = perpsTrader.getFuturesSetups();
    res.json({ setups });
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

  // ---- Sol Trenches ----
  router.get('/trenches', (_req: Request, res: Response) => {
    const tokens = solTrenches.getTrackedTokens();
    const newTokens = solTrenches.getNewTokens();
    const recent = solTrenches.getRecentTokens();
    const established = solTrenches.getEstablishedTokens();
    const pumpCandidates = solTrenches.getPumpCandidates();
    const flowSummary = solTrenches.getFundFlowSummary();
    res.json({
      tokens, pumpCandidates, flowSummary,
      counts: { new: newTokens.length, recent: recent.length, established: established.length },
    });
  });

  router.post('/trenches/scan', async (_req: Request, res: Response) => {
    try {
      const tokens = await solTrenches.scanTrenches();
      res.json({ tokens, count: tokens.length });
    } catch (err: any) {
      logger.error(`Trenches scan failed: ${err.message}`);
      res.status(500).json({ error: 'Trenches scan failed' });
    }
  });

  router.post('/trenches/track', async (req: Request, res: Response) => {
    const { address } = req.body;
    if (!address) {
      res.status(400).json({ error: 'address or symbol required' });
      return;
    }
    const token = await solTrenches.trackToken(address);
    if (!token) {
      res.status(404).json({ error: 'Token not found on Solana' });
      return;
    }
    res.json({ ok: true, token });
  });

  router.get('/trenches/:address', (req: Request, res: Response) => {
    const tokens = solTrenches.getTrackedTokens();
    const token = tokens.find((t: any) => t.address === req.params.address);
    if (!token) {
      res.status(404).json({ error: 'Token not tracked' });
      return;
    }
    res.json({ token });
  });

  router.delete('/trenches/:address', (req: Request, res: Response) => {
    solTrenches.removeToken(req.params.address as string);
    res.json({ ok: true, tokens: solTrenches.getTrackedTokens() });
  });

  router.post('/trenches/refresh', async (_req: Request, res: Response) => {
    const tokens = await solTrenches.refreshTracked();
    res.json({ tokens });
  });

  return router;
}
