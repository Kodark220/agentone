import { useState, useEffect, useCallback } from 'react';
import { io, Socket } from 'socket.io-client';
import { motion, AnimatePresence } from 'framer-motion';
import { api } from './api';

// ============================================
// ANIMATIONS
// ============================================
const fadeIn = { initial: { opacity: 0, y: 12 }, animate: { opacity: 1, y: 0 }, exit: { opacity: 0, y: -8 } };
const stagger = { animate: { transition: { staggerChildren: 0.04 } } };
const cardVariant = { initial: { opacity: 0, scale: 0.97 }, animate: { opacity: 1, scale: 1 }, exit: { opacity: 0, scale: 0.95 } };

// ============================================
// MAIN APP COMPONENT
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
  const [futuresLastUpdate, setFuturesLastUpdate] = useState<number>(0);
  const [trenchesLastUpdate, setTrenchesLastUpdate] = useState<number>(0);
  const [activeTab, setActiveTab] = useState<'futures' | 'trenches'>('futures');

  // Form states
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [newWallet, setNewWallet] = useState('');
  const [addSymbol, setAddSymbol] = useState('');
  const [addChain, setAddChain] = useState('any');
  const [analysisResult, setAnalysisResult] = useState<any>(null);

  // ---- Load initial data ----
  const refresh = useCallback(async () => {
    try {
      const [s, sig, pos, wl, wal, n, ft, tr] = await Promise.all([
        api.getStatus(),
        api.getSignals(),
        api.getPositions(),
        api.getWatchlist(),
        api.getWallets(),
        api.getNews(),
        api.getFuturesSetups(),
        api.getTrenches(),
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
      setTrenchesLastUpdate(Date.now());
    } catch (err) {
      console.error('Failed to load data:', err);
    }
  }, []);

  const refreshLive = useCallback(async () => {
    try {
      const [ft, tr] = await Promise.all([api.getFuturesSetups(), api.getTrenches()]);
      if (ft.setups?.length) { setFuturesSetups(ft.setups); setFuturesLastUpdate(Date.now()); }
      if (tr.tokens) {
        setTrenchTokens(tr.tokens);
        setTrenchCounts(tr.counts || { new: 0, recent: 0, established: 0 });
        setTrenchesLastUpdate(Date.now());
      }
    } catch {}
  }, []);

  useEffect(() => { refresh(); const i = setInterval(refresh, 30000); return () => clearInterval(i); }, [refresh]);
  useEffect(() => { const i = setInterval(refreshLive, 5000); return () => clearInterval(i); }, [refreshLive]);

  useEffect(() => {
    const socket: Socket = io();
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
    try {
      const result = await api.runPipeline();
      setSignals(result.signals || []);
      setAggregated(result.aggregated || []);
      await refresh();
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    const result = await api.searchTokens(searchQuery);
    setSearchResults(result.pairs || []);
  };

  const handleAnalyse = async (symbol: string, chain: string = 'any') => {
    setLoading(true);
    try {
      const result = await api.analyseToken(symbol, chain);
      setAnalysisResult(result);
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  };

  const handleAddWatchlist = async () => {
    if (!addSymbol.trim()) return;
    await api.addToWatchlist(addSymbol.toUpperCase(), addChain);
    setAddSymbol('');
    refresh();
  };

  const handleRemoveWatchlist = async (symbol: string, chain: string) => {
    await api.removeFromWatchlist(symbol, chain);
    refresh();
  };

  const handleAddWallet = async () => {
    if (!newWallet.trim()) return;
    await api.addWallet(newWallet.trim());
    setNewWallet('');
    refresh();
  };

  const handleClosePosition = async (id: string) => {
    await api.closePosition(id);
    refresh();
  };

  const handleToggleAutoTrade = async () => {
    const newValue = !autoTrade;
    await api.setAutoTrade(newValue);
    setAutoTrade(newValue);
  };

  const handleGenerateFutures = async () => {
    setLoading(true);
    try {
      const result = await api.generateFuturesSetups();
      setFuturesSetups(result.setups || []);
      setFuturesLastUpdate(Date.now());
      await refresh();
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  };

  const handleScanTrenches = async () => {
    setLoading(true);
    try {
      const result = await api.scanTrenches();
      setTrenchTokens(result.tokens || []);
      setTrenchesLastUpdate(Date.now());
      await refresh();
    } catch (err) {
      console.error(err);
    }
    setLoading(false);
  };

  const handleTrackTrench = async () => {
    if (!trenchInput.trim()) return;
    try {
      await api.trackTrenchToken(trenchInput.trim());
      setTrenchInput('');
      await refresh();
    } catch (err) {
      console.error(err);
    }
  };

  const handleRemoveTrench = async (address: string) => {
    await api.removeTrenchToken(address);
    await refresh();
  };

  const confColor = (c: number) =>
    c >= 80 ? 'var(--green)' : c >= 60 ? 'var(--yellow)' : c >= 40 ? 'var(--blue)' : 'var(--red)';

  const formatPrice = (p: number) => {
    if (!p || p === 0) return '$0';
    if (p >= 1) return `$${p.toFixed(2)}`;
    if (p >= 0.001) return `$${p.toFixed(4)}`;
    return `$${p.toFixed(8)}`;
  };

  const formatAge = (hours: number) => {
    if (hours < 1) return `${Math.floor(hours * 60)}m`;
    if (hours < 24) return `${Math.floor(hours)}h`;
    if (hours < 168) return `${Math.floor(hours / 24)}d`;
    return `${Math.floor(hours / 168)}w`;
  };

  const filteredTrench = trenchFilter === 'ALL'
    ? trenchTokens
    : trenchTokens.filter((t: any) => t.ageLabel === trenchFilter);

  const timeAgo = (ts: number) => {
    if (!ts) return 'never';
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 5) return 'just now';
    if (s < 60) return `${s}s ago`;
    return `${Math.floor(s / 60)}m ago`;
  };

  return (
    <div className="app">
      {/* HEADER */}
      <header>
        <h1>Token Analyser Agent</h1>
        <div className="status">
          <span>
            <span className={`dot ${status?.exchangeConnected ? 'on' : 'off'}`} />
            Exchange
          </span>
          <span>
            <span className="dot on" /> Agent
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: '0.8rem' }}>Auto-Trade</span>
            <div className={`toggle ${autoTrade ? 'on' : ''}`} onClick={handleToggleAutoTrade}>
              <div className="knob" />
            </div>
          </div>
          <button className="btn-primary" onClick={handleRunPipeline} disabled={loading}>
            {loading ? 'Scanning...' : 'Run Pipeline'}
          </button>
        </div>
      </header>

      {/* STATS ROW */}
      <div className="stat-row">
        <div className="stat">
          <div className="label">Balance</div>
          <div className="value blue">${status?.balance?.total?.toFixed(2) || '0.00'}</div>
        </div>
        <div className="stat">
          <div className="label">Total PnL</div>
          <div className={`value ${(status?.totalPnL || 0) >= 0 ? 'green' : 'red'}`}>
            ${(status?.totalPnL || 0).toFixed(2)}
          </div>
        </div>
        <div className="stat">
          <div className="label">Open Positions</div>
          <div className="value">{status?.openPositions || 0}</div>
        </div>
        <div className="stat">
          <div className="label">Active Signals</div>
          <div className="value">{aggregated.length}</div>
        </div>
        <div className="stat">
          <div className="label">Watchlist</div>
          <div className="value">{status?.watchlistSize || 0}</div>
        </div>
      </div>

      <div className="grid">
        {/* SIGNALS */}
        <div className="card">
          <h2>
            Aggregated Signals <span className="badge">{aggregated.length}</span>
          </h2>
          {aggregated.length === 0 ? (
            <div className="empty">No signals yet. Run the pipeline to scan.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Token</th>
                  <th>Chain</th>
                  <th>Direction</th>
                  <th>Confidence</th>
                  <th>Sources</th>
                  <th>Price</th>
                </tr>
              </thead>
              <tbody>
                {aggregated.map((s: any, i: number) => (
                  <tr key={i}>
                    <td><strong>{s.symbol}</strong></td>
                    <td>{s.chain}</td>
                    <td className={s.direction === 'LONG' ? 'long' : 'short'}>{s.direction}</td>
                    <td>
                      {s.totalConfidence?.toFixed(0)}%
                      <div className="conf-bar">
                        <div
                          className="fill"
                          style={{
                            width: `${s.totalConfidence}%`,
                            background: confColor(s.totalConfidence),
                          }}
                        />
                      </div>
                    </td>
                    <td>
                      {s.signals?.map((sig: any, j: number) => (
                        <span key={j} className={`tag ${sig.source?.toLowerCase()}`}>
                          {sig.source}
                        </span>
                      ))}
                    </td>
                    <td>${s.suggestedEntry?.toFixed(6)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* FUTURES TOKEN TRADING */}
        <div className="card card-futures">
          <h2>
            <span className="section-icon">📊</span> Futures Trading Setups <span className="badge badge-futures">{futuresSetups.length}</span>
            <span className="live-indicator"><span className="live-dot" /> LIVE</span>
            <span className="last-update">Updated {timeAgo(futuresLastUpdate)}</span>
            <button className="btn-futures btn-sm" onClick={handleGenerateFutures} disabled={loading} style={{ marginLeft: 'auto' }}>
              {loading ? '...' : 'Generate'}
            </button>
          </h2>
          {futuresSetups.length === 0 ? (
            <div className="empty">No futures setups. Click Generate to scan exchange perps.</div>
          ) : (
            <div className="futures-list">
              {futuresSetups.map((s: any, i: number) => (
                <div key={i} className="futures-card">
                  <div className="futures-header">
                    <strong>{s.pair || s.symbol}</strong>
                    <span className={s.direction === 'LONG' ? 'long' : 'short'}>{s.direction}</span>
                    <span className="tag-chain">{s.exchange || 'Binance'}</span>
                    <span className="futures-conf" style={{ color: confColor(s.confidence) }}>
                      {s.confidence?.toFixed(0)}%
                    </span>
                  </div>
                  <div className="futures-levels">
                    <div className="level entry">
                      <span className="level-label">ENTRY</span>
                      <span className="level-value">{formatPrice(s.entry)}</span>
                    </div>
                    <div className="level sl">
                      <span className="level-label">STOP LOSS</span>
                      <span className="level-value">{formatPrice(s.stopLoss)}</span>
                    </div>
                    <div className="level tp">
                      <span className="level-label">TAKE PROFIT</span>
                      <span className="level-value">{formatPrice(s.takeProfit)}</span>
                    </div>
                  </div>
                  <div className="futures-meta">
                    <span>Leverage: {s.leverage}x</span>
                    <span>R:R {s.riskReward?.toFixed(1)}</span>
                    {s.technicals && (
                      <span className="futures-technicals">
                        <span className="tag technical">RSI {s.technicals.rsi?.toFixed(1)}</span>
                        <span className={`tag ${s.technicals.macd === 'BULLISH' ? 'bullish' : 'bearish'}`}>
                          MACD {s.technicals.macd}
                        </span>
                        <span className={`tag ${s.technicals.trend === 'BULLISH' ? 'bullish' : s.technicals.trend === 'BEARISH' ? 'bearish' : 'neutral'}`}>
                          {s.technicals.trend}
                        </span>
                      </span>
                    )}
                  </div>
                  {s.reason && (
                    <div className="futures-reason">{s.reason}</div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        {/* SOL TRENCHES */}
        <div className="card card-trenches">
          <h2>
            <span className="section-icon">🔥</span> Sol Trenches
            <span className="badge badge-trenches">{trenchTokens.length}</span>
            <span className="live-indicator live-trenches"><span className="live-dot live-dot-trenches" /> LIVE</span>
            <span className="last-update">Updated {timeAgo(trenchesLastUpdate)}</span>
            <button className="btn-trenches btn-sm" onClick={handleScanTrenches} disabled={loading} style={{ marginLeft: 'auto' }}>
              {loading ? '...' : 'Scan'}
            </button>
          </h2>
          <div className="trench-stats">
            <span className="trench-stat new-stat">NEW {trenchCounts.new}</span>
            <span className="trench-stat recent-stat">RECENT {trenchCounts.recent}</span>
            <span className="trench-stat est-stat">OLD {trenchCounts.established}</span>
          </div>
          <div className="trench-filters">
            {(['ALL', 'NEW', 'RECENT', 'ESTABLISHED'] as const).map(f => (
              <button
                key={f}
                className={`btn-filter ${trenchFilter === f ? 'active' : ''}`}
                onClick={() => setTrenchFilter(f)}
              >
                {f === 'ESTABLISHED' ? 'OLD' : f}
              </button>
            ))}
          </div>
          <div className="input-row">
            <input
              placeholder="Token address or symbol..."
              value={trenchInput}
              onChange={(e) => setTrenchInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleTrackTrench()}
            />
            <button className="btn-success" onClick={handleTrackTrench}>Track</button>
          </div>
          {filteredTrench.length === 0 ? (
            <div className="empty">No tokens found. Scan the trenches.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Token</th>
                  <th>Age</th>
                  <th>Price</th>
                  <th>5m</th>
                  <th>1h</th>
                  <th>24h</th>
                  <th>Vol 24h</th>
                  <th>Liq</th>
                  <th>Buys/Sells</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filteredTrench.slice(0, 30).map((t: any, i: number) => (
                  <tr key={i}>
                    <td>
                      <strong>{t.symbol}</strong>
                      <span className={`age-badge ${t.ageLabel?.toLowerCase()}`}>{t.ageLabel}</span>
                    </td>
                    <td>{formatAge(t.ageHours)}</td>
                    <td>{formatPrice(t.price)}</td>
                    <td className={(t.priceChange5m || 0) >= 0 ? 'long' : 'short'}>
                      {(t.priceChange5m || 0).toFixed(1)}%
                    </td>
                    <td className={(t.priceChange1h || 0) >= 0 ? 'long' : 'short'}>
                      {(t.priceChange1h || 0).toFixed(1)}%
                    </td>
                    <td className={(t.priceChange24h || 0) >= 0 ? 'long' : 'short'}>
                      {(t.priceChange24h || 0).toFixed(1)}%
                    </td>
                    <td>${(t.volume24h || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                    <td>${(t.liquidity || 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                    <td>
                      <span className="long">{t.txns24h?.buys || 0}</span>
                      {' / '}
                      <span className="short">{t.txns24h?.sells || 0}</span>
                    </td>
                    <td>
                      <button className="btn-danger btn-sm" onClick={() => handleRemoveTrench(t.address)}>
                        X
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* POSITIONS */}
        <div className="card">
          <h2>
            Open Positions <span className="badge">{positions.length}</span>
          </h2>
          {positions.length === 0 ? (
            <div className="empty">No open positions</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Side</th>
                  <th>Entry</th>
                  <th>Current</th>
                  <th>PnL</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p: any) => (
                  <tr key={p.id}>
                    <td><strong>{p.symbol}</strong></td>
                    <td className={p.side === 'LONG' ? 'long' : 'short'}>{p.side} {p.leverage}x</td>
                    <td>${p.entryPrice?.toFixed(4)}</td>
                    <td>${p.currentPrice?.toFixed(4)}</td>
                    <td className={p.pnl >= 0 ? 'long' : 'short'}>
                      ${p.pnl?.toFixed(2)} ({p.pnlPct?.toFixed(1)}%)
                    </td>
                    <td>
                      <button className="btn-danger btn-sm" onClick={() => handleClosePosition(p.id)}>
                        Close
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* TOKEN SEARCH & ANALYSIS */}
        <div className="card">
          <h2>Token Search & Analysis</h2>
          <div className="input-row">
            <input
              placeholder="Search token (e.g., WIF, BONK)..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
            />
            <button className="btn-primary" onClick={handleSearch}>Search</button>
          </div>

          {searchResults.length > 0 && (
            <table>
              <thead>
                <tr><th>Token</th><th>Chain</th><th>Price</th><th>24h</th><th></th></tr>
              </thead>
              <tbody>
                {searchResults.slice(0, 10).map((p: any, i: number) => (
                  <tr key={i}>
                    <td>{p.baseToken?.symbol}</td>
                    <td>{p.chainId}</td>
                    <td>${parseFloat(p.priceUsd || 0).toFixed(6)}</td>
                    <td className={(p.priceChange?.h24 || 0) >= 0 ? 'long' : 'short'}>
                      {(p.priceChange?.h24 || 0).toFixed(1)}%
                    </td>
                    <td>
                      <button
                        className="btn-primary btn-sm"
                        onClick={() => handleAnalyse(p.baseToken?.symbol, p.chainId)}
                      >
                        Analyse
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {analysisResult && (
            <div style={{ marginTop: 12, padding: 12, background: 'var(--bg3)', borderRadius: 8 }}>
              <h3 style={{ fontSize: '0.9rem', marginBottom: 8 }}>
                {analysisResult.analysis?.symbol} Analysis
              </h3>
              <div style={{ fontSize: '0.8rem', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                <span>Price: ${analysisResult.analysis?.price?.toFixed(6)}</span>
                <span>24h: {analysisResult.analysis?.priceChange24h?.toFixed(1)}%</span>
                <span>RSI: {analysisResult.analysis?.technicals?.rsi?.toFixed(1)}</span>
                <span>Trend: {analysisResult.analysis?.technicals?.trend}</span>
                <span>MACD: {analysisResult.analysis?.technicals?.macdSignal}</span>
                <span>Vol: ${(analysisResult.analysis?.volume24h || 0).toLocaleString()}</span>
                <span>Liquidity: ${(analysisResult.analysis?.liquidity || 0).toLocaleString()}</span>
                <span>Score: {analysisResult.analysis?.overallScore}/100</span>
              </div>
              {analysisResult.signal && (
                <div style={{ marginTop: 8, padding: 8, background: 'var(--bg2)', borderRadius: 6 }}>
                  <strong className={analysisResult.signal.direction === 'LONG' ? 'long' : 'short'}>
                    Signal: {analysisResult.signal.direction}
                  </strong>
                  {' '} | Confidence: {analysisResult.signal.confidence}%
                  <br />
                  <span style={{ fontSize: '0.75rem', color: 'var(--text2)' }}>
                    {analysisResult.signal.reason}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* WATCHLIST */}
        <div className="card">
          <h2>Watchlist <span className="badge">{watchlist.length}</span></h2>
          <div className="input-row">
            <input
              placeholder="Symbol (e.g., SOL)"
              value={addSymbol}
              onChange={(e) => setAddSymbol(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAddWatchlist()}
            />
            <select value={addChain} onChange={(e) => setAddChain(e.target.value)}>
              <option value="any">Any Chain</option>
              <option value="solana">Solana</option>
              <option value="ethereum">Ethereum</option>
              <option value="bsc">BSC</option>
              <option value="arbitrum">Arbitrum</option>
              <option value="base">Base</option>
            </select>
            <button className="btn-success" onClick={handleAddWatchlist}>Add</button>
          </div>
          {watchlist.length === 0 ? (
            <div className="empty">Add tokens to watchlist for automated scanning</div>
          ) : (
            <table>
              <thead><tr><th>Symbol</th><th>Chain</th><th></th></tr></thead>
              <tbody>
                {watchlist.map((t: any, i: number) => (
                  <tr key={i}>
                    <td><strong>{t.symbol}</strong></td>
                    <td>{t.chain}</td>
                    <td>
                      <button className="btn-danger btn-sm" onClick={() => handleRemoveWatchlist(t.symbol, t.chain)}>
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* WALLET TRACKER */}
        <div className="card">
          <h2>Solana Wallet Tracker <span className="badge">{wallets.length}</span></h2>
          <div className="input-row">
            <input
              placeholder="Solana wallet address..."
              value={newWallet}
              onChange={(e) => setNewWallet(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleAddWallet()}
            />
            <button className="btn-success" onClick={handleAddWallet}>Track</button>
          </div>
          {wallets.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              {wallets.map((w: string) => (
                <div key={w} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0', fontSize: '0.8rem' }}>
                  <code>{w.slice(0, 8)}...{w.slice(-6)}</code>
                  <button className="btn-danger btn-sm" onClick={() => { api.removeWallet(w); refresh(); }}>
                    Remove
                  </button>
                </div>
              ))}
            </div>
          )}
          <h3 style={{ fontSize: '0.85rem', color: 'var(--text2)', marginTop: 8, marginBottom: 6 }}>Recent Activity</h3>
          {walletActivity.length === 0 ? (
            <div className="empty">No wallet activity detected</div>
          ) : (
            walletActivity.slice(0, 15).map((a: any, i: number) => (
              <div key={i} className="activity-item">
                <span className={a.type}>{a.type.toUpperCase()}</span>
                {' '}{a.token}{' '}
                <span style={{ color: 'var(--text2)' }}>by {a.wallet?.slice(0, 6)}...</span>
              </div>
            ))
          )}
        </div>

        {/* NEWS */}
        <div className="card">
          <h2>News & Sentiment <span className="badge">{news.length}</span></h2>
          {news.length === 0 ? (
            <div className="empty">No news data. Set CRYPTOPANIC_API_KEY in .env</div>
          ) : (
            news.slice(0, 15).map((n: any, i: number) => (
              <div key={i} className="news-item">
                <div className="title">
                  <span className={n.sentiment}>{n.sentiment === 'positive' ? '+' : n.sentiment === 'negative' ? '-' : '~'}</span>
                  {' '}{n.title}
                </div>
                <div className="meta">
                  {n.source} | {n.relevantTokens?.join(', ') || 'General'} | Score: {n.score}
                </div>
              </div>
            ))
          )}
        </div>

        {/* RAW SIGNALS LOG */}
        <div className="card">
          <h2>Raw Signal Log <span className="badge">{signals.length}</span></h2>
          {signals.length === 0 ? (
            <div className="empty">No raw signals in this cycle</div>
          ) : (
            <table>
              <thead>
                <tr><th>Token</th><th>Dir</th><th>Confidence</th><th>Source</th><th>Reason</th></tr>
              </thead>
              <tbody>
                {signals.slice(0, 20).map((s: any, i: number) => (
                  <tr key={i}>
                    <td>{s.symbol}</td>
                    <td className={s.direction === 'LONG' ? 'long' : 'short'}>{s.direction}</td>
                    <td>{s.confidence}%</td>
                    <td><span className={`tag ${s.source?.toLowerCase()}`}>{s.source}</span></td>
                    <td style={{ maxWidth: 250, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
