// ============================================
// SOL TRENCHES SERVICE
// Tracks Solana memecoin "trenches" — new & old tokens
// Discovers pumps, rugs, and hidden gems
// ============================================

import axios from 'axios';
import { logger } from '../utils/logger';
import { v4Fallback } from '../utils/id';

const DEXSCREENER_BASE = 'https://api.dexscreener.com/latest';

export interface FundFlow {
  netFlow: number;            // positive = inflow, negative = outflow
  buyVolume: number;          // total buy volume in USD
  sellVolume: number;         // total sell volume in USD
  buyPressure: number;        // buy % of total volume (0-100)
  largeOrders: number;        // number of large orders (whale activity)
  flowTrend: 'accumulating' | 'distributing' | 'neutral';
  pumpScore: number;          // 0-100 score predicting pump potential
  pumpReasons: string[];
}

export interface TrenchToken {
  id: string;
  symbol: string;
  name: string;
  address: string;
  pairAddress: string;
  price: number;
  priceChange5m: number;
  priceChange1h: number;
  priceChange6h: number;
  priceChange24h: number;
  volume24h: number;
  liquidity: number;
  marketCap: number;
  txns24h: { buys: number; sells: number };
  txns1h: { buys: number; sells: number };
  txns5m: { buys: number; sells: number };
  pairCreatedAt: number;
  ageLabel: 'NEW' | 'RECENT' | 'ESTABLISHED';
  ageHours: number;
  dexId: string;
  url: string;
  lastUpdated: number;
  fundFlow: FundFlow;
  priceHistory: { price: number; ts: number }[];
}

export class SolTrenchesService {
  private trackedTokens: Map<string, TrenchToken> = new Map();
  private scanHistory: Map<string, number> = new Map(); // address -> last scan ts
  private priceSnapshots: Map<string, { price: number; ts: number }[]> = new Map();

