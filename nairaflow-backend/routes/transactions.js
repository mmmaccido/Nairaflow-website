// ─────────────────────────────────────────────
//  routes/transactions.js
//  POST /api/transactions/initiate  — start a transfer
//  GET  /api/transactions/:id       — get status
//  GET  /api/transactions/verify/:ref — verify Paystack payment
// ─────────────────────────────────────────────
const express = require('express');
const axios   = require('axios');
const crypto  = require('crypto');
const router  = express.Router();
const db      = require('../db/database');
const notify  = require('../services/notify');

// ── Fee calculator ──
function calculateFee(ngnAmount) {
  const percent = ngnAmount * 0.01;      // 1%
  return Math.min(Math.max(percent, 500), 5000);  // min ₦500, max ₦5,000
}

// ── Generate a short readable reference ──
function generateRef() {
  return 'NF-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

// ────────────────────────────────────────────────────────
//  POST /api/transactions/initiate
//  Body: { ngnAmount, targetCurrency, deliveryType, recipientDetails, senderDetails }
// ────────────────────────────────────────────────────────
router.post('/initiate', async (req, res) => {
  try {
    const {
      ngnAmount,
      targetCurrency,
      deliveryType,      // CASH_PICKUP | BANK_TRANSFER_NGN | USD_WIRE | WALLET
      recipientDetails,  // { name, phone, accountNumber, bankName, sortCode, iban, address, etc. }
      senderDetails,     // { name, email, phone, bvn }
    } = req.body;

    // ── Validate input ──
    if (!ngnAmount || ngnAmount < 5000) {
      return res.status(400).json({ error: 'Minimum transfer amount is ₦5,000' });
    }
    if (!targetCurrency) {
      return res.status(400).json({ error: 'Target currency is required' });
    }
    if (!recipientDetails?.name || !recipientDetails?.phone) {
      return res.status(400).json({ error: 'Recipient name and phone are required' });
    }

    // ── Get live rate ──
    const rateRes = await axios.get(
      `http://localhost:${process.env.PORT || 3000}/api/rates/${targetCurrency}`
    );
    const rateData = rateRes.data;

    const fee         = calculateFee(ngnAmount);
    const netNgn      = ngnAmount - fee;
    const targetAmount = (netNgn * rateData.rate).toFixed(4);
    const reference   = generateRef();

    // ── Save transaction to database ──
    const transaction = await db.createTransaction({
      reference,
      senderName:    senderDetails.name,
      senderEmail:   senderDetails.email,
      senderPhone:   senderDetails.phone,
      recipientName: recipientDetails.name,
      recipientPhone: recipientDetails.phone,
      recipientDetails: JSON.stringify(recipientDetails),
      ngnAmount,
      fee,
      netNgn,
      targetCurrency,
      targetAmount,
      exchangeRate:  rateData.rate,
      deliveryType,
      status: 'PENDING_PAYMENT',
    });

    // ── Initialize Paystack payment ──
    const paystackRes = await axios.post(
      'https://api.paystack.co/transaction/initialize',
      {
        email:        senderDetails.email,
        amount:       Math.round(ngnAmount * 100),  // Paystack uses kobo (100ths of naira)
        reference:    transaction.reference,
        callback_url: `${process.env.BASE_URL}/api/transactions/verify/${transaction.reference}`,
        metadata: {
          transactionId:  transaction.id,
          targetCurrency,
          deliveryType,
          recipientName:  recipientDetails.name,
          custom_fields: [
            { display_name: 'Transfer to',    variable_name: 'transfer_to',    value: recipientDetails.name },
            { display_name: 'Currency',        variable_name: 'currency',       value: targetCurrency },
            { display_name: 'Recipient gets', variable_name: 'recipient_gets', value: `${rateData.symbol}${parseFloat(targetAmount).toFixed(2)}` },
          ]
        }
      },
      {
        headers: {
          Authorization:  `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
          'Content-Type': 'application/json',
        }
      }
    );

    const { authorization_url, access_code } = paystackRes.data.data;

    // Update transaction with Paystack access code
    await db.updateTransaction(transaction.id, { paystackAccessCode: access_code });

    // ── Respond to frontend ──
    res.json({
      success:          true,
      transactionId:    transaction.id,
      reference:        transaction.reference,
      authorizationUrl: authorization_url,   // redirect user here to pay
      summary: {
        ngnAmount,
        fee,
        targetAmount: `${rateData.symbol}${parseFloat(targetAmount).toFixed(2)} ${targetCurrency}`,
        rate:         `₦1,000 = ${(rateData.rate * 1000).toFixed(4)} ${targetCurrency}`,
        deliveryType,
      }
    });

  } catch (err) {
    console.error('[Transaction] Initiate error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Could not initiate transaction', details: err.message });
  }
});

// ────────────────────────────────────────────────────────
//  GET /api/transactions/verify/:reference
//  Called by Paystack after redirect — confirm payment
// ────────────────────────────────────────────────────────
router.get('/verify/:reference', async (req, res) => {
  try {
    const { reference } = req.params;

    // Verify payment with Paystack
    const verifyRes = await axios.get(
      `https://api.paystack.co/transaction/verify/${reference}`,
      {
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
      }
    );

    const paymentData = verifyRes.data.data;

    if (paymentData.status !== 'success') {
      return res.redirect(
        `${process.env.FRONTEND_URL}/payment-failed?ref=${reference}&reason=${paymentData.gateway_response}`
      );
    }

    // Update transaction status
    const transaction = await db.getTransactionByRef(reference);
    await db.updateTransaction(transaction.id, {
      status:        'PAID',
      paystackTxnId: paymentData.id,
      paidAt:        new Date(),
    });

    // Trigger payout (handled async by webhook — this is just the redirect)
    res.redirect(
      `${process.env.FRONTEND_URL}/payment-success?ref=${reference}&amount=${transaction.targetAmount}&currency=${transaction.targetCurrency}`
    );

  } catch (err) {
    console.error('[Transaction] Verify error:', err.message);
    res.redirect(`${process.env.FRONTEND_URL}/payment-failed?ref=${req.params.reference}`);
  }
});

// ────────────────────────────────────────────────────────
//  GET /api/transactions/:id
//  Track a transaction status
// ────────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const transaction = await db.getTransaction(req.params.id);
    if (!transaction) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    // Return safe subset (no internal IDs)
    res.json({
      reference:     transaction.reference,
      status:        transaction.status,
      ngnAmount:     transaction.ngn_amount,
      targetAmount:  transaction.target_amount,
      targetCurrency:transaction.target_currency,
      deliveryType:  transaction.delivery_type,
      createdAt:     transaction.created_at,
      updatedAt:     transaction.updated_at,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
