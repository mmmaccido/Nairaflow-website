// ─────────────────────────────────────────────
//  routes/rates.js
//  GET /api/rates/all        — all active currencies
//  GET /api/rates/:currency  — single currency rate
// ─────────────────────────────────────────────
const express = require('express');
const axios   = require('axios');
const router  = express.Router();

// ── In-memory cache (refresh every 5 minutes) ──
let rateCache     = null;
let cacheTime     = 0;
const CACHE_MS    = 5 * 60 * 1000;

// ── Currency config — edit spreads here or via admin dashboard ──
const CURRENCY_CONFIG = {
  USD: { symbol: '$',   name: 'US Dollar',           spread: 1.5, payout: 'wise',         speed: 'Minutes–1 day',  active: true  },
  CAD: { symbol: 'CA$', name: 'Canadian Dollar',      spread: 1.5, payout: 'wise',         speed: 'Minutes–1 day',  active: true  },
  GBP: { symbol: '£',   name: 'British Pound',        spread: 1.5, payout: 'wise',         speed: 'Seconds–hours',  active: true  },
  EUR: { symbol: '€',   name: 'Euro',                 spread: 1.5, payout: 'wise',         speed: '1–2 days',       active: true  },
  TRY: { symbol: '₺',   name: 'Turkish Lira',         spread: 2.5, payout: 'thunes',       speed: '1–2 days',       active: true  },
  AUD: { symbol: 'A$',  name: 'Australian Dollar',    spread: 1.5, payout: 'wise',         speed: 'Minutes',        active: true  },
  GHS: { symbol: '₵',   name: 'Ghanaian Cedi',        spread: 2.0, payout: 'flutterwave',  speed: 'Hours',          active: true  },
  ZAR: { symbol: 'R',   name: 'South African Rand',   spread: 2.0, payout: 'wise',         speed: '1–2 days',       active: true  },
  MYR: { symbol: 'RM',  name: 'Malaysian Ringgit',    spread: 1.8, payout: 'thunes',       speed: '1 day',          active: true  },
};

// ── Fetch live rates from ExchangeRate-API ──
async function fetchLiveRates() {
  const now = Date.now();

  // Return cached rates if still fresh
  if (rateCache && now - cacheTime < CACHE_MS) {
    return rateCache;
  }

  try {
    const response = await axios.get(
      `https://v6.exchangerate-api.com/v6/${process.env.EXCHANGE_RATE_API_KEY}/latest/USD`
    );

    const usdRates = response.data.conversion_rates;
    const ngnPerUsd = usdRates.NGN; // e.g. 1620

    const result = {};

    for (const [code, config] of Object.entries(CURRENCY_CONFIG)) {
      if (!config.active) continue;

      const targetPerUsd = usdRates[code]; // e.g. 1.36 for CAD
      if (!targetPerUsd) continue;

      // NGN → USD → target currency
      // To convert 1 NGN to target: divide by ngnPerUsd then multiply by targetPerUsd
      const rawRate = targetPerUsd / ngnPerUsd;

      // Apply spread — customers get slightly less than market rate
      const customerRate = rawRate * (1 - config.spread / 100);

      result[code] = {
        symbol:        config.symbol,
        name:          config.name,
        speed:         config.speed,
        payout:        config.payout,
        spread:        config.spread,
        marketRate:    rawRate,
        rate:          customerRate,           // what customer gets per 1 NGN
        ngnPer1Unit:   (1 / customerRate),     // NGN needed to get 1 unit of currency
        per1000NGN:    (customerRate * 1000),  // units received per ₦1,000 sent
        updatedAt:     new Date().toISOString(),
      };
    }

    rateCache = result;
    cacheTime = now;
    console.log(`[Rates] Refreshed at ${new Date().toLocaleTimeString()} — NGN/USD: ${ngnPerUsd}`);
    return result;

  } catch (error) {
    console.error('[Rates] Failed to fetch live rates:', error.message);

    // Return stale cache if available, rather than crashing
    if (rateCache) {
      console.warn('[Rates] Returning stale cache');
      return rateCache;
    }

    // Last resort fallback rates (approximate — update these monthly)
    return getFallbackRates();
  }
}

function getFallbackRates() {
  return {
    USD: { symbol: '$',   name: 'US Dollar',        rate: 0.000617, ngnPer1Unit: 1620, per1000NGN: 0.617, speed: 'Minutes–1 day', payout: 'wise' },
    CAD: { symbol: 'CA$', name: 'Canadian Dollar',  rate: 0.000840, ngnPer1Unit: 1190, per1000NGN: 0.840, speed: 'Minutes–1 day', payout: 'wise' },
    GBP: { symbol: '£',   name: 'British Pound',    rate: 0.000487, ngnPer1Unit: 2053, per1000NGN: 0.487, speed: 'Seconds–hours', payout: 'wise' },
    EUR: { symbol: '€',   name: 'Euro',             rate: 0.000571, ngnPer1Unit: 1751, per1000NGN: 0.571, speed: '1–2 days',      payout: 'wise' },
    TRY: { symbol: '₺',   name: 'Turkish Lira',     rate: 0.0196,   ngnPer1Unit: 51,   per1000NGN: 19.6,  speed: '1–2 days',      payout: 'thunes' },
    AUD: { symbol: 'A$',  name: 'Australian Dollar',rate: 0.000940, ngnPer1Unit: 1064, per1000NGN: 0.940, speed: 'Minutes',       payout: 'wise' },
    GHS: { symbol: '₵',   name: 'Ghanaian Cedi',    rate: 0.00750,  ngnPer1Unit: 133,  per1000NGN: 7.50,  speed: 'Hours',         payout: 'flutterwave' },
    ZAR: { symbol: 'R',   name: 'South Afr. Rand',  rate: 0.01120,  ngnPer1Unit: 89,   per1000NGN: 11.2,  speed: '1–2 days',      payout: 'wise' },
  };
}

// ── ROUTES ──

// GET /api/rates/all
router.get('/all', async (req, res) => {
  try {
    const rates = await fetchLiveRates();
    res.json(rates);
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch rates', details: err.message });
  }
});

// GET /api/rates/:currency  (e.g. /api/rates/USD)
router.get('/:currency', async (req, res) => {
  try {
    const { currency } = req.params;
    const rates = await fetchLiveRates();
    const rate = rates[currency.toUpperCase()];

    if (!rate) {
      return res.status(404).json({ error: `Currency ${currency} not supported` });
    }

    res.json(rate);
  } catch (err) {
    res.status(500).json({ error: 'Could not fetch rate', details: err.message });
  }
});

module.exports = router;
