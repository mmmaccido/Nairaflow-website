// ─────────────────────────────────────────────
//  services/payouts.js
//  All payout methods in one place:
//  - Wise API (USD, CAD, GBP, EUR, AUD, ZAR, TRY)
//  - Thunes (TRY, MYR, exotic currencies)
//  - Flutterwave (GHS, African currencies)
//  - Nigerian bank transfer (NGN domestic)
//  - Cash agent assignment
//  - Virtual wallet credit
// ─────────────────────────────────────────────
const axios  = require('axios');
const db     = require('../db/database');
const notify = require('./notify');

const WISE_BASE = process.env.WISE_ENV === 'live'
  ? 'https://api.transferwise.com'
  : 'https://api.sandbox.transferwise.com';

const THUNES_BASE = process.env.THUNES_ENV === 'live'
  ? 'https://api.thunes.com'
  : 'https://api.preprod.thunes.com';

// ────────────────────────────────────────────────────────
//  1. WISE — International bank transfer
//     Supports: USD, CAD, GBP, EUR, AUD, ZAR, TRY
// ────────────────────────────────────────────────────────
async function sendViaWise(transaction) {
  const recipient  = JSON.parse(transaction.recipient_details);
  const profileId  = process.env.WISE_PROFILE_ID;
  const headers    = { Authorization: `Bearer ${process.env.WISE_API_KEY}` };
  const currency   = transaction.target_currency;

  try {
    // ── Step 1: Create a quote (how much to send) ──
    const quoteRes = await axios.post(
      `${WISE_BASE}/v3/profiles/${profileId}/quotes`,
      {
        sourceCurrency: 'USD',          // Wise operates in USD as intermediary
        targetCurrency: currency,
        targetAmount:   parseFloat(transaction.target_amount),
        payOut:         'BANK_TRANSFER',
      },
      { headers }
    );
    const quoteId = quoteRes.data.id;

    // ── Step 2: Create recipient account ──
    const recipientPayload = buildWiseRecipientPayload(currency, recipient, profileId);
    const recipientRes = await axios.post(
      `${WISE_BASE}/v1/accounts`,
      recipientPayload,
      { headers }
    );
    const recipientId = recipientRes.data.id;

    // ── Step 3: Create the transfer ──
    const transferRes = await axios.post(
      `${WISE_BASE}/v1/transfers`,
      {
        targetAccount:              recipientId,
        quoteUuid:                  quoteId,
        customerTransactionId:      transaction.reference,
        details: {
          reference: `NairaFlow-${transaction.reference}`,
          transferPurpose: 'verification.transfers.purpose.pay.for.goods',
          sourceOfFunds:   'verification.source.of.funds.other',
        }
      },
      { headers }
    );
    const transferId = transferRes.data.id;

    // ── Step 4: Fund from Wise balance ──
    await axios.post(
      `${WISE_BASE}/v3/profiles/${profileId}/transfers/${transferId}/payments`,
      { type: 'BALANCE' },
      { headers }
    );

    // ── Update DB ──
    await db.updateTransaction(transaction.id, {
      status:           'PROCESSING',
      payoutProvider:   'wise',
      payoutTransferId: String(transferId),
    });

    // ── Notify recipient ──
    await notify.sms(
      recipient.phone,
      `Hi ${recipient.name}, ₦${parseInt(transaction.ngn_amount).toLocaleString()} has been sent to your ${currency} bank account by NairaFlow. Ref: ${transaction.reference}. Arrives in ${getSpeed(currency)}.`
    );

    console.log(`[Wise] Transfer created: ${transferId} for ${transaction.reference}`);
    return { provider: 'wise', transferId };

  } catch (err) {
    const errMsg = err.response?.data || err.message;
    console.error('[Wise] Error:', JSON.stringify(errMsg));
    throw new Error(`Wise payout failed: ${JSON.stringify(errMsg)}`);
  }
}

