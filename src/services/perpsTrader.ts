// ============================================
// PERPS TRADING ENGINE
// Executes perpetual futures trades via CCXT
// Supports: Binance, Bybit, OKX, Hyperliquid
// ============================================

import ccxt, { Exchange, Order, Balances } from 'ccxt';
import axios from 'axios';
import { RSI, MACD, EMA, BollingerBands } from 'technicalindicators';
import { config } from '../config';
import { logger } from '../utils/logger';
import { Position, AggregatedSignal } from '../types';
import { v4Fallback } from '../utils/id';

const CMC_API_KEY = process.env.CMC_API_KEY || '';
const CMC_BASE = 'https://pro-api.coinmarketcap.com/v1';
type RiskMode = 'RISK_ON' | 'RISK_OFF';

export class PerpsTrader {
  private exchange: Exchange | null = null;
  private activeExchangeId: string | null = null;
  private positions: Map<string, Position> = new Map();
  private isInitialized = false;
  private marketMode: RiskMode = 'RISK_OFF';
  private derivativesCache: Map<string, { data: DerivativesIntel; ts: number }> = new Map();
  private setupOutcomes: SetupOutcome[] = [];
  private setupLedger: Map<string, FuturesSetup> = new Map();
  private thresholds = {
    minPublishConfidence: config.trading.minPublishConfidence,
    minRiskReward: config.trading.minPublishRR,
    minConfluence: config.trading.minConfluence,
    minRawScore: config.trading.minRawScore,
  };

  setMarketMode(mode: RiskMode) {
    this.marketMode = mode;
  }

  getMarketMode(): RiskMode {
    return this.marketMode;
  }

  private getConfiguredExchangeClassId(): string {
    if (config.exchange.id === 'binance') return 'binanceusdm';
    return config.exchange.id;
  }

  private getExchangeCandidates(): string[] {
    return [...new Set([this.getConfiguredExchangeClassId(), 'gateio'])];
  }

  private getExchangeLabel(exchangeId: string): string {
    switch (exchangeId) {
      case 'binanceusdm':
        return 'Binance Futures';
      case 'gateio':
        return 'Gate.io';
      case 'okx':
        return 'OKX';
      default:
        return exchangeId;
    }
  }

  getActiveExchangeLabel(): string {
    return this.getExchangeLabel(this.activeExchangeId || this.getConfiguredExchangeClassId());
  }

  private hasPrivateApiAccess(): boolean {
    return Boolean((this.exchange as any)?.apiKey);
  }

  canTrade(): boolean {
    return this.isReady() && this.hasPrivateApiAccess();
  }

  private shouldEnableSandbox(exchangeId: string): boolean {
    if (!config.exchange.sandbox) return false;
    if (exchangeId !== this.getConfiguredExchangeClassId()) return false;

    if (exchangeId === 'binance' || exchangeId === 'binanceusdm') {
      logger.warn('Binance futures sandbox is deprecated in CCXT; continuing with live public endpoints and disabling sandbox mode');
      return false;
    }

    return true;
  }

  private createExchange(exchangeId: string, useCredentials: boolean): Exchange {
    const ExchangeClass = (ccxt as any)[exchangeId];
    return new ExchangeClass({
      apiKey: useCredentials ? config.exchange.apiKey : undefined,
      secret: useCredentials ? config.exchange.secret : undefined,
      password: useCredentials ? (config.exchange.password || undefined) : undefined,
      options: {
        defaultType: 'future',
        adjustForTimeDifference: true,
        fetchCurrencies: false,
      },
    });
  }

  // ---- Initialize exchange connection ----
  async initialize(): Promise<boolean> {
    let lastError = 'unknown error';

    for (const exchangeId of this.getExchangeCandidates()) {
      try {
        const useCredentials = exchangeId === this.getConfiguredExchangeClassId();
      const ExchangeClass = (ccxt as any)[exchangeId];
      if (!ExchangeClass) {
        logger.error(`Exchange '${exchangeId}' not supported by CCXT`);
        continue;
      }

        this.exchange = this.createExchange(exchangeId, useCredentials);

        if (this.shouldEnableSandbox(exchangeId)) {
          this.exchange!.setSandboxMode(true);
          logger.info(`Exchange running in SANDBOX mode (${this.getExchangeLabel(exchangeId)})`);
        }

        await this.exchange!.loadMarkets();

        this.isInitialized = true;
        this.activeExchangeId = exchangeId;

        logger.info(`Exchange public market data connected: ${this.getExchangeLabel(exchangeId)}${useCredentials ? '' : ' (fallback)'}`);

        return true;
      } catch (err: any) {
        lastError = err.message;
        logger.warn(`[INIT] ${this.getExchangeLabel(exchangeId)} unavailable: ${err.message}`);
      }
    }

    this.exchange = null;
    this.activeExchangeId = null;
    this.isInitialized = false;
    logger.error(`Exchange init failed: ${lastError}`);
    return false;
  }

  isReady(): boolean {
    return this.isInitialized && this.exchange !== null;
  }

  // ---- Get account balance ----
  async getBalance(): Promise<{ total: number; free: number; used: number }> {
    if (!this.exchange || !this.hasPrivateApiAccess()) return { total: 0, free: 0, used: 0 };
    try {
      const balance: any = await this.exchange.fetchBalance();
      return {
        total: balance.total?.USDT || balance.total?.USD || 0,
        free: balance.free?.USDT || balance.free?.USD || 0,
        used: balance.used?.USDT || balance.used?.USD || 0,
      };
    } catch (err: any) {
      logger.error(`Balance fetch failed: ${err.message}`);
      return { total: 0, free: 0, used: 0 };
    }
  }

  // ---- Set leverage for a symbol ----
  async setLeverage(symbol: string, leverage: number): Promise<boolean> {
    if (!this.exchange || !this.canTrade()) return false;
    try {
      await this.exchange.setLeverage(leverage, symbol);
      logger.info(`Leverage set to ${leverage}x for ${symbol}`);
      return true;
    } catch (err: any) {
      logger.warn(`setLeverage failed for ${symbol}: ${err.message}`);
      return false;
    }
  }

  // ---- Open a perpetual position ----
  async openPosition(signal: AggregatedSignal): Promise<Position | null> {
    if (!this.exchange) {
      logger.error('Exchange not initialized');
      return null;
    }
    if (!this.canTrade()) {
      logger.warn(`Trading unavailable on current exchange connection (${this.getActiveExchangeLabel()})`);
      return null;
    }

    // Check max positions
    if (this.positions.size >= config.trading.maxPositions) {
      logger.warn('Max positions reached, skipping');
      return null;
    }

    // Build the trading symbol (e.g., BTC/USDT:USDT for perps)
    const tradingSymbol = this.buildPerpsSymbol(signal.symbol);
    if (!tradingSymbol) {
      logger.warn(`Cannot build perps symbol for ${signal.symbol}`);
      return null;
    }

    const side = signal.direction === 'LONG' ? 'buy' : 'sell';
    const leverage = config.trading.defaultLeverage;

    try {
      // Set leverage
      await this.setLeverage(tradingSymbol, leverage);

      // Calculate position size
      const balance = await this.getBalance();
      const positionUSD = Math.min(config.trading.maxPositionSize, balance.free * 0.2);
      const ticker = await this.exchange.fetchTicker(tradingSymbol);
      const currentPrice = ticker.last || signal.suggestedEntry;

      if (!currentPrice || currentPrice <= 0) {
        logger.error(`Invalid price for ${tradingSymbol}`);
        return null;
      }

      const amount = (positionUSD * leverage) / currentPrice;

      // Place market order
      logger.info(`Opening ${side.toUpperCase()} ${tradingSymbol} | Size: $${positionUSD} | ${leverage}x`);
      const order: Order = await this.exchange.createOrder(
        tradingSymbol,
        'market',
        side,
        amount
      );

      const entryPrice = order.average || order.price || currentPrice;

      // Calculate SL/TP
      const slMultiplier = signal.direction === 'LONG' ? (1 - config.trading.stopLossPct / 100) : (1 + config.trading.stopLossPct / 100);
      const tpMultiplier = signal.direction === 'LONG' ? (1 + config.trading.takeProfitPct / 100) : (1 - config.trading.takeProfitPct / 100);
      const stopLoss = signal.suggestedSL || entryPrice * slMultiplier;
      const takeProfit = signal.suggestedTP || entryPrice * tpMultiplier;

      // Place stop loss order
      try {
        const slSide = signal.direction === 'LONG' ? 'sell' : 'buy';
        await this.exchange.createOrder(tradingSymbol, 'stop', slSide, amount, stopLoss, {
          stopPrice: stopLoss,
          reduceOnly: true,
        });
      } catch (slErr: any) {
        logger.warn(`SL order failed (will manage manually): ${slErr.message}`);
      }

      // Place take profit order
      try {
        const tpSide = signal.direction === 'LONG' ? 'sell' : 'buy';
        await this.exchange.createOrder(tradingSymbol, 'limit', tpSide, amount, takeProfit, {
          reduceOnly: true,
        });
      } catch (tpErr: any) {
        logger.warn(`TP order failed (will manage manually): ${tpErr.message}`);
      }

      const position: Position = {
        id: v4Fallback(),
        exchange: config.exchange.id,
        symbol: tradingSymbol,
        side: signal.direction,
        entryPrice,
        currentPrice: entryPrice,
        size: positionUSD,
        leverage,
        pnl: 0,
        pnlPct: 0,
        stopLoss,
        takeProfit,
        openedAt: Date.now(),
        status: 'open',
      };

      this.positions.set(position.id, position);
      logger.info(`Position opened: ${position.id} | ${tradingSymbol} ${signal.direction} @ ${entryPrice}`);
      return position;
    } catch (err: any) {
      logger.error(`Failed to open position for ${tradingSymbol}: ${err.message}`);
      return null;
    }
  }

