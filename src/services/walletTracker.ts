// ============================================
// SOLANA WALLET TRACKER
// Monitors whale/smart money wallets on Solana
// Detects large buys, token accumulation patterns
// ============================================

import { Connection, PublicKey, ParsedTransactionWithMeta } from '@solana/web3.js';
import axios from 'axios';
import { config } from '../config';
import { logger } from '../utils/logger';
import { WalletActivity, TokenSignal } from '../types';
import { v4Fallback } from '../utils/id';

// Known DEX program IDs on Solana
const DEX_PROGRAMS = {
  RAYDIUM_V4: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  RAYDIUM_CPMM: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
  JUPITER_V6: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
  ORCA_WHIRLPOOL: 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  PUMP_FUN: '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
};

const MIN_USD_VALUE = 1000; // Minimum USD value to track

export class SolanaWalletTracker {
  private connection: Connection;
  private trackedWallets: Set<string> = new Set();
  private recentActivities: WalletActivity[] = [];
  private subscriptionIds: Map<string, number> = new Map();
  private isMonitoring = false;

  constructor() {
    this.connection = new Connection(config.solana.rpcUrl, {
      wsEndpoint: config.solana.wsUrl,
      commitment: 'confirmed',
    });

    // Add configured wallets
    for (const wallet of config.trackedWallets) {
      this.trackedWallets.add(wallet);
    }
  }

  addWallet(address: string) {
    this.trackedWallets.add(address);
    logger.info(`Tracking wallet: ${address.slice(0, 8)}...`);
    if (this.isMonitoring) {
      this.subscribeToWallet(address);
    }
  }

  removeWallet(address: string) {
    this.trackedWallets.delete(address);
    const subId = this.subscriptionIds.get(address);
    if (subId !== undefined) {
      this.connection.removeAccountChangeListener(subId);
      this.subscriptionIds.delete(address);
    }
  }

  getTrackedWallets(): string[] {
    return Array.from(this.trackedWallets);
  }

  getRecentActivities(): WalletActivity[] {
    return this.recentActivities.slice(-100);
  }

  // ---- Start real-time monitoring via WebSocket ----
  async startMonitoring(onActivity: (activity: WalletActivity) => void): Promise<void> {
    this.isMonitoring = true;
    logger.info(`Starting wallet monitoring for ${this.trackedWallets.size} wallets`);

    for (const wallet of this.trackedWallets) {
      await this.subscribeToWallet(wallet, onActivity);
    }
  }

  private async subscribeToWallet(address: string, onActivity?: (activity: WalletActivity) => void) {
    try {
      const pubkey = new PublicKey(address);
      const subId = this.connection.onAccountChange(pubkey, async () => {
        // Account changed, fetch recent transactions
        const activities = await this.fetchRecentTransactions(address, 5);
        for (const activity of activities) {
          this.recentActivities.push(activity);
          if (onActivity) onActivity(activity);
        }
      });
      this.subscriptionIds.set(address, subId);
      logger.info(`Subscribed to wallet: ${address.slice(0, 8)}...`);
    } catch (err: any) {
      logger.error(`Failed to subscribe to wallet ${address}: ${err.message}`);
    }
  }

  stopMonitoring() {
    this.isMonitoring = false;
    for (const [address, subId] of this.subscriptionIds) {
      this.connection.removeAccountChangeListener(subId);
      logger.info(`Unsubscribed from wallet: ${address.slice(0, 8)}...`);
    }
    this.subscriptionIds.clear();
  }

  // ---- Fetch recent transactions for a wallet ----
  async fetchRecentTransactions(walletAddress: string, limit: number = 20): Promise<WalletActivity[]> {
    const activities: WalletActivity[] = [];

    try {
      const pubkey = new PublicKey(walletAddress);
      const signatures = await this.connection.getSignaturesForAddress(pubkey, { limit });

      for (const sig of signatures) {
        try {
          const tx = await this.connection.getParsedTransaction(sig.signature, {
            maxSupportedTransactionVersion: 0,
          });

          if (!tx) continue;
          const activity = this.parseTransaction(walletAddress, tx, sig.signature);
          if (activity) activities.push(activity);
        } catch {
          // Skip failed tx parsing
        }
      }
    } catch (err: any) {
      logger.error(`Failed to fetch transactions for ${walletAddress}: ${err.message}`);
    }

    return activities;
  }