  // ---- Calculate fund flow from DexScreener pair data ----
  private calculateFundFlow(pair: any): FundFlow {
    const buys24h = pair.txns?.h24?.buys || 0;
    const sells24h = pair.txns?.h24?.sells || 0;
    const buys1h = pair.txns?.h1?.buys || 0;
    const sells1h = pair.txns?.h1?.sells || 0;
    const buys5m = pair.txns?.m5?.buys || 0;
    const sells5m = pair.txns?.m5?.sells || 0;
    const volume24h = pair.volume?.h24 || 0;
    const volume1h = pair.volume?.h1 || 0;
    const volume5m = pair.volume?.m5 || 0;
    const liquidity = pair.liquidity?.usd || 0;

    const totalTxns = buys24h + sells24h;
    const buyPressure = totalTxns > 0 ? (buys24h / totalTxns) * 100 : 50;

    // Estimate buy/sell volume based on txn ratio
    const buyVolume = volume24h * (buyPressure / 100);
    const sellVolume = volume24h * (1 - buyPressure / 100);
    const netFlow = buyVolume - sellVolume;

    // Detect large orders: if recent 5m volume is spike vs 1h average
    const avg5mVol = volume1h / 12; // 12 five-min periods in 1h
    const largeOrders = volume5m > avg5mVol * 3 ? Math.ceil(volume5m / (avg5mVol || 1)) : 0;

    // Determine flow trend
    let flowTrend: 'accumulating' | 'distributing' | 'neutral' = 'neutral';
    if (buyPressure > 60 && buys1h > sells1h * 1.3) flowTrend = 'accumulating';
    else if (buyPressure < 40 && sells1h > buys1h * 1.3) flowTrend = 'distributing';

    // Calculate pump score (0-100)
    let pumpScore = 0;
    const pumpReasons: string[] = [];

    // 1. Strong buy pressure (max 25 pts)
    if (buyPressure > 70) { pumpScore += 25; pumpReasons.push(`Strong buy pressure ${buyPressure.toFixed(0)}%`); }
    else if (buyPressure > 60) { pumpScore += 15; pumpReasons.push(`Buy pressure ${buyPressure.toFixed(0)}%`); }

    // 2. Volume spike relative to liquidity (max 25 pts)
    const volLiqRatio = liquidity > 0 ? volume24h / liquidity : 0;
    if (volLiqRatio > 5) { pumpScore += 25; pumpReasons.push(`Extreme vol/liq ratio ${volLiqRatio.toFixed(1)}x`); }
    else if (volLiqRatio > 2) { pumpScore += 15; pumpReasons.push(`High vol/liq ratio ${volLiqRatio.toFixed(1)}x`); }
    else if (volLiqRatio > 1) { pumpScore += 8; pumpReasons.push(`Active trading ${volLiqRatio.toFixed(1)}x vol/liq`); }

    // 3. Acceleration: 5m activity vs average (max 20 pts)
    const recentBuyAccel = buys5m > 0 && buys1h > 0 ? (buys5m / (buys1h / 12)) : 0;
    if (recentBuyAccel > 3) { pumpScore += 20; pumpReasons.push(`Buy acceleration ${recentBuyAccel.toFixed(1)}x`); }
    else if (recentBuyAccel > 1.5) { pumpScore += 10; pumpReasons.push(`Rising buy activity`); }

    // 4. Large orders detected (max 15 pts)
    if (largeOrders > 3) { pumpScore += 15; pumpReasons.push(`${largeOrders} whale-size orders`); }
    else if (largeOrders > 0) { pumpScore += 8; pumpReasons.push(`${largeOrders} large order(s)`); }

    // 5. Price momentum alignment (max 15 pts)
    const priceChange5m = pair.priceChange?.m5 || 0;
    const priceChange1h = pair.priceChange?.h1 || 0;
    if (priceChange5m > 5 && priceChange1h > 10) { pumpScore += 15; pumpReasons.push(`Strong momentum +${priceChange5m.toFixed(0)}% 5m`); }
    else if (priceChange5m > 2 && priceChange1h > 0) { pumpScore += 8; pumpReasons.push(`Positive momentum`); }

    return {
      netFlow, buyVolume, sellVolume, buyPressure, largeOrders, flowTrend,
      pumpScore: Math.min(pumpScore, 100),
      pumpReasons,
    };
  }

  // ---- Scan Solana trenches for new/trending tokens ----
  async scanTrenches(): Promise<TrenchToken[]> {
    const tokens: TrenchToken[] = [];

    try {
      // 1. Get trending/boosted tokens on Solana
      const boostResp = await axios.get('https://api.dexscreener.com/token-boosts/latest/v1', {
        timeout: 10000,
      });
      const boosted = (boostResp.data || []).filter(
        (t: any) => t.chainId === 'solana' && t.tokenAddress
      );

      // 2. Process top boosted tokens
      for (const token of boosted.slice(0, 30)) {
        try {
          const pairs = await this.getTokenPairs(token.tokenAddress);
          const topPair = pairs[0];
          if (!topPair || !topPair.baseToken) continue;

          const trenchToken = this.pairToTrenchToken(topPair, token.tokenAddress);
          if (trenchToken) {
            tokens.push(trenchToken);
            this.trackedTokens.set(trenchToken.address, trenchToken);
          }
        } catch { /* skip individual failures */ }
      }

      // 3. Also search for known Solana meme categories
      const memeQueries = ['pump', 'sol', 'bonk', 'dog', 'cat', 'pepe', 'degen'];
      for (const query of memeQueries.slice(0, 3)) {
        try {
          const searchResp = await axios.get(`${DEXSCREENER_BASE}/dex/search`, {
            params: { q: query },
            timeout: 10000,
          });
          const solPairs = (searchResp.data?.pairs || []).filter(
            (p: any) => p.chainId === 'solana' && parseFloat(p.priceUsd || '0') > 0
          );

          for (const pair of solPairs.slice(0, 5)) {
            const trenchToken = this.pairToTrenchToken(pair, pair.baseToken?.address);
            if (trenchToken && !this.trackedTokens.has(trenchToken.address)) {
              tokens.push(trenchToken);
              this.trackedTokens.set(trenchToken.address, trenchToken);
            }
          }
        } catch { /* skip */ }
      }
    } catch (err: any) {
      logger.error(`Sol trenches scan failed: ${err.message}`);
    }

    // Update age labels and sort
    tokens.sort((a, b) => b.volume24h - a.volume24h);
    logger.info(`Sol trenches: found ${tokens.length} tokens`);
    return tokens;
  }

