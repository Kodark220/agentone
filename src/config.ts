import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3001'),
  nodeEnv: process.env.NODE_ENV || 'development',

  exchange: {
    id: process.env.EXCHANGE_ID || 'binance',
    apiKey: process.env.EXCHANGE_API_KEY || '',
    secret: process.env.EXCHANGE_SECRET || '',
    password: process.env.EXCHANGE_PASSWORD || '',
    sandbox: process.env.EXCHANGE_SANDBOX === 'true',
  },

  solana: {
    rpcUrl: process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com',
    wsUrl: process.env.SOLANA_WS_URL || 'wss://api.mainnet-beta.solana.com',
  },

  trackedWallets: (process.env.TRACKED_WALLETS || '')
    .split(',')
    .map((w) => w.trim())
    .filter(Boolean),

  apis: {
    cryptoPanicKey: process.env.CRYPTOPANIC_API_KEY || '',
    lunarCrushKey: process.env.LUNARCRUSH_API_KEY || '',
    birdeyeKey: process.env.BIRDEYE_API_KEY || '',
  },

  trading: {
    maxPositionSize: parseFloat(process.env.MAX_POSITION_SIZE || '100'),
    defaultLeverage: parseInt(process.env.DEFAULT_LEVERAGE || '3'),
    maxPositions: parseInt(process.env.MAX_POSITIONS || '5'),
    stopLossPct: parseFloat(process.env.STOP_LOSS_PCT || '5'),
    takeProfitPct: parseFloat(process.env.TAKE_PROFIT_PCT || '15'),
    minSignalConfidence: parseInt(process.env.MIN_SIGNAL_CONFIDENCE || '70'),
    targetAccuracyPct: parseFloat(process.env.TARGET_ACCURACY_PCT || '80'),
    setupLookaheadMin: parseInt(process.env.SETUP_LOOKAHEAD_MIN || '180'),
    minPublishConfidence: parseInt(process.env.MIN_PUBLISH_CONFIDENCE || '80'),
    minPublishRR: parseFloat(process.env.MIN_PUBLISH_RR || '2'),
    minConfluence: parseInt(process.env.MIN_CONFLUENCE || '3'),
    minRawScore: parseInt(process.env.MIN_RAW_SCORE || '55'),
  },
};
