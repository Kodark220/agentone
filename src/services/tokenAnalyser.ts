// ============================================
// TOKEN ANALYSIS SERVICE
// Multi-chain token scanning + technical analysis
// Uses DexScreener (free) + Birdeye (Solana)
// ============================================

import axios from 'axios';
import { RSI, MACD, EMA, BollingerBands } from 'technicalindicators';
import { config } from '../config';
import { logger } from '../utils/logger';
import { TokenAnalysis, TokenSignal, Chain } from '../types';
import { v4Fallback } from '../utils/id';
import type { NewsSentimentEngine } from './newsSentiment';

const DEXSCREENER_BASE = 'https://api.dexscreener.com/latest';
const BIRDEYE_BASE = 'https://public-api.birdeye.so';

interface OHLCVCandle {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  timestamp: number;
}

export class TokenAnalyser {
  private watchlist: Map<string, { symbol: string; chain: Chain; address?: string }> = new Map();
  private newsEngine: NewsSentimentEngine | null = null;

  // Link the news engine so token analysis includes sentiment data
  setNewsEngine(engine: NewsSentimentEngine) {
    this.newsEngine = engine;
  }

  addToWatchlist(symbol: string, chain: Chain, address?: string) {
    const key = `${symbol}:${chain}`;
    this.watchlist.set(key, { symbol, chain, address });
    logger.info(`Added ${symbol} on ${chain} to watchlist`);
  }

  removeFromWatchlist(symbol: string, chain: Chain) {
    this.watchlist.delete(`${symbol}:${chain}`);
  }

  getWatchlist() {
    return Array.from(this.watchlist.values());
  }

  // ---- DexScreener: search tokens across chains ----
  async searchTokens(query: string): Promise<any[]> {
    try {
      const resp = await axios.get(`${DEXSCREENER_BASE}/dex/search`, {
        params: { q: query },
        timeout: 10000,
      });
      return resp.data?.pairs || [];
    } catch (err: any) {
      logger.error(`DexScreener search failed: ${err.message}`);
      return [];
    }
  }

  // ---- DexScreener: get pair data by chain + pair address ----
  async getPairData(chain: string, pairAddress: string): Promise<any> {
    try {
      const resp = await axios.get(`${DEXSCREENER_BASE}/dex/pairs/${chain}/${pairAddress}`, {
        timeout: 10000,
      });
      return resp.data?.pairs?.[0] || null;
    } catch (err: any) {
      logger.error(`DexScreener pair fetch failed: ${err.message}`);
      return null;
    }
  }

  // ---- DexScreener: get token pairs by token address ----
  async getTokenPairs(tokenAddress: string): Promise<any[]> {
    try {
      const resp = await axios.get(`${DEXSCREENER_BASE}/dex/tokens/${tokenAddress}`, {
        timeout: 10000,
      });
      return resp.data?.pairs || [];
    } catch (err: any) {
      logger.error(`DexScreener token pairs failed: ${err.message}`);
      return [];
    }
  }

  // ---- Get trending/boosted tokens from DexScreener ----
  async getTrendingTokens(): Promise<any[]> {
    try {
      const resp = await axios.get('https://api.dexscreener.com/token-boosts/latest/v1', {
        timeout: 10000,
      });
      return resp.data || [];
    } catch (err: any) {
      logger.error(`DexScreener trending failed: ${err.message}`);
      return [];
    }
  }

