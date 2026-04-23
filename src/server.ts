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
import { NewsSentimentEngine } from './services/newsSentiment';
import { PerpsTrader } from './services/perpsTrader';
import { MarketContextCoordinator } from './services/marketContext';
import { createRouter } from './routes/api';

const isProd = config.nodeEnv === 'production';

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map((o) => o.trim().replace(/\/+$/, ''))
  : ['http://localhost:5173', 'http://localhost:3001'];

interface WatchlistItem {
  symbol: string;
  chain: string;
  address?: string;
}

async function main() {
  logger.info('========================================');
  logger.info('  TOKEN ANALYSER AGENT v1.0');
  logger.info(`  Mode: ${isProd ? 'PRODUCTION' : 'DEVELOPMENT'}`);
  logger.info(`  CORS origins: ${ALLOWED_ORIGINS.join(', ')}`);
  logger.info('  Futures Agent | Technical + News Context');
  logger.info('========================================');

  const newsEngine = new NewsSentimentEngine();
  const perpsTrader = new PerpsTrader();
  const marketContext = new MarketContextCoordinator();

  let autoTrade = false;
  let watchlist: WatchlistItem[] = [];

  const connected = await perpsTrader.initialize();
  if (connected) {
    if (config.exchange.apiKey) {
      logger.info('Exchange connected successfully');
    } else {
      logger.info('Exchange public market data connected (analysis-only mode)');
      logger.warn('No exchange API key set - trading disabled');
    }
  } else {
    logger.warn('Exchange connection failed - trading disabled');
  }

  const app = express();

  app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: false }));

  const corsOptions: cors.CorsOptions = {
    origin: isProd
      ? (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
          if (!origin || ALLOWED_ORIGINS.includes(origin)) {
            cb(null, true);
          } else {
            logger.warn(`CORS blocked origin: ${origin}`);
            cb(null, true);
          }
        }
      : true,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  };
  app.use(cors(corsOptions));
  app.options('*', cors(corsOptions));

  app.use(compression());
  app.use('/api', rateLimit({
    windowMs: 60_000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, slow down' },
  }));

  app.use(express.json({ limit: '1mb' }));
  app.set('trust proxy', 1);

  app.use('/api', createRouter(
    newsEngine,
    perpsTrader,
    marketContext,
    () => autoTrade,
    (enabled) => { autoTrade = enabled; },
    () => watchlist,
    (items) => { watchlist = items; }
  ));

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      env: config.nodeEnv,
      exchangeConnected: perpsTrader.isReady(),
      activeExchange: perpsTrader.getActiveExchangeLabel(),
      tradingEnabled: perpsTrader.canTrade(),
      timestamp: new Date().toISOString(),
    });
  });

  if (isProd) {
    const clientDist = path.join(__dirname, '..', 'client', 'dist');
    app.use(express.static(clientDist));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

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

    socket.emit('state', {
      positions: perpsTrader.getOpenPositions(),
      watchlist,
      autoTrade,
      marketContext: marketContext.getContext(),
    });

    socket.on('disconnect', () => {
      logger.info(`Client disconnected: ${socket.id}`);
    });
  });

  cron.schedule('* * * * *', async () => {
    if (perpsTrader.isReady()) {
      const positions = await perpsTrader.updatePositions();
      io.emit('positions', positions);
    }
  });

  cron.schedule('2,7,12,17,22,27,32,37,42,47,52,57 * * * *', async () => {
    try {
      const setups = await perpsTrader.scanFuturesMarkets();
      io.emit('futuresSetups', setups);
    } catch (err: any) {
      logger.error(`[CRON] Futures scan failed: ${err.message}`);
    }
  });

  cron.schedule('* * * * *', async () => {
    try {
      const context = await marketContext.refresh(perpsTrader);
      io.emit('marketContext', context);
    } catch (err: any) {
      logger.error(`[CRON] Market context refresh failed: ${err.message}`);
    }
  });

  server.listen(config.port, () => {
    logger.info(`Server running on http://localhost:${config.port}`);
    logger.info(`API: http://localhost:${config.port}/api/status`);
    logger.info(`Env: ${config.nodeEnv} | Configured Exchange: ${config.exchange.id} | Active Exchange: ${perpsTrader.getActiveExchangeLabel()} | Sandbox: ${config.exchange.sandbox}`);
  });

  try {
    const context = await marketContext.refresh(perpsTrader);
    io.emit('marketContext', context);
  } catch (err: any) {
    logger.warn(`[INIT] Market context prime failed: ${err.message}`);
  }

  const shutdown = (signal: string) => {
    logger.info(`${signal} received - shutting down gracefully...`);
    server.close(() => {
      io.close();
      logger.info('Server closed');
      process.exit(0);
    });
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
