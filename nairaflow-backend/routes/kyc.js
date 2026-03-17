// ─────────────────────────────────────────────
//  routes/kyc.js
//  POST /api/kyc/verify-bvn  — verify Nigerian BVN
// ─────────────────────────────────────────────
const express = require('express');
const axios   = require('axios');
const router  = express.Router();

// POST /api/kyc/verify-bvn
router.post('/verify-bvn', async (req, res) => {
  const { bvn, firstName, lastName, phone } = req.body;

  if (!bvn || bvn.length !== 11) {
    return res.status(400).json({ error: 'BVN must be 11 digits' });
  }

  try {
    // Smile Identity BVN lookup
    const response = await axios.post(
      'https://api.smileidentity.com/v1/id_verification',
      {
        partner_id:   process.env.SMILE_PARTNER_ID,
        api_key:      process.env.SMILE_API_KEY,
        country:      'NG',
        id_type:      'BVN',
        id_number:    bvn,
        first_name:   firstName,
        last_name:    lastName,
        phone_number: phone,
      }
    );

    const result = response.data;
    const verified = result.ResultCode === '1012' || result.SmileJobID;

    res.json({
      verified,
      message: verified ? 'BVN verified successfully' : 'BVN could not be verified',
      smileJobId: result.SmileJobID,
    });

  } catch (err) {
    console.error('[KYC] BVN verify error:', err.response?.data || err.message);
    res.status(500).json({ error: 'KYC verification failed', details: err.message });
  }
});

module.exports = router;