  // ---- Synthesize OHLCV-like candles from DexScreener pair snapshot ----
  // Used when Birdeye isn't available (non-Solana chains)
  private synthesizeCandlesFromPair(pair: any): OHLCVCandle[] {
    const candles: OHLCVCandle[] = [];
    const currentPrice = parseFloat(pair.priceUsd || '0');
    if (currentPrice <= 0) return candles;

    // Use the available timeframe price changes to approximate recent history
    const changes: { mins: number; pct: number }[] = [];
    if (pair.priceChange?.m5 != null) changes.push({ mins: 5, pct: pair.priceChange.m5 });
    if (pair.priceChange?.h1 != null) changes.push({ mins: 60, pct: pair.priceChange.h1 });
    if (pair.priceChange?.h6 != null) changes.push({ mins: 360, pct: pair.priceChange.h6 });
    if (pair.priceChange?.h24 != null) changes.push({ mins: 1440, pct: pair.priceChange.h24 });

    // Build approximate candles stepping back in time
    const now = Date.now();
    const volume24h = pair.volume?.h24 || 0;

    for (const { mins, pct } of changes.reverse()) {
      const pastPrice = currentPrice / (1 + pct / 100);
      const candleVolume = volume24h * (mins / 1440);
      const spread = Math.abs(currentPrice - pastPrice) * 0.1;

      candles.push({
        open: pastPrice,
        high: Math.max(pastPrice, currentPrice) + spread,
        low: Math.min(pastPrice, currentPrice) - spread,
        close: pastPrice + (currentPrice - pastPrice) * 0.5,
        volume: candleVolume * 0.4,
        timestamp: now - mins * 60 * 1000,
      });
    }

    // Add current candle
    if (changes.length > 0) {
      const lastHist = changes[changes.length - 1];
      const prevPrice = currentPrice / (1 + (lastHist?.pct || 0) / 100);
      candles.push({
        open: prevPrice,
        high: currentPrice * 1.01,
        low: currentPrice * 0.99,
        close: currentPrice,
        volume: volume24h * 0.05,
        timestamp: now,
      });
    }

    return candles;
  }

