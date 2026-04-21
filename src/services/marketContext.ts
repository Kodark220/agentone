import axios from 'axios';
import { logger } from '../utils/logger';
import { PerpsTrader } from './perpsTrader';

export type MarketMode = 'RISK_ON' | 'RISK_OFF';
export type TrendState = 'bullish' | 'bearish' | 'neutral';
export type DominanceTrend = 'rising' | 'falling' | 'flat';
export type VolatilityState = 'normal' | 'elevated' | 'extreme';

export interface MarketContext {
  btcPrice: number;
  btcChange24h: number;
  btcTrend: TrendState;
  btcDominance: number;
  btcDominanceTrend: DominanceTrend;
  usdtDominance: number;
  cyclePhase: string;
  sectorRotation: string;
  marketMode: MarketMode;
  volatilityState: VolatilityState;
  riskScore: number;
  futuresBias: {
    longCount: number;
    shortCount: number;
    avgConfidence: number;
  };
  tokenFlow: {
    totalNetFlow: number;
    accumulating: number;
    distributing: number;
    pumpCandidates: number;
    highRiskTokens: number;
  };
  futuresSafety: {
    highRiskSetups: number;
    blockedSetups: number;
  };
  warnings: string[];
  lastUpdated: number;
}

export class MarketContextCoordinator {
  private context: MarketContext = {
    btcPrice: 0,
    btcChange24h: 0,
    btcTrend: 'neutral',
    btcDominance: 0,
    btcDominanceTrend: 'flat',
    usdtDominance: 0,
    cyclePhase: 'Neutral',
    sectorRotation: 'Rotating / Unclear',
    marketMode: 'RISK_OFF',
    volatilityState: 'normal',
    riskScore: 50,
    futuresBias: { longCount: 0, shortCount: 0, avgConfidence: 0 },
    tokenFlow: { totalNetFlow: 0, accumulating: 0, distributing: 0, pumpCandidates: 0, highRiskTokens: 0 },
    futuresSafety: { highRiskSetups: 0, blockedSetups: 0 },
    warnings: [],
    lastUpdated: 0,
  };

  private previousDominance = 0;

  async refresh(perpsTrader: PerpsTrader): Promise<MarketContext> {
    const [btcData, globalData] = await Promise.all([
      this.fetchBTCData(),
      this.fetchGlobalData(),
    ]);

    const setups = perpsTrader.getFuturesSetups();
    const longCount = setups.filter(s => s.direction === 'LONG').length;
    const shortCount = setups.filter(s => s.direction === 'SHORT').length;
    const avgConfidence = setups.length > 0
      ? setups.reduce((sum, s) => sum + (s.confidence || 0), 0) / setups.length
      : 0;

    const flow = { totalNetFlow: 0, accumulating: 0, distributing: 0 };
    const pumpCandidates = 0;
    const highRiskTokens = 0;
    const highRiskSetups = setups.filter(s => s.safety?.level === 'high').length;
    const blockedSetups = setups.filter(s => s.safety?.blocked).length;

    const btcTrend: TrendState = btcData.change24h > 1.5
      ? 'bullish'
      : btcData.change24h < -1.5
        ? 'bearish'
        : 'neutral';

    const btcDominanceTrend: DominanceTrend = this.previousDominance === 0
      ? 'flat'
      : globalData.btcDominance - this.previousDominance > 0.2
        ? 'rising'
        : globalData.btcDominance - this.previousDominance < -0.2
          ? 'falling'
          : 'flat';

    this.previousDominance = globalData.btcDominance;

    const volatilityState: VolatilityState = Math.abs(btcData.change24h) >= 8
      ? 'extreme'
      : Math.abs(btcData.change24h) >= 4
        ? 'elevated'
        : 'normal';

    let riskScore = 50;

    if (btcTrend === 'bullish') riskScore += 10;
    if (btcTrend === 'bearish') riskScore -= 10;

    if (btcDominanceTrend === 'falling') riskScore += 8;
    if (btcDominanceTrend === 'rising') riskScore -= 8;

    if ((flow.totalNetFlow || 0) > 0) riskScore += 8;
    if ((flow.totalNetFlow || 0) < 0) riskScore -= 8;

    if (longCount > shortCount) riskScore += 6;
    if (shortCount > longCount) riskScore -= 6;

    if (volatilityState === 'elevated') riskScore -= 5;
    if (volatilityState === 'extreme') riskScore -= 12;

    if (avgConfidence >= 70) riskScore += 4;
    if (avgConfidence <= 45 && setups.length > 0) riskScore -= 4;
    if (highRiskTokens > Math.max(3, pumpCandidates)) riskScore -= 6;
    if (highRiskSetups > Math.max(2, Math.floor(setups.length * 0.25))) riskScore -= 5;

    riskScore = Math.max(0, Math.min(100, riskScore));
    const marketMode: MarketMode = riskScore >= 55 ? 'RISK_ON' : 'RISK_OFF';

    const warnings: string[] = [];
    if (volatilityState === 'extreme') warnings.push('Extreme BTC volatility detected');
    if ((flow.distributing || 0) > (flow.accumulating || 0)) warnings.push('Token flow shows broad distribution');
    if (btcTrend === 'bearish' && shortCount > longCount) warnings.push('Bearish structure dominates futures setups');
    if (highRiskTokens > Math.max(3, pumpCandidates)) warnings.push('Elevated rug/fake-volume risk in token flow');
    if (blockedSetups > 0) warnings.push(`${blockedSetups} futures setups blocked by safety guard`);

    // Push shared risk mode into the futures engine.
    perpsTrader.setMarketMode(marketMode);

    const cyclePhase = this.computeCyclePhase(btcTrend, btcDominanceTrend, globalData.usdtDominance, riskScore);
    const sectorRotation = this.computeSectorRotation(btcDominanceTrend, btcTrend);

    this.context = {
      btcPrice: btcData.price,
      btcChange24h: btcData.change24h,
      btcTrend,
      btcDominance: globalData.btcDominance,
      btcDominanceTrend,
      usdtDominance: globalData.usdtDominance,
      cyclePhase,
      sectorRotation,
      marketMode,
      volatilityState,
      riskScore,
      futuresBias: { longCount, shortCount, avgConfidence: Number(avgConfidence.toFixed(1)) },
      tokenFlow: {
        totalNetFlow: flow.totalNetFlow || 0,
        accumulating: flow.accumulating || 0,
        distributing: flow.distributing || 0,
        pumpCandidates,
        highRiskTokens,
      },
      futuresSafety: {
        highRiskSetups,
        blockedSetups,
      },
      warnings,
      lastUpdated: Date.now(),
    };

    return this.context;
  }

