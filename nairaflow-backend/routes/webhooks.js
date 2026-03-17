// ─────────────────────────────────────────────
//  routes/webhooks.js
//  POST /webhooks/paystack — Paystack payment events
//
//  This is the HEART of the system.
//  When Paystack confirms a payment, this fires
//  and triggers the correct payout automatically.
// ─────────────────────────────────────────────
const express = require('express');
const crypto  = require('crypto');
const router  = express.Router();
const db      = require('../db/database');
const payouts = require('../services/payouts');
const notify  = require('../services/notify');

// ────────────────────────────────────────────────────────
//  POST /webhooks/paystack
// ────────────────────────────────────────────────────────
router.post('/paystack', async (req, res) => {

  // ── 1. Verify the request is genuinely from Paystack ──
  const signature = req.headers['x-paystack-signature'];
  const hash = crypto
    .createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
    .update(req.body)                // raw body (not parsed JSON)
    .digest('hex');

  if (hash !== signature) {
    console.warn('[Webhook] Invalid Paystack signature — possible fake request');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // ── 2. Parse the event ──
  const event = JSON.parse(req.body);
  console.log(`[Webhook] Received: ${event.event} | Ref: ${event.data?.reference}`);

  // ── 3. Handle charge.success ──
  if (event.event === 'charge.success') {
    const { reference, amount, customer } = event.data;

    try {
      // Get the transaction from DB
      const transaction = await db.getTransactionByRef(reference);

      if (!transaction) {
        console.error(`[Webhook] Transaction not found for ref: ${reference}`);
        return res.sendStatus(200); // Acknowledge anyway so Paystack stops retrying
      }

      // Guard against duplicate webhook calls
      if (transaction.status === 'PAID' || transaction.status === 'COMPLETED') {
        console.log(`[Webhook] Already processed: ${reference}`);
        return res.sendStatus(200);
      }

      // Verify amount matches (convert from kobo to naira)
      const paidNgn = amount / 100;
      if (paidNgn < transaction.ngn_amount * 0.99) {
        await db.updateTransaction(transaction.id, { status: 'UNDERPAID' });
        console.error(`[Webhook] Underpaid: expected ₦${transaction.ngn_amount}, got ₦${paidNgn}`);
        await notify.smsAdmin(`⚠️ Underpaid transaction ${reference}: expected ₦${transaction.ngn_amount}, got ₦${paidNgn}`);
        return res.sendStatus(200);
      }

      // ── 4. Update status to PAID ──
      await db.updateTransaction(transaction.id, {
        status: 'PAID',
        paidAt: new Date(),
      });

      // ── 5. Route to correct payout method ──
      await routePayout(transaction);

      // ── 6. Notify sender ──
      await notify.sms(
        transaction.sender_phone,
        `Hi ${transaction.sender_name}, your NairaFlow transfer of ₦${parseInt(transaction.ngn_amount).toLocaleString()} has been received. Ref: ${reference}. Your recipient will be notified once delivered.`
      );

    } catch (err) {
      console.error('[Webhook] Processing error:', err.message);
      await notify.smsAdmin(`❌ Webhook error for ${reference}: ${err.message}`);
    }
  }

  // Always return 200 so Paystack doesn't retry
  res.sendStatus(200);
});

// ────────────────────────────────────────────────────────
//  Route payout to the right delivery method
// ────────────────────────────────────────────────────────
async function routePayout(transaction) {
  const { delivery_type, id } = transaction;

  console.log(`[Payout] Routing ${id} via ${delivery_type}`);

  try {
    switch (delivery_type) {

      case 'CASH_PICKUP':
        // Assign a local agent to deliver cash in Nigeria
        await payouts.assignCashAgent(transaction);
        break;

      case 'BANK_TRANSFER_NGN':
        // Send NGN to a Nigerian bank account
        await payouts.sendNigerianBankTransfer(transaction);
        break;

      case 'USD_WIRE':
      case 'CAD_WIRE':
      case 'GBP_WIRE':
      case 'EUR_WIRE':
      case 'AUD_WIRE':
      case 'ZAR_WIRE':
        // International bank wire via Wise
        await payouts.sendViaWise(transaction);
        break;

      case 'TRY_WIRE':
      case 'MYR_WIRE':
        // Exotic currency via Thunes
        await payouts.sendViaThunes(transaction);
        break;

      case 'GHS_WIRE':
        // Ghana via Flutterwave
        await payouts.sendViaFlutterwave(transaction);
        break;

      case 'WALLET':
        // Credit a virtual wallet (Grey / Geegpay)
        await payouts.creditWallet(transaction);
        break;

      default:
        // Auto-detect based on currency
        await payouts.autoRoute(transaction);
    }

  } catch (err) {
    console.error(`[Payout] Failed for ${id}:`, err.message);
    await db.updateTransaction(id, { status: 'PAYOUT_FAILED', errorMessage: err.message });
    await notify.smsAdmin(`❌ Payout failed for transaction ${transaction.reference}: ${err.message}`);
    throw err;
  }
}

module.exports = router;
