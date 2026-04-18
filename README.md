# Token Analyser Agent

AI-powered trading agent that analyses tokens across chains, tracks whale wallets on Solana, monitors news sentiment, and executes perpetual futures trades.

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│                    React Dashboard                        │
│   Signals | Positions | Watchlist | Wallets | News        │
└──────────────────┬───────────────────────────────────────┘
                   │ REST + WebSocket
┌──────────────────▼───────────────────────────────────────┐
│                Express + Socket.IO Server                 │
├──────────────────────────────────────────────────────────┤
│                  Signal Aggregator                        │
│   Collects → Weights → Filters → Executes                │
├──────────┬──────────┬───────────┬────────────────────────┤
│ Token    │ News     │ Wallet    │ Perps                  │
│ Analyser │ Sentiment│ Tracker   │ Trader                 │
│          │          │ (Solana)  │ (CCXT)                 │
├──────────┼──────────┼───────────┼────────────────────────┤
│DexScreener│CryptoPanic│Solana RPC│ Binance/Bybit/OKX    │
│ Birdeye  │LunarCrush │ Jupiter  │ Hyperliquid           │
└──────────┴──────────┴───────────┴────────────────────────┘
```

## Features

- **Multi-chain Token Analysis**: Scans tokens across Solana, ETH, BSC, Arbitrum, Base via DexScreener
- **Technical Analysis**: RSI, MACD, EMA, Bollinger Bands on OHLCV data
- **News Sentiment Engine**: CryptoPanic + LunarCrush integration for alpha detection
- **Solana Wallet Tracker**: Real-time monitoring of whale/smart money wallets
- **Perps Trading**: Automated LONG/SHORT execution with SL/TP via CCXT (Binance, Bybit, OKX, etc.)
- **Signal Aggregation**: Multi-source signal weighting with confidence scoring
- **React Dashboard**: Real-time monitoring with WebSocket updates
- **Scheduled Scanning**: Automated pipeline runs every 5 minutes

## Quick Start

### 1. Install Dependencies

```bash
npm run install:all
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your API keys
```

### 3. Start the Agent

```bash
# Terminal 1: Backend
npm run dev

# Terminal 2: Dashboard
npm run client
```

- Backend API: http://localhost:3001
- Dashboard: http://localhost:5173

## Configuration (.env)

| Variable | Description | Required |
|----------|-------------|----------|
| `EXCHANGE_ID` | Exchange (binance, bybit, okx) | For trading |
| `EXCHANGE_API_KEY` | Exchange API key | For trading |
| `EXCHANGE_SECRET` | Exchange secret | For trading |
| `EXCHANGE_SANDBOX` | Use testnet (true/false) | Recommended |
| `SOLANA_RPC_URL` | Solana RPC endpoint | For wallet tracking |
| `TRACKED_WALLETS` | Comma-separated wallet addresses | For wallet tracking |
| `CRYPTOPANIC_API_KEY` | CryptoPanic API key | For news |
| `LUNARCRUSH_API_KEY` | LunarCrush API key | For social data |
| `BIRDEYE_API_KEY` | Birdeye API key | For Solana OHLCV |
| `MAX_POSITION_SIZE` | Max USD per position | Yes |
| `DEFAULT_LEVERAGE` | Default leverage multiplier | Yes |
| `STOP_LOSS_PCT` | Stop loss percentage | Yes |
| `TAKE_PROFIT_PCT` | Take profit percentage | Yes |
| `MIN_SIGNAL_CONFIDENCE` | Min confidence to trade (0-100) | Yes |

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/status` | Agent status & balance |
| GET | `/api/analyse/:symbol` | Analyse a token |
| GET | `/api/search/:query` | Search tokens |
| GET | `/api/trending` | Trending tokens |
| GET/POST | `/api/watchlist` | Manage watchlist |
| GET/POST | `/api/wallets` | Manage tracked wallets |
| GET | `/api/wallets/scan` | Scan wallets for accumulation |
| GET | `/api/positions` | View positions |
| POST | `/api/positions/close/:id` | Close a position |
| GET | `/api/signals` | View signals |
| POST | `/api/pipeline/run` | Run full pipeline |
| POST | `/api/settings/autotrade` | Toggle auto-trading |
| GET | `/api/news` | Latest news & sentiment |

## Signal Sources & Weights

| Source | Weight | What it detects |
|--------|--------|----------------|
| TECHNICAL | 1.2x | RSI, MACD, EMA, Bollinger patterns |
| WALLET | 1.3x | Multi-wallet accumulation on Solana |
| NEWS | 1.0x | Bullish/bearish news from CryptoPanic |
| VOLUME | 0.8x | Volume spikes on DexScreener trending |
| SOCIAL | 0.7x | Social buzz from LunarCrush |

Multi-source signals get a +10% confidence bonus per additional source.

## Safety Features

- **Sandbox mode** by default (testnet trading)
- **Max position limits** to prevent over-exposure
- **Stop-loss/Take-profit** on every position
- **Confidence threshold** filtering (default 70%)
- **Auto-trade toggle** (disabled by default, signals only)

## Important Notes

- Start with `EXCHANGE_SANDBOX=true` to test on paper
- The agent works in **analysis-only mode** without exchange keys
- DexScreener API is free (no key needed)
- Wallet tracking requires a good Solana RPC (consider Helius or QuickNode)
- Not financial advice - use at your own risk