  // ---- Refresh prices for all tracked tokens ----
  async refreshTracked(): Promise<TrenchToken[]> {
    const updated: TrenchToken[] = [];

    for (const [address, token] of this.trackedTokens) {
      // Don't refresh more than once per 30s
      const lastScan = this.scanHistory.get(address) || 0;
      if (Date.now() - lastScan < 30000) {
        updated.push(token);
        continue;
      }

      try {
        const pairs = await this.getTokenPairs(address);
        const topPair = pairs[0];
        if (topPair) {
          const refreshed = this.pairToTrenchToken(topPair, address);
          if (refreshed) {
            this.trackedTokens.set(address, refreshed);
            updated.push(refreshed);
            this.scanHistory.set(address, Date.now());
          }
        }
      } catch { /* keep existing data */ }
    }

    return updated;
  }

  // ---- Convert DexScreener pair to TrenchToken ----
  private pairToTrenchToken(pair: any, tokenAddress: string): TrenchToken | null {
    if (!pair.baseToken) return null;

    const price = parseFloat(pair.priceUsd || '0');
    if (price <= 0) return null;

    const pairCreatedAt = pair.pairCreatedAt || 0;
    const ageMs = Date.now() - pairCreatedAt;
    const ageHours = ageMs / (1000 * 60 * 60);

    let ageLabel: 'NEW' | 'RECENT' | 'ESTABLISHED';
    if (ageHours < 24) ageLabel = 'NEW';
    else if (ageHours < 168) ageLabel = 'RECENT';  // < 7 days
    else ageLabel = 'ESTABLISHED';

    // Calculate fund flow
    const fundFlow = this.calculateFundFlow(pair);

    // Track price history
    const addr = tokenAddress || pair.baseToken.address || '';
    const history = this.priceSnapshots.get(addr) || [];
    history.push({ price, ts: Date.now() });
    // Keep last 60 snapshots (= ~5h at 5min intervals)
    if (history.length > 60) history.splice(0, history.length - 60);
    this.priceSnapshots.set(addr, history);

    return {
      id: v4Fallback(),
      symbol: pair.baseToken.symbol || '???',
      name: pair.baseToken.name || pair.baseToken.symbol || 'Unknown',
      address: addr,
      pairAddress: pair.pairAddress || '',
      price,
      priceChange5m: pair.priceChange?.m5 || 0,
      priceChange1h: pair.priceChange?.h1 || 0,
      priceChange6h: pair.priceChange?.h6 || 0,
      priceChange24h: pair.priceChange?.h24 || 0,
      volume24h: pair.volume?.h24 || 0,
      liquidity: pair.liquidity?.usd || 0,
      marketCap: pair.marketCap || pair.fdv || 0,
      txns24h: {
        buys: pair.txns?.h24?.buys || 0,
        sells: pair.txns?.h24?.sells || 0,
      },
      txns1h: {
        buys: pair.txns?.h1?.buys || 0,
        sells: pair.txns?.h1?.sells || 0,
      },
      txns5m: {
        buys: pair.txns?.m5?.buys || 0,
        sells: pair.txns?.m5?.sells || 0,
      },
      pairCreatedAt,
      ageLabel,
      ageHours,
      dexId: pair.dexId || 'unknown',
      url: pair.url || `https://dexscreener.com/solana/${pair.pairAddress}`,
      lastUpdated: Date.now(),
      fundFlow,
      priceHistory: history.slice(-20), // send last 20 snapshots to frontend
    };
  }