  // ---- Close a position ----
  async closePosition(positionId: string): Promise<boolean> {
    if (!this.exchange || !this.canTrade()) return false;

    const position = this.positions.get(positionId);
    if (!position || position.status === 'closed') return false;

    try {
      const closeSide = position.side === 'LONG' ? 'sell' : 'buy';
      const ticker = await this.exchange.fetchTicker(position.symbol);
      const currentPrice = ticker.last || 0;
      const amount = (position.size * position.leverage) / position.entryPrice;

      await this.exchange.createOrder(position.symbol, 'market', closeSide, amount, undefined, {
        reduceOnly: true,
      });

      position.status = 'closed';
      position.currentPrice = currentPrice;
      if (position.side === 'LONG') {
        position.pnl = (currentPrice - position.entryPrice) / position.entryPrice * position.size * position.leverage;
      } else {
        position.pnl = (position.entryPrice - currentPrice) / position.entryPrice * position.size * position.leverage;
      }
      position.pnlPct = (position.pnl / position.size) * 100;

      logger.info(`Position closed: ${positionId} | PnL: $${position.pnl.toFixed(2)} (${position.pnlPct.toFixed(2)}%)`);
      return true;
    } catch (err: any) {
      logger.error(`Failed to close position ${positionId}: ${err.message}`);
      return false;
    }
  }

  // ---- Update all open positions with current prices ----
  async updatePositions(): Promise<Position[]> {
    if (!this.exchange) return [];

    for (const [, position] of this.positions) {
      if (position.status !== 'open') continue;

      try {
        const ticker = await this.exchange.fetchTicker(position.symbol);
        position.currentPrice = ticker.last || position.currentPrice;

        if (position.side === 'LONG') {
          position.pnl = (position.currentPrice - position.entryPrice) / position.entryPrice * position.size * position.leverage;
        } else {
          position.pnl = (position.entryPrice - position.currentPrice) / position.entryPrice * position.size * position.leverage;
        }
        position.pnlPct = (position.pnl / position.size) * 100;

        // Check if SL/TP triggered (manual management fallback)
        if (position.side === 'LONG') {
          if (position.currentPrice <= position.stopLoss || position.currentPrice >= position.takeProfit) {
            await this.closePosition(position.id);
          }
        } else {
          if (position.currentPrice >= position.stopLoss || position.currentPrice <= position.takeProfit) {
            await this.closePosition(position.id);
          }
        }
      } catch (err: any) {
        logger.warn(`Price update failed for ${position.symbol}: ${err.message}`);
      }
    }

    return this.getOpenPositions();
  }

  // ---- Get positions ----
  getOpenPositions(): Position[] {
    return Array.from(this.positions.values()).filter((p) => p.status === 'open');
  }

  getAllPositions(): Position[] {
    return Array.from(this.positions.values());
  }

  getTotalPnL(): number {
    return Array.from(this.positions.values()).reduce((sum, p) => sum + p.pnl, 0);
  }

  // ---- Fetch available perps markets ----
  async getAvailableMarkets(): Promise<string[]> {
    if (!this.exchange) return [];
    try {
      const markets = await this.exchange.loadMarkets();
      return Object.keys(markets).filter((s) => markets[s]?.swap || markets[s]?.future);
    } catch {
      return [];
    }
  }

  // ---- Build perpetual symbol format ----
  private buildPerpsSymbol(baseSymbol: string): string | null {
    if (!this.exchange) return null;

    // Try common perps formats
    const candidates = [
      `${baseSymbol}/USDT:USDT`,
      `${baseSymbol}/USD:USD`,
      `${baseSymbol}/USDC:USDC`,
      `${baseSymbol}USDT`,
    ];

    for (const candidate of candidates) {
      if (this.exchange.markets && this.exchange.markets[candidate]) {
        return candidate;
      }
    }

    // Fallback
    return `${baseSymbol}/USDT:USDT`;
  }

  // ---- Get OHLCV data from exchange ----
  async getOHLCV(symbol: string, timeframe: string = '15m', limit: number = 100): Promise<any[]> {
    if (!this.exchange) return [];
    try {
      const tradingSymbol = this.buildPerpsSymbol(symbol) || `${symbol}/USDT:USDT`;
      return await this.exchange.fetchOHLCV(tradingSymbol, timeframe, undefined, limit);
    } catch (err: any) {
      logger.warn(`OHLCV fetch failed for ${symbol}: ${err.message}`);
      return [];
    }
  }

  // ========================================
  // FUTURES SCANNER
  // Scans exchange-listed perps for setups
  // ========================================

  // Major perps tokens to scan when exchange isn't connected
  private static readonly FUTURES_SYMBOLS = [
    'BTC', 'ETH', 'SOL', 'BNB', 'XRP', 'DOGE', 'ADA', 'AVAX', 'DOT', 'LINK',
    'MATIC', 'UNI', 'ATOM', 'LTC', 'FIL', 'NEAR', 'APT', 'ARB', 'OP', 'SUI',
    'INJ', 'TIA', 'SEI', 'WIF', 'PEPE', 'BONK', 'ORDI', 'JTO', 'PYTH', 'JUP',
    'RENDER', 'FET', 'AAVE', 'MKR', 'CRV', 'RUNE', 'STX', 'IMX', 'MANA', 'SAND',
  ];

  private futuresSetups: FuturesSetup[] = [];

  // ---- Fetch OHLCV from Gate.io public futures API (no key needed) ----
  private async fetchGateIOOHLCV(symbol: string, interval: string = '15m', limit: number = 100): Promise<number[][]> {
    try {
      // Gate.io uses underscore format: BTC_USDT
      const contract = `${symbol}_USDT`;
      // Gate.io interval format: 15m, 1h, 4h, 1d
      const resp = await axios.get('https://api.gateio.ws/api/v4/futures/usdt/candlesticks', {
        params: { contract, interval, limit },
        timeout: 10000,
      });
      // Gate.io returns: { t, o, h, l, c, v, sum }
      return (resp.data || []).map((k: any) => [
        Number(k.t) * 1000, // timestamp to ms
        Number(k.o),        // open
        Number(k.h),        // high
        Number(k.l),        // low
        Number(k.c),        // close
        Number(k.v),        // volume
      ]);
    } catch {
      return [];
    }
  }

  // ---- Fallback: Fetch OHLCV from CryptoCompare (no key needed) ----
  private async fetchCryptoCompareOHLCV(symbol: string, limit: number = 100): Promise<number[][]> {
    try {
      // CryptoCompare doesn't have 15m directly; use histominute with limit*15 then aggregate
      const resp = await axios.get('https://min-api.cryptocompare.com/data/v2/histominute', {
        params: { fsym: symbol, tsym: 'USD', limit: Math.min(limit * 15, 2000), e: 'CCCAGG' },
        timeout: 15000,
      });
      const minuteData = resp.data?.Data?.Data || [];
      if (minuteData.length < 15) return [];

      // Aggregate 1m candles into 15m candles
      const candles: number[][] = [];
      for (let i = 0; i + 14 < minuteData.length; i += 15) {
        const chunk = minuteData.slice(i, i + 15);
        const open = chunk[0].open;
        const close = chunk[chunk.length - 1].close;
        const high = Math.max(...chunk.map((c: any) => c.high));
        const low = Math.min(...chunk.map((c: any) => c.low));
        const vol = chunk.reduce((s: number, c: any) => s + (c.volumeto || 0), 0);
        candles.push([chunk[0].time * 1000, open, high, low, close, vol]);
      }
      return candles;
    } catch {
      return [];
    }
  }

