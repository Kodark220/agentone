// ============================================
// NEWS SENTIMENT ENGINE
// Monitors crypto news sources for alpha signals
// Sources: CryptoPanic, LunarCrush
// ============================================

import axios from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';
import { NewsItem, TokenSignal } from '../types';
import { v4Fallback } from '../utils/id';

// Keywords that indicate bullish news
const BULLISH_KEYWORDS = [
  'partnership', 'listing', 'binance listing', 'coinbase listing', 'launch',
  'mainnet', 'upgrade', 'airdrop', 'funding', 'raised', 'institutional',
  'adoption', 'integration', 'bullish', 'breakout', 'ath', 'all-time high',
  'surge', 'pump', 'moon', 'rally', 'explosion', 'parabolic',
  'million', 'billion', 'whale', 'burning', 'burn', 'staking',
];

// Keywords that indicate bearish news
const BEARISH_KEYWORDS = [
  'hack', 'exploit', 'rug', 'scam', 'sec', 'lawsuit', 'ban',
  'crash', 'dump', 'bearish', 'sell-off', 'delisting', 'fraud',
  'investigation', 'vulnerability', 'breach', 'insolvent',
];

export class NewsSentimentEngine {
  private newsCache: NewsItem[] = [];
  private lastFetchTime = 0;
  private readonly cacheTTL = 5 * 60 * 1000; // 5 minutes

  // ---- CryptoPanic: fetch latest news ----
  async fetchCryptoPanicNews(filter?: string): Promise<NewsItem[]> {
    if (!config.apis.cryptoPanicKey) {
      logger.warn('CryptoPanic API key not set');
      return [];
    }

    try {
      const params: Record<string, string> = {
        auth_token: config.apis.cryptoPanicKey,
        public: 'true',
      };
      if (filter) params.currencies = filter;

      const resp = await axios.get('https://cryptopanic.com/api/v1/posts/', {
        params,
        timeout: 10000,
      });

      const results = resp.data?.results || [];
      return results.map((item: any) => {
        const title = (item.title || '').toLowerCase();
        const sentiment = this.analyseSentiment(title);
        const tokens = this.extractTokens(title, item.currencies || []);

        return {
          title: item.title,
          url: item.url,
          source: item.source?.title || 'CryptoPanic',
          sentiment: sentiment.direction,
          relevantTokens: tokens,
          publishedAt: new Date(item.published_at).getTime(),
          score: sentiment.score,
        };
      });
    } catch (err: any) {
      logger.error(`CryptoPanic fetch failed: ${err.message}`);
      return [];
    }
  }

  // ---- LunarCrush: social/news data ----
  async fetchLunarCrushData(symbol: string): Promise<{ socialScore: number; newsScore: number; sentiment: string }> {
    if (!config.apis.lunarCrushKey) {
      return { socialScore: 0, newsScore: 0, sentiment: 'neutral' };
    }

    try {
      const resp = await axios.get('https://lunarcrush.com/api4/public/coins/list/v2', {
        params: { sort: 'galaxy_score', limit: 100 },
        headers: { Authorization: `Bearer ${config.apis.lunarCrushKey}` },
        timeout: 10000,
      });

      const coins = resp.data?.data || [];
      const coin = coins.find((c: any) => c.symbol?.toUpperCase() === symbol.toUpperCase());

      if (!coin) return { socialScore: 0, newsScore: 0, sentiment: 'neutral' };

      const socialScore = Math.min((coin.galaxy_score || 0) * 1.5, 100);
      const newsScore = Math.min((coin.alt_rank_30d || 50), 100);
      const sentiment = socialScore > 60 ? 'positive' : socialScore < 30 ? 'negative' : 'neutral';

      return { socialScore, newsScore, sentiment };
    } catch (err: any) {
      logger.error(`LunarCrush fetch failed: ${err.message}`);
      return { socialScore: 0, newsScore: 0, sentiment: 'neutral' };
    }
  }

  // ---- Keyword-based sentiment analysis ----
  analyseSentiment(text: string): { direction: 'positive' | 'negative' | 'neutral'; score: number } {
    const lower = text.toLowerCase();
    let bullCount = 0;
    let bearCount = 0;

    for (const keyword of BULLISH_KEYWORDS) {
      if (lower.includes(keyword)) bullCount++;
    }
    for (const keyword of BEARISH_KEYWORDS) {
      if (lower.includes(keyword)) bearCount++;
    }

    if (bullCount > bearCount) {
      return { direction: 'positive', score: Math.min(50 + bullCount * 15, 100) };
    } else if (bearCount > bullCount) {
      return { direction: 'negative', score: Math.min(50 + bearCount * 15, 100) };
    }
    return { direction: 'neutral', score: 30 };
  }

  // ---- Extract token symbols from news ----
  extractTokens(title: string, currencies: any[]): string[] {
    const tokens: string[] = [];

    // From CryptoPanic's currency tags
    for (const c of currencies) {
      if (c.code) tokens.push(c.code.toUpperCase());
    }

    // Common token mentions in title
    const tokenPattern = /\$([A-Z]{2,10})/g;
    let match;
    while ((match = tokenPattern.exec(title.toUpperCase())) !== null) {
      if (!tokens.includes(match[1])) tokens.push(match[1]);
    }

    return tokens;
  }

  // ---- Scan news and generate signals ----
  async scanForSignals(targetTokens?: string[]): Promise<TokenSignal[]> {
    const signals: TokenSignal[] = [];

    // Fetch news
    const now = Date.now();
    if (now - this.lastFetchTime > this.cacheTTL) {
      const filter = targetTokens?.join(',');
      this.newsCache = await this.fetchCryptoPanicNews(filter);
      this.lastFetchTime = now;
    }

    // Filter for recent high-impact news (last 2 hours)
    const recentNews = this.newsCache.filter(
      (n) => now - n.publishedAt < 2 * 60 * 60 * 1000 && n.score > 50
    );

    for (const news of recentNews) {
      for (const token of news.relevantTokens) {
        if (targetTokens && !targetTokens.includes(token)) continue;

        const direction = news.sentiment === 'positive' ? 'LONG' : 'SHORT';
        if (news.sentiment === 'neutral') continue;

        signals.push({
          id: v4Fallback(),
          token,
          symbol: token,
          chain: 'any',
          direction,
          confidence: news.score,
          source: 'NEWS',
          reason: `News: "${news.title}" (${news.source})`,
          price: 0, // Will be filled by aggregator
          timestamp: now,
          metadata: { newsUrl: news.url, newsSource: news.source },
        });
      }
    }

    return signals;
  }

  // ---- Get cached news ----
  getCachedNews(): NewsItem[] {
    return this.newsCache;
  }
}
