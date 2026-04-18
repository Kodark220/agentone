// ============================================
// SIGNAL AGGREGATOR
// Combines signals from all sources, scores them,
// and decides whether to execute trades
// ============================================

import { config } from '../config';
import { logger } from '../utils/logger';
import { TokenSignal, AggregatedSignal, Chain } from '../types';
import { TokenAnalyser } from './tokenAnalyser';
import { NewsSentimentEngine } from './newsSentiment';
import { SolanaWalletTracker } from './walletTracker';
import { PerpsTrader } from './perpsTrader';
import { v4Fallback } from '../utils/id';

// Weight for each signal source
const SOURCE_WEIGHTS: Record<string, number> = {
  TECHNICAL: 1.2,
  NEWS: 1.0,
  WALLET: 1.3,
  VOLUME: 0.8,
  SOCIAL: 0.7,
};

export class SignalAggregator {
  private tokenAnalyser: TokenAnalyser;
  private newsEngine: NewsSentimentEngine;
  private walletTracker: SolanaWalletTracker;
  private perpsTrader: PerpsTrader;
  private recentSignals: TokenSignal[] = [];
  private aggregatedSignals: AggregatedSignal[] = [];
  private autoTradeEnabled = false;

  constructor(
    tokenAnalyser: TokenAnalyser,
    newsEngine: NewsSentimentEngine,
    walletTracker: SolanaWalletTracker,
    perpsTrader: PerpsTrader
  ) {
    this.tokenAnalyser = tokenAnalyser;
    this.newsEngine = newsEngine;
    this.walletTracker = walletTracker;
    this.perpsTrader = perpsTrader;
  }

  setAutoTrade(enabled: boolean) {
    this.autoTradeEnabled = enabled;
    logger.info(`Auto-trade ${enabled ? 'ENABLED' : 'DISABLED'}`);
  }

  isAutoTradeEnabled(): boolean {
    return this.autoTradeEnabled;
  }

  // ---- Collect signals from all sources ----
  // Performs cross-enrichment: news data feeds into technicals and vice versa
  async collectAllSignals(): Promise<TokenSignal[]> {
    const allSignals: TokenSignal[] = [];

    logger.info('Collecting signals from all sources...');

    // 0. Pre-fetch news so it's available for token analysis enrichment
    try {
      const watchlistSymbols = this.tokenAnalyser.getWatchlist().map((t) => t.symbol);
      await this.newsEngine.scanForSignals(
        watchlistSymbols.length > 0 ? watchlistSymbols : undefined
      );
      logger.info('News cache refreshed for cross-enrichment');
    } catch (err: any) {
      logger.error(`News pre-fetch failed: ${err.message}`);
    }

    // 1. Technical analysis from watchlist (now includes news/social data)
    try {
      const { signals: techSignals } = await this.tokenAnalyser.scanWatchlist();
      allSignals.push(...techSignals);
      logger.info(`Technical signals: ${techSignals.length}`);
    } catch (err: any) {
      logger.error(`Technical scan failed: ${err.message}`);
    }

    // 2. Trending tokens scan
    try {
      const trendingSignals = await this.tokenAnalyser.scanTrending();
      allSignals.push(...trendingSignals);
      logger.info(`Trending signals: ${trendingSignals.length}`);
    } catch (err: any) {
      logger.error(`Trending scan failed: ${err.message}`);
    }

    // 3. News-only signals (tokens not in watchlist that have strong news)
    try {
      const newsSignals = await this.newsEngine.scanForSignals();
      // For news signals, try to enrich with price data
      for (const signal of newsSignals) {
        if (signal.price === 0) {
          try {
            const pairs = await this.tokenAnalyser.searchTokens(signal.symbol);
            if (pairs.length > 0) {
              signal.price = parseFloat(pairs[0].priceUsd || '0');
            }
          } catch { /* skip price enrichment */ }
        }
      }
      allSignals.push(...newsSignals);
      logger.info(`News signals: ${newsSignals.length}`);
    } catch (err: any) {
      logger.error(`News scan failed: ${err.message}`);
    }

    // 4. Wallet tracking (Solana)
    try {
      const walletSignals = await this.walletTracker.detectAccumulationSignals();
      allSignals.push(...walletSignals);
      logger.info(`Wallet signals: ${walletSignals.length}`);
    } catch (err: any) {
      logger.error(`Wallet scan failed: ${err.message}`);
    }

    // Store recent signals
    this.recentSignals = allSignals;
    return allSignals;
  }