  // ---- Fetch OHLCV with fallback chain: Gate.io -> CryptoCompare ----
  private async fetchFuturesOHLCV(symbol: string, limit: number = 100): Promise<number[][]> {
    // Try Gate.io first (real futures data)
    let candles = await this.fetchGateIOOHLCV(symbol, '15m', limit);
    if (candles.length >= 50) return candles;

    // Try CoinGecko OHLCV (free, no key)
    candles = await this.fetchCoinGeckoOHLCV(symbol, limit);
    if (candles.length >= 50) return candles;

    // Fallback to CryptoCompare (spot data, still useful for technicals)
    candles = await this.fetchCryptoCompareOHLCV(symbol, limit);
    return candles;
  }

  // ---- CoinGecko OHLCV data (free, no key) ----
  private async fetchCoinGeckoOHLCV(symbol: string, limit: number = 100): Promise<number[][]> {
    try {
      const cgId = PerpsTrader.COINGECKO_IDS[symbol];
      if (!cgId) {
        // Try to resolve the id dynamically
        const searchResp = await axios.get('https://api.coingecko.com/api/v3/search', {
          params: { query: symbol },
          timeout: 8000,
        });
        const coin = searchResp.data?.coins?.[0];
        if (!coin?.id) return [];
        // Cache for future lookups
        PerpsTrader.COINGECKO_IDS[symbol] = coin.id;
        return this.fetchCoinGeckoOHLCVById(coin.id, limit);
      }
      return this.fetchCoinGeckoOHLCVById(cgId, limit);
    } catch {
      return [];
    }
  }

  private async fetchCoinGeckoOHLCVById(cgId: string, limit: number): Promise<number[][]> {
    try {
      // CoinGecko /ohlc endpoint: days=1 gives ~15min candles, days=7 gives hourly
      // For ~100 15-min candles we need 1 day of data
      const resp = await axios.get(`https://api.coingecko.com/api/v3/coins/${cgId}/ohlc`, {
        params: { vs_currency: 'usd', days: 1 },
        timeout: 10000,
      });
      const raw = resp.data || [];
      // CoinGecko returns [timestamp, open, high, low, close] — add volume=0
      return raw.map((c: number[]) => [c[0], c[1], c[2], c[3], c[4], 0]);
    } catch {
      return [];
    }
  }

  // ---- Get available futures symbols from Gate.io ----
  private async fetchExchangeFuturesSymbols(): Promise<string[]> {
    try {
      const resp = await axios.get('https://api.gateio.ws/api/v4/futures/usdt/contracts', {
        timeout: 10000,
      });
      const contracts = (resp.data || [])
        .filter((c: any) => c.name?.endsWith('_USDT'))
        .map((c: any) => ({
          symbol: c.name.replace('_USDT', ''),
          volume: Number(c.trade_size || 0),
        }))
        .sort((a: any, b: any) => b.volume - a.volume)
        .slice(0, 80)
        .map((c: any) => c.symbol);
      return contracts.length > 0 ? contracts : PerpsTrader.FUTURES_SYMBOLS;
    } catch {
      return PerpsTrader.FUTURES_SYMBOLS;
    }
  }

  // ---- Which exchanges list a token for futures trading ----
  private static readonly EXCHANGE_LISTINGS: Record<string, string[]> = {
    'BTC': ['Binance', 'Bybit', 'OKX', 'Gate.io', 'Bitget', 'MEXC', 'KuCoin', 'dYdX', 'Hyperliquid'],
    'ETH': ['Binance', 'Bybit', 'OKX', 'Gate.io', 'Bitget', 'MEXC', 'KuCoin', 'dYdX', 'Hyperliquid'],
    'SOL': ['Binance', 'Bybit', 'OKX', 'Gate.io', 'Bitget', 'MEXC', 'KuCoin', 'Hyperliquid'],
    'BNB': ['Binance', 'Bybit', 'OKX', 'Gate.io', 'Bitget', 'MEXC'],
    'XRP': ['Binance', 'Bybit', 'OKX', 'Gate.io', 'Bitget', 'MEXC', 'KuCoin'],
    'DOGE': ['Binance', 'Bybit', 'OKX', 'Gate.io', 'Bitget', 'MEXC', 'KuCoin'],
    'ADA': ['Binance', 'Bybit', 'OKX', 'Gate.io', 'Bitget', 'MEXC'],
    'AVAX': ['Binance', 'Bybit', 'OKX', 'Gate.io', 'Bitget', 'MEXC'],
    'DOT': ['Binance', 'Bybit', 'OKX', 'Gate.io', 'Bitget', 'MEXC'],
    'LINK': ['Binance', 'Bybit', 'OKX', 'Gate.io', 'Bitget', 'MEXC', 'KuCoin'],
    'MATIC': ['Binance', 'Bybit', 'OKX', 'Gate.io', 'Bitget', 'MEXC'],
    'UNI': ['Binance', 'Bybit', 'OKX', 'Gate.io', 'Bitget'],
    'ATOM': ['Binance', 'Bybit', 'OKX', 'Gate.io', 'Bitget'],
    'LTC': ['Binance', 'Bybit', 'OKX', 'Gate.io', 'Bitget', 'MEXC'],
    'NEAR': ['Binance', 'Bybit', 'OKX', 'Gate.io', 'Bitget'],
    'APT': ['Binance', 'Bybit', 'OKX', 'Gate.io', 'Bitget'],
    'ARB': ['Binance', 'Bybit', 'OKX', 'Gate.io', 'Bitget', 'MEXC'],
    'OP': ['Binance', 'Bybit', 'OKX', 'Gate.io', 'Bitget'],
    'SUI': ['Binance', 'Bybit', 'OKX', 'Gate.io', 'Bitget'],
    'INJ': ['Binance', 'Bybit', 'OKX', 'Gate.io', 'Bitget'],
    'WIF': ['Binance', 'Bybit', 'Gate.io', 'Bitget', 'MEXC'],
    'PEPE': ['Binance', 'Bybit', 'OKX', 'Gate.io', 'Bitget', 'MEXC'],
    'FET': ['Binance', 'Bybit', 'OKX', 'Gate.io', 'Bitget'],
    'RENDER': ['Binance', 'Bybit', 'OKX', 'Gate.io'],
    'AAVE': ['Binance', 'Bybit', 'OKX', 'Gate.io'],
    'CRV': ['Binance', 'Bybit', 'OKX', 'Gate.io'],
    'RUNE': ['Binance', 'Bybit', 'Gate.io'],
  };

  private getExchangesForSymbol(symbol: string): string[] {
    return PerpsTrader.EXCHANGE_LISTINGS[symbol] || ['Gate.io'];
  }

  // ---- Dynamically fetch exchange listings from CoinGecko tickers ----
  private exchangeTickerCache: Map<string, { exchanges: string[]; ts: number }> = new Map();

  private async fetchExchangeListings(symbol: string): Promise<string[]> {
    // Cache for 30 minutes
    const cached = this.exchangeTickerCache.get(symbol);
    if (cached && Date.now() - cached.ts < 1800000) return cached.exchanges;

    // If we have hardcoded data, use it as base
    const hardcoded = PerpsTrader.EXCHANGE_LISTINGS[symbol];

    try {
      const cgId = PerpsTrader.COINGECKO_IDS[symbol];
      if (!cgId) return hardcoded || ['Gate.io'];

      const resp = await axios.get(`https://api.coingecko.com/api/v3/coins/${cgId}/tickers`, {
        params: { include_exchange_logo: false, depth: false },
        timeout: 10000,
      });
      const tickers = resp.data?.tickers || [];
      const exchangeSet = new Set<string>();
      for (const t of tickers) {
        if (t.market?.name) {
          exchangeSet.add(t.market.name);
        }
      }
      // Keep well-known exchanges, prioritize popular ones first
      const knownOrder = ['Binance', 'Bybit', 'OKX', 'Gate.io', 'Bitget', 'MEXC', 'KuCoin', 'Coinbase Exchange', 'Kraken', 'HTX', 'Bitfinex', 'dYdX', 'Hyperliquid', 'Crypto.com Exchange'];
      const sorted: string[] = [];
      for (const ex of knownOrder) {
        if (exchangeSet.has(ex)) sorted.push(ex);
      }
      // Add remaining exchanges not in known list
      for (const ex of exchangeSet) {
        if (!sorted.includes(ex) && sorted.length < 15) sorted.push(ex);
      }
      const result = sorted.length > 0 ? sorted : (hardcoded || ['Gate.io']);
      this.exchangeTickerCache.set(symbol, { exchanges: result, ts: Date.now() });
      return result;
    } catch {
      return hardcoded || ['Gate.io'];
    }
  }

  // ---- CoinGecko market data (free, no key) ----
  private coinGeckoCache: Map<string, { data: any; ts: number }> = new Map();