  getContext(): MarketContext {
    return this.context;
  }

  private async fetchBTCData(): Promise<{ price: number; change24h: number }> {
    try {
      const resp = await axios.get('https://api.coingecko.com/api/v3/simple/price', {
        params: {
          ids: 'bitcoin',
          vs_currencies: 'usd',
          include_24hr_change: true,
        },
        timeout: 10000,
      });
      const btc = resp.data?.bitcoin;
      return {
        price: Number(btc?.usd || 0),
        change24h: Number(btc?.usd_24h_change || 0),
      };
    } catch (err: any) {
      logger.debug(`[MARKET_CONTEXT] BTC data fetch failed: ${err.message}`);
      return {
        price: this.context.btcPrice || 0,
        change24h: this.context.btcChange24h || 0,
      };
    }
  }

  private computeCyclePhase(trend: TrendState, domTrend: DominanceTrend, usdtDom: number, riskScore: number): string {
    if (trend === 'bearish' && riskScore < 40) return 'Bear / Risk Off';
    if (trend === 'bullish' && domTrend === 'rising') return 'BTC Season';
    if (trend === 'bullish' && domTrend === 'falling') return 'Alt Season';
    if (trend === 'bullish') return 'Early Bull / Accumulation';
    if (usdtDom > 6) return 'Stablecoin Accumulation';
    if (riskScore >= 55) return 'Neutral / Cautious Bull';
    return 'Ranging / Neutral';
  }

  private computeSectorRotation(domTrend: DominanceTrend, trend: TrendState): string {
    if (trend === 'bearish') return 'Risk Off → Stables';
    if (domTrend === 'rising') return 'Alts → BTC';
    if (domTrend === 'falling') return 'BTC → L1s → Memes';
    return 'BTC / ETH Consolidation';
  }

  private async fetchGlobalData(): Promise<{ btcDominance: number; usdtDominance: number }> {
    try {
      const resp = await axios.get('https://api.coingecko.com/api/v3/global', { timeout: 10000 });
      return {
        btcDominance: Number(resp.data?.data?.market_cap_percentage?.btc || 0),
        usdtDominance: Number(resp.data?.data?.market_cap_percentage?.usdt || 0),
      };
    } catch (err: any) {
      logger.debug(`[MARKET_CONTEXT] Global data fetch failed: ${err.message}`);
      return {
        btcDominance: this.context.btcDominance || 0,
        usdtDominance: this.context.usdtDominance || 0,
      };
    }
  }
}
