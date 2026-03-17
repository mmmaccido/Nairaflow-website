// ─────────────────────────────────────────────
//  server.js — NairaFlow Backend Entry Point
// ─────────────────────────────────────────────
require('dotenv').config();
const express = require('express');
const cors    = require('cors');

const ratesRouter        = require('./routes/rates');
const transactionsRouter = require('./routes/transactions');
const webhooksRouter     = require('./routes/webhooks');
const kycRouter          = require('./routes/kyc');
const payoutsRouter      = require('./routes/payouts');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── MIDDLEWARE ──
app.use(cors({
  origin: [
    process.env.FRONTEND_URL,
    'http://localhost:5500',
    'http://127.0.0.1:5500',
  ],
  credentials: true
}));

// Raw body needed for Paystack webhook signature check
app.use('/webhooks/paystack', express.raw({ type: 'application/json' }));
app.use(express.json());

// ── ROUTES ──
app.use('/api/rates',        ratesRouter);
app.use('/api/transactions', transactionsRouter);
app.use('/webhooks',         webhooksRouter);
app.use('/api/kyc',          kycRouter);
app.use('/api/payouts',      payoutsRouter);

// ── HEALTH CHECK ──
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'NairaFlow API',
    timestamp: new Date().toISOString()
  });
});

// ── START ──
app.listen(PORT, () => {
  console.log(`\n✅  NairaFlow API running at http://localhost:${PORT}`);
  console.log(`   Health check: http://localhost:${PORT}/health`);
  console.log(`   Rates:        http://localhost:${PORT}/api/rates/all\n`);
});