  private static COINGECKO_IDS: Record<string, string> = {
    'BTC': 'bitcoin', 'ETH': 'ethereum', 'SOL': 'solana', 'BNB': 'binancecoin',
    'XRP': 'ripple', 'DOGE': 'dogecoin', 'ADA': 'cardano', 'AVAX': 'avalanche-2',
    'DOT': 'polkadot', 'LINK': 'chainlink', 'MATIC': 'matic-network', 'UNI': 'uniswap',
    'ATOM': 'cosmos', 'LTC': 'litecoin', 'FIL': 'filecoin', 'NEAR': 'near',
    'APT': 'aptos', 'ARB': 'arbitrum', 'OP': 'optimism', 'SUI': 'sui',
    'INJ': 'injective-protocol', 'TIA': 'celestia', 'SEI': 'sei-network',
    'WIF': 'dogwifcoin', 'PEPE': 'pepe', 'BONK': 'bonk',
    'RENDER': 'render-token', 'FET': 'fetch-ai', 'AAVE': 'aave', 'MKR': 'maker',
    'CRV': 'curve-dao-token', 'RUNE': 'thorchain', 'STX': 'blockstack',
    'IMX': 'immutable-x', 'MANA': 'decentraland', 'SAND': 'the-sandbox',
    'DYDX': 'dydx-chain', 'ICP': 'internet-computer', 'SHIB': 'shiba-inu',
    'JASMY': 'jasmycoin', 'FLOW': 'flow',
  };

  private async fetchCoinGeckoData(symbols: string[]): Promise<Map<string, any>> {
    const result = new Map<string, any>();
    const ids = symbols
      .map(s => PerpsTrader.COINGECKO_IDS[s])
      .filter(Boolean);
    if (ids.length === 0) return result;

    // Check cache (60s TTL)
    const now = Date.now();
    const uncachedIds: string[] = [];
    for (const s of symbols) {
      const cached = this.coinGeckoCache.get(s);
      if (cached && now - cached.ts < 60000) {
        result.set(s, cached.data);
      } else {
        uncachedIds.push(s);
      }
    }

    if (uncachedIds.length === 0) return result;

    const cgIds = uncachedIds.map(s => PerpsTrader.COINGECKO_IDS[s]).filter(Boolean);
    if (cgIds.length === 0) return result;

    try {
      // CoinGecko allows up to 250 ids per request
      const resp = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
        params: {
          ids: cgIds.join(','),
          vs_currencies: 'usd',
          include_market_cap: true,
          include_24hr_vol: true,
          include_24hr_change: true,
        },
        timeout: 10000,
      });

