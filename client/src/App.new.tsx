import { useState, useEffect, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { motion, AnimatePresence } from 'framer-motion';
import { getSocketUrl } from './api';
import {
  Activity, BarChart3, TrendingUp, TrendingDown, Wallet, Search,
  Zap, RefreshCw, X, Eye, Flame, ChevronRight, Clock, ExternalLink, Radio,
  ArrowUpRight, ArrowDownRight, DollarSign, Globe, FileText,
} from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { api } from './api';

// ============================================
// ANIMATION VARIANTS
// ============================================
const fadeInUp = { initial: { opacity: 0, y: 16 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: -8 } };
const staggerContainer = { animate: { transition: { staggerChildren: 0.05 } } };
const cardSpring = {
  initial: { opacity: 0, scale: 0.96, y: 10 },
  animate: { opacity: 1, scale: 1, y: 0, transition: { type: 'spring' as const, stiffness: 300, damping: 25 } },
  exit: { opacity: 0, scale: 0.95, transition: { duration: 0.15 } },
};

// ============================================
// MAIN APP
// ============================================
export default function App() {
  const [status, setStatus] = useState<any>(null);
  const [signals, setSignals] = useState<any[]>([]);
  const [aggregated, setAggregated] = useState<any[]>([]);
  const [positions, setPositions] = useState<any[]>([]);
  const [watchlist, setWatchlist] = useState<any[]>([]);
  const [wallets, setWallets] = useState<string[]>([]);
  const [walletActivity, setWalletActivity] = useState<any[]>([]);
  const [news, setNews] = useState<any[]>([]);
  const [autoTrade, setAutoTrade] = useState(false);
  const [loading, setLoading] = useState(false);
  const [futuresSetups, setFuturesSetups] = useState<any[]>([]);
  const [trenchTokens, setTrenchTokens] = useState<any[]>([]);
  const [trenchCounts, setTrenchCounts] = useState<any>({ new: 0, recent: 0, established: 0 });
  const [trenchFilter, setTrenchFilter] = useState<'ALL' | 'NEW' | 'RECENT' | 'ESTABLISHED'>('ALL');
  const [trenchInput, setTrenchInput] = useState('');
  const [futuresLastUpdate, setFuturesLastUpdate] = useState(0);
  const [trenchesLastUpdate, setTrenchesLastUpdate] = useState(0);
  const [pumpCandidates, setPumpCandidates] = useState<any[]>([]);
  const [flowSummary, setFlowSummary] = useState<any>(null);
  const [expandedSetup, setExpandedSetup] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [newWallet, setNewWallet] = useState('');
  const [addSymbol, setAddSymbol] = useState('');
  const [addChain, setAddChain] = useState('any');
  const [analysisResult, setAnalysisResult] = useState<any>(null);

  // ---- Data Loading ----
  const refresh = useCallback(async () => {
    try {
      const [s, sig, pos, wl, wal, n, ft, tr] = await Promise.all([
        api.getStatus(), api.getSignals(), api.getPositions(), api.getWatchlist(),
        api.getWallets(), api.getNews(), api.getFuturesSetups(), api.getTrenches(),
      ]);
      setStatus(s);
      setSignals(sig.recent || []);
      setAggregated(sig.aggregated || []);
      setPositions(pos.open || []);
      setWatchlist(wl.watchlist || []);
      setWallets(wal.wallets || []);
      setWalletActivity(wal.recentActivity || []);
      setNews(n.news || []);
      setAutoTrade(s.autoTrade || false);
      setFuturesSetups(ft.setups || []);
      setFuturesLastUpdate(Date.now());
      setTrenchTokens(tr.tokens || []);
      setTrenchCounts(tr.counts || { new: 0, recent: 0, established: 0 });
      setPumpCandidates(tr.pumpCandidates || []);
      setFlowSummary(tr.flowSummary || null);
      setTrenchesLastUpdate(Date.now());
    } catch (err) { console.error('Failed to load:', err); }
  }, []);

  const refreshLive = useCallback(async () => {
    try {
      const [ft, tr] = await Promise.all([api.getFuturesSetups(), api.getTrenches()]);
      if (ft.setups?.length) { setFuturesSetups(ft.setups); setFuturesLastUpdate(Date.now()); }
      if (tr.tokens) {
        setTrenchTokens(tr.tokens);
        setTrenchCounts(tr.counts || { new: 0, recent: 0, established: 0 });
        setPumpCandidates(tr.pumpCandidates || []);
        setFlowSummary(tr.flowSummary || null);
        setTrenchesLastUpdate(Date.now());
      }
    } catch {}
  }, []);

  useEffect(() => { refresh(); const i = setInterval(refresh, 30000); return () => clearInterval(i); }, [refresh]);
  useEffect(() => { const i = setInterval(refreshLive, 5000); return () => clearInterval(i); }, [refreshLive]);

  useEffect(() => {
    const socket: Socket = io(getSocketUrl());
    socket.on('pipelineResult', (r: any) => { setSignals(r.signals || []); setAggregated(r.aggregated || []); });
    socket.on('positions', (p: any[]) => setPositions(p));
    socket.on('walletActivity', (a: any) => setWalletActivity(prev => [a, ...prev].slice(0, 100)));
    socket.on('state', (s: any) => {
      setAggregated(s.signals || []); setPositions(s.positions || []);
      setWatchlist(s.watchlist || []); setWallets(s.wallets || []);
      setAutoTrade(s.autoTrade || false);
    });
    socket.on('trenchesUpdate', (t: any[]) => { setTrenchTokens(t); setTrenchesLastUpdate(Date.now()); });
    socket.on('futuresSetups', (s: any[]) => { setFuturesSetups(s); setFuturesLastUpdate(Date.now()); });
    return () => { socket.disconnect(); };
  }, []);

  // ---- Handlers ----
  const handleRunPipeline = async () => {
    setLoading(true);
    try { const r = await api.runPipeline(); setSignals(r.signals || []); setAggregated(r.aggregated || []); await refresh(); }
    catch (e) { console.error(e); }
    setLoading(false);
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    const r = await api.searchTokens(searchQuery);
    setSearchResults(r.pairs || []);
  };

  const handleAnalyse = async (symbol: string, chain = 'any') => {
    setLoading(true);
    try { setAnalysisResult(await api.analyseToken(symbol, chain)); } catch (e) { console.error(e); }
    setLoading(false);
  };

  const handleAddWatchlist = async () => {
    if (!addSymbol.trim()) return;
    await api.addToWatchlist(addSymbol.toUpperCase(), addChain);
    setAddSymbol(''); refresh();
  };

  const handleGenerateFutures = async () => {
    setLoading(true);
    try {
      const r = await api.generateFuturesSetups();
      setFuturesSetups(r.setups || []); setFuturesLastUpdate(Date.now()); await refresh();
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  const handleScanTrenches = async () => {
    setLoading(true);
    try {
      const r = await api.scanTrenches();
      setTrenchTokens(r.tokens || []); setTrenchesLastUpdate(Date.now()); await refresh();
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  const handleTrackTrench = async () => {
    if (!trenchInput.trim()) return;
    try { await api.trackTrenchToken(trenchInput.trim()); setTrenchInput(''); await refresh(); }
    catch (e) { console.error(e); }
  };

  const handleAddWallet = async () => {
    if (!newWallet.trim()) return;
    await api.addWallet(newWallet.trim());
    setNewWallet(''); refresh();
  };

  // ---- Helpers ----
  const confColor = (c: number) => c >= 80 ? 'text-emerald-400' : c >= 60 ? 'text-amber-400' : c >= 40 ? 'text-blue-400' : 'text-red-400';
  const confBg = (c: number) => c >= 80 ? 'bg-emerald-500' : c >= 60 ? 'bg-amber-500' : c >= 40 ? 'bg-blue-500' : 'bg-red-500';

  const formatPrice = (p: number) => {
    if (!p || p === 0) return '$0';
    if (p >= 1000) return `$${p.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
    if (p >= 1) return `$${p.toFixed(2)}`;
    if (p >= 0.001) return `$${p.toFixed(4)}`;
    return `$${p.toFixed(8)}`;
  };

  const formatAge = (h: number) => {
    if (h < 1) return `${Math.floor(h * 60)}m`;
    if (h < 24) return `${Math.floor(h)}h`;
    if (h < 168) return `${Math.floor(h / 24)}d`;
    return `${Math.floor(h / 168)}w`;
  };

  const timeAgo = (ts: number) => {
    if (!ts) return '--';
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 5) return 'just now';
    if (s < 60) return `${s}s ago`;
    return `${Math.floor(s / 60)}m ago`;
  };

  const filteredTrench = trenchFilter === 'ALL' ? trenchTokens : trenchTokens.filter((t: any) => t.ageLabel === trenchFilter);

  const formatCompact = (n: number) => {
    if (!n) return '$0';
    if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
    if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
    if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
    return `$${n.toFixed(0)}`;
  };

  const flowColor = (flow: string) => flow === 'accumulating' ? 'text-emerald-400' : flow === 'distributing' ? 'text-red-400' : 'text-zinc-400';
  const pumpScoreColor = (s: number) => s >= 60 ? 'text-emerald-400' : s >= 40 ? 'text-amber-400' : s >= 20 ? 'text-blue-400' : 'text-zinc-500';
  const pumpScoreBg = (s: number) => s >= 60 ? 'bg-emerald-500' : s >= 40 ? 'bg-amber-500' : s >= 20 ? 'bg-blue-500' : 'bg-zinc-600';

  // ============================================
  // RENDER
  // ============================================
  return (
    <div className="min-h-screen bg-background">
      {/* ---- HEADER ---- */}
      <motion.header
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        className="sticky top-0 z-50 w-full border-b border-border/60 backdrop-blur-xl bg-background/80"
      >
        <div className="max-w-[1480px] mx-auto flex items-center justify-between px-5 h-14">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center">
              <Activity className="w-4 h-4 text-white" />
            </div>
            <h1 className="text-base font-bold tracking-tight">Token Analyser</h1>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span className={cn('w-2 h-2 rounded-full', status?.exchangeConnected ? 'bg-emerald-400' : 'bg-red-400')} />
              <span className="text-xs text-muted-foreground">Exchange</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-400" />
              <span className="text-xs text-muted-foreground">Agent</span>
            </div>
            <div className="flex items-center gap-2 ml-2">
              <span className="text-xs text-muted-foreground">Auto-Trade</span>
              <Switch checked={autoTrade} onCheckedChange={(v) => { setAutoTrade(v); api.setAutoTrade(v); }} />
            </div>
            <Button size="sm" onClick={handleRunPipeline} disabled={loading} className="ml-2">
              <RefreshCw className={cn('w-3.5 h-3.5 mr-1.5', loading && 'animate-spin')} />
              {loading ? 'Scanning...' : 'Run Pipeline'}
            </Button>
          </div>
        </div>
      </motion.header>

      <main className="max-w-[1480px] mx-auto px-5 py-5 space-y-5">
        {/* ---- STAT CARDS ---- */}
        <motion.div initial="initial" animate="animate" variants={staggerContainer} className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {[
            { label: 'Balance', value: `$${status?.balance?.total?.toFixed(2) || '0.00'}`, color: 'text-blue-400', icon: Wallet },
            { label: 'Total PnL', value: `$${(status?.totalPnL || 0).toFixed(2)}`, color: (status?.totalPnL || 0) >= 0 ? 'text-emerald-400' : 'text-red-400', icon: TrendingUp },
            { label: 'Open Positions', value: status?.openPositions || 0, color: 'text-foreground', icon: BarChart3 },
            { label: 'Active Signals', value: aggregated.length, color: 'text-foreground', icon: Zap },
            { label: 'Watchlist', value: status?.watchlistSize || 0, color: 'text-foreground', icon: Eye },
          ].map((stat, i) => (
            <motion.div key={i} variants={fadeInUp}>
              <Card className="bg-card/50 border-border/50">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium">{stat.label}</span>
                    <stat.icon className="w-3.5 h-3.5 text-muted-foreground" />
                  </div>
                  <span className={cn('text-xl font-bold tabular-nums', stat.color)}>{stat.value}</span>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </motion.div>

        {/* ---- FUTURES & TRENCHES ---- */}
        <Tabs defaultValue="futures" className="space-y-4">
          <div className="flex items-center justify-between">
            <TabsList className="bg-secondary/60">
              <TabsTrigger value="futures" className="gap-1.5 data-[state=active]:bg-blue-500/15 data-[state=active]:text-blue-400">
                <BarChart3 className="w-3.5 h-3.5" /> Futures Trading
              </TabsTrigger>
              <TabsTrigger value="trenches" className="gap-1.5 data-[state=active]:bg-purple-500/15 data-[state=active]:text-purple-400">
                <Flame className="w-3.5 h-3.5" /> Sol Trenches
              </TabsTrigger>
            </TabsList>
          </div>

          {/* ---- FUTURES TAB ---- */}
          <TabsContent value="futures">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }}>
              <Card className="gradient-border-blue border-border/50">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <CardTitle className="text-blue-400 flex items-center gap-2">
                        <BarChart3 className="w-4 h-4" /> Futures Trading Setups
                      </CardTitle>
                      <Badge variant="info" className="tabular-nums">{futuresSetups.length}</Badge>
                      <div className="flex items-center gap-1.5 text-emerald-400">
                        <Radio className="w-3 h-3 animate-live-pulse" />
                        <span className="text-[10px] font-bold tracking-widest">LIVE</span>
                      </div>
                      <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                        <Clock className="w-3 h-3" /> {timeAgo(futuresLastUpdate)}
                      </span>
                    </div>
                    <Button size="sm" onClick={handleGenerateFutures} disabled={loading}
                      className="bg-blue-600 hover:bg-blue-700 text-white">
                      <RefreshCw className={cn('w-3 h-3 mr-1.5', loading && 'animate-spin')} />
                      Generate
                    </Button>
                  </div>
                </CardHeader>
                <CardContent>
                  {futuresSetups.length === 0 ? (
                    <div className="text-center py-12 text-muted-foreground">
                      <BarChart3 className="w-10 h-10 mx-auto mb-3 opacity-30" />
                      <p className="text-sm">No futures setups yet. Click Generate to scan exchange perps.</p>
                    </div>
                  ) : (
                    <motion.div variants={staggerContainer} initial="initial" animate="animate" className="futures-grid">
                      <AnimatePresence mode="popLayout">
                        {futuresSetups.map((s: any, i: number) => (
                          <motion.div key={s.id || i} variants={cardSpring} layout>
                            <Card className="bg-secondary/30 border-border/40 hover:border-blue-500/30 transition-colors cursor-pointer"
                              onClick={() => setExpandedSetup(expandedSetup === s.id ? null : s.id)}>
                              <CardContent className="p-4 space-y-3">
                                {/* Header */}
                                <div className="flex items-center justify-between">
                                  <div className="flex items-center gap-2">
                                    <span className="font-bold text-sm">{s.pair || s.symbol}</span>
                                    <Badge variant={s.direction === 'LONG' ? 'long' : 'short'} className="text-[10px]">
                                      {s.direction === 'LONG' ? <TrendingUp className="w-3 h-3 mr-0.5" /> : <TrendingDown className="w-3 h-3 mr-0.5" />}
                                      {s.direction}
                                    </Badge>
                                  </div>
                                  <div className="flex items-center gap-2">
                                    <Badge variant="outline" className="text-[10px] text-muted-foreground">{s.exchange || 'Gate.io'}</Badge>
                                    <span className={cn('text-sm font-bold tabular-nums', confColor(s.confidence))}>{s.confidence?.toFixed(0)}%</span>
                                  </div>
                                </div>

                                {/* Price Levels */}
                                <div className="flex gap-2">
                                  <div className="price-level entry">
                                    <span className="price-level-label">Entry</span>
                                    <span className="price-level-value">{formatPrice(s.entry)}</span>
                                  </div>
                                  <div className="price-level sl">
                                    <span className="price-level-label">Stop Loss</span>
                                    <span className="price-level-value">{formatPrice(s.stopLoss)}</span>
                                  </div>
                                  <div className="price-level tp">
                                    <span className="price-level-label">Take Profit</span>
                                    <span className="price-level-value">{formatPrice(s.takeProfit)}</span>
                                  </div>
                                </div>

                                {/* Market data row */}
                                {(s.marketCap || s.volume24h || s.priceChange24h !== undefined) && (
                                  <div className="flex items-center gap-2 flex-wrap text-[10px]">
                                    {s.marketCap ? <span className="text-muted-foreground"><DollarSign className="w-3 h-3 inline" /> MCap {formatCompact(s.marketCap)}</span> : null}
                                    {s.volume24h ? <span className="text-muted-foreground">Vol {formatCompact(s.volume24h)}</span> : null}
                                    {s.priceChange24h !== undefined && s.priceChange24h !== 0 ? (
                                      <span className={cn(s.priceChange24h >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                                        24h {s.priceChange24h > 0 ? '+' : ''}{s.priceChange24h?.toFixed(1)}%
                                      </span>
                                    ) : null}
                                    {s.priceChange7d !== undefined && s.priceChange7d !== 0 ? (
                                      <span className={cn(s.priceChange7d >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                                        7d {s.priceChange7d > 0 ? '+' : ''}{s.priceChange7d?.toFixed(1)}%
                                      </span>
                                    ) : null}
                                    {s.cmcRank ? <span className="text-muted-foreground">Rank #{s.cmcRank}</span> : null}
                                  </div>
                                )}

                                {/* Meta row */}
                                <div className="flex items-center gap-2 flex-wrap">
                                  <Badge variant="secondary" className="text-[10px]">{s.leverage}x Lev</Badge>
                                  <Badge variant="secondary" className="text-[10px]">R:R {s.riskReward?.toFixed(1)}</Badge>
                                  {s.technicals && (
                                    <>
                                      <Badge variant="info" className="text-[10px]">RSI {s.technicals.rsi?.toFixed(1)}</Badge>
                                      <Badge variant={s.technicals.macd === 'bullish' ? 'success' : 'destructive'} className="text-[10px]">
                                        MACD {s.technicals.macd}
                                      </Badge>
                                      <Badge
                                        variant={s.technicals.trend === 'uptrend' ? 'success' : s.technicals.trend === 'downtrend' ? 'destructive' : 'warning'}
                                        className="text-[10px]"
                                      >
                                        {s.technicals.trend}
                                      </Badge>
                                    </>
                                  )}
                                </div>

                                {/* News sentiment */}
                                {s.news?.headline && (
                                  <div className="flex items-start gap-1.5 text-[10px] bg-background/40 rounded-md p-2">
                                    <FileText className="w-3 h-3 mt-0.5 shrink-0 text-amber-400" />
                                    <div>
                                      <span className={cn('font-semibold mr-1',
                                        s.news.sentiment === 'bullish' ? 'text-emerald-400' : s.news.sentiment === 'bearish' ? 'text-red-400' : 'text-zinc-400'
                                      )}>
                                        {s.news.sentiment.toUpperCase()}
                                      </span>
                                      <span className="text-muted-foreground line-clamp-1">{s.news.headline}</span>
                                      {s.news.source && <span className="text-zinc-600 ml-1">— {s.news.source}</span>}
                                    </div>
                                  </div>
                                )}

                                {/* Exchanges */}
                                {s.exchanges?.length > 0 && (
                                  <div className="flex items-center gap-1 flex-wrap">
                                    <Globe className="w-3 h-3 text-muted-foreground" />
                                    {s.exchanges.slice(0, 5).map((ex: string) => (
                                      <Badge key={ex} variant="outline" className="text-[9px] px-1.5 py-0 text-muted-foreground">{ex}</Badge>
                                    ))}
                                    {s.exchanges.length > 5 && <span className="text-[9px] text-muted-foreground">+{s.exchanges.length - 5}</span>}
                                  </div>
                                )}

                                {/* Confidence bar */}
                                <div className="w-full h-1 rounded-full bg-muted overflow-hidden">
                                  <motion.div
                                    className={cn('h-full rounded-full', confBg(s.confidence))}
                                    initial={{ width: 0 }}
                                    animate={{ width: `${s.confidence}%` }}
                                    transition={{ duration: 0.8, ease: 'easeOut' }}
                                  />
                                </div>

                                {/* Reason */}
                                {s.reason && (
                                  <p className="text-[11px] text-muted-foreground leading-relaxed line-clamp-2 pt-1 border-t border-border/30">{s.reason}</p>
                                )}

                                {/* Expanded detailed analysis */}
                                <AnimatePresence>
                                  {expandedSetup === s.id && s.analysisDetail && (
                                    <motion.div
                                      initial={{ height: 0, opacity: 0 }}
                                      animate={{ height: 'auto', opacity: 1 }}
                                      exit={{ height: 0, opacity: 0 }}
                                      className="overflow-hidden"
                                    >
                                      <div className="pt-2 mt-1 border-t border-blue-500/20 space-y-1.5">
                                        <span className="text-[10px] font-semibold text-blue-400 uppercase tracking-wider">Detailed Analysis</span>
                                        <p className="text-[11px] text-muted-foreground leading-relaxed whitespace-pre-line">{s.analysisDetail}</p>
                                        {s.technicals && (
                                          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px] pt-1">
                                            <span className="text-muted-foreground">EMA20: <span className="text-foreground font-medium">{formatPrice(s.technicals.ema20)}</span></span>
                                            <span className="text-muted-foreground">EMA50: <span className="text-foreground font-medium">{formatPrice(s.technicals.ema50)}</span></span>
                                            <span className="text-muted-foreground">Bollinger: <span className="text-foreground font-medium">{s.technicals.bollinger}</span></span>
                                            <span className="text-muted-foreground">SL Distance: <span className="text-foreground font-medium">{((Math.abs(s.entry - s.stopLoss) / s.entry) * 100).toFixed(2)}%</span></span>
                                          </div>
                                        )}
                                      </div>
                                    </motion.div>
                                  )}
                                </AnimatePresence>
                              </CardContent>
                            </Card>
                          </motion.div>
                        ))}
                      </AnimatePresence>
                    </motion.div>
                  )}
                </CardContent>
              </Card>
            </motion.div>
          </TabsContent>

          {/* ---- SOL TRENCHES TAB ---- */}
          <TabsContent value="trenches">
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }}>
              <Card className="gradient-border-purple border-border/50">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <CardTitle className="text-purple-400 flex items-center gap-2">
                        <Flame className="w-4 h-4" /> Sol Trenches
                      </CardTitle>
                      <Badge variant="purple" className="tabular-nums">{trenchTokens.length}</Badge>
                      <div className="flex items-center gap-1.5 text-purple-400">
                        <Radio className="w-3 h-3 animate-live-pulse" />
                        <span className="text-[10px] font-bold tracking-widest">LIVE</span>
                      </div>
                      <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                        <Clock className="w-3 h-3" /> {timeAgo(trenchesLastUpdate)}
                      </span>
                    </div>
                    <Button size="sm" onClick={handleScanTrenches} disabled={loading}
                      className="bg-purple-600 hover:bg-purple-700 text-white">
                      <RefreshCw className={cn('w-3 h-3 mr-1.5', loading && 'animate-spin')} />
                      Scan Trenches
                    </Button>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {/* Fund Flow Summary */}
                  {flowSummary && (
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      <div className="rounded-lg bg-background/40 p-2.5 text-center">
                        <span className="text-[10px] text-muted-foreground block">Net Flow</span>
                        <span className={cn('text-sm font-bold tabular-nums', (flowSummary.totalNetFlow || 0) >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                          {(flowSummary.totalNetFlow || 0) >= 0 ? '+' : ''}{formatCompact(flowSummary.totalNetFlow || 0)}
                        </span>
                      </div>
                      <div className="rounded-lg bg-background/40 p-2.5 text-center">
                        <span className="text-[10px] text-muted-foreground block">Accumulating</span>
                        <span className="text-sm font-bold text-emerald-400 tabular-nums">{flowSummary.accumulating || 0}</span>
                      </div>
                      <div className="rounded-lg bg-background/40 p-2.5 text-center">
                        <span className="text-[10px] text-muted-foreground block">Distributing</span>
                        <span className="text-sm font-bold text-red-400 tabular-nums">{flowSummary.distributing || 0}</span>
                      </div>
                      <div className="rounded-lg bg-background/40 p-2.5 text-center">
                        <span className="text-[10px] text-muted-foreground block">Pump Alerts</span>
                        <span className="text-sm font-bold text-amber-400 tabular-nums">{flowSummary.topPumps?.length || 0}</span>
                      </div>
                    </div>
                  )}

                  {/* Pump Candidates */}
                  {pumpCandidates.length > 0 && (
                    <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-3 space-y-2">
                      <div className="flex items-center gap-1.5">
                        <Zap className="w-3.5 h-3.5 text-amber-400" />
                        <span className="text-xs font-semibold text-amber-400">Pump Candidates — Fund Flow Detected</span>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {pumpCandidates.slice(0, 6).map((t: any, i: number) => (
                          <div key={t.address || i} className="flex items-center justify-between bg-background/40 rounded-md p-2">
                            <div className="flex items-center gap-2">
                              <span className="font-bold text-xs">{t.symbol}</span>
                              <Badge variant={t.ageLabel === 'NEW' ? 'success' : t.ageLabel === 'RECENT' ? 'warning' : 'info'} className="text-[9px] px-1 py-0">{t.ageLabel}</Badge>
                            </div>
                            <div className="flex items-center gap-2">
                              <div className="text-right">
                                <span className={cn('text-xs font-bold tabular-nums', pumpScoreColor(t.fundFlow?.pumpScore || 0))}>{t.fundFlow?.pumpScore || 0}</span>
                                <span className="text-[9px] text-muted-foreground">/100</span>
                              </div>
                              <div className="w-12 h-1 rounded-full bg-muted overflow-hidden">
                                <div className={cn('h-full rounded-full', pumpScoreBg(t.fundFlow?.pumpScore || 0))} style={{ width: `${t.fundFlow?.pumpScore || 0}%` }} />
                              </div>
                              <span className={cn('text-[9px] font-medium', flowColor(t.fundFlow?.flowTrend || 'neutral'))}>
                                {t.fundFlow?.flowTrend === 'accumulating' ? <ArrowUpRight className="w-3 h-3 inline" /> : t.fundFlow?.flowTrend === 'distributing' ? <ArrowDownRight className="w-3 h-3 inline" /> : null}
                                {t.fundFlow?.flowTrend}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Stats + Filters */}
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div className="flex gap-2">
                      <Badge variant="success" className="text-xs">NEW {trenchCounts.new}</Badge>
                      <Badge variant="warning" className="text-xs">RECENT {trenchCounts.recent}</Badge>
                      <Badge variant="info" className="text-xs">OLD {trenchCounts.established}</Badge>
                    </div>
                    <div className="flex gap-1">
                      {(['ALL', 'NEW', 'RECENT', 'ESTABLISHED'] as const).map(f => (
                        <Button key={f} size="xs"
                          variant={trenchFilter === f ? 'default' : 'ghost'}
                          className={cn(trenchFilter === f && 'bg-purple-600 hover:bg-purple-700 text-white')}
                          onClick={() => setTrenchFilter(f)}
                        >
                          {f === 'ESTABLISHED' ? 'OLD' : f}
                        </Button>
                      ))}
                    </div>
                  </div>

                  {/* Track input */}
                  <div className="flex gap-2">
                    <Input
                      placeholder="Token address or symbol to track..."
                      value={trenchInput}
                      onChange={e => setTrenchInput(e.target.value)}
                      onKeyDown={e => e.key === 'Enter' && handleTrackTrench()}
                      className="bg-secondary/40"
                    />
                    <Button variant="success" size="sm" onClick={handleTrackTrench}>Track</Button>
                  </div>

                  {/* Table */}
                  {filteredTrench.length === 0 ? (
                    <div className="text-center py-12 text-muted-foreground">
                      <Flame className="w-10 h-10 mx-auto mb-3 opacity-30" />
                      <p className="text-sm">No tokens found. Scan the trenches.</p>
                    </div>
                  ) : (
                    <div className="overflow-x-auto -mx-5 px-5">
                      <table className="data-table">
                        <thead>
                          <tr>
                            <th>Token</th><th>Age</th><th>Price</th><th>5m</th><th>1h</th><th>24h</th><th>Vol 24h</th><th>Liq</th><th>Buy Press.</th><th>Flow</th><th>Pump</th><th></th>
                          </tr>
                        </thead>
                        <tbody>
                          <AnimatePresence>
                            {filteredTrench.slice(0, 30).map((t: any, i: number) => (
                              <motion.tr key={t.address || i} variants={fadeInUp} initial="initial" animate="animate" exit="exit" layout>
                                <td>
                                  <div className="flex items-center gap-1.5">
                                    <span className="font-semibold">{t.symbol}</span>
                                    <Badge variant={t.ageLabel === 'NEW' ? 'success' : t.ageLabel === 'RECENT' ? 'warning' : 'info'} className="text-[9px] px-1.5 py-0">
                                      {t.ageLabel}
                                    </Badge>
                                  </div>
                                </td>
                                <td className="text-muted-foreground tabular-nums">{formatAge(t.ageHours)}</td>
                                <td className="font-medium tabular-nums">{formatPrice(t.price)}</td>
                                <td className={cn('tabular-nums font-medium', (t.priceChange5m || 0) >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                                  {(t.priceChange5m || 0).toFixed(1)}%
                                </td>
                                <td className={cn('tabular-nums font-medium', (t.priceChange1h || 0) >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                                  {(t.priceChange1h || 0).toFixed(1)}%
                                </td>
                                <td className={cn('tabular-nums font-medium', (t.priceChange24h || 0) >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                                  {(t.priceChange24h || 0).toFixed(1)}%
                                </td>
                                <td className="tabular-nums text-muted-foreground">{formatCompact(t.volume24h || 0)}</td>
                                <td className="tabular-nums text-muted-foreground">{formatCompact(t.liquidity || 0)}</td>
                                <td>
                                  <div className="flex items-center gap-1">
                                    <span className={cn('tabular-nums text-xs font-medium', (t.fundFlow?.buyPressure || 50) > 55 ? 'text-emerald-400' : (t.fundFlow?.buyPressure || 50) < 45 ? 'text-red-400' : 'text-zinc-400')}>
                                      {(t.fundFlow?.buyPressure || 50).toFixed(0)}%
                                    </span>
                                    <div className="w-8 h-1 rounded-full bg-muted overflow-hidden">
                                      <div className={cn('h-full rounded-full', (t.fundFlow?.buyPressure || 50) > 55 ? 'bg-emerald-500' : (t.fundFlow?.buyPressure || 50) < 45 ? 'bg-red-500' : 'bg-zinc-500')}
                                        style={{ width: `${t.fundFlow?.buyPressure || 50}%` }} />
                                    </div>
                                  </div>
                                </td>
                                <td>
                                  <span className={cn('text-[10px] font-medium', flowColor(t.fundFlow?.flowTrend || 'neutral'))}>
                                    {t.fundFlow?.flowTrend === 'accumulating' ? '↗ ACC' : t.fundFlow?.flowTrend === 'distributing' ? '↘ DIST' : '— NEU'}
                                  </span>
                                </td>
                                <td>
                                  <span className={cn('text-xs font-bold tabular-nums', pumpScoreColor(t.fundFlow?.pumpScore || 0))}>
                                    {t.fundFlow?.pumpScore || 0}
                                  </span>
                                </td>
                                <td>
                                  <Button variant="ghost" size="xs" onClick={() => { api.removeTrenchToken(t.address); refresh(); }}
                                    className="text-red-400 hover:text-red-300 hover:bg-red-500/10">
                                    <X className="w-3 h-3" />
                                  </Button>
                                </td>
                              </motion.tr>
                            ))}
                          </AnimatePresence>
                        </tbody>
                      </table>
                    </div>
                  )}
                </CardContent>
              </Card>
            </motion.div>
          </TabsContent>
        </Tabs>

        {/* ---- BOTTOM GRID ---- */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* ---- SIGNALS ---- */}
          <motion.div {...fadeInUp} transition={{ delay: 0.1 }}>
            <Card className="border-border/50 h-full">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Zap className="w-4 h-4 text-amber-400" /> Aggregated Signals
                  <Badge variant="secondary" className="ml-1">{aggregated.length}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {aggregated.length === 0 ? (
                  <p className="text-center py-8 text-sm text-muted-foreground">No signals yet. Run the pipeline.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="data-table">
                      <thead><tr><th>Token</th><th>Chain</th><th>Dir</th><th>Confidence</th><th>Price</th></tr></thead>
                      <tbody>
                        {aggregated.map((s: any, i: number) => (
                          <tr key={i}>
                            <td className="font-semibold">{s.symbol}</td>
                            <td><Badge variant="outline" className="text-[10px]">{s.chain}</Badge></td>
                            <td>
                              <Badge variant={s.direction === 'LONG' ? 'long' : 'short'} className="text-[10px]">{s.direction}</Badge>
                            </td>
                            <td>
                              <div className="flex items-center gap-1.5">
                                <span className={cn('text-sm font-semibold tabular-nums', confColor(s.totalConfidence))}>{s.totalConfidence?.toFixed(0)}%</span>
                                <div className="conf-bar">
                                  <div className="fill" style={{ width: `${s.totalConfidence}%`, background: s.totalConfidence >= 70 ? '#10b981' : s.totalConfidence >= 50 ? '#f59e0b' : '#3b82f6' }} />
                                </div>
                              </div>
                            </td>
                            <td className="tabular-nums">${s.suggestedEntry?.toFixed(6)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardContent>
            </Card>
          </motion.div>

          {/* ---- POSITIONS ---- */}
          <motion.div {...fadeInUp} transition={{ delay: 0.15 }}>
            <Card className="border-border/50 h-full">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <BarChart3 className="w-4 h-4 text-blue-400" /> Open Positions
                  <Badge variant="secondary" className="ml-1">{positions.length}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {positions.length === 0 ? (
                  <p className="text-center py-8 text-sm text-muted-foreground">No open positions</p>
                ) : (
                  <table className="data-table">
                    <thead><tr><th>Symbol</th><th>Side</th><th>Entry</th><th>Current</th><th>PnL</th><th></th></tr></thead>
                    <tbody>
                      {positions.map((p: any) => (
                        <tr key={p.id}>
                          <td className="font-semibold">{p.symbol}</td>
                          <td>
                            <Badge variant={p.side === 'LONG' ? 'long' : 'short'} className="text-[10px]">{p.side} {p.leverage}x</Badge>
                          </td>
                          <td className="tabular-nums">${p.entryPrice?.toFixed(4)}</td>
                          <td className="tabular-nums">${p.currentPrice?.toFixed(4)}</td>
                          <td className={cn('font-semibold tabular-nums', p.pnl >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                            ${p.pnl?.toFixed(2)} ({p.pnlPct?.toFixed(1)}%)
                          </td>
                          <td>
                            <Button variant="destructive" size="xs" onClick={() => { api.closePosition(p.id); refresh(); }}>Close</Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </CardContent>
            </Card>
          </motion.div>

          {/* ---- SEARCH & ANALYSIS ---- */}
          <motion.div {...fadeInUp} transition={{ delay: 0.2 }}>
            <Card className="border-border/50 h-full">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Search className="w-4 h-4 text-cyan-400" /> Token Search & Analysis
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex gap-2">
                  <Input placeholder="Search token (e.g. WIF, BONK)..." value={searchQuery}
                    onChange={e => setSearchQuery(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleSearch()}
                    className="bg-secondary/40"
                  />
                  <Button size="sm" onClick={handleSearch}><Search className="w-3 h-3 mr-1" />Search</Button>
                </div>

                {searchResults.length > 0 && (
                  <table className="data-table">
                    <thead><tr><th>Token</th><th>Chain</th><th>Price</th><th>24h</th><th></th></tr></thead>
                    <tbody>
                      {searchResults.slice(0, 8).map((p: any, i: number) => (
                        <tr key={i}>
                          <td className="font-semibold">{p.baseToken?.symbol}</td>
                          <td><Badge variant="outline" className="text-[10px]">{p.chainId}</Badge></td>
                          <td className="tabular-nums">${parseFloat(p.priceUsd || 0).toFixed(6)}</td>
                          <td className={cn('tabular-nums font-medium', (p.priceChange?.h24 || 0) >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                            {(p.priceChange?.h24 || 0).toFixed(1)}%
                          </td>
                          <td>
                            <Button size="xs" variant="secondary" onClick={() => handleAnalyse(p.baseToken?.symbol, p.chainId)}>
                              Analyse
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                {analysisResult && (
                  <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                    className="rounded-lg bg-secondary/40 p-3 space-y-2"
                  >
                    <h4 className="text-sm font-semibold">{analysisResult.analysis?.symbol} Analysis</h4>
                    <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                      <span>Price: <span className="font-medium">${analysisResult.analysis?.price?.toFixed(6)}</span></span>
                      <span>24h: <span className={cn('font-medium', (analysisResult.analysis?.priceChange24h || 0) >= 0 ? 'text-emerald-400' : 'text-red-400')}>{analysisResult.analysis?.priceChange24h?.toFixed(1)}%</span></span>
                      <span>RSI: <span className="font-medium">{analysisResult.analysis?.technicals?.rsi?.toFixed(1)}</span></span>
                      <span>Trend: <span className="font-medium">{analysisResult.analysis?.technicals?.trend}</span></span>
                      <span>MACD: <span className="font-medium">{analysisResult.analysis?.technicals?.macdSignal}</span></span>
                      <span>Vol: <span className="font-medium">${(analysisResult.analysis?.volume24h || 0).toLocaleString()}</span></span>
                      <span>Liq: <span className="font-medium">${(analysisResult.analysis?.liquidity || 0).toLocaleString()}</span></span>
                      <span>Score: <span className="font-medium">{analysisResult.analysis?.overallScore}/100</span></span>
                    </div>
                    {analysisResult.signal && (
                      <div className="rounded-md bg-background/60 p-2 text-xs">
                        <Badge variant={analysisResult.signal.direction === 'LONG' ? 'long' : 'short'} className="text-[10px] mr-2">
                          {analysisResult.signal.direction}
                        </Badge>
                        Confidence: {analysisResult.signal.confidence}%
                        <p className="text-muted-foreground mt-1 text-[11px]">{analysisResult.signal.reason}</p>
                      </div>
                    )}
                  </motion.div>
                )}
              </CardContent>
            </Card>
          </motion.div>

          {/* ---- WATCHLIST ---- */}
          <motion.div {...fadeInUp} transition={{ delay: 0.25 }}>
            <Card className="border-border/50 h-full">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Eye className="w-4 h-4 text-cyan-400" /> Watchlist
                  <Badge variant="secondary" className="ml-1">{watchlist.length}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex gap-2">
                  <Input placeholder="Symbol (e.g. SOL)" value={addSymbol}
                    onChange={e => setAddSymbol(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleAddWatchlist()}
                    className="bg-secondary/40"
                  />
                  <select value={addChain} onChange={e => setAddChain(e.target.value)}
                    className="h-10 rounded-md border border-input bg-background px-3 text-sm">
                    <option value="any">Any</option>
                    <option value="solana">Solana</option>
                    <option value="ethereum">Ethereum</option>
                    <option value="bsc">BSC</option>
                    <option value="arbitrum">Arbitrum</option>
                    <option value="base">Base</option>
                  </select>
                  <Button variant="success" size="sm" onClick={handleAddWatchlist}>Add</Button>
                </div>
                {watchlist.length === 0 ? (
                  <p className="text-center py-6 text-sm text-muted-foreground">Add tokens for automated scanning</p>
                ) : (
                  <table className="data-table">
                    <thead><tr><th>Symbol</th><th>Chain</th><th></th></tr></thead>
                    <tbody>
                      {watchlist.map((t: any, i: number) => (
                        <tr key={i}>
                          <td className="font-semibold">{t.symbol}</td>
                          <td><Badge variant="outline" className="text-[10px]">{t.chain}</Badge></td>
                          <td>
                            <Button variant="ghost" size="xs" onClick={() => { api.removeFromWatchlist(t.symbol, t.chain); refresh(); }}
                              className="text-red-400 hover:text-red-300 hover:bg-red-500/10"><X className="w-3 h-3" /></Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </CardContent>
            </Card>
          </motion.div>

          {/* ---- WALLET TRACKER ---- */}
          <motion.div {...fadeInUp} transition={{ delay: 0.3 }}>
            <Card className="border-border/50 h-full">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <Wallet className="w-4 h-4 text-emerald-400" /> Solana Wallet Tracker
                  <Badge variant="secondary" className="ml-1">{wallets.length}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="flex gap-2">
                  <Input placeholder="Solana wallet address..." value={newWallet}
                    onChange={e => setNewWallet(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && handleAddWallet()}
                    className="bg-secondary/40"
                  />
                  <Button variant="success" size="sm" onClick={handleAddWallet}>Track</Button>
                </div>
                {wallets.length > 0 && (
                  <div className="space-y-1">
                    {wallets.map((w: string) => (
                      <div key={w} className="flex items-center justify-between py-1.5 px-2 rounded-md hover:bg-secondary/40 text-xs">
                        <code className="text-muted-foreground">{w.slice(0, 8)}...{w.slice(-6)}</code>
                        <Button variant="ghost" size="xs" onClick={() => { api.removeWallet(w); refresh(); }}
                          className="text-red-400 hover:text-red-300 hover:bg-red-500/10"><X className="w-3 h-3" /></Button>
                      </div>
                    ))}
                  </div>
                )}
                <h4 className="text-xs font-medium text-muted-foreground pt-1">Recent Activity</h4>
                {walletActivity.length === 0 ? (
                  <p className="text-center py-4 text-xs text-muted-foreground">No activity detected</p>
                ) : (
                  <div className="space-y-1 max-h-48 overflow-y-auto">
                    {walletActivity.slice(0, 15).map((a: any, i: number) => (
                      <div key={i} className="text-xs py-1 border-b border-border/30">
                        <Badge variant={a.type === 'buy' ? 'success' : 'destructive'} className="text-[9px] mr-1">{a.type?.toUpperCase()}</Badge>
                        {a.token} <span className="text-muted-foreground">by {a.wallet?.slice(0, 6)}...</span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </motion.div>

          {/* ---- NEWS ---- */}
          <motion.div {...fadeInUp} transition={{ delay: 0.35 }}>
            <Card className="border-border/50 h-full">
              <CardHeader className="pb-3">
                <CardTitle className="flex items-center gap-2 text-sm">
                  <ChevronRight className="w-4 h-4 text-amber-400" /> News & Sentiment
                  <Badge variant="secondary" className="ml-1">{news.length}</Badge>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {news.length === 0 ? (
                  <p className="text-center py-8 text-xs text-muted-foreground">No news data. Set CRYPTOPANIC_API_KEY in .env</p>
                ) : (
                  <div className="space-y-2 max-h-72 overflow-y-auto">
                    {news.slice(0, 15).map((n: any, i: number) => (
                      <div key={i} className="py-2 border-b border-border/30">
                        <div className="flex items-start gap-1.5 text-sm">
                          <Badge variant={n.sentiment === 'positive' ? 'success' : n.sentiment === 'negative' ? 'destructive' : 'secondary'}
                            className="text-[9px] mt-0.5 shrink-0">
                            {n.sentiment === 'positive' ? '+' : n.sentiment === 'negative' ? '-' : '~'}
                          </Badge>
                          <span className="line-clamp-2 text-xs">{n.title}</span>
                        </div>
                        <p className="text-[10px] text-muted-foreground mt-1 ml-6">
                          {n.source} | {n.relevantTokens?.join(', ') || 'General'} | Score: {n.score}
                        </p>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </motion.div>
        </div>

        {/* ---- RAW SIGNALS ---- */}
        <motion.div {...fadeInUp} transition={{ delay: 0.4 }}>
          <Card className="border-border/50">
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-sm">
                <Activity className="w-4 h-4 text-red-400" /> Raw Signal Log
                <Badge variant="secondary" className="ml-1">{signals.length}</Badge>
              </CardTitle>
            </CardHeader>
            <CardContent>
              {signals.length === 0 ? (
                <p className="text-center py-6 text-sm text-muted-foreground">No raw signals in this cycle</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="data-table">
                    <thead><tr><th>Token</th><th>Dir</th><th>Confidence</th><th>Source</th><th>Reason</th></tr></thead>
                    <tbody>
                      {signals.slice(0, 20).map((s: any, i: number) => (
                        <tr key={i}>
                          <td className="font-semibold">{s.symbol}</td>
                          <td><Badge variant={s.direction === 'LONG' ? 'long' : 'short'} className="text-[10px]">{s.direction}</Badge></td>
                          <td className="tabular-nums">{s.confidence}%</td>
                          <td><Badge variant="secondary" className="text-[10px]">{s.source}</Badge></td>
                          <td className="max-w-[260px] truncate text-muted-foreground text-xs">{s.reason}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
        </motion.div>
      </main>
    </div>
  );
}
