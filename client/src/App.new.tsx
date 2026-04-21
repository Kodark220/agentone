import { useState, useEffect, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { motion, AnimatePresence } from 'framer-motion';
import { getSocketUrl } from './api';
import {
  Activity, BarChart3, TrendingUp, TrendingDown, RefreshCw, X, Radio,
  Globe, FileText, ChevronDown, ChevronUp, Zap, Shield, AlertTriangle,
} from 'lucide-react';

import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { api } from './api';

// Animations
const fadeUp = { initial: { opacity: 0, y: 12 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: -8 } };
const cardSpring = {
  initial: { opacity: 0, scale: 0.97, y: 8 },
  animate: { opacity: 1, scale: 1, y: 0, transition: { type: 'spring' as const, stiffness: 300, damping: 26 } },
  exit: { opacity: 0, scale: 0.96, transition: { duration: 0.12 } },
};

// Helpers
const fmtPrice = (p: number) => {
  if (!p) return '--';
  if (p >= 10000) return `$${p.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  if (p >= 1)     return `$${p.toFixed(2)}`;
  if (p >= 0.001) return `$${p.toFixed(4)}`;
  return `$${p.toFixed(8)}`;
};
const fmtCompact = (n: number) => {
  if (!n) return '--';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
};
const timeAgo = (ts: number) => {
  if (!ts) return '--';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5)  return 'just now';
  if (s < 60) return `${s}s ago`;
  return `${Math.floor(s / 60)}m ago`;
};
const confColor = (c: number) => c >= 75 ? 'text-emerald-400' : c >= 55 ? 'text-amber-400' : 'text-blue-400';
const confBg    = (c: number) => c >= 75 ? 'bg-emerald-500' : c >= 55 ? 'bg-amber-500' : 'bg-blue-500';
const dirVariant = (d: string) => d === 'LONG' ? 'long' : 'short';
const safetyVariant = (l?: string) => !l || l === 'low' ? 'success' : l === 'medium' ? 'warning' : 'destructive';

function ConvictionBar({ value }: { value: number }) {
  return (
    <div className="w-full h-1.5 rounded-full bg-muted overflow-hidden">
      <motion.div
        className={cn('h-full rounded-full', confBg(value))}
        initial={{ width: 0 }}
        animate={{ width: `${value}%` }}
        transition={{ duration: 0.7, ease: 'easeOut' }}
      />
    </div>
  );
}

function PricePill({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className={cn('flex-1 rounded-lg p-2.5 text-center border', color)}>
      <div className="text-[9px] font-bold uppercase tracking-widest text-muted-foreground mb-0.5">{label}</div>
      <div className="text-xs font-black tabular-nums">{fmtPrice(value)}</div>
    </div>
  );
}

export default function App() {
  const [setups,      setSetups]      = useState<any[]>([]);
  const [marketCtx,   setMarketCtx]   = useState<any>(null);
  const [status,      setStatus]      = useState<any>(null);
  const [autoTrade,   setAutoTrade]   = useState(false);
  const [loading,     setLoading]     = useState(false);
  const [lastUpdate,  setLastUpdate]  = useState(0);
  const [detail,      setDetail]      = useState<any | null>(null);
  const [expanded,    setExpanded]    = useState<string | null>(null);
  const [filter,      setFilter]      = useState<'ALL' | 'LONG' | 'SHORT'>('ALL');
  const [sortBy,      setSortBy]      = useState<'confidence' | 'rr'>('confidence');

  const load = useCallback(async () => {
    try {
      const [s, ft, mc] = await Promise.all([
        api.getStatus(),
        api.getFuturesSetups(),
        api.getMarketContext(),
      ]);
      setStatus(s);
      setAutoTrade(s.autoTrade || false);
      setSetups(ft.setups || []);
      setMarketCtx(mc.context || null);
      setLastUpdate(Date.now());
    } catch (e) { console.error(e); }
  }, []);

  useEffect(() => { load(); const t = setInterval(load, 30_000); return () => clearInterval(t); }, [load]);

  useEffect(() => {
    const sock: Socket = io(getSocketUrl());
    sock.on('futuresSetups', (s: any[]) => { setSetups(s); setLastUpdate(Date.now()); });
    sock.on('marketContext', (c: any) => setMarketCtx(c));
    sock.on('state', (s: any) => {
      setAutoTrade(s.autoTrade || false);
      if (s.marketContext) setMarketCtx(s.marketContext);
    });
    return () => { sock.disconnect(); };
  }, []);

  const handleGenerate = async () => {
    setLoading(true);
    try { const r = await api.generateFuturesSetups(); setSetups(r.setups || []); setLastUpdate(Date.now()); }
    catch (e) { console.error(e); }
    setLoading(false);
  };

  const filtered = setups
    .filter(s => filter === 'ALL' || s.direction === filter)
    .sort((a, b) => sortBy === 'confidence' ? b.confidence - a.confidence : b.riskReward - a.riskReward);

  const longCount  = setups.filter(s => s.direction === 'LONG').length;
  const shortCount = setups.filter(s => s.direction === 'SHORT').length;

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <motion.header
        initial={{ opacity: 0, y: -16 }} animate={{ opacity: 1, y: 0 }}
        className="sticky top-0 z-50 border-b border-border/50 backdrop-blur-xl bg-background/85"
      >
        <div className="max-w-7xl mx-auto flex items-center justify-between px-5 h-14">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center">
              <BarChart3 className="w-4 h-4 text-white" />
            </div>
            <div>
              <h1 className="text-sm font-black tracking-wide text-blue-400">ORACLE</h1>
              <p className="text-[10px] text-muted-foreground -mt-0.5 leading-none">Altcoin Futures Agent</p>
            </div>
          </div>
          <div className="flex items-center gap-5">
            <div className="flex items-center gap-1.5">
              <Radio className="w-3 h-3 text-emerald-400" />
              <span className="text-[11px] text-muted-foreground">Live · {timeAgo(lastUpdate)}</span>
            </div>
            <div className="flex items-center gap-1.5">
              <span className={cn('w-2 h-2 rounded-full', status?.exchangeConnected ? 'bg-emerald-400' : 'bg-zinc-600')} />
              <span className="text-[11px] text-muted-foreground">
                {status?.exchangeConnected ? 'Exchange on' : 'Analysis mode'}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-muted-foreground">Auto-trade</span>
              <Switch checked={autoTrade} onCheckedChange={v => { setAutoTrade(v); api.setAutoTrade(v); }} />
            </div>
            <Button size="sm" onClick={handleGenerate} disabled={loading}
              className="bg-blue-600 hover:bg-blue-700 text-white gap-1.5">
              <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
              {loading ? 'Scanning...' : 'Generate'}
            </Button>
          </div>
        </div>
      </motion.header>

      <main className="max-w-7xl mx-auto px-5 py-5 space-y-5">
        {/* Market context strip */}
        <AnimatePresence>
          {marketCtx && (
            <motion.div key="ctx" {...fadeUp}>
              <Card className="border-border/40 bg-card/60">
                <CardContent className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                    <div className="flex items-center gap-2">
                      {marketCtx.btcTrend === 'bullish'
                        ? <TrendingUp  className="w-3.5 h-3.5 text-emerald-400" />
                        : marketCtx.btcTrend === 'bearish'
                          ? <TrendingDown className="w-3.5 h-3.5 text-red-400" />
                          : <Activity    className="w-3.5 h-3.5 text-amber-400" />}
                      <span className="text-xs font-bold tabular-nums">{fmtPrice(marketCtx.btcPrice)}</span>
                      <span className={cn('text-[11px] font-semibold tabular-nums',
                        (marketCtx.btcChange24h || 0) >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                        {(marketCtx.btcChange24h || 0) >= 0 ? '+' : ''}{(marketCtx.btcChange24h || 0).toFixed(2)}%
                      </span>
                    </div>
                    <div className="w-px h-4 bg-border/50" />
                    <div className={cn('rounded-md px-2.5 py-1 border text-[10px] font-black uppercase tracking-widest',
                      marketCtx.marketMode === 'RISK_ON'
                        ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-400'
                        : 'bg-red-500/10 border-red-500/25 text-red-400')}>
                      {marketCtx.marketMode === 'RISK_ON' ? 'RISK ON' : 'RISK OFF'}
                    </div>
                    <div className="w-px h-4 bg-border/50" />
                    <div className="text-xs">
                      <span className="text-muted-foreground">BTC.D </span>
                      <span className="font-bold">{(marketCtx.btcDominance || 0).toFixed(1)}%</span>
                      <span className={cn('ml-1 text-[10px]',
                        marketCtx.btcDominanceTrend === 'falling' ? 'text-emerald-400'
                          : marketCtx.btcDominanceTrend === 'rising' ? 'text-red-400' : 'text-zinc-500')}>
                        {marketCtx.btcDominanceTrend === 'falling' ? 'down' : marketCtx.btcDominanceTrend === 'rising' ? 'up' : 'flat'}
                      </span>
                    </div>
                    <div className="text-xs">
                      <span className="text-muted-foreground">Volatility </span>
                      <span className={cn('font-bold uppercase',
                        marketCtx.volatilityState === 'extreme' ? 'text-red-400'
                          : marketCtx.volatilityState === 'elevated' ? 'text-amber-400' : 'text-emerald-400')}>
                        {marketCtx.volatilityState}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-xs ml-auto">
                      <span className="text-muted-foreground">Bias</span>
                      <Badge variant="long"  className="text-[10px]">L {longCount}</Badge>
                      <Badge variant="short" className="text-[10px]">S {shortCount}</Badge>
                      <div className="flex items-center gap-1.5">
                        <span className={cn('font-bold tabular-nums text-xs',
                          marketCtx.riskScore >= 60 ? 'text-emerald-400'
                            : marketCtx.riskScore <= 40 ? 'text-red-400' : 'text-amber-400')}>
                          {marketCtx.riskScore}/100
                        </span>
                        <div className="w-16 h-1.5 rounded-full bg-muted overflow-hidden">
                          <div className={cn('h-full rounded-full transition-all duration-700',
                            marketCtx.riskScore >= 60 ? 'bg-emerald-500'
                              : marketCtx.riskScore <= 40 ? 'bg-red-500' : 'bg-amber-500')}
                            style={{ width: `${marketCtx.riskScore}%` }} />
                        </div>
                      </div>
                    </div>
                  </div>
                  {marketCtx.warnings?.length > 0 && (
                    <div className="mt-2.5 flex flex-wrap gap-1.5">
                      {marketCtx.warnings.map((w: string, i: number) => (
                        <div key={i} className="flex items-center gap-1 rounded-md bg-amber-500/8 border border-amber-500/20 px-2 py-0.5">
                          <AlertTriangle className="w-2.5 h-2.5 text-amber-400 shrink-0" />
                          <span className="text-[10px] text-amber-300">{w}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Filters */}
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground font-medium">Direction</span>
            {(['ALL', 'LONG', 'SHORT'] as const).map(f => (
              <Button key={f} size="sm" variant={filter === f ? 'default' : 'ghost'}
                className={cn('h-7 text-xs px-3',
                  filter === f && (f === 'LONG' ? 'bg-emerald-600 hover:bg-emerald-700 text-white'
                    : f === 'SHORT' ? 'bg-red-600 hover:bg-red-700 text-white'
                      : 'bg-blue-600 hover:bg-blue-700 text-white'))}
                onClick={() => setFilter(f)}>
                {f}
              </Button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground font-medium">Sort</span>
            {(['confidence', 'rr'] as const).map(s => (
              <Button key={s} size="sm" variant={sortBy === s ? 'default' : 'ghost'}
                className={cn('h-7 text-xs px-3', sortBy === s && 'bg-blue-600 hover:bg-blue-700 text-white')}
                onClick={() => setSortBy(s)}>
                {s === 'confidence' ? 'Conviction' : 'R:R Ratio'}
              </Button>
            ))}
          </div>
          <span className="text-xs text-muted-foreground tabular-nums">
            {filtered.length} setup{filtered.length !== 1 ? 's' : ''}
          </span>
        </div>

        {/* Setup cards */}
        {filtered.length === 0 ? (
          <div className="text-center py-24 text-muted-foreground">
            <BarChart3 className="w-12 h-12 mx-auto mb-4 opacity-20" />
            <p className="text-sm font-medium">No setups yet</p>
            <p className="text-xs mt-1 opacity-60">Click Generate to scan futures markets</p>
          </div>
        ) : (
          <motion.div
            className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3"
            initial="initial" animate="animate"
            variants={{ animate: { transition: { staggerChildren: 0.04 } } }}
          >
            <AnimatePresence mode="popLayout">
              {filtered.map((s: any) => (
                <motion.div key={s.id} variants={cardSpring} layout>
                  <SetupCard
                    setup={s}
                    expanded={expanded === s.id}
                    onToggleExpand={() => setExpanded(expanded === s.id ? null : s.id)}
                    onOpenDetail={() => setDetail(s)}
                  />
                </motion.div>
              ))}
            </AnimatePresence>
          </motion.div>
        )}
      </main>

      {/* Detail modal */}
      <AnimatePresence>
        {detail && (
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4"
            onClick={() => setDetail(null)}
          >
            <motion.div
              initial={{ scale: 0.92, opacity: 0, y: 20 }}
              animate={{ scale: 1,    opacity: 1, y: 0 }}
              exit={{    scale: 0.95, opacity: 0, y: 10 }}
              transition={{ type: 'spring', stiffness: 320, damping: 28 }}
              className="w-full max-w-xl max-h-[88vh] overflow-y-auto rounded-xl border border-border bg-card shadow-2xl"
              onClick={e => e.stopPropagation()}
            >
              <DetailModal setup={detail} onClose={() => setDetail(null)} />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// SetupCard
function SetupCard({ setup: s, expanded, onToggleExpand, onOpenDetail }: {
  setup: any; expanded: boolean; onToggleExpand: () => void; onOpenDetail: () => void;
}) {
  return (
    <Card className={cn(
      'border-border/40 bg-card/70 hover:border-blue-500/30 transition-colors cursor-pointer',
      s.safety?.blocked && 'opacity-50 border-red-500/20',
    )}>
      <CardContent className="p-4 space-y-3" onClick={onOpenDetail}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="font-black text-sm">{s.pair || s.symbol}</span>
            <Badge variant={dirVariant(s.direction)} className="text-[10px] gap-0.5">
              {s.direction === 'LONG' ? <TrendingUp className="w-2.5 h-2.5" /> : <TrendingDown className="w-2.5 h-2.5" />}
              {s.direction}
            </Badge>
            {s.safety?.level && s.safety.level !== 'low' && (
              <Badge variant={safetyVariant(s.safety.level)} className="text-[9px] px-1">
                <Shield className="w-2 h-2 mr-0.5" />{s.safety.level.toUpperCase()}
              </Badge>
            )}
            {s.safety?.blocked && <Badge variant="destructive" className="text-[9px] px-1">BLOCKED</Badge>}
          </div>
          <div className="text-right">
            <span className={cn('text-lg font-black tabular-nums', confColor(s.confidence))}>{s.confidence?.toFixed(0)}</span>
            <span className="text-[10px] text-muted-foreground">%</span>
          </div>
        </div>

        <div className="flex gap-1.5">
          <PricePill label="Entry" value={s.entry}      color="bg-blue-500/8    border-blue-500/20" />
          <PricePill label="SL"    value={s.stopLoss}   color="bg-red-500/8     border-red-500/20" />
          <PricePill label="TP"    value={s.takeProfit} color="bg-emerald-500/8 border-emerald-500/20" />
        </div>

        {/* T1/T2/T3 if available */}
        {s.targets && (
          <div className="flex gap-1.5">
            <PricePill label="T1" value={s.targets.t1} color="bg-emerald-500/5  border-emerald-500/15" />
            <PricePill label="T2" value={s.targets.t2} color="bg-emerald-500/8  border-emerald-500/20" />
            <PricePill label="T3" value={s.targets.t3} color="bg-emerald-500/12 border-emerald-500/25" />
          </div>
        )}

        <div className="flex items-center gap-1.5 flex-wrap">
          <Badge variant="secondary" className="text-[10px]">{s.leverage}x</Badge>
          <Badge variant="secondary" className="text-[10px]">R:R {s.riskReward?.toFixed(1)}</Badge>
          {s.technicals && (
            <>
              <Badge variant="info" className={cn('text-[10px]', s.technicals.rsi < 30 ? '!text-emerald-400' : s.technicals.rsi > 70 ? '!text-red-400' : '')}>
                RSI {s.technicals.rsi?.toFixed(0)}
              </Badge>
              <Badge variant={s.technicals.macd === 'bullish' ? 'success' : s.technicals.macd === 'bearish' ? 'destructive' : 'secondary'} className="text-[10px]">
                {s.technicals.macd?.toUpperCase()}
              </Badge>
              <Badge variant={s.technicals.trend === 'uptrend' ? 'success' : s.technicals.trend === 'downtrend' ? 'destructive' : 'warning'} className="text-[10px]">
                {s.technicals.trend}
              </Badge>
            </>
          )}
          {s.derivatives?.fundingRate !== undefined && (
            <Badge variant="outline" className="text-[10px]">Fund {s.derivatives.fundingRate?.toFixed(4)}%</Badge>
          )}
        </div>

        {(s.marketCap || s.volume24h || s.priceChange24h != null) && (
          <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
            {s.marketCap     && <span>MC {fmtCompact(s.marketCap)}</span>}
            {s.volume24h     && <span>Vol {fmtCompact(s.volume24h)}</span>}
            {s.priceChange24h != null && (
              <span className={cn(s.priceChange24h >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                24h {s.priceChange24h > 0 ? '+' : ''}{s.priceChange24h?.toFixed(1)}%
              </span>
            )}
            {s.exchanges?.length > 0 && (
              <span className="ml-auto flex items-center gap-0.5">
                <Globe className="w-2.5 h-2.5" />
                {s.exchanges.slice(0, 3).join(', ')}{s.exchanges.length > 3 && ` +${s.exchanges.length - 3}`}
              </span>
            )}
          </div>
        )}

        {s.news?.headline && (
          <div className="flex items-start gap-1.5 rounded-md bg-background/50 border border-border/30 px-2.5 py-2 text-[10px]">
            <FileText className="w-3 h-3 mt-0.5 shrink-0 text-amber-400" />
            <div>
              <span className={cn('font-semibold mr-1',
                s.news.sentiment === 'bullish' ? 'text-emerald-400'
                  : s.news.sentiment === 'bearish' ? 'text-red-400' : 'text-zinc-400')}>
                {s.news.sentiment?.toUpperCase()}
              </span>
              <span className="text-muted-foreground line-clamp-1">{s.news.headline}</span>
            </div>
          </div>
        )}

        <ConvictionBar value={s.confidence} />

        {s.reason && (
          <p className="text-[10px] text-muted-foreground leading-relaxed line-clamp-1 pt-0.5 border-t border-border/20">
            {s.reason}
          </p>
        )}
      </CardContent>

      {s.analysisDetail && (
        <>
          <div className="px-4 pb-1" onClick={e => e.stopPropagation()}>
            <button
              className="w-full flex items-center justify-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors py-1 border-t border-border/20"
              onClick={onToggleExpand}
            >
              {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
              {expanded ? 'Less' : 'Full analysis'}
            </button>
          </div>
          <AnimatePresence>
            {expanded && (
              <motion.div
                initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                className="overflow-hidden" onClick={e => e.stopPropagation()}
              >
                <div className="px-4 pb-4 pt-2 border-t border-blue-500/15 bg-blue-500/3 space-y-1.5">
                  <span className="text-[10px] font-semibold text-blue-400 uppercase tracking-wider">Detailed Analysis</span>
                  <p className="text-[11px] text-muted-foreground leading-relaxed whitespace-pre-line">{s.analysisDetail}</p>
                  {s.technicals && (
                    <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[10px] pt-1">
                      <span className="text-muted-foreground">EMA20 <span className="text-foreground font-medium">{fmtPrice(s.technicals.ema20)}</span></span>
                      <span className="text-muted-foreground">EMA50 <span className="text-foreground font-medium">{fmtPrice(s.technicals.ema50)}</span></span>
                      <span className="text-muted-foreground">Bollinger <span className="text-foreground font-medium">{s.technicals.bollinger}</span></span>
                      <span className="text-muted-foreground">SL dist <span className="text-foreground font-medium">{((Math.abs(s.entry - s.stopLoss) / s.entry) * 100).toFixed(2)}%</span></span>
                    </div>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}
    </Card>
  );
}

// DetailModal
function DetailModal({ setup: s, onClose }: { setup: any; onClose: () => void }) {
  return (
    <div className="p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <h2 className="text-xl font-black">{s.pair || s.symbol}</h2>
          <Badge variant={dirVariant(s.direction)} className="text-xs gap-0.5">
            {s.direction === 'LONG' ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
            {s.direction}
          </Badge>
          {s.safety?.level && s.safety.level !== 'low' && (
            <Badge variant={safetyVariant(s.safety.level)} className="text-xs">Safety {s.safety.level.toUpperCase()}</Badge>
          )}
          <span className={cn('text-xl font-black tabular-nums', confColor(s.confidence))}>{s.confidence?.toFixed(0)}%</span>
        </div>
        <Button variant="ghost" size="sm" onClick={onClose}><X className="w-4 h-4" /></Button>
      </div>

      <div className="flex gap-2">
        <PricePill label="Entry"      value={s.entry}      color="bg-blue-500/10    border-blue-500/25" />
        <PricePill label="Stop Loss"  value={s.stopLoss}   color="bg-red-500/10     border-red-500/25" />
        <PricePill label="Take Profit" value={s.takeProfit} color="bg-emerald-500/10 border-emerald-500/25" />
      </div>

      {s.targets && (
        <div className="flex gap-2">
          <PricePill label="Target 1" value={s.targets.t1} color="bg-emerald-500/6  border-emerald-500/15" />
          <PricePill label="Target 2" value={s.targets.t2} color="bg-emerald-500/9  border-emerald-500/20" />
          <PricePill label="Target 3" value={s.targets.t3} color="bg-emerald-500/12 border-emerald-500/25" />
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {[
          { label: 'Leverage',    value: `${s.leverage}x` },
          { label: 'Risk:Reward', value: s.riskReward?.toFixed(2) },
          { label: 'Market Cap',  value: fmtCompact(s.marketCap) },
          { label: '24h Change',  value: `${(s.priceChange24h || 0) >= 0 ? '+' : ''}${(s.priceChange24h || 0).toFixed(1)}%`,
            color: (s.priceChange24h || 0) >= 0 ? 'text-emerald-400' : 'text-red-400' },
        ].map(item => (
          <div key={item.label} className="rounded-lg bg-secondary/40 p-2.5">
            <div className="text-[10px] text-muted-foreground">{item.label}</div>
            <div className={cn('text-sm font-bold', (item as any).color || 'text-foreground')}>{item.value || '--'}</div>
          </div>
        ))}
      </div>

      {s.derivatives && (
        <div>
          <h3 className="text-xs font-semibold text-blue-400 mb-2 flex items-center gap-1.5">
            <Zap className="w-3 h-3" /> Derivatives Intel
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {[
              { label: 'Funding Rate',   value: `${s.derivatives.fundingRate?.toFixed(4)}%`,
                color: s.derivatives.fundingRate >= 0 ? 'text-amber-400' : 'text-blue-400' },
              { label: 'Open Interest',  value: `${(s.derivatives.openInterest || 0).toFixed(0)}` },
              { label: 'L/S Ratio',      value: s.derivatives.longShortRatio?.toFixed(2) },
              { label: 'Squeeze Risk',   value: s.derivatives.squeezeRisk?.replace('_', ' ').toUpperCase(),
                color: s.derivatives.squeezeRisk === 'low' ? 'text-zinc-400' : 'text-amber-400' },
            ].map(item => (
              <div key={item.label} className="rounded-lg bg-secondary/40 p-2.5">
                <div className="text-[10px] text-muted-foreground">{item.label}</div>
                <div className={cn('text-sm font-bold', (item as any).color || 'text-foreground')}>{item.value || '--'}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {s.technicals && (
        <div>
          <h3 className="text-xs font-semibold text-blue-400 mb-2 flex items-center gap-1.5">
            <Activity className="w-3 h-3" /> Technical Analysis
          </h3>
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-lg bg-secondary/40 p-2.5">
              <div className="text-[10px] text-muted-foreground">RSI (14)</div>
              <div className={cn('text-sm font-bold', s.technicals.rsi < 30 ? 'text-emerald-400' : s.technicals.rsi > 70 ? 'text-red-400' : 'text-foreground')}>
                {s.technicals.rsi?.toFixed(1)}
              </div>
              <div className="mt-1 w-full h-1 rounded-full bg-muted overflow-hidden">
                <div className={cn('h-full rounded-full', s.technicals.rsi < 30 ? 'bg-emerald-500' : s.technicals.rsi > 70 ? 'bg-red-500' : 'bg-blue-500')}
                  style={{ width: `${s.technicals.rsi}%` }} />
              </div>
            </div>
            <div className="rounded-lg bg-secondary/40 p-2.5">
              <div className="text-[10px] text-muted-foreground">MACD</div>
              <Badge variant={s.technicals.macd === 'bullish' ? 'success' : s.technicals.macd === 'bearish' ? 'destructive' : 'secondary'} className="text-xs mt-0.5">
                {s.technicals.macd}
              </Badge>
            </div>
            <div className="rounded-lg bg-secondary/40 p-2.5">
              <div className="text-[10px] text-muted-foreground">Trend</div>
              <Badge variant={s.technicals.trend === 'uptrend' ? 'success' : s.technicals.trend === 'downtrend' ? 'destructive' : 'warning'} className="text-xs mt-0.5">
                {s.technicals.trend}
              </Badge>
            </div>
            <div className="rounded-lg bg-secondary/40 p-2.5">
              <div className="text-[10px] text-muted-foreground">EMA 20</div>
              <div className="text-sm font-bold tabular-nums">{fmtPrice(s.technicals.ema20)}</div>
            </div>
            <div className="rounded-lg bg-secondary/40 p-2.5">
              <div className="text-[10px] text-muted-foreground">EMA 50</div>
              <div className="text-sm font-bold tabular-nums">{fmtPrice(s.technicals.ema50)}</div>
            </div>
            <div className="rounded-lg bg-secondary/40 p-2.5">
              <div className="text-[10px] text-muted-foreground">Bollinger</div>
              <Badge variant={s.technicals.bollinger === 'lower' ? 'success' : s.technicals.bollinger === 'upper' ? 'destructive' : 'secondary'} className="text-xs mt-0.5">
                {s.technicals.bollinger}
              </Badge>
            </div>
          </div>
        </div>
      )}

      {s.exchanges?.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold text-muted-foreground mb-1.5 flex items-center gap-1.5">
            <Globe className="w-3 h-3" /> Where to trade
          </h3>
          <div className="flex flex-wrap gap-1">
            {s.exchanges.map((ex: string) => <Badge key={ex} variant="outline" className="text-[10px]">{ex}</Badge>)}
          </div>
        </div>
      )}

      {s.news?.headline && (
        <div className="rounded-lg bg-amber-500/5 border border-amber-500/15 p-3">
          <h3 className="text-[10px] font-semibold text-amber-400 mb-1 flex items-center gap-1">
            <FileText className="w-3 h-3" /> Latest News
          </h3>
          <div className="flex items-start gap-2 text-xs">
            <Badge variant={s.news.sentiment === 'bullish' ? 'success' : s.news.sentiment === 'bearish' ? 'destructive' : 'secondary'} className="text-[9px] shrink-0">
              {s.news.sentiment?.toUpperCase()}
            </Badge>
            <span className="text-muted-foreground">{s.news.headline}</span>
          </div>
          {s.news.source && <span className="text-[10px] text-zinc-600 mt-0.5 block">{s.news.source}</span>}
        </div>
      )}

      {s.safety?.warnings?.length > 0 && (
        <div className="rounded-lg bg-red-500/5 border border-red-500/15 p-3 space-y-1">
          <h3 className="text-[10px] font-semibold text-red-400 flex items-center gap-1">
            <Shield className="w-3 h-3" /> Safety Warnings
          </h3>
          {s.safety.warnings.map((w: string, i: number) => (
            <div key={i} className="text-[10px] text-red-300 flex items-center gap-1"><span>-</span>{w}</div>
          ))}
        </div>
      )}

      {s.analysisDetail && (
        <div className="rounded-lg bg-background/50 border border-border/30 p-3">
          <div className="text-[10px] text-blue-400 font-semibold mb-1.5">Full Analysis</div>
          <p className="text-xs text-muted-foreground leading-relaxed whitespace-pre-line">{s.analysisDetail}</p>
        </div>
      )}

      <div>
        <div className="flex justify-between text-[10px] text-muted-foreground mb-1">
          <span>Conviction score</span>
          <span className={cn('font-bold', confColor(s.confidence))}>{s.confidence?.toFixed(0)}%</span>
        </div>
        <ConvictionBar value={s.confidence} />
      </div>
    </div>
  );
}