      const data = resp.data || {};
      for (const s of uncachedIds) {
        const cgId = PerpsTrader.COINGECKO_IDS[s];
        if (cgId && data[cgId]) {
          const d = {
            marketCap: data[cgId].usd_market_cap || 0,
            volume24h: data[cgId].usd_24h_vol || 0,
            priceChange24h: data[cgId].usd_24h_change || 0,
          };
          result.set(s, d);
          this.coinGeckoCache.set(s, { data: d, ts: now });
        }
      }
    } catch (err: any) {
      logger.debug(`[FUTURES] CoinGecko fetch failed: ${err.message}`);
    }

    return result;
  }

  // ---- CoinMarketCap: discover trending/gainers for more futures coins ----
  private cmcCache: { symbols: string[]; ts: number } = { symbols: [], ts: 0 };

  private async fetchCMCTrendingSymbols(): Promise<string[]> {
    // Cache for 10 minutes
    if (Date.now() - this.cmcCache.ts < 600000 && this.cmcCache.symbols.length > 0) {
      return this.cmcCache.symbols;
    }

    const symbols: string[] = [];

    try {
      if (CMC_API_KEY) {
        // With API key: use CMC's listings endpoint sorted by % change
        const resp = await axios.get(`${CMC_BASE}/cryptocurrency/listings/latest`, {
          headers: { 'X-CMC_PRO_API_KEY': CMC_API_KEY },
          params: { start: 1, limit: 100, sort: 'percent_change_24h', sort_dir: 'desc', convert: 'USD' },
          timeout: 10000,
        });
        const listings = resp.data?.data || [];
        for (const coin of listings) {
          if (coin.symbol && !symbols.includes(coin.symbol)) {
            symbols.push(coin.symbol);
          }
        }
      }
    } catch (err: any) {
      logger.debug(`[FUTURES] CMC listings fetch failed: ${err.message}`);
    }

    // Fallback: use CoinGecko trending coins (no key needed)
    try {
      const resp = await axios.get('https://api.coingecko.com/api/v3/search/trending', { timeout: 10000 });
      const coins = resp.data?.coins || [];
      for (const c of coins) {
        const sym = c.item?.symbol?.toUpperCase();
        if (sym && !symbols.includes(sym)) symbols.push(sym);
      }
    } catch (err: any) {
      logger.debug(`[FUTURES] CoinGecko trending fetch failed: ${err.message}`);
    }

    // Also get CoinGecko top gainers
    try {
      const resp = await axios.get('https://api.coingecko.com/api/v3/coins/markets', {
        params: { vs_currency: 'usd', order: 'volume_desc', per_page: 50, page: 1, sparkline: false },
        timeout: 10000,
      });
      const markets = resp.data || [];
      for (const coin of markets) {
        const sym = coin.symbol?.toUpperCase();
        if (sym && !symbols.includes(sym)) symbols.push(sym);
      }
    } catch (err: any) {
      logger.debug(`[FUTURES] CoinGecko markets fetch failed: ${err.message}`);
    }

    // Under-the-radar: low-cap gainers from CoinGecko (sorted by 24h gain, lower mcap)
    try {
      const resp = await axios.get('https://api.coingecko.com/api/v3/coins/markets', {
        params: { vs_currency: 'usd', order: 'percent_change_24h_desc', per_page: 50, page: 1, sparkline: false, price_change_percentage: '24h,7d' },
        timeout: 10000,
      });
      const gainers = resp.data || [];
      for (const coin of gainers) {
        const sym = coin.symbol?.toUpperCase();
        if (sym && !symbols.includes(sym)) symbols.push(sym);
      }
    } catch (err: any) {
      logger.debug(`[FUTURES] CoinGecko gainers fetch failed: ${err.message}`);
    }

    // Recently added / new listings from CoinGecko
    try {
      const resp = await axios.get('https://api.coingecko.com/api/v3/coins/list/new', { timeout: 10000 });
      const newCoins = resp.data || [];
      for (const coin of newCoins.slice(0, 20)) {
        const sym = coin.symbol?.toUpperCase();
        if (sym && !symbols.includes(sym)) symbols.push(sym);
      }
    } catch (err: any) {
      logger.debug(`[FUTURES] CoinGecko new coins fetch failed: ${err.message}`);
    }

    // Gate.io recently listed futures (high volume newcomers)
    try {
      const resp = await axios.get('https://api.gateio.ws/api/v4/futures/usdt/contracts', { timeout: 10000 });
      const contracts = (resp.data || [])
        .filter((c: any) => c.name?.endsWith('_USDT'))
        .sort((a: any, b: any) => Number(b.create_time || 0) - Number(a.create_time || 0))
        .slice(0, 30);
      for (const c of contracts) {
        const sym = c.name?.replace('_USDT', '');
        if (sym && !symbols.includes(sym)) symbols.push(sym);
      }
    } catch (err: any) {
      logger.debug(`[FUTURES] Gate.io new listings fetch failed: ${err.message}`);
    }

    if (symbols.length > 0) {
      this.cmcCache = { symbols, ts: Date.now() };
    }
    return symbols;
  }

  // ---- Fetch detailed market data from CoinMarketCap ----
  private async fetchCMCMarketData(symbols: string[]): Promise<Map<string, {
    marketCap: number; volume24h: number; priceChange24h: number;
    priceChange7d: number; dominance: number; rank: number;
    circulatingSupply: number; maxSupply: number | null;
  }>> {
    const result = new Map<string, any>();
    if (!CMC_API_KEY || symbols.length === 0) return result;

    try {
      const resp = await axios.get(`${CMC_BASE}/cryptocurrency/quotes/latest`, {
        headers: { 'X-CMC_PRO_API_KEY': CMC_API_KEY },
        params: { symbol: symbols.slice(0, 50).join(','), convert: 'USD' },
        timeout: 10000,
      });
      const data = resp.data?.data || {};
      for (const sym of symbols) {
        const coin = data[sym]?.[0] || data[sym];
        if (!coin) continue;
        const quote = coin.quote?.USD;
        if (!quote) continue;
        result.set(sym, {
          marketCap: quote.market_cap || 0,
          volume24h: quote.volume_24h || 0,
          priceChange24h: quote.percent_change_24h || 0,
          priceChange7d: quote.percent_change_7d || 0,
          dominance: quote.market_cap_dominance || 0,
          rank: coin.cmc_rank || 0,
          circulatingSupply: coin.circulating_supply || 0,
          maxSupply: coin.max_supply || null,
        });
      }
    } catch (err: any) {
      logger.debug(`[FUTURES] CMC quotes fetch failed: ${err.message}`);
    }
    return result;
  }
  private newsCache: Map<string, { sentiment: string; headline?: string; source?: string; ts: number }> = new Map();

  async fetchNewsSentiment(symbols: string[]): Promise<Map<string, { sentiment: string; headline?: string; source?: string }>> {
    const result = new Map<string, { sentiment: string; headline?: string; source?: string }>();
    const now = Date.now();

    // Check cache (5 min TTL)
    const uncached: string[] = [];
    for (const s of symbols) {
      const cached = this.newsCache.get(s);
      if (cached && now - cached.ts < 300000) {
        result.set(s, { sentiment: cached.sentiment, headline: cached.headline, source: cached.source });
      } else {
        uncached.push(s);
      }
    }

    if (uncached.length === 0) return result;

    try {
      // Use CryptoCompare news (free, no key needed)
      const resp = await axios.get('https://min-api.cryptocompare.com/data/v2/news/', {
        params: { lang: 'EN', categories: uncached.join(',') },
        timeout: 10000,
      });

      const articles = resp.data?.Data || [];
      for (const s of uncached) {
        const sym = s.toLowerCase();
        const relevant = articles.filter((a: any) =>
          a.title?.toLowerCase().includes(sym) ||
          a.categories?.toLowerCase().includes(sym) ||
          a.body?.toLowerCase().includes(sym)
        );

        if (relevant.length > 0) {
          const article = relevant[0];
          // Simple sentiment from title keywords
          const title = (article.title || '').toLowerCase();
          let sentiment: 'bullish' | 'bearish' | 'neutral' = 'neutral';
          const bullishWords = ['surge', 'rally', 'bullish', 'pump', 'soar', 'rise', 'gain', 'high', 'breakout', 'buy', 'upside', 'moon', 'ath', 'record'];
          const bearishWords = ['crash', 'dump', 'bearish', 'fall', 'drop', 'plunge', 'sell', 'down', 'low', 'correction', 'decline', 'fear'];

          const bullCount = bullishWords.filter(w => title.includes(w)).length;
          const bearCount = bearishWords.filter(w => title.includes(w)).length;
          if (bullCount > bearCount) sentiment = 'bullish';
          else if (bearCount > bullCount) sentiment = 'bearish';

          const entry = { sentiment, headline: article.title, source: article.source };
          result.set(s, entry);
          this.newsCache.set(s, { ...entry, ts: now });
        } else {
          result.set(s, { sentiment: 'neutral' });
          this.newsCache.set(s, { sentiment: 'neutral', ts: now });
        }
      }
    } catch (err: any) {
      logger.debug(`[FUTURES] News fetch failed: ${err.message}`);
      for (const s of uncached) {
        result.set(s, { sentiment: 'neutral' });
      }
    }

    return result;
  }

  private registerPublishedSetups(setups: FuturesSetup[]) {
    for (const s of setups) this.setupLedger.set(s.id, s);
  }

  private recordSetupOutcome(outcome: SetupOutcome) {
    this.setupOutcomes.push(outcome);
    if (this.setupOutcomes.length > 1500) {
      this.setupOutcomes.splice(0, this.setupOutcomes.length - 1500);
    }
  }

  private async evaluateHistoricalOutcomes(): Promise<void> {
    if (this.setupLedger.size === 0) return;

    const lookaheadMin = config.trading.setupLookaheadMin;
    const barsToCheck = Math.max(4, Math.floor(lookaheadMin / 15));
    const now = Date.now();
    const symbols = [...new Set(Array.from(this.setupLedger.values()).map(s => s.symbol))];
    const candlesMap = new Map<string, number[][]>();

    await Promise.all(symbols.map(async (sym) => {
      candlesMap.set(sym, await this.fetchFuturesOHLCV(sym, 220));
    }));

    for (const [id, setup] of this.setupLedger) {
      const ageMin = (now - setup.timestamp) / 60000;
      if (ageMin < lookaheadMin) continue;

      const candles = candlesMap.get(setup.symbol) || [];
      if (candles.length < 40) continue;

      const startIdx = candles.findIndex(c => Number(c[0]) >= setup.timestamp);
      if (startIdx < 0) continue;

      const endIdx = Math.min(candles.length - 1, startIdx + barsToCheck);
      if (endIdx <= startIdx) continue;

      let outcome: 'WIN' | 'LOSS' | 'TIMEOUT' = 'TIMEOUT';
      let exitPrice = Number(candles[endIdx][4]);
      let closeTs = Number(candles[endIdx][0]);
      for (let i = startIdx; i <= endIdx; i++) {
        const high = Number(candles[i][2]);
        const low = Number(candles[i][3]);
        const ts = Number(candles[i][0]);

        if (setup.direction === 'LONG') {
          const slHit = low <= setup.stopLoss;
          const tpHit = high >= setup.takeProfit;
          if (slHit || tpHit) {
            // Conservative tie-break if both touched in same candle.
            outcome = slHit ? 'LOSS' : 'WIN';
            exitPrice = slHit ? setup.stopLoss : setup.takeProfit;
            closeTs = ts;
            break;
          }
        } else {
          const slHit = high >= setup.stopLoss;
          const tpHit = low <= setup.takeProfit;
          if (slHit || tpHit) {
            outcome = slHit ? 'LOSS' : 'WIN';
            exitPrice = slHit ? setup.stopLoss : setup.takeProfit;
            closeTs = ts;
            break;
          }
        }
      }

      const risk = Math.max(1e-9, Math.abs(setup.entry - setup.stopLoss));
      const directionalMove = setup.direction === 'LONG'
        ? (exitPrice - setup.entry)
        : (setup.entry - exitPrice);
      const rMultiple = outcome === 'WIN'
        ? setup.riskReward
        : outcome === 'LOSS'
          ? -1
          : directionalMove / risk;

      this.recordSetupOutcome({
        setupId: setup.id,
        symbol: setup.symbol,
        direction: setup.direction,
        confidence: setup.confidence,
        riskReward: setup.riskReward,
        outcome,
        rMultiple: Number(rMultiple.toFixed(3)),
        openedAt: setup.timestamp,
        closedAt: closeTs,
      });
      this.setupLedger.delete(id);
    }
  }

  private buildRollingStats(window: number): RollingStats {
    const slice = this.setupOutcomes.slice(-window);
    const decisive = slice.filter(s => s.outcome !== 'TIMEOUT');
    const wins = decisive.filter(s => s.outcome === 'WIN').length;
    const losses = decisive.filter(s => s.outcome === 'LOSS').length;
    const hitRate = decisive.length > 0 ? (wins / decisive.length) * 100 : 0;
    const avgR = decisive.length > 0 ? decisive.reduce((sum, s) => sum + s.rMultiple, 0) / decisive.length : 0;
    return {
      sample: decisive.length,
      wins,
      losses,
      timeouts: slice.length - decisive.length,
      hitRate: Number(hitRate.toFixed(2)),
      avgR: Number(avgR.toFixed(3)),
    };
  }

  private autoTuneThresholds() {
    const target = config.trading.targetAccuracyPct;
    const r50 = this.buildRollingStats(50);
    if (r50.sample < 20) return;

    if (r50.hitRate < target - 2) {
      this.thresholds.minPublishConfidence = Math.min(94, this.thresholds.minPublishConfidence + 2);
      this.thresholds.minRiskReward = Number(Math.min(3, this.thresholds.minRiskReward + 0.1).toFixed(2));
      this.thresholds.minConfluence = Math.min(5, this.thresholds.minConfluence + 1);
      this.thresholds.minRawScore = Math.min(72, this.thresholds.minRawScore + 1);
      logger.info(`[TUNE] Tightened thresholds due to ${r50.hitRate.toFixed(1)}% hit-rate on last ${r50.sample}`);
      return;
    }

    if (r50.hitRate > target + 7) {
      this.thresholds.minPublishConfidence = Math.max(76, this.thresholds.minPublishConfidence - 1);
      this.thresholds.minRiskReward = Number(Math.max(1.8, this.thresholds.minRiskReward - 0.05).toFixed(2));
      this.thresholds.minConfluence = Math.max(3, this.thresholds.minConfluence - 1);
      this.thresholds.minRawScore = Math.max(52, this.thresholds.minRawScore - 1);
      logger.info(`[TUNE] Relaxed thresholds due to ${r50.hitRate.toFixed(1)}% hit-rate on last ${r50.sample}`);
    }
  }

  // ---- Compute technicals from OHLCV data ----
  private computeFuturesTechnicals(candles: number[][]): {
    rsi: number;
    macdSignal: 'bullish' | 'bearish' | 'neutral';
    ema20: number;
    ema50: number;
    ema200: number;
    bollingerPosition: 'upper' | 'middle' | 'lower';
    trend: 'uptrend' | 'downtrend' | 'sideways';
    atr: number;
    volumeRatio: number;
    momentum3: number;
    momentum12: number;
    currentPrice: number;
  } | null {
    if (candles.length < 50) return null;

    const closes = candles.map(c => c[4]);
    const highs = candles.map(c => c[2]);
    const lows = candles.map(c => c[3]);
    const currentPrice = closes[closes.length - 1];

    // RSI
    const rsiValues = RSI.calculate({ values: closes, period: 14 });
    const rsi = rsiValues[rsiValues.length - 1] || 50;

    // MACD
    const macdResult = MACD.calculate({
      values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
      SimpleMAOscillator: false, SimpleMASignal: false,
    });
    const lastMacd = macdResult[macdResult.length - 1];
    const macdSignal: 'bullish' | 'bearish' | 'neutral' =
      lastMacd?.histogram !== undefined
        ? lastMacd.histogram > 0 ? 'bullish' : 'bearish'
        : 'neutral';

    // EMA
    const ema20Values = EMA.calculate({ values: closes, period: 20 });
    const ema50Values = EMA.calculate({ values: closes, period: 50 });
    const ema200Values = EMA.calculate({ values: closes, period: 200 });
    const ema20 = ema20Values[ema20Values.length - 1] || 0;
    const ema50 = ema50Values[ema50Values.length - 1] || 0;
    const ema200 = ema200Values[ema200Values.length - 1] || ema50;

    // Bollinger Bands
    const bbResult = BollingerBands.calculate({ values: closes, period: 20, stdDev: 2 });
    const lastBB = bbResult[bbResult.length - 1];
    let bollingerPosition: 'upper' | 'middle' | 'lower' = 'middle';
    if (lastBB) {
      if (currentPrice >= lastBB.upper) bollingerPosition = 'upper';
      else if (currentPrice <= lastBB.lower) bollingerPosition = 'lower';
    }

    // Trend
    let trend: 'uptrend' | 'downtrend' | 'sideways' = 'sideways';
    if (ema20 > ema50 && ema50 > ema200 && currentPrice > ema20) trend = 'uptrend';
    else if (ema20 < ema50 && ema50 < ema200 && currentPrice < ema20) trend = 'downtrend';

    // ATR (for SL/TP sizing)
    const atrPeriod = 14;
    let atrSum = 0;
    for (let i = candles.length - atrPeriod; i < candles.length; i++) {
      const tr = Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      );
      atrSum += tr;
    }
    const atr = atrSum / atrPeriod;

    // Volume expansion: current volume vs 20-candle average.
    const recentVolume = candles[candles.length - 1][5] || 0;
    const avgVolume20 = candles.slice(-20).reduce((sum, c) => sum + (c[5] || 0), 0) / 20;
    const volumeRatio = avgVolume20 > 0 ? recentVolume / avgVolume20 : 1;

    // Short and medium momentum snapshots.
    const momentum3 = closes.length > 3 ? ((currentPrice - closes[closes.length - 4]) / closes[closes.length - 4]) * 100 : 0;
    const momentum12 = closes.length > 12 ? ((currentPrice - closes[closes.length - 13]) / closes[closes.length - 13]) * 100 : 0;

    return { rsi, macdSignal, ema20, ema50, ema200, bollingerPosition, trend, atr, volumeRatio, momentum3, momentum12, currentPrice };
  }

  // ---- Scan exchange futures markets and generate setups ----
  async scanFuturesMarkets(): Promise<FuturesSetup[]> {
    await this.evaluateHistoricalOutcomes();
    const setups: FuturesSetup[] = [];

    // Get symbols to scan
    let symbols: string[];
    if (this.isInitialized && this.exchange) {
      try {
        const markets = await this.exchange.loadMarkets();
        symbols = Object.keys(markets)
          .filter(s => markets[s]?.swap || markets[s]?.future)
          .filter(s => s.endsWith('/USDT:USDT'))
          .map(s => s.split('/')[0])
          .slice(0, 60);
      } catch {
        symbols = PerpsTrader.FUTURES_SYMBOLS;
      }
    } else {
      // Use Gate.io public API (no auth needed) for symbol list
      symbols = await this.fetchExchangeFuturesSymbols();
    }

    // Merge with CMC/CoinGecko trending coins for broader coverage
    try {
      const trendingSymbols = await this.fetchCMCTrendingSymbols();
      // Only add trending symbols that are also available on Gate.io futures
      const gateSymbols = new Set(symbols.map(s => s.toUpperCase()));
      for (const sym of trendingSymbols) {
        if (!gateSymbols.has(sym.toUpperCase())) {
          symbols.push(sym);
        }
      }
    } catch {}

    // Deduplicate
    symbols = [...new Set(symbols.map(s => s.toUpperCase()))];

    logger.info(`[FUTURES] Scanning ${symbols.length} exchange perps markets (incl. trending)...`);

    for (const symbol of symbols.slice(0, 70)) {
      try {
        // Fetch OHLCV — from connected exchange or Gate.io/CryptoCompare
        let candles: number[][];
        if (this.isInitialized && this.exchange) {
          const raw = await this.exchange.fetchOHLCV(`${symbol}/USDT:USDT`, '15m', undefined, 100);
          candles = raw.map((c: any) => c.map((v: any) => Number(v || 0)));
        } else {
          candles = await this.fetchFuturesOHLCV(symbol, 100);
        }

        if (candles.length < 50) continue;

        const tech = this.computeFuturesTechnicals(candles);
        if (!tech) continue;

        // Generate setup based on technicals
        const setup = this.evaluateFuturesSetup(symbol, tech);
        if (setup) {
          setups.push(setup);
        }
      } catch (err: any) {
        logger.debug(`[FUTURES] Skip ${symbol}: ${err.message}`);
      }
    }

    setups.sort((a, b) => b.confidence - a.confidence);

    // Enrich with news sentiment, CoinGecko data, CMC data, derivatives, and exchange availability
    const setupSymbols = setups.map(s => s.symbol);
    const [newsData, cgData, cmcData] = await Promise.all([
      this.fetchNewsSentiment(setupSymbols),
      this.fetchCoinGeckoData(setupSymbols),
      this.fetchCMCMarketData(setupSymbols),
    ]);

    const derivativesPairs = await Promise.all(
      setups.map(async (s) => [s.symbol, await this.fetchDerivativesIntel(s.symbol)] as const)
    );
    const derivativesMap = new Map<string, DerivativesIntel>();
    for (const [sym, d] of derivativesPairs) {
      if (d) derivativesMap.set(sym, d);
    }

    for (const setup of setups) {
      // News sentiment
      const news = newsData.get(setup.symbol);
      if (news) {
        setup.news = {
          sentiment: news.sentiment as any,
          headline: news.headline,
          source: news.source,
        };
        // Boost confidence if news aligns with direction
        if ((news.sentiment === 'bullish' && setup.direction === 'LONG') ||
            (news.sentiment === 'bearish' && setup.direction === 'SHORT')) {
          setup.confidence = Math.min(setup.confidence + 10, 100);
          setup.reason += ' | News confirms direction';
        } else if ((news.sentiment === 'bearish' && setup.direction === 'LONG') ||
                   (news.sentiment === 'bullish' && setup.direction === 'SHORT')) {
          setup.confidence = Math.max(setup.confidence - 5, 0);
          setup.reason += ' | News contradicts direction';
        }
      }

      // CoinGecko market data
      const cg = cgData.get(setup.symbol);
      if (cg) {
        setup.marketCap = cg.marketCap;
        setup.volume24h = cg.volume24h;
        setup.priceChange24h = cg.priceChange24h;
      }

      // CoinMarketCap enrichment (overrides CoinGecko if available - more accurate)
      const cmc = cmcData.get(setup.symbol);
      if (cmc) {
        setup.marketCap = cmc.marketCap || setup.marketCap;
        setup.volume24h = cmc.volume24h || setup.volume24h;
        setup.priceChange24h = cmc.priceChange24h || setup.priceChange24h;
        setup.priceChange7d = cmc.priceChange7d;
        setup.cmcRank = cmc.rank;
        setup.circulatingSupply = cmc.circulatingSupply;
        setup.maxSupply = cmc.maxSupply;
      }

      // Exchange availability — try dynamic CoinGecko tickers, fall back to static map
      try {
        setup.exchanges = await this.fetchExchangeListings(setup.symbol);
      } catch {
        setup.exchanges = this.getExchangesForSymbol(setup.symbol);
      }

      // Derivatives intelligence
      const derivatives = derivativesMap.get(setup.symbol);
      if (derivatives) setup.derivatives = derivatives;

      // Market-mode context sharing
      if (this.marketMode === 'RISK_OFF') {
        if (setup.direction === 'LONG') {
          setup.confidence = Math.max(0, setup.confidence - 8);
          setup.reason += ' | Risk-off mode trims long bias';
        } else {
          setup.confidence = Math.min(100, setup.confidence + 4);
          setup.reason += ' | Risk-off mode supports defensive short';
        }
      } else if (setup.direction === 'LONG') {
        setup.confidence = Math.min(100, setup.confidence + 5);
        setup.reason += ' | Risk-on mode supports long momentum';
      }

      this.applyDerivativesAdjustments(setup);

      // Detailed analysis summary
      setup.analysisDetail = this.buildAnalysisDetail(setup);
    }

    // Re-sort after confidence adjustments
    setups.sort((a, b) => b.confidence - a.confidence);

    // Professional filter: publish only A-grade setups with solid R:R and no hard block.
    // Use sliding minPublishConfidence: 2-confluence needs lower score than 3+ confluence
    const filtered = setups
      .filter(s => {
        const confluenceAdjustedGate = s.confluence >= 3 
          ? this.thresholds.minPublishConfidence
          : Math.max(30, this.thresholds.minPublishConfidence - 50);
        return s.confidence >= confluenceAdjustedGate;
      })
      .filter(s => s.riskReward >= this.thresholds.minRiskReward)
      .filter(s => !s.safety?.blocked)
      .slice(0, 25);

    this.futuresSetups = filtered;
    this.registerPublishedSetups(filtered);
    this.autoTuneThresholds();
    logger.info(`[FUTURES] Generated ${filtered.length} high-confidence setups (from ${setups.length} raw candidates)`);
    return filtered;
  }

  // ---- Build a detailed analysis summary for each setup ----
  private buildAnalysisDetail(setup: FuturesSetup): string {
    const parts: string[] = [];
    const t = setup.technicals;

    // RSI analysis
    if (t.rsi < 30) parts.push(`RSI at ${t.rsi.toFixed(1)} indicates heavily oversold conditions — potential reversal zone`);
    else if (t.rsi > 70) parts.push(`RSI at ${t.rsi.toFixed(1)} signals overbought — watch for correction`);
    else if (t.rsi < 40) parts.push(`RSI ${t.rsi.toFixed(1)} approaching oversold territory`);
    else if (t.rsi > 60) parts.push(`RSI ${t.rsi.toFixed(1)} leaning overbought`);
    else parts.push(`RSI at ${t.rsi.toFixed(1)} — neutral zone`);

    // MACD analysis
    if (t.macd === 'bullish') parts.push('MACD histogram positive with bullish crossover — momentum favors longs');
    else if (t.macd === 'bearish') parts.push('MACD histogram negative with bearish crossover — momentum favors shorts');
    else parts.push('MACD flat — no clear momentum signal');

    // Trend
    if (t.trend === 'uptrend') parts.push(`Price above EMA20 ($${t.ema20.toFixed(4)}) & EMA50 ($${t.ema50.toFixed(4)}) — confirmed uptrend`);
    else if (t.trend === 'downtrend') parts.push(`Price below EMA20 ($${t.ema20.toFixed(4)}) & EMA50 ($${t.ema50.toFixed(4)}) — confirmed downtrend`);
    else parts.push(`EMAs converging — sideways/range-bound market`);

    // Bollinger
    if (t.bollinger === 'lower') parts.push('Trading near lower Bollinger Band — potential mean reversion bounce');
    else if (t.bollinger === 'upper') parts.push('Testing upper Bollinger Band — potential resistance/pullback');

    // Market data
    if (setup.marketCap) parts.push(`Market Cap: $${(setup.marketCap / 1e6).toFixed(1)}M`);
    if (setup.volume24h) parts.push(`24h Volume: $${(setup.volume24h / 1e6).toFixed(1)}M`);
    if (setup.priceChange24h) parts.push(`24h Change: ${setup.priceChange24h > 0 ? '+' : ''}${setup.priceChange24h.toFixed(2)}%`);
    if (setup.priceChange7d) parts.push(`7d Change: ${setup.priceChange7d > 0 ? '+' : ''}${setup.priceChange7d.toFixed(2)}%`);

    // Risk/Reward
    parts.push(`Risk/Reward: ${setup.riskReward.toFixed(1)}:1 — SL ${((Math.abs(setup.entry - setup.stopLoss) / setup.entry) * 100).toFixed(2)}% from entry`);

    // Derivatives
    if (setup.derivatives) {
      parts.push(
        `Funding ${setup.derivatives.fundingRate.toFixed(4)}% | OI ${setup.derivatives.openInterest.toFixed(0)} (${setup.derivatives.openInterestChange24h >= 0 ? '+' : ''}${setup.derivatives.openInterestChange24h.toFixed(1)}%) | L/S ${setup.derivatives.longShortRatio.toFixed(2)}`
      );
    }

    // Where to trade
    if (setup.exchanges?.length > 0) {
      parts.push(`Available on: ${setup.exchanges.join(', ')}`);
    }

    // News
    if (setup.news?.headline) {
      parts.push(`Latest News (${setup.news.sentiment}): "${setup.news.headline}"`);
    }

    // Safety guard
    if (setup.safety?.warnings?.length) {
      parts.push(`Safety: ${setup.safety.warnings.join(' | ')}`);
    }

    return parts.join('. ');
  }

  private async fetchDerivativesIntel(symbol: string): Promise<DerivativesIntel | null> {
    const cached = this.derivativesCache.get(symbol);
    if (cached && Date.now() - cached.ts < 60000) return cached.data;

    try {
      const pair = `${symbol.toUpperCase()}USDT`;
      const [fundingResp, oiResp, lsResp] = await Promise.all([
        axios.get('https://fapi.binance.com/fapi/v1/fundingRate', {
          params: { symbol: pair, limit: 2 },
          timeout: 8000,
        }),
        axios.get('https://fapi.binance.com/fapi/v1/openInterest', {
          params: { symbol: pair },
          timeout: 8000,
        }),
        axios.get('https://fapi.binance.com/futures/data/globalLongShortAccountRatio', {
          params: { symbol: pair, period: '1h', limit: 2 },
          timeout: 8000,
        }),
      ]);

      const fundingRows = fundingResp.data || [];
      const fundingRate = Number(fundingRows[fundingRows.length - 1]?.fundingRate || 0) * 100;

      const openInterest = Number(oiResp.data?.openInterest || 0);

      const lsRows = lsResp.data || [];
      const latestLs = Number(lsRows[lsRows.length - 1]?.longShortRatio || 1);
      const prevLs = Number(lsRows[Math.max(0, lsRows.length - 2)]?.longShortRatio || latestLs || 1);
      const openInterestChange24h = ((latestLs - prevLs) / (prevLs || 1)) * 100;

      const overleveraged = Math.abs(fundingRate) > 0.04 || latestLs > 2.2 || latestLs < 0.45;
      const squeezeRisk: 'short_squeeze' | 'long_squeeze' | 'low' =
        fundingRate < -0.01 && latestLs < 0.9
          ? 'short_squeeze'
          : fundingRate > 0.01 && latestLs > 1.3
            ? 'long_squeeze'
            : 'low';

      const data: DerivativesIntel = {
        fundingRate,
        openInterest,
        openInterestChange24h,
        longShortRatio: latestLs,
        overleveraged,
        squeezeRisk,
      };
      this.derivativesCache.set(symbol, { data, ts: Date.now() });
      return data;
    } catch {
      return null;
    }
  }

  private applyDerivativesAdjustments(setup: FuturesSetup) {
    const d = setup.derivatives;
    if (!d) return;

    const warnings: string[] = [];

    if (d.fundingRate > 0.02 && setup.direction === 'SHORT') {
      setup.confidence = Math.min(100, setup.confidence + 6);
      setup.reason += ' | Positive funding favors contrarian short';
    }
    if (d.fundingRate < -0.02 && setup.direction === 'LONG') {
      setup.confidence = Math.min(100, setup.confidence + 6);
      setup.reason += ' | Negative funding favors contrarian long';
    }

    if (d.longShortRatio > 1.8 && setup.direction === 'LONG') {
      setup.confidence = Math.max(0, setup.confidence - 8);
      warnings.push('Long crowding risk');
    }
    if (d.longShortRatio < 0.7 && setup.direction === 'SHORT') {
      setup.confidence = Math.max(0, setup.confidence - 8);
      warnings.push('Short crowding risk');
    }

    if (d.overleveraged) {
      setup.confidence = Math.max(0, setup.confidence - 6);
      warnings.push('Overleveraged derivatives conditions');
    }

    const headline = (setup.news?.headline || '').toLowerCase();
    const eventWords = ['cpi', 'fomc', 'fed', 'sec', 'lawsuit', 'hack', 'liquidation'];
    if (eventWords.some(w => headline.includes(w))) {
      setup.confidence = Math.max(0, setup.confidence - 5);
      warnings.push('Major news-event volatility risk');
    }

    let level: 'low' | 'medium' | 'high' = 'low';
    if (warnings.length >= 2 || setup.confidence < 45) level = 'high';
    else if (warnings.length === 1 || setup.confidence < 60) level = 'medium';

    setup.safety = {
      level,
      blocked: level === 'high' && this.marketMode === 'RISK_OFF',
      warnings,
    };
  }

  // ---- Evaluate a futures setup from technicals ----
  private evaluateFuturesSetup(
    symbol: string,
    tech: NonNullable<ReturnType<PerpsTrader['computeFuturesTechnicals']>>
  ): FuturesSetup | null {
    let longScore = 0;
    let shortScore = 0;
    let longConfluence = 0;
    let shortConfluence = 0;
    const longReasons: string[] = [];
    const shortReasons: string[] = [];

    // Trend and structure (highest weight)
    if (tech.trend === 'uptrend') {
      longScore += 22;
      longConfluence++;
      longReasons.push('Market structure bullish (EMA20 > EMA50 > EMA200)');
    }
    if (tech.trend === 'downtrend') {
      shortScore += 22;
      shortConfluence++;
      shortReasons.push('Market structure bearish (EMA20 < EMA50 < EMA200)');
    }

    // Momentum confirmation
    if (tech.macdSignal === 'bullish') {
      longScore += 20;
      longConfluence++;
      longReasons.push('MACD bullish momentum');
    }
    if (tech.macdSignal === 'bearish') {
      shortScore += 20;
      shortConfluence++;
      shortReasons.push('MACD bearish momentum');
    }

    // RSI regime and reversal zones
    if (tech.rsi >= 45 && tech.rsi <= 65) {
      if (tech.momentum3 > 0 && tech.momentum12 > 0) {
        longScore += 10;
        longConfluence++;
        longReasons.push(`RSI trend regime healthy (${tech.rsi.toFixed(1)})`);
      }
      if (tech.momentum3 < 0 && tech.momentum12 < 0) {
        shortScore += 10;
        shortConfluence++;
        shortReasons.push(`RSI trend regime weak (${tech.rsi.toFixed(1)})`);
      }
    }
    if (tech.rsi <= 35 && tech.bollingerPosition === 'lower') {
      longScore += 14;
      longConfluence++;
      longReasons.push(`Oversold mean-reversion pocket (RSI ${tech.rsi.toFixed(1)})`);
    }
    if (tech.rsi >= 65 && tech.bollingerPosition === 'upper') {
      shortScore += 14;
      shortConfluence++;
      shortReasons.push(`Overbought fade zone (RSI ${tech.rsi.toFixed(1)})`);
    }

    // Volume confirmation
    if (tech.volumeRatio >= 1.2 && tech.momentum3 > 0) {
      longScore += 10;
      longConfluence++;
      longReasons.push(`Volume expansion confirms upside (${tech.volumeRatio.toFixed(2)}x)`);
    }
    if (tech.volumeRatio >= 1.2 && tech.momentum3 < 0) {
      shortScore += 10;
      shortConfluence++;
      shortReasons.push(`Volume expansion confirms downside (${tech.volumeRatio.toFixed(2)}x)`);
    }

    // Penalize obvious counter-structure attempts.
    if (tech.trend === 'uptrend') shortScore -= 14;
    if (tech.trend === 'downtrend') longScore -= 14;
    // Allow counter-trend if momentum is strong enough
    if (tech.trend === 'uptrend' && tech.macdSignal === 'bearish') {
      shortScore += 12;
      shortConfluence++;
    }
    if (tech.trend === 'downtrend' && tech.macdSignal === 'bullish') {
      longScore += 12;
      longConfluence++;
    }
    if (tech.trend === 'sideways' && tech.macdSignal === 'bearish') {
      shortScore += 12;
      shortConfluence++;
    }
    if (tech.trend === 'sideways' && tech.macdSignal === 'bullish') {
      longScore += 12;
      longConfluence++;
    }

    const direction: 'LONG' | 'SHORT' = longScore >= shortScore ? 'LONG' : 'SHORT';
    const confidence = Math.max(longScore, shortScore);
    const confluence = direction === 'LONG' ? longConfluence : shortConfluence;
    const reasons = direction === 'LONG' ? longReasons : shortReasons;

    // Professional threshold: at least 2 confluence factors and raw score above 30.
    const minConfForPublish = Math.max(2, this.thresholds.minConfluence - 1);
    const minScoreForEval = Math.max(30, this.thresholds.minRawScore - 25);
    if (confluence < minConfForPublish || confidence < minScoreForEval) return null;

    // Calculate SL/TP using ATR
    const atrMultSL = 1.6;
    const atrMultTP = 3.6;
    const entry = tech.currentPrice;
    const sl = direction === 'LONG'
      ? entry - tech.atr * atrMultSL
      : entry + tech.atr * atrMultSL;
    const tp = direction === 'LONG'
      ? entry + tech.atr * atrMultTP
      : entry - tech.atr * atrMultTP;

    const riskAmt = Math.abs(entry - sl);
    const rewardAmt = Math.abs(tp - entry);
    const riskReward = riskAmt > 0 ? rewardAmt / riskAmt : 0;

    const t1 = tp;
    const t2 = direction === 'LONG' ? entry + tech.atr * 5 : entry - tech.atr * 5;
    const t3 = direction === 'LONG' ? entry + tech.atr * 7 : entry - tech.atr * 7;

    return {
      id: v4Fallback(),
      symbol,
      pair: `${symbol}/USDT`,
      exchange: this.isInitialized ? this.getActiveExchangeLabel() : 'Gate.io',
      direction,
      confluence,
      entry,
      stopLoss: sl,
      takeProfit: tp,
      targets: { t1, t2, t3 },
      confidence: Math.min(Math.max(confidence, 0), 100),
      leverage: config.trading.defaultLeverage,
      reason: reasons.join(' | '),
      riskReward,
      technicals: {
        rsi: tech.rsi,
        macd: tech.macdSignal,
        trend: tech.trend,
        ema20: tech.ema20,
        ema50: tech.ema50,
        bollinger: tech.bollingerPosition,
      },
      safety: { level: 'low', blocked: false, warnings: [] },
      exchanges: this.getExchangesForSymbol(symbol),
      timestamp: Date.now(),
    };
  }

  getFuturesSetups(): FuturesSetup[] {
    return this.futuresSetups;
  }

  getPerformanceStats(): PerformanceStats {
    return {
      totalEvaluated: this.setupOutcomes.length,
      rolling20: this.buildRollingStats(20),
      rolling50: this.buildRollingStats(50),
      rolling100: this.buildRollingStats(100),
      targetAccuracy: config.trading.targetAccuracyPct,
      thresholds: { ...this.thresholds },
      recentOutcomes: this.setupOutcomes.slice(-20).reverse(),
    };
  }

  // ---- Get detailed data for a single futures setup ----
  getFuturesSetupById(id: string): FuturesSetup | undefined {
    return this.futuresSetups.find(s => s.id === id);
  }
}

