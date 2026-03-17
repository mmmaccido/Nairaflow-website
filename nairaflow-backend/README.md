# NairaFlow Backend API

Multi-currency remittance backend for the NairaFlow website.

## Quick Start

### 1. Install dependencies
```bash
npm install
```

### 2. Set up environment variables
```bash
cp .env.example .env
# Open .env and fill in your API keys (see guide below)
```

### 3. Set up the database
Create a free PostgreSQL database at https://supabase.com, copy the connection string into `.env`, then run:
```bash
node -e "require('./db/database').setupTables()"
```

### 4. Start the server
```bash
npm run dev      # development (auto-restarts on changes)
npm start        # production
```

Your API is now running at http://localhost:3000

---

## API Keys You Need

| Service | Purpose | Where to get it | Cost |
|---|---|---|---|
| **Paystack** | Collect NGN payments | dashboard.paystack.com | Free (1.5% per txn) |
| **ExchangeRate-API** | Live FX rates | app.exchangerate-api.com | Free tier (1,500 req/month) |
| **Wise** | International payouts | wise.com/gb/business/api | ~$3–5 per transfer |
| **Thunes** | TRY, MYR payouts | docs.thunes.com | Contact for pricing |
| **Flutterwave** | GHS payouts | dashboard.flutterwave.com | 1.4% per transfer |
| **Termii** | SMS notifications | termii.com | ~₦4 per SMS |
| **Smile Identity** | BVN verification | smileidentity.com | ~$0.50 per check |
| **Supabase** | PostgreSQL database | supabase.com | Free tier |

---

## Connecting to Your Frontend

In your `index.html`, the calculator and send button need to call your backend.
Update the `simulatePay` function and rate fetching to point to your server:

```javascript
// Fetch live rates (replace static RATES object)
async function loadRates() {
  const res = await fetch('http://localhost:3000/api/rates/all');
  RATES = await res.json();
  calcUpdate();
}
loadRates();

// Initiate payment (replace simulatePay function)
async function simulatePay() {
  const res = await fetch('http://localhost:3000/api/transactions/initiate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ngnAmount: parseFloat(document.getElementById('m_ngn').value),
      targetCurrency: document.getElementById('m_currency').value,
      deliveryType: document.getElementById('m_delivery').value,
      senderDetails: {
        name: 'Sender Name',       // collect from a login/profile
        email: 'sender@email.com', // collect from step 2 form
        phone: '+2348012345678',
      },
      recipientDetails: {
        name: document.getElementById('r_first').value + ' ' + document.getElementById('r_last').value,
        phone: document.getElementById('r_phone').value,
        accountNumber: document.getElementById('b_accountNumber')?.value,
        // ... other bank fields
      }
    })
  });
  const data = await res.json();
  window.location.href = data.authorizationUrl; // redirect to Paystack
}
```

---

## Webhook Setup (Important)

Paystack needs to send payment confirmations to your server. 

1. In your Paystack dashboard, go to **Settings → API Keys & Webhooks**
2. Set Webhook URL to: `https://yourdomain.com/webhooks/paystack`
3. For local testing, use [ngrok](https://ngrok.com): run `ngrok http 3000` and use the https URL

---

## Deployment

Recommended free/cheap hosting options:

| Platform | Cost | Notes |
|---|---|---|
| **Railway** | ~$5/mo | Easiest — connects to GitHub, auto-deploys |
| **Render** | Free tier | Sleeps after 15min inactivity on free plan |
| **Heroku** | ~$7/mo | Classic choice, reliable |
| **VPS (DigitalOcean)** | $6/mo | Full control, needs more setup |

For Railway (recommended):
1. Push this backend folder to a GitHub repo
2. Go to railway.app → New Project → Deploy from GitHub
3. Add all your `.env` variables in Railway's dashboard
4. Railway gives you a public URL automatically