// Build Wise recipient account payload — differs per currency
function buildWiseRecipientPayload(currency, recipient, profileId) {
  const base = {
    currency,
    profile: parseInt(profileId),
    accountHolderName: recipient.name,
    legalType: 'PRIVATE',
  };

  switch (currency) {
    case 'USD':
      return { ...base, type: 'aba', details: {
        accountType:   'CHECKING',
        accountNumber: recipient.accountNumber,
        abartn:        recipient.routingNumber,   // ABA routing number
      }};
    case 'CAD':
      return { ...base, type: 'canadian', details: {
        accountNumber:     recipient.accountNumber,
        transitNumber:     recipient.transitNumber,
        institutionNumber: recipient.institutionNumber,
      }};
    case 'GBP':
      return { ...base, type: 'sort_code', details: {
        accountNumber: recipient.accountNumber,
        sortCode:      recipient.sortCode.replace(/-/g, ''),
      }};
    case 'EUR':
      return { ...base, type: 'iban', details: {
        IBAN: recipient.iban,
        BIC:  recipient.bic,
      }};
    case 'TRY':
      return { ...base, type: 'turkish_earthport', details: {
        IBAN: recipient.iban,  // TR + 24 digits
      }};
    case 'AUD':
      return { ...base, type: 'australian', details: {
        accountNumber: recipient.accountNumber,
        bsbCode:       recipient.bsb,
      }};
    case 'ZAR':
      return { ...base, type: 'southafrica', details: {
        accountNumber: recipient.accountNumber,
        bankCode:      recipient.bankCode,        // SWIFT/BIC code
      }};
    default:
      return { ...base, type: 'iban', details: { IBAN: recipient.iban } };
  }
}

// ────────────────────────────────────────────────────────
//  2. THUNES — Exotic currencies (TRY fallback, MYR, etc.)
// ────────────────────────────────────────────────────────
async function sendViaThunes(transaction) {
  const recipient = JSON.parse(transaction.recipient_details);
  const authConfig = {
    auth: {
      username: process.env.THUNES_API_KEY,
      password: process.env.THUNES_API_SECRET,
    }
  };

  try {
    // ── Step 1: Create quotation ──
    const quoteRes = await axios.post(
      `${THUNES_BASE}/v2/money-transfer/quotations`,
      {
        external_id: transaction.reference,
        payer_id:    parseInt(process.env.THUNES_PAYER_ID),
        mode:        'SOURCE_AMOUNT',
        source: {
          amount:   parseFloat(transaction.ngn_amount),
          currency: 'NGN',
        },
        destination: {
          currency: transaction.target_currency,
        },
      },
      authConfig
    );
    const quotationId = quoteRes.data.id;

    // ── Step 2: Create transaction ──
    const txnRes = await axios.post(
      `${THUNES_BASE}/v2/money-transfer/quotations/${quotationId}/transactions`,
      {
        external_id: transaction.reference,
        credit_party_identifier: {
          bank_account_number: recipient.accountNumber,
          bank_name:           recipient.bankName,
          iban:                recipient.iban,
        },
        beneficiary: {
          last_name:  recipient.name.split(' ').pop(),
          first_name: recipient.name.split(' ')[0],
          address: {
            line1:            recipient.address || '',
            country_iso_code: recipient.countryCode || 'TR',
          }
        },
        sending_business: {
          name: process.env.BUSINESS_NAME || 'NairaFlow',
        }
      },
      authConfig
    );
    const thuneTxnId = txnRes.data.id;

    // ── Step 3: Confirm ──
    await axios.post(
      `${THUNES_BASE}/v2/money-transfer/transactions/${thuneTxnId}/confirm`,
      {},
      authConfig
    );

    await db.updateTransaction(transaction.id, {
      status:           'PROCESSING',
      payoutProvider:   'thunes',
      payoutTransferId: String(thuneTxnId),
    });

    await notify.sms(
      recipient.phone,
      `Hi ${recipient.name}, your transfer of ${transaction.target_currency} ${parseFloat(transaction.target_amount).toFixed(2)} from NairaFlow is on its way. Ref: ${transaction.reference}.`
    );

    console.log(`[Thunes] Transaction confirmed: ${thuneTxnId}`);
    return { provider: 'thunes', transferId: thuneTxnId };

  } catch (err) {
    const errMsg = err.response?.data || err.message;
    throw new Error(`Thunes payout failed: ${JSON.stringify(errMsg)}`);
  }
}