// ---- Type for futures trading setups ----
export interface FuturesSetup {
  id: string;
  symbol: string;
  pair: string;
  exchange: string;
  direction: 'LONG' | 'SHORT';
  confluence: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  targets: { t1: number; t2: number; t3: number };
  confidence: number;
  leverage: number;
  reason: string;
  riskReward: number;
  technicals: {
    rsi: number;
    macd: 'bullish' | 'bearish' | 'neutral';
    trend: 'uptrend' | 'downtrend' | 'sideways';
    ema20: number;
    ema50: number;
    bollinger: 'upper' | 'middle' | 'lower';
  };
  news?: {
    sentiment: 'bullish' | 'bearish' | 'neutral';
    headline?: string;
    source?: string;
  };
  marketCap?: number;
  volume24h?: number;
  priceChange24h?: number;
  priceChange7d?: number;
  cmcRank?: number;
  circulatingSupply?: number;
  maxSupply?: number | null;
  derivatives?: DerivativesIntel;
  safety?: SetupSafety;
  analysisDetail?: string;
  exchanges: string[];
  timestamp: number;
}

export interface DerivativesIntel {
  fundingRate: number;
  openInterest: number;
  openInterestChange24h: number;
  longShortRatio: number;
  overleveraged: boolean;
  squeezeRisk: 'short_squeeze' | 'long_squeeze' | 'low';
}

export interface SetupSafety {
  level: 'low' | 'medium' | 'high';
  blocked: boolean;
  warnings: string[];
}

export interface SetupOutcome {
  setupId: string;
  symbol: string;
  direction: 'LONG' | 'SHORT';
  confidence: number;
  riskReward: number;
  outcome: 'WIN' | 'LOSS' | 'TIMEOUT';
  rMultiple: number;
  openedAt: number;
  closedAt: number;
}

export interface RollingStats {
  sample: number;
  wins: number;
  losses: number;
  timeouts: number;
  hitRate: number;
  avgR: number;
}

export interface PerformanceStats {
  totalEvaluated: number;
  rolling20: RollingStats;
  rolling50: RollingStats;
  rolling100: RollingStats;
  targetAccuracy: number;
  thresholds: {
    minPublishConfidence: number;
    minRiskReward: number;
    minConfluence: number;
    minRawScore: number;
  };
  recentOutcomes: SetupOutcome[];
}
