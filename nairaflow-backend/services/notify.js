// ─────────────────────────────────────────────
//  services/notify.js
//  SMS via Termii (Nigerian provider)
//  Email via Nodemailer (Gmail / SMTP)
// ─────────────────────────────────────────────
const axios      = require('axios');
const nodemailer = require('nodemailer');

// ── Email transporter ──
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  }
});

// ────────────────────────────────────────────────────────
//  SMS via Termii (best for Nigerian numbers)
// ────────────────────────────────────────────────────────
async function sms(phone, message) {
  if (!phone || !process.env.TERMII_API_KEY) {
    console.log(`[SMS - no key] To: ${phone} | ${message}`);
    return;
  }

  // Normalize Nigerian number
  const normalized = normalizePhone(phone);

  try {
    const res = await axios.post('https://api.ng.termii.com/api/sms/send', {
      to:       normalized,
      from:     process.env.TERMII_SENDER_ID || 'NairaFlow',
      sms:      message,
      type:     'plain',
      channel:  'generic',
      api_key:  process.env.TERMII_API_KEY,
    });
    console.log(`[SMS] Sent to ${normalized}: ${res.data?.message}`);
  } catch (err) {
    console.error(`[SMS] Failed to ${normalized}:`, err.response?.data || err.message);
    // Don't throw — SMS failure should not block the payout
  }
}

// Send SMS alert to your own admin number
async function smsAdmin(message) {
  const adminPhone = process.env.ADMIN_PHONE;
  if (adminPhone) {
    await sms(adminPhone, `[NairaFlow Admin] ${message}`);
  }
  console.log(`[Admin Alert] ${message}`);
}

// ────────────────────────────────────────────────────────
//  Email notifications
// ────────────────────────────────────────────────────────
async function email(to, subject, htmlBody) {
  if (!process.env.SMTP_USER) {
    console.log(`[Email - no config] To: ${to} | Subject: ${subject}`);
    return;
  }

  try {
    await transporter.sendMail({
      from:    `"NairaFlow" <${process.env.SMTP_USER}>`,
      to,
      subject,
      html:    htmlBody,
    });
    console.log(`[Email] Sent to ${to}: ${subject}`);
  } catch (err) {
    console.error(`[Email] Failed to ${to}:`, err.message);
  }
}

// ── Transfer confirmation email ──
async function sendTransferConfirmation(transaction) {
  if (!transaction.sender_email) return;

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px">
      <div style="background:#D4A843;padding:16px 24px;border-radius:8px 8px 0 0">
        <h1 style="color:#0D1117;margin:0;font-size:20px">Transfer Confirmed ✓</h1>
      </div>
      <div style="background:#f8f9fc;padding:24px;border-radius:0 0 8px 8px;border:1px solid #e2e8f4;border-top:none">
        <p>Hi ${transaction.sender_name},</p>
        <p>Your transfer has been received and is being processed.</p>
        <table style="width:100%;border-collapse:collapse;margin:20px 0">
          <tr style="border-bottom:1px solid #e2e8f4">
            <td style="padding:10px 0;color:#6b7a99;font-size:14px">Reference</td>
            <td style="padding:10px 0;font-weight:600;font-size:14px">${transaction.reference}</td>
          </tr>
          <tr style="border-bottom:1px solid #e2e8f4">
            <td style="padding:10px 0;color:#6b7a99;font-size:14px">Amount sent</td>
            <td style="padding:10px 0;font-weight:600;font-size:14px">₦${parseInt(transaction.ngn_amount).toLocaleString()}</td>
          </tr>
          <tr style="border-bottom:1px solid #e2e8f4">
            <td style="padding:10px 0;color:#6b7a99;font-size:14px">Recipient receives</td>
            <td style="padding:10px 0;font-weight:600;font-size:14px;color:#0F9E6B">${transaction.target_currency} ${parseFloat(transaction.target_amount).toFixed(2)}</td>
          </tr>
          <tr style="border-bottom:1px solid #e2e8f4">
            <td style="padding:10px 0;color:#6b7a99;font-size:14px">Recipient</td>
            <td style="padding:10px 0;font-weight:600;font-size:14px">${transaction.recipient_name}</td>
          </tr>
          <tr>
            <td style="padding:10px 0;color:#6b7a99;font-size:14px">Delivery method</td>
            <td style="padding:10px 0;font-weight:600;font-size:14px">${transaction.delivery_type}</td>
          </tr>
        </table>
        <p style="color:#6b7a99;font-size:13px">You will receive another email when the transfer is delivered. For support, reply to this email or call ${process.env.SUPPORT_PHONE || 'our helpline'}.</p>
      </div>
    </div>
  `;

  await email(
    transaction.sender_email,
    `Transfer confirmed — ₦${parseInt(transaction.ngn_amount).toLocaleString()} to ${transaction.recipient_name}`,
    html
  );
}

// ── Normalize phone number to international format ──
function normalizePhone(phone) {
  let p = phone.replace(/\s+/g, '').replace(/[^+\d]/g, '');
  if (p.startsWith('0')) p = '+234' + p.slice(1);
  if (!p.startsWith('+')) p = '+' + p;
  return p;
}

module.exports = { sms, smsAdmin, email, sendTransferConfirmation };