// ────────────────────────────────────────────────────────
//  3. FLUTTERWAVE — African currencies (GHS, etc.)
// ────────────────────────────────────────────────────────
async function sendViaFlutterwave(transaction) {
  const recipient = JSON.parse(transaction.recipient_details);

  try {
    const res = await axios.post(
      'https://api.flutterwave.com/v3/transfers',
      {
        account_bank:   recipient.bankCode,    // Flutterwave bank code
        account_number: recipient.accountNumber,
        amount:         parseFloat(transaction.target_amount),
        currency:       transaction.target_currency,
        narration:      `NairaFlow transfer from Nigeria`,
        reference:      transaction.reference,
        beneficiary_name: recipient.name,
        meta: {
          sender:           transaction.sender_name,
          sender_country:   'NG',
          transfer_purpose: 'Student support',
        }
      },
      {
        headers: {
          Authorization:  `Bearer ${process.env.FLUTTERWAVE_SECRET_KEY}`,
          'Content-Type': 'application/json',
        }
      }
    );

    const fwTxnId = res.data.data?.id;

    await db.updateTransaction(transaction.id, {
      status:           'PROCESSING',
      payoutProvider:   'flutterwave',
      payoutTransferId: String(fwTxnId),
    });

    await notify.sms(
      recipient.phone,
      `Hi ${recipient.name}, ${transaction.target_currency} ${parseFloat(transaction.target_amount).toFixed(2)} has been sent to your account via NairaFlow. Ref: ${transaction.reference}.`
    );

    console.log(`[Flutterwave] Transfer queued: ${fwTxnId}`);
    return { provider: 'flutterwave', transferId: fwTxnId };

  } catch (err) {
    const errMsg = err.response?.data || err.message;
    throw new Error(`Flutterwave payout failed: ${JSON.stringify(errMsg)}`);
  }
}

// ────────────────────────────────────────────────────────
//  4. NIGERIAN BANK TRANSFER (NGN domestic via Paystack)
// ────────────────────────────────────────────────────────
async function sendNigerianBankTransfer(transaction) {
  const recipient = JSON.parse(transaction.recipient_details);

  try {
    // Step 1: Create a transfer recipient on Paystack
    const recipientRes = await axios.post(
      'https://api.paystack.co/transferrecipient',
      {
        type:           'nuban',
        name:           recipient.name,
        account_number: recipient.accountNumber,
        bank_code:      recipient.bankCode,       // Paystack bank code (e.g. '058' for GTB)
        currency:       'NGN',
      },
      {
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
      }
    );
    const recipientCode = recipientRes.data.data.recipient_code;

    // Step 2: Initiate the transfer
    const transferRes = await axios.post(
      'https://api.paystack.co/transfer',
      {
        source:    'balance',
        amount:    Math.round(transaction.ngn_amount * 100),  // kobo
        recipient: recipientCode,
        reason:    `NairaFlow transfer — Ref: ${transaction.reference}`,
        reference: `${transaction.reference}-NGN`,
      },
      {
        headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
      }
    );

    const transferCode = transferRes.data.data.transfer_code;

    await db.updateTransaction(transaction.id, {
      status:           'PROCESSING',
      payoutProvider:   'paystack_ngn',
      payoutTransferId: transferCode,
    });

    await notify.sms(
      recipient.phone,
      `Hi ${recipient.name}, ₦${parseInt(transaction.ngn_amount).toLocaleString()} has been sent to your ${recipient.bankName} account by NairaFlow. Usually arrives in minutes. Ref: ${transaction.reference}.`
    );

    console.log(`[Paystack NGN] Transfer initiated: ${transferCode}`);
    return { provider: 'paystack_ngn', transferCode };

  } catch (err) {
    const errMsg = err.response?.data || err.message;
    throw new Error(`Nigerian bank transfer failed: ${JSON.stringify(errMsg)}`);
  }
}

