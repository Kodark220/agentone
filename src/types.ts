// ============================================
// SHARED TYPES
// ============================================

export type SignalDirection = 'LONG' | 'SHORT';
export type SignalSource = 'TECHNICAL' | 'NEWS' | 'WALLET' | 'VOLUME' | 'SOCIAL';
export type Chain = 'solana' | 'ethereum' | 'bsc' | 'arbitrum' | 'base' | 'any';

export interface TokenSignal {
  id: string;
  token: string;
  symbol: string;
  chain: Chain;
  direction: SignalDirection;
  confidence: number; // 0-100
  source: SignalSource;
  reason: string;
  price: number;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface AggregatedSignal {
  token: string;
  symbol: string;
  chain: Chain;
  direction: SignalDirection;
  totalConfidence: number;
  signals: TokenSignal[];
  suggestedEntry: number;
  suggestedSL: number;
  suggestedTP: number;
  timestamp: number;
}

export interface Position {
  id: string;
  exchange: string;
  symbol: string;
  side: SignalDirection;
  entryPrice: number;
  currentPrice: number;
  size: number;
  leverage: number;
  pnl: number;
  pnlPct: number;
  stopLoss: number;
  takeProfit: number;
  openedAt: number;
  status: 'open' | 'closed';
}

export interface WalletActivity {
  wallet: string;
  type: 'buy' | 'sell' | 'transfer';
  token: string;
  tokenAddress: string;
  amount: number;
  usdValue: number;
  timestamp: number;
  txHash: string;
}

export interface NewsItem {
  title: string;
  url: string;
  source: string;
  sentiment: 'positive' | 'negative' | 'neutral';
  relevantTokens: string[];
  publishedAt: number;
  score: number;
}

export interface TokenAnalysis {
  symbol: string;
  chain: Chain;
  price: number;
  priceChange24h: number;
  volume24h: number;
  volumeChange: number;
  marketCap: number;
  liquidity: number;
  holders?: number;
  technicals: {
    rsi: number;
    macdSignal: 'bullish' | 'bearish' | 'neutral';
    ema20: number;
    ema50: number;
    bollingerPosition: 'upper' | 'middle' | 'lower';
    trend: 'uptrend' | 'downtrend' | 'sideways';
  };
  socialScore: number;
  newsScore: number;
  overallScore: number;
}

export interface AgentState {
  isRunning: boolean;
  positions: Position[];
  signals: AggregatedSignal[];
  recentAlerts: TokenSignal[];
  trackedTokens: string[];
  pnlTotal: number;
  startedAt: number;
}