  // ---- Add a token to track manually ----
  async trackToken(addressOrSymbol: string): Promise<TrenchToken | null> {
    // Try by address first
    let pairs = await this.getTokenPairs(addressOrSymbol);
    if (pairs.length === 0) {
      // Search by symbol
      try {
        const resp = await axios.get(`${DEXSCREENER_BASE}/dex/search`, {
          params: { q: addressOrSymbol },
          timeout: 10000,
        });
        pairs = (resp.data?.pairs || []).filter((p: any) => p.chainId === 'solana');
      } catch { return null; }
    }

    const topPair = pairs[0];
    if (!topPair) return null;

    const token = this.pairToTrenchToken(topPair, topPair.baseToken?.address || addressOrSymbol);
    if (token) {
      this.trackedTokens.set(token.address, token);
      this.scanHistory.set(token.address, Date.now());
    }
    return token;
  }

  // ---- Remove a tracked token ----
  removeToken(address: string) {
    this.trackedTokens.delete(address);
    this.scanHistory.delete(address);
  }

  // ---- Get all tracked tokens ----
  getTrackedTokens(): TrenchToken[] {
    return Array.from(this.trackedTokens.values());
  }

  // ---- Get tokens by age ----
  getNewTokens(): TrenchToken[] {
    return this.getTrackedTokens().filter(t => t.ageLabel === 'NEW');
  }

  getRecentTokens(): TrenchToken[] {
    return this.getTrackedTokens().filter(t => t.ageLabel === 'RECENT');
  }

  getEstablishedTokens(): TrenchToken[] {
    return this.getTrackedTokens().filter(t => t.ageLabel === 'ESTABLISHED');
  }

  // ---- Get tokens sorted by pump potential ----
  getPumpCandidates(): TrenchToken[] {
    return this.getTrackedTokens()
      .filter(t => t.fundFlow.pumpScore > 20)
      .sort((a, b) => b.fundFlow.pumpScore - a.fundFlow.pumpScore);
  }

  // ---- Get fund flow summary across all tracked tokens ----
  getFundFlowSummary(): {
    totalNetFlow: number;
    accumulating: number;
    distributing: number;
    neutral: number;
    topPumps: { symbol: string; pumpScore: number; flowTrend: string }[];
  } {
    const tokens = this.getTrackedTokens();
    let totalNetFlow = 0;
    let accumulating = 0;
    let distributing = 0;
    let neutral = 0;

    for (const t of tokens) {
      totalNetFlow += t.fundFlow.netFlow;
      if (t.fundFlow.flowTrend === 'accumulating') accumulating++;
      else if (t.fundFlow.flowTrend === 'distributing') distributing++;
      else neutral++;
    }

    const topPumps = tokens
      .filter(t => t.fundFlow.pumpScore > 30)
      .sort((a, b) => b.fundFlow.pumpScore - a.fundFlow.pumpScore)
      .slice(0, 10)
      .map(t => ({ symbol: t.symbol, pumpScore: t.fundFlow.pumpScore, flowTrend: t.fundFlow.flowTrend }));

    return { totalNetFlow, accumulating, distributing, neutral, topPumps };
  }

  // ---- Helper: get token pairs from DexScreener ----
  private async getTokenPairs(tokenAddress: string): Promise<any[]> {
    try {
      const resp = await axios.get(`${DEXSCREENER_BASE}/dex/tokens/${tokenAddress}`, {
        timeout: 10000,
      });
      return (resp.data?.pairs || []).filter((p: any) => p.chainId === 'solana');
    } catch {
      return [];
    }
  }
}