  // ---- Parse a Solana transaction into WalletActivity ----
  private parseTransaction(
    walletAddress: string,
    tx: ParsedTransactionWithMeta,
    txHash: string
  ): WalletActivity | null {
    if (!tx.meta || tx.meta.err) return null;

    const instructions = tx.transaction.message.instructions;
    const isDexSwap = instructions.some((ix: any) => {
      const programId = ix.programId?.toBase58();
      return Object.values(DEX_PROGRAMS).includes(programId || '');
    });

    if (!isDexSwap) return null;

    // Analyze token balance changes
    const preBalances = tx.meta.preTokenBalances || [];
    const postBalances = tx.meta.postTokenBalances || [];

    let tokenIn = '';
    let tokenOut = '';
    let amountIn = 0;
    let amountOut = 0;

    for (const post of postBalances) {
      const pre = preBalances.find(
        (p) => p.accountIndex === post.accountIndex && p.mint === post.mint
      );
      const preAmount = pre ? parseFloat(pre.uiTokenAmount.uiAmountString || '0') : 0;
      const postAmount = parseFloat(post.uiTokenAmount.uiAmountString || '0');
      const diff = postAmount - preAmount;

      if (diff > 0 && post.owner === walletAddress) {
        tokenIn = post.mint;
        amountIn = diff;
      } else if (diff < 0 && post.owner === walletAddress) {
        tokenOut = post.mint;
        amountOut = Math.abs(diff);
      }
    }

    if (!tokenIn && !tokenOut) return null;

    // Determine if buy or sell (simplified: buying = receiving a non-SOL token)
    const SOL_MINT = 'So11111111111111111111111111111111111111112';
    const type = tokenIn && tokenIn !== SOL_MINT ? 'buy' : 'sell';
    const token = type === 'buy' ? tokenIn : tokenOut;
    const amount = type === 'buy' ? amountIn : amountOut;

    return {
      wallet: walletAddress,
      type,
      token: token.slice(0, 8) + '...',
      tokenAddress: token,
      amount,
      usdValue: 0, // Would need price lookup
      timestamp: (tx.blockTime || Math.floor(Date.now() / 1000)) * 1000,
      txHash,
    };
  }

  // ---- Get token price from Birdeye/Jupiter ----
  async getTokenPrice(tokenAddress: string): Promise<number> {
    try {
      const resp = await axios.get(`https://price.jup.ag/v6/price`, {
        params: { ids: tokenAddress },
        timeout: 5000,
      });
      return resp.data?.data?.[tokenAddress]?.price || 0;
    } catch {
      return 0;
    }
  }

  // ---- Detect multi-wallet accumulation patterns ----
  async detectAccumulationSignals(): Promise<TokenSignal[]> {
    const signals: TokenSignal[] = [];
    const tokenBuyCounts: Map<string, { count: number; wallets: Set<string>; totalAmount: number }> = new Map();

    // Scan all tracked wallets
    for (const wallet of this.trackedWallets) {
      const activities = await this.fetchRecentTransactions(wallet, 10);

      for (const activity of activities) {
        if (activity.type !== 'buy') continue;

        const existing = tokenBuyCounts.get(activity.tokenAddress) || {
          count: 0,
          wallets: new Set<string>(),
          totalAmount: 0,
        };
        existing.count++;
        existing.wallets.add(wallet);
        existing.totalAmount += activity.amount;
        tokenBuyCounts.set(activity.tokenAddress, existing);
      }
    }

    // Generate signals for tokens bought by multiple wallets
    for (const [tokenAddress, data] of tokenBuyCounts) {
      if (data.wallets.size < 2) continue;

      const confidence = Math.min(30 + data.wallets.size * 20 + data.count * 5, 95);
      const price = await this.getTokenPrice(tokenAddress);

      signals.push({
        id: v4Fallback(),
        token: tokenAddress.slice(0, 8) + '...',
        symbol: tokenAddress.slice(0, 6),
        chain: 'solana',
        direction: 'LONG',
        confidence,
        source: 'WALLET',
        reason: `${data.wallets.size} tracked wallets buying, ${data.count} total buys`,
        price,
        timestamp: Date.now(),
        metadata: {
          tokenAddress,
          buyerCount: data.wallets.size,
          totalBuys: data.count,
        },
      });
    }

    return signals;
  }

  // ---- Quick poll (for non-WebSocket fallback) ----
  async pollWallets(): Promise<WalletActivity[]> {
    const allActivities: WalletActivity[] = [];
    for (const wallet of this.trackedWallets) {
      const activities = await this.fetchRecentTransactions(wallet, 5);
      allActivities.push(...activities);
    }
    this.recentActivities.push(...allActivities);
    // Keep only last 500
    if (this.recentActivities.length > 500) {
      this.recentActivities = this.recentActivities.slice(-500);
    }
    return allActivities;
  }
}