  // ---- Birdeye: get Solana token price/OHLCV ----
  async getSolanaTokenOHLCV(address: string, interval: string = '15m', limit: number = 100): Promise<OHLCVCandle[]> {
    if (!config.apis.birdeyeKey) {
      logger.warn('Birdeye API key not set, skipping Solana OHLCV');
      return [];
    }

    try {
      const now = Math.floor(Date.now() / 1000);
      const intervalSecs: Record<string, number> = { '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '4h': 14400, '1d': 86400 };
      const secs = intervalSecs[interval] || 900;
      const from = now - secs * limit;

      const resp = await axios.get(`${BIRDEYE_BASE}/defi/ohlcv`, {
        params: { address, type: interval, time_from: from, time_to: now },
        headers: { 'X-API-KEY': config.apis.birdeyeKey, accept: 'application/json' },
        timeout: 15000,
      });

      const items = resp.data?.data?.items || [];
      return items.map((c: any) => ({
        open: c.o,
        high: c.h,
        low: c.l,
        close: c.c,
        volume: c.v,
        timestamp: c.unixTime * 1000,
      }));
    } catch (err: any) {
      logger.error(`Birdeye OHLCV failed: ${err.message}`);
      return [];
    }
  }

  // ---- Birdeye: Solana token overview ----
  async getSolanaTokenOverview(address: string): Promise<any> {
    if (!config.apis.birdeyeKey) return null;
    try {
      const resp = await axios.get(`${BIRDEYE_BASE}/defi/token_overview`, {
        params: { address },
        headers: { 'X-API-KEY': config.apis.birdeyeKey, accept: 'application/json' },
        timeout: 10000,
      });
      return resp.data?.data || null;
    } catch (err: any) {
      logger.error(`Birdeye overview failed: ${err.message}`);
      return null;
    }
  }

  // ---- Technical analysis on candle data ----
  // Works for both established tokens (50+ candles) and new tokens (fewer candles)
  computeTechnicals(candles: OHLCVCandle[]): TokenAnalysis['technicals'] {
    const closes = candles.map((c) => c.close);
    const currentPrice = closes[closes.length - 1] || 0;

    // For very new tokens (< 14 candles) use price-action heuristics
    if (closes.length < 14) {
      return this.computeNewTokenTechnicals(candles);
    }

    // For tokens with 14-49 candles, use shorter-period indicators
    if (closes.length < 50) {
      return this.computeShortHistoryTechnicals(candles);
    }

    // RSI
    const rsiValues = RSI.calculate({ values: closes, period: 14 });
    const rsi = rsiValues[rsiValues.length - 1] || 50;

    // MACD
    const macdResult = MACD.calculate({
      values: closes,
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9,
      SimpleMAOscillator: false,
      SimpleMASignal: false,
    });
    const lastMacd = macdResult[macdResult.length - 1];
    const macdSignal: 'bullish' | 'bearish' | 'neutral' =
      lastMacd && lastMacd.histogram !== undefined
        ? lastMacd.histogram > 0
          ? 'bullish'
          : 'bearish'
        : 'neutral';

    // EMA
    const ema20Values = EMA.calculate({ values: closes, period: 20 });
    const ema50Values = EMA.calculate({ values: closes, period: 50 });
    const ema20 = ema20Values[ema20Values.length - 1] || 0;
    const ema50 = ema50Values[ema50Values.length - 1] || 0;

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
    if (ema20 > ema50 && currentPrice > ema20) trend = 'uptrend';
    else if (ema20 < ema50 && currentPrice < ema20) trend = 'downtrend';

    return { rsi, macdSignal, ema20, ema50, bollingerPosition, trend };
  }

  // ---- Heuristics for brand-new tokens with < 14 candles ----
  private computeNewTokenTechnicals(candles: OHLCVCandle[]): TokenAnalysis['technicals'] {
    if (candles.length === 0) {
      return { rsi: 50, macdSignal: 'neutral', ema20: 0, ema50: 0, bollingerPosition: 'middle', trend: 'sideways' };
    }

    const closes = candles.map((c) => c.close);
    const volumes = candles.map((c) => c.volume);
    const currentPrice = closes[closes.length - 1];
    const firstPrice = closes[0];

    // Simple momentum: how much has price changed from open to now
    const momentum = firstPrice > 0 ? ((currentPrice - firstPrice) / firstPrice) * 100 : 0;

    // Volume trend: is volume increasing?
    const recentVol = volumes.slice(-Math.ceil(volumes.length / 2));
    const earlyVol = volumes.slice(0, Math.ceil(volumes.length / 2));
    const avgRecent = recentVol.reduce((a, b) => a + b, 0) / (recentVol.length || 1);
    const avgEarly = earlyVol.reduce((a, b) => a + b, 0) / (earlyVol.length || 1);
    const volumeGrowing = avgRecent > avgEarly * 1.5;

    // Synthesize pseudo-RSI from momentum
    let rsi = 50 + momentum * 0.5;
    rsi = Math.max(10, Math.min(90, rsi));

    const macdSignal: 'bullish' | 'bearish' | 'neutral' =
      momentum > 15 ? 'bullish' : momentum < -15 ? 'bearish' : 'neutral';

    const trend: 'uptrend' | 'downtrend' | 'sideways' =
      momentum > 10 && volumeGrowing ? 'uptrend' : momentum < -10 ? 'downtrend' : 'sideways';

    return {
      rsi,
      macdSignal,
      ema20: currentPrice,
      ema50: firstPrice,
      bollingerPosition: momentum > 20 ? 'upper' : momentum < -20 ? 'lower' : 'middle',
      trend,
    };
  }

  // ---- Shorter-period indicators for tokens with 14-49 candles ----
  private computeShortHistoryTechnicals(candles: OHLCVCandle[]): TokenAnalysis['technicals'] {
    const closes = candles.map((c) => c.close);
    const price = closes[closes.length - 1];

    // RSI with standard 14-period (we have at least 14 candles)
    const rsiValues = RSI.calculate({ values: closes, period: 14 });
    const rsi = rsiValues[rsiValues.length - 1] || 50;

    // Use shorter EMAs: 9 & 21 instead of 20 & 50
    const ema9Values = EMA.calculate({ values: closes, period: 9 });
    const ema21Values = EMA.calculate({ values: closes, period: 21 });
    const ema9 = ema9Values[ema9Values.length - 1] || price;
    const ema21 = ema21Values[ema21Values.length - 1] || price;

    // MACD if we have enough data (26+ candles)
    let macdSignal: 'bullish' | 'bearish' | 'neutral' = 'neutral';
    if (closes.length >= 26) {
      const macdResult = MACD.calculate({
        values: closes, fastPeriod: 12, slowPeriod: 26, signalPeriod: 9,
        SimpleMAOscillator: false, SimpleMASignal: false,
      });
      const lastMacd = macdResult[macdResult.length - 1];
      if (lastMacd && lastMacd.histogram !== undefined) {
        macdSignal = lastMacd.histogram > 0 ? 'bullish' : 'bearish';
      }
    } else {
      // Approximate from EMA cross
      macdSignal = ema9 > ema21 ? 'bullish' : ema9 < ema21 ? 'bearish' : 'neutral';
    }

    // Bollinger with period = min(20, candles available)
    const bbPeriod = Math.min(20, closes.length);
    let bollingerPosition: 'upper' | 'middle' | 'lower' = 'middle';
    if (closes.length >= bbPeriod) {
      const bbResult = BollingerBands.calculate({ values: closes, period: bbPeriod, stdDev: 2 });
      const lastBB = bbResult[bbResult.length - 1];
      if (lastBB) {
        if (price >= lastBB.upper) bollingerPosition = 'upper';
        else if (price <= lastBB.lower) bollingerPosition = 'lower';
      }
    }

    const trend: 'uptrend' | 'downtrend' | 'sideways' =
      ema9 > ema21 && price > ema9 ? 'uptrend' :
      ema9 < ema21 && price < ema9 ? 'downtrend' : 'sideways';

    return { rsi, macdSignal, ema20: ema9, ema50: ema21, bollingerPosition, trend };
  }

  // ---- Generate trading signal from analysis ----
  generateSignalFromAnalysis(analysis: TokenAnalysis): TokenSignal | null {
    const { technicals, symbol, chain, price, volumeChange } = analysis;
    let confidence = 0;
    let direction: 'LONG' | 'SHORT' = 'LONG';
    const reasons: string[] = [];

    // RSI signals
    if (technicals.rsi < 30) {
      confidence += 25;
      reasons.push(`RSI oversold (${technicals.rsi.toFixed(1)})`);
      direction = 'LONG';
    } else if (technicals.rsi > 70) {
      confidence += 25;
      reasons.push(`RSI overbought (${technicals.rsi.toFixed(1)})`);
      direction = 'SHORT';
    }

    // MACD
    if (technicals.macdSignal === 'bullish') {
      confidence += 20;
      reasons.push('MACD bullish crossover');
    } else if (technicals.macdSignal === 'bearish') {
      confidence += 20;
      reasons.push('MACD bearish crossover');
      if (!reasons.some((r) => r.includes('oversold'))) direction = 'SHORT';
    }

    // Trend alignment
    if (technicals.trend === 'uptrend' && direction === 'LONG') {
      confidence += 15;
      reasons.push('Aligned with uptrend');
    } else if (technicals.trend === 'downtrend' && direction === 'SHORT') {
      confidence += 15;
      reasons.push('Aligned with downtrend');
    }

    // Bollinger
    if (technicals.bollingerPosition === 'lower' && direction === 'LONG') {
      confidence += 10;
      reasons.push('At Bollinger lower band');
    } else if (technicals.bollingerPosition === 'upper' && direction === 'SHORT') {
      confidence += 10;
      reasons.push('At Bollinger upper band');
    }

    // Volume spike
    if (volumeChange > 200) {
      confidence += 15;
      reasons.push(`Volume spike +${volumeChange.toFixed(0)}%`);
    } else if (volumeChange > 100) {
      confidence += 10;
      reasons.push(`Volume increase +${volumeChange.toFixed(0)}%`);
    }

    // News/social boost
    if (analysis.newsScore > 70) {
      confidence += 10;
      reasons.push('Strong positive news');
    }
    if (analysis.socialScore > 70) {
      confidence += 10;
      reasons.push('High social buzz');
    }

    if (confidence < 30) return null;

    return {
      id: v4Fallback(),
      token: symbol,
      symbol,
      chain,
      direction,
      confidence: Math.min(confidence, 100),
      source: 'TECHNICAL',
      reason: reasons.join(' | '),
      price,
      timestamp: Date.now(),
    };
  }

  // ---- Full analysis for a token ----
  async analyseToken(symbol: string, chain: Chain, address?: string): Promise<TokenAnalysis | null> {
    try {
      // Get data from DexScreener
      const pairs = await this.searchTokens(symbol);
      const pair = pairs.find(
        (p: any) =>
          (chain === 'any' || p.chainId === chain) &&
          (p.baseToken?.symbol?.toUpperCase() === symbol.toUpperCase() ||
            (address && p.baseToken?.address === address))
      );

      if (!pair) {
        logger.warn(`No pair found for ${symbol} on ${chain}`);
        return null;
      }

      const price = parseFloat(pair.priceUsd || '0');
      const volume24h = pair.volume?.h24 || 0;
      const priceChange24h = pair.priceChange?.h24 || 0;
      const liquidity = pair.liquidity?.usd || 0;
      const marketCap = pair.marketCap || pair.fdv || 0;

      // Get OHLCV for technicals
      // Solana: via Birdeye | Other chains: synthesize from DexScreener pair data
      let candles: OHLCVCandle[] = [];
      if (chain === 'solana' && pair.baseToken?.address) {
        candles = await this.getSolanaTokenOHLCV(pair.baseToken.address);
      }

      // Fallback: build candles from DexScreener price history data points
      if (candles.length === 0 && pair.priceUsd) {
        candles = this.synthesizeCandlesFromPair(pair);
      }

      const technicals = this.computeTechnicals(candles);

      // ---- Enrich with news & social sentiment ----
      let socialScore = 0;
      let newsScore = 0;
      if (this.newsEngine) {
        try {
          const lunarData = await this.newsEngine.fetchLunarCrushData(symbol);
          socialScore = lunarData.socialScore;
          newsScore = lunarData.newsScore;

          // Also check cached news for this token
          const cachedNews = this.newsEngine.getCachedNews();
          const tokenNews = cachedNews.filter((n) =>
            n.relevantTokens.some((t) => t.toUpperCase() === symbol.toUpperCase())
          );
          if (tokenNews.length > 0) {
            const positiveCount = tokenNews.filter((n) => n.sentiment === 'positive').length;
            const negativeCount = tokenNews.filter((n) => n.sentiment === 'negative').length;
            const newsImpact = (positiveCount - negativeCount) / tokenNews.length;
            // Blend LunarCrush score with CryptoPanic data
            newsScore = Math.max(newsScore, Math.min(50 + newsImpact * 50, 100));
          }
        } catch (err: any) {
          logger.warn(`Social/news enrichment failed for ${symbol}: ${err.message}`);
        }
      }

      // Determine if this is a "new" token (low market cap, limited history)
      const isNewToken = candles.length < 50 || marketCap < 10_000_000;

      const analysis: TokenAnalysis = {
        symbol,
        chain: (pair.chainId as Chain) || chain,
        price,
        priceChange24h,
        volume24h,
        volumeChange: pair.volume?.h24Change || 0,
        marketCap,
        liquidity,
        technicals,
        socialScore,
        newsScore,
        overallScore: 0,
      };

      // ---- Compute overall score (weighted by token maturity) ----
      let score = 50;

      // Price action
      if (priceChange24h > 10) score += 10;
      if (priceChange24h > 30) score += 10;

      // Volume
      if (volume24h > 1_000_000) score += 10;
      else if (isNewToken && volume24h > 100_000) score += 8;

      // Liquidity
      if (liquidity > 500_000) score += 5;
      else if (isNewToken && liquidity > 50_000) score += 3;

      // Technicals
      if (technicals.trend === 'uptrend') score += 10;
      if (technicals.rsi < 30 || technicals.rsi > 70) score += 5;
      if (technicals.macdSignal === 'bullish') score += 10;

      // News sentiment (critical for futures decisions)
      if (newsScore > 70) score += 15;
      else if (newsScore > 50) score += 8;
      else if (newsScore < 20 && newsScore > 0) score -= 10;

      // Social momentum
      if (socialScore > 70) score += 10;
      else if (socialScore > 50) score += 5;

      // New token bonus: for tokens that are pumping with news + volume,
      // even without long technicals history, boost score
      if (isNewToken && priceChange24h > 20 && volume24h > 200_000 && newsScore > 50) {
        score += 15;
      }

      analysis.overallScore = Math.max(0, Math.min(score, 100));

      return analysis;
    } catch (err: any) {
      logger.error(`Token analysis failed for ${symbol}: ${err.message}`);
      return null;
    }
  }

  // ---- Scan all watchlist tokens ----
  async scanWatchlist(): Promise<{ analyses: TokenAnalysis[]; signals: TokenSignal[] }> {
    const analyses: TokenAnalysis[] = [];
    const signals: TokenSignal[] = [];

    for (const [, item] of this.watchlist) {
      const analysis = await this.analyseToken(item.symbol, item.chain, item.address);
      if (analysis) {
        analyses.push(analysis);
        const signal = this.generateSignalFromAnalysis(analysis);
        if (signal) signals.push(signal);
      }
    }

    return { analyses, signals };
  }

  // ---- Scan DexScreener for trending tokens with potential ----
  async scanTrending(): Promise<TokenSignal[]> {
    const signals: TokenSignal[] = [];
    try {
      const trending = await this.getTrendingTokens();
      const topTrending = trending.slice(0, 20);

      // Track symbols already seen to avoid duplicates
      const seenSymbols = new Set<string>();

      for (const token of topTrending) {
        if (!token.tokenAddress) continue;
        const pairs = await this.getTokenPairs(token.tokenAddress);
        const topPair = pairs[0];
        if (!topPair) continue;

        const symbol = topPair.baseToken?.symbol || '???';
        const volume24h = topPair.volume?.h24 || 0;
        const priceChange = topPair.priceChange?.h24 || 0;
        const liquidity = topPair.liquidity?.usd || 0;

        // Skip duplicate symbols (e.g., ASTROID and ASTEROID)
        const symKey = symbol.toUpperCase().replace(/[^A-Z]/g, '');
        if (seenSymbols.has(symKey)) continue;

        // Filter: needs real liquidity and volume (stricter minimums)
        if (liquidity < 100000 || volume24h < 200000) continue;

        // Filter out obvious junk/scam/duplicate token names
        const symLower = symbol.toLowerCase();
        if (symLower.length > 12) continue; // Very long names are often scams
        if (/test|scam|fake|rug|honeypot|airdrop/i.test(symbol)) continue;

        seenSymbols.add(symKey);

        let confidence = 30;
        const reasons: string[] = ['Trending on DexScreener'];

        if (priceChange > 20) { confidence += 15; reasons.push(`+${priceChange.toFixed(1)}% 24h`); }
        if (volume24h > 1_000_000) { confidence += 15; reasons.push('High volume >$1M'); }
        if (priceChange > 50) { confidence += 10; reasons.push('Massive pump'); }
        if (liquidity > 500000) { confidence += 5; reasons.push('Strong liquidity'); }

        if (confidence >= 40) {
          signals.push({
            id: v4Fallback(),
            token: topPair.baseToken?.name || 'Unknown',
            symbol,
            chain: (topPair.chainId as Chain) || 'any',
            direction: 'LONG',
            confidence: Math.min(confidence, 100),
            source: 'VOLUME',
            reason: reasons.join(' | '),
            price: parseFloat(topPair.priceUsd || '0'),
            timestamp: Date.now(),
            metadata: { pairAddress: topPair.pairAddress, tokenAddress: token.tokenAddress },
          });
        }
      }
    } catch (err: any) {
      logger.error(`Trending scan failed: ${err.message}`);
    }

    return signals;
  }
}
