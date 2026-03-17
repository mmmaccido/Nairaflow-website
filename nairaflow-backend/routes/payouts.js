// routes/payouts.js — check payout status
const express = require('express');
const axios   = require('axios');
const router  = express.Router();
const db      = require('../db/database');

const WISE_BASE = process.env.WISE_ENV === 'live'
  ? 'https://api.transferwise.com'
  : 'https://api.sandbox.transferwise.com';

// GET /api/payouts/status/:transactionId
router.get('/status/:transactionId', async (req, res) => {
  try {
    const txn = await db.getTransaction(req.params.transactionId);
    if (!txn) return res.status(404).json({ error: 'Transaction not found' });

    let providerStatus = null;

    if (txn.payout_provider === 'wise' && txn.payout_transfer_id) {
      const wiseRes = await axios.get(
        `${WISE_BASE}/v1/transfers/${txn.payout_transfer_id}`,
        { headers: { Authorization: `Bearer ${process.env.WISE_API_KEY}` } }
      );
      providerStatus = wiseRes.data.status;

      // Wise statuses: processing → funds_converted → outgoing_payment_sent → bounced_back / charged_back
      if (providerStatus === 'outgoing_payment_sent') {
        await db.updateTransaction(txn.id, { status: 'COMPLETED' });
      }
    }

    res.json({
      reference:      txn.reference,
      status:         txn.status,
      providerStatus,
      payoutProvider: txn.payout_provider,
      updatedAt:      txn.updated_at,
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
