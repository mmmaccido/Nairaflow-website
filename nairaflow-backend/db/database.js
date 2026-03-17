// ─────────────────────────────────────────────
//  db/database.js
//  PostgreSQL database helpers
//  Uses the pg (node-postgres) library
// ─────────────────────────────────────────────
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost')
    ? false
    : { rejectUnauthorized: false }   // needed for Supabase / Railway
});

// Test connection on startup
pool.query('SELECT NOW()', (err) => {
  if (err) console.error('[DB] Connection failed:', err.message);
  else console.log('[DB] Connected to PostgreSQL');
});

// ────────────────────────────────────────────────────────
//  SETUP — Run this once to create your tables
//  Call: node db/setup.js
// ────────────────────────────────────────────────────────
async function setupTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transactions (
      id                  SERIAL PRIMARY KEY,
      reference           VARCHAR(50) UNIQUE NOT NULL,
      sender_name         VARCHAR(100),
      sender_email        VARCHAR(150),
      sender_phone        VARCHAR(20),
      recipient_name      VARCHAR(100),
      recipient_phone     VARCHAR(20),
      recipient_details   JSONB,
      ngn_amount          DECIMAL(15,2) NOT NULL,
      fee                 DECIMAL(10,2),
      net_ngn             DECIMAL(15,2),
      target_currency     VARCHAR(3),
      target_amount       DECIMAL(15,4),
      exchange_rate       DECIMAL(16,10),
      delivery_type       VARCHAR(30),
      status              VARCHAR(30) DEFAULT 'PENDING_PAYMENT',
      paystack_txn_id     VARCHAR(100),
      paystack_access_code VARCHAR(100),
      payout_provider     VARCHAR(30),
      payout_transfer_id  VARCHAR(100),
      agent_id            INTEGER,
      error_message       TEXT,
      paid_at             TIMESTAMP,
      created_at          TIMESTAMP DEFAULT NOW(),
      updated_at          TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS agents (
      id              SERIAL PRIMARY KEY,
      name            VARCHAR(100) NOT NULL,
      phone           VARCHAR(20)  NOT NULL,
      email           VARCHAR(150),
      city            VARCHAR(50),
      state           VARCHAR(50),
      cash_balance    DECIMAL(15,2) DEFAULT 0,
      is_available    BOOLEAN DEFAULT true,
      rating          DECIMAL(3,2) DEFAULT 5.0,
      total_deliveries INTEGER DEFAULT 0,
      created_at      TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS agent_jobs (
      id                SERIAL PRIMARY KEY,
      agent_id          INTEGER REFERENCES agents(id),
      transaction_id    INTEGER REFERENCES transactions(id),
      job_ref           VARCHAR(50),
      ngn_amount        DECIMAL(15,2),
      recipient_name    VARCHAR(100),
      recipient_phone   VARCHAR(20),
      recipient_address TEXT,
      status            VARCHAR(20) DEFAULT 'ASSIGNED',
      deadline          TIMESTAMP,
      completed_at      TIMESTAMP,
      created_at        TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_transactions_reference ON transactions(reference);
    CREATE INDEX IF NOT EXISTS idx_transactions_status    ON transactions(status);
    CREATE INDEX IF NOT EXISTS idx_transactions_created   ON transactions(created_at);
  `);
  console.log('[DB] Tables ready');
}

// ────────────────────────────────────────────────────────
//  TRANSACTION HELPERS
// ────────────────────────────────────────────────────────
async function createTransaction(data) {
  const { rows } = await pool.query(`
    INSERT INTO transactions (
      reference, sender_name, sender_email, sender_phone,
      recipient_name, recipient_phone, recipient_details,
      ngn_amount, fee, net_ngn, target_currency, target_amount,
      exchange_rate, delivery_type, status
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
    RETURNING *
  `, [
    data.reference, data.senderName, data.senderEmail, data.senderPhone,
    data.recipientName, data.recipientPhone, data.recipientDetails,
    data.ngnAmount, data.fee, data.netNgn, data.targetCurrency, data.targetAmount,
    data.exchangeRate, data.deliveryType, data.status || 'PENDING_PAYMENT'
  ]);
  return rows[0];
}

async function getTransaction(id) {
  const { rows } = await pool.query('SELECT * FROM transactions WHERE id = $1', [id]);
  return rows[0] || null;
}

async function getTransactionByRef(reference) {
  const { rows } = await pool.query('SELECT * FROM transactions WHERE reference = $1', [reference]);
  return rows[0] || null;
}

async function updateTransaction(id, updates) {
  const fields = Object.entries(updates);
  const setClauses = fields.map(([key, _], i) => {
    const col = camelToSnake(key);
    return `${col} = $${i + 2}`;
  }).join(', ');
  const values = fields.map(([_, v]) => v);

  await pool.query(
    `UPDATE transactions SET ${setClauses}, updated_at = NOW() WHERE id = $1`,
    [id, ...values]
  );
}

// ────────────────────────────────────────────────────────
//  AGENT HELPERS
// ────────────────────────────────────────────────────────
async function findAvailableAgent({ city, minCashBalance }) {
  const { rows } = await pool.query(`
    SELECT * FROM agents
    WHERE is_available = true
      AND cash_balance >= $1
      AND (city ILIKE $2 OR state ILIKE $2)
    ORDER BY rating DESC, cash_balance DESC
    LIMIT 1
  `, [minCashBalance, `%${city}%`]);
  return rows[0] || null;
}

async function decrementAgentBalance(agentId, amount) {
  await pool.query(
    'UPDATE agents SET cash_balance = cash_balance - $1 WHERE id = $2',
    [amount, agentId]
  );
}

async function createAgentJob(data) {
  const { rows } = await pool.query(`
    INSERT INTO agent_jobs (
      agent_id, transaction_id, job_ref, ngn_amount,
      recipient_name, recipient_phone, recipient_address, status, deadline
    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    RETURNING *
  `, [
    data.agentId, data.transactionId, data.jobRef, data.ngnAmount,
    data.recipientName, data.recipientPhone, data.recipientAddress,
    data.status, data.deadline
  ]);
  return rows[0];
}

// ── Helper: camelCase to snake_case ──
function camelToSnake(str) {
  return str.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
}

module.exports = {
  pool,
  setupTables,
  createTransaction,
  getTransaction,
  getTransactionByRef,
  updateTransaction,
  findAvailableAgent,
  decrementAgentBalance,
  createAgentJob,
};
