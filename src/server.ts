// ============================================
// TOKEN ANALYSER AGENT - MAIN SERVER
// ============================================

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import http from 'http';
import path from 'path';
import { Server as SocketIOServer } from 'socket.io';
import cron from 'node-cron';
import { config } from './config';
import { logger } from './utils/logger';
import { TokenAnalyser } from './services/tokenAnalyser';
import { NewsSentimentEngine } from './services/newsSentiment';
import { SolanaWalletTracker } from './services/walletTracker';
import { PerpsTrader } from './services/perpsTrader';
import { SignalAggregator } from './services/signalAggregator';
import { SolTrenchesService } from './services/solTrenches';
import { createRouter } from './routes/api';

const isProd = config.nodeEnv === 'production';

// Allowed frontend origins for CORS
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim().replace(/\/+$/, ''))
  : ['http://localhost:5173', 'http://localhost:3001'];

async function main() {
  logger.info('========================================');
  logger.info('  TOKEN ANALYSER AGENT v1.0');
  logger.info(`  Mode: ${isProd ? 'PRODUCTION' : 'DEVELOPMENT'}`);
  logger.info(`  CORS origins: ${ALLOWED_ORIGINS.join(', ')}`);
  logger.info('  Perps Trading | Token Analysis | Wallet Tracking');
  logger.info('========================================');

  // Initialize services
  const tokenAnalyser = new TokenAnalyser();
  const newsEngine = new NewsSentimentEngine();
  const walletTracker = new SolanaWalletTracker();
  const perpsTrader = new PerpsTrader();
  const solTrenches = new SolTrenchesService();

  // Cross-link services: token analyser uses news for enrichment
  tokenAnalyser.setNewsEngine(newsEngine);

  const signalAggregator = new SignalAggregator(
    tokenAnalyser,
    newsEngine,
    walletTracker,
    perpsTrader
  );

  // Initialize exchange (non-blocking - will work without it)
  if (config.exchange.apiKey) {
    const connected = await perpsTrader.initialize();
    if (connected) {
      logger.info('Exchange connected successfully');
    } else {
      logger.warn('Exchange connection failed - trading disabled');
    }
  } else {
    logger.warn('No exchange API key set - running in analysis-only mode');
  }

  // Start wallet monitoring
  if (config.trackedWallets.length > 0) {
    walletTracker.startMonitoring((activity) => {
      logger.info(`Wallet Activity: ${activity.wallet.slice(0, 8)}... ${activity.type} ${activity.token}`);
      // Emit to connected clients
      io.emit('walletActivity', activity);
    });
  }

  // ---- Express App ----
  const app = express();

  // Security headers
  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));

  // CORS - allow Vercel frontend + local dev
  const corsOptions: cors.CorsOptions = {
    origin: isProd
      ? (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
          // Allow requests with no origin (mobile apps, curl, server-to-server)
          if (!origin || ALLOWED_ORIGINS.includes(origin)) {
            cb(null, true);
          } else {
            logger.warn(`CORS blocked origin: ${origin}`);
            cb(null, true); // Allow anyway for now — tighten after confirming it works
          }
        }
      : true, // reflect request origin in dev
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  };
  app.use(cors(corsOptions));

  // Handle preflight explicitly
  app.options('*', cors(corsOptions));

  // Gzip compression
  app.use(compression());

  // Rate limiting (100 req/min per IP)
  app.use('/api', rateLimit({
    windowMs: 60_000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, slow down' },
  }));

  app.use(express.json({ limit: '1mb' }));

  // Trust proxy (Railway/Render run behind a reverse proxy)
  app.set('trust proxy', 1);

  // API routes
  const apiRouter = createRouter(tokenAnalyser, newsEngine, walletTracker, perpsTrader, signalAggregator, solTrenches);
  app.use('/api', apiRouter);

  // Health check
  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      env: config.nodeEnv,
      exchangeConnected: perpsTrader.isReady(),
      timestamp: new Date().toISOString(),
    });
  });

  // Serve frontend static files in production
  if (isProd) {
    const clientDist = path.join(__dirname, '..', 'client', 'dist');
    app.use(express.static(clientDist));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  // ---- WebSocket (Socket.IO) ----
  const server = http.createServer(app);
  const io = new SocketIOServer(server, {
    cors: {
      origin: isProd ? ALLOWED_ORIGINS : '*',
      methods: ['GET', 'POST'],
      credentials: true,
    },
    pingTimeout: 60000,
  });

  io.on('connection', (socket) => {
    logger.info(`Client connected: ${socket.id}`);

    // Send current state
    socket.emit('state', {
      signals: signalAggregator.getAggregatedSignals(),
      positions: perpsTrader.getOpenPositions(),
      watchlist: tokenAnalyser.getWatchlist(),
      wallets: walletTracker.getTrackedWallets(),
      autoTrade: signalAggregator.isAutoTradeEnabled(),
    });

    socket.on('disconnect', () => {
      logger.info(`Client disconnected: ${socket.id}`);
    });
  });

  // ---- Scheduled Jobs ----

  // Run full pipeline every 5 minutes
  cron.schedule('*/5 * * * *', async () => {
    logger.info('[CRON] Running signal pipeline...');
    try {
      const result = await signalAggregator.runPipeline();
      io.emit('pipelineResult', result);
      io.emit('positions', perpsTrader.getOpenPositions());
    } catch (err: any) {
      logger.error(`[CRON] Pipeline failed: ${err.message}`);
    }
  });

  // Update positions every minute
  cron.schedule('* * * * *', async () => {
    if (perpsTrader.isReady()) {
      const positions = await perpsTrader.updatePositions();
      io.emit('positions', positions);
    }
  });

  // Scan Sol trenches every 3 minutes
  cron.schedule('*/3 * * * *', async () => {
    try {
      await solTrenches.scanTrenches();
      io.emit('trenchesUpdate', solTrenches.getTrackedTokens());
    } catch (err: any) {
      logger.error(`[CRON] Trenches scan failed: ${err.message}`);
    }
  });

  // Scan exchange futures markets every 5 minutes (offset from pipeline)
  cron.schedule('2,7,12,17,22,27,32,37,42,47,52,57 * * * *', async () => {
    try {
      const setups = await perpsTrader.scanFuturesMarkets();
      io.emit('futuresSetups', setups);
    } catch (err: any) {
      logger.error(`[CRON] Futures scan failed: ${err.message}`);
    }
  });

  // Poll wallets every 2 minutes (fallback for WebSocket)
  cron.schedule('*/2 * * * *', async () => {
    if (walletTracker.getTrackedWallets().length > 0) {
      const activities = await walletTracker.pollWallets();
      if (activities.length > 0) {
        io.emit('walletActivities', activities);
      }
    }
  });

  // ---- Start Server ----
  server.listen(config.port, () => {
    logger.info(`Server running on http://localhost:${config.port}`);
    logger.info(`API: http://localhost:${config.port}/api/status`);
    logger.info(`Env: ${config.nodeEnv} | Exchange: ${config.exchange.id} | Sandbox: ${config.exchange.sandbox}`);
  });

  // ---- Graceful Shutdown ----
  const shutdown = (signal: string) => {
    logger.info(`${signal} received — shutting down gracefully...`);
    server.close(() => {
      io.close();
      logger.info('Server closed');
      process.exit(0);
    });
    // Force exit after 10s
    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10_000);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.error(`Fatal error: ${err.message}`);
  process.exit(1);
});