  // ---- Aggregate signals for the same token ----
  // Requires both TECHNICAL and NEWS/WALLET/VOLUME confirmation for trades
  aggregateSignals(signals: TokenSignal[]): AggregatedSignal[] {
    const grouped: Map<string, TokenSignal[]> = new Map();

    for (const signal of signals) {
      const key = `${signal.symbol}:${signal.direction}`;
      const existing = grouped.get(key) || [];
      existing.push(signal);
      grouped.set(key, existing);
    }

    const aggregated: AggregatedSignal[] = [];

    for (const [, group] of grouped) {
      // Calculate weighted confidence
      let totalWeight = 0;
      let weightedConfidence = 0;

      for (const signal of group) {
        const weight = SOURCE_WEIGHTS[signal.source] || 1.0;
        weightedConfidence += signal.confidence * weight;
        totalWeight += weight;
      }

      const avgConfidence = totalWeight > 0 ? weightedConfidence / totalWeight : 0;

      // Identify which source types are present
      const sourceTypes = new Set(group.map((s) => s.source));
      const hasTechnical = sourceTypes.has('TECHNICAL') || sourceTypes.has('VOLUME');
      const hasFundamental = sourceTypes.has('NEWS') || sourceTypes.has('WALLET') || sourceTypes.has('SOCIAL');

      // ---- Multi-source confirmation logic ----
      // For perps trading, we want at LEAST technicals + one fundamental signal
      // (news, wallet tracking, or social) to agree on direction.
      // Single-source signals get a confidence penalty.
      let multiSourceBonus = 0;
      let singleSourcePenalty = 0;

      if (hasTechnical && hasFundamental) {
        // Best case: technicals confirmed by news/wallet data
        multiSourceBonus = sourceTypes.size * 8;
        logger.info(`[AGG] ${group[0].symbol} ${group[0].direction}: CONFIRMED by ${Array.from(sourceTypes).join('+')}`);
      } else if (sourceTypes.size >= 2) {
        // Two sources of same category (e.g., TECHNICAL + VOLUME)
        multiSourceBonus = 5;
      } else {
        // Single source only — reduce confidence for trading safety
        singleSourcePenalty = 15;
        logger.info(`[AGG] ${group[0].symbol} ${group[0].direction}: single-source (${Array.from(sourceTypes)[0]}), penalty applied`);
      }

      const totalConfidence = Math.min(
        Math.max(avgConfidence + multiSourceBonus - singleSourcePenalty, 0),
        100
      );

      const bestPrice = group.find((s) => s.price > 0)?.price || 0;
      const direction = group[0].direction;

      // Calculate SL/TP — tighter for single-source, wider for confirmed signals
      const slPct = config.trading.stopLossPct / 100;
      const tpPct = config.trading.takeProfitPct / 100;
      const slAdjust = hasTechnical && hasFundamental ? 1.0 : 0.7; // tighter SL if unconfirmed
      const tpAdjust = hasTechnical && hasFundamental ? 1.2 : 1.0; // wider TP if confirmed

      const suggestedSL = direction === 'LONG'
        ? bestPrice * (1 - slPct * slAdjust)
        : bestPrice * (1 + slPct * slAdjust);
      const suggestedTP = direction === 'LONG'
        ? bestPrice * (1 + tpPct * tpAdjust)
        : bestPrice * (1 - tpPct * tpAdjust);

      aggregated.push({
        token: group[0].token,
        symbol: group[0].symbol,
        chain: group[0].chain,
        direction,
        totalConfidence,
        signals: group,
        suggestedEntry: bestPrice,
        suggestedSL,
        suggestedTP,
        timestamp: Date.now(),
      });
    }

    // Sort by confidence descending
    aggregated.sort((a, b) => b.totalConfidence - a.totalConfidence);
    this.aggregatedSignals = aggregated;
    return aggregated;
  }

  // ---- Execute the full pipeline: scan -> aggregate -> trade ----
  async runPipeline(): Promise<{
    signals: TokenSignal[];
    aggregated: AggregatedSignal[];
    tradesExecuted: number;
  }> {
    logger.info('======= RUNNING SIGNAL PIPELINE =======');

    // 1. Collect all signals
    const signals = await this.collectAllSignals();
    logger.info(`Total raw signals: ${signals.length}`);

    // 2. Aggregate
    const aggregated = this.aggregateSignals(signals);
    logger.info(`Aggregated signal groups: ${aggregated.length}`);

    // 3. Filter by minimum confidence
    const actionable = aggregated.filter(
      (s) => s.totalConfidence >= config.trading.minSignalConfidence
    );
    logger.info(`Actionable signals (>=${config.trading.minSignalConfidence}% confidence): ${actionable.length}`);

    let tradesExecuted = 0;

    // 4. Execute trades if auto-trade enabled
    if (this.autoTradeEnabled && this.perpsTrader.isReady()) {
      for (const signal of actionable) {
        const position = await this.perpsTrader.openPosition(signal);
        if (position) {
          tradesExecuted++;
          logger.info(
            `TRADE EXECUTED: ${signal.direction} ${signal.symbol} @ ${signal.suggestedEntry} | Confidence: ${signal.totalConfidence.toFixed(1)}%`
          );
        }
      }
    } else if (actionable.length > 0) {
      logger.info('Auto-trade disabled. Signals available for manual review.');
      for (const signal of actionable) {
        logger.info(
          `SIGNAL: ${signal.direction} ${signal.symbol} | Confidence: ${signal.totalConfidence.toFixed(1)}% | ${signal.signals.map((s) => s.source).join(', ')}`
        );
      }
    }

    // 5. Update existing positions
    if (this.perpsTrader.isReady()) {
      await this.perpsTrader.updatePositions();
    }

    logger.info('======= PIPELINE COMPLETE =======');
    return { signals, aggregated, tradesExecuted };
  }

  // ---- Getters ----
  getRecentSignals(): TokenSignal[] {
    return this.recentSignals;
  }

  getAggregatedSignals(): AggregatedSignal[] {
    return this.aggregatedSignals;
  }
}