// ────────────────────────────────────────────────────────
//  5. CASH AGENT ASSIGNMENT
// ────────────────────────────────────────────────────────
async function assignCashAgent(transaction) {
  const recipient = JSON.parse(transaction.recipient_details);

  try {
    // Find an available agent near recipient's city with enough float
    const agent = await db.findAvailableAgent({
      city:            recipient.city || recipient.address,
      minCashBalance:  parseFloat(transaction.ngn_amount),
    });

    if (!agent) {
      // No agent available — fall back to bank transfer
      console.warn(`[CashAgent] No agent available in ${recipient.city} — falling back to bank transfer`);
      await notify.smsAdmin(
        `⚠️ No cash agent available for transaction ${transaction.reference} in ${recipient.city}. Falling back to bank transfer.`
      );
      // Update delivery type and reroute
      await db.updateTransaction(transaction.id, { deliveryType: 'BANK_TRANSFER_NGN' });
      return sendNigerianBankTransfer(transaction);
    }

    // Assign the job to the agent
    const jobRef = `JOB-${transaction.reference}`;
    await db.createAgentJob({
      agentId:        agent.id,
      transactionId:  transaction.id,
      jobRef,
      ngnAmount:      transaction.ngn_amount,
      recipientName:  recipient.name,
      recipientPhone: recipient.phone,
      recipientAddress: recipient.address,
      status:         'ASSIGNED',
      deadline:       new Date(Date.now() + 4 * 60 * 60 * 1000), // 4 hours
    });

    // Deduct from agent float balance
    await db.decrementAgentBalance(agent.id, parseFloat(transaction.ngn_amount));

    // Notify the agent
    await notify.sms(
      agent.phone,
      `NairaFlow Job ${jobRef}: Deliver ₦${parseInt(transaction.ngn_amount).toLocaleString()} to ${recipient.name} at ${recipient.address}. Phone: ${recipient.phone}. Confirm with code: ${transaction.reference.slice(-6)}. Deadline: 4 hours.`
    );

    // Notify the recipient
    await notify.sms(
      recipient.phone,
      `Hi ${recipient.name}, ₦${parseInt(transaction.ngn_amount).toLocaleString()} is on its way to you via NairaFlow. Our agent will contact you shortly. Confirmation code: ${transaction.reference.slice(-6)}.`
    );

    await db.updateTransaction(transaction.id, {
      status:  'AGENT_ASSIGNED',
      agentId: agent.id,
    });

    console.log(`[CashAgent] Job ${jobRef} assigned to agent ${agent.id}`);
    return { provider: 'cash_agent', agentId: agent.id, jobRef };

  } catch (err) {
    throw new Error(`Cash agent assignment failed: ${err.message}`);
  }
}

// ────────────────────────────────────────────────────────
//  6. VIRTUAL WALLET (Grey / Geegpay)
// ────────────────────────────────────────────────────────
async function creditWallet(transaction) {
  const recipient = JSON.parse(transaction.recipient_details);

  // Grey and Geegpay have their own APIs — this is a placeholder
  // Replace with actual Grey API: https://grey.co/developers
  console.log(`[Wallet] Crediting ${recipient.walletId} with ${transaction.target_currency} ${transaction.target_amount}`);

  await db.updateTransaction(transaction.id, {
    status:         'PROCESSING',
    payoutProvider: 'wallet',
  });

  await notify.sms(
    recipient.phone,
    `Hi ${recipient.name}, ${transaction.target_currency} ${parseFloat(transaction.target_amount).toFixed(2)} has been sent to your wallet (${recipient.walletId}) via NairaFlow. Ref: ${transaction.reference}.`
  );

  return { provider: 'wallet' };
}

// ────────────────────────────────────────────────────────
//  7. AUTO-ROUTE based on currency
// ────────────────────────────────────────────────────────
async function autoRoute(transaction) {
  const currency = transaction.target_currency;
  const WISE_CURRENCIES      = ['USD', 'CAD', 'GBP', 'EUR', 'AUD', 'ZAR'];
  const THUNES_CURRENCIES    = ['TRY', 'MYR'];
  const FLUTTERWAVE_CURRENCIES = ['GHS'];

  if (WISE_CURRENCIES.includes(currency))       return sendViaWise(transaction);
  if (THUNES_CURRENCIES.includes(currency))     return sendViaThunes(transaction);
  if (FLUTTERWAVE_CURRENCIES.includes(currency))return sendViaFlutterwave(transaction);
  if (currency === 'NGN')                       return sendNigerianBankTransfer(transaction);
  throw new Error(`No payout route for currency: ${currency}`);
}

function getSpeed(currency) {
  const speeds = { USD:'minutes–1 day', CAD:'minutes–1 day', GBP:'seconds–hours', EUR:'1–2 days', AUD:'minutes', ZAR:'1–2 days', TRY:'1–2 days', GHS:'hours' };
  return speeds[currency] || '1–3 days';
}

module.exports = {
  sendViaWise,
  sendViaThunes,
  sendViaFlutterwave,
  sendNigerianBankTransfer,
  assignCashAgent,
  creditWallet,
  autoRoute,
};
