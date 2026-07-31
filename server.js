const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

const serviceAccount = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();
const app = express();
app.use(cors());
app.use(express.json());

// ─── GET DJ INFO (supports username OR doc ID) ────────────
app.get('/dj/:djId', async (req, res) => {
  try {
    const usernameQuery = await db.collection('users')
      .where('username', '==', req.params.djId)
      .limit(1)
      .get();

    let doc;
    if (!usernameQuery.empty) {
      doc = usernameQuery.docs[0];
    } else {
      doc = await db.collection('users').doc(req.params.djId).get();
      if (!doc.exists) return res.status(404).json({ error: 'DJ not found' });
    }

    const data = doc.data();
    res.set('Cache-Control', 'no-store');
    res.json({
      id: doc.id,
      name: data.name || data.displayName || 'DJ',
      username: data.username || null,
      photo: data.photoURL || null,
      isLive: data.isLive || false,
      minTip: data.minTip || 0,
      freeRequests: data.freeRequests || 2,
      paypalMerchantId: data.paypalMerchantId || null,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── SUBMIT REQUEST (guest submits this) ──────────────────
app.post('/requests', async (req, res) => {
  try {
    const { djId, songName, artistName, tipAmount, guestName, message, paymentIntentId } = req.body;
    if (!djId || !songName) {
      return res.status(400).json({ error: 'djId and songName are required' });
    }
    const request = {
      djId,
      song: songName,
      artist: artistName || '',
      note: message || '',
      tip: tipAmount ? `$${tipAmount}` : null,
      tipAmount: tipAmount || 0,
      paymentIntentId: paymentIntentId || null,
      guestName: guestName || 'Anonymous',
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    const ref = await db.collection('requests').add(request);

    try {
      const djDoc = await db.collection('users').doc(djId).get();
      const pushToken = djDoc.exists ? djDoc.data().expoPushToken : null;
      if (pushToken) {
        await fetch('https://exp.host/--/api/v2/push/send', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            to: pushToken,
            title: '🎵 New Song Request!',
            body: `${guestName || 'Someone'} wants to hear "${songName}"${tipAmount ? ` · $${tipAmount} tip` : ''}`,
            sound: 'default',
            data: { requestId: ref.id },
          }),
        });
      }
    } catch (pushError) {
      console.error('Push notification failed:', pushError.message);
    }

    res.json({ id: ref.id, ...request });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── GET REQUESTS FOR DJ ──────────────────────────────────
app.get('/requests/:djId', async (req, res) => {
  try {
    const snapshot = await db.collection('requests')
      .where('djId', '==', req.params.djId)
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get();
    const requests = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(requests);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── UPDATE REQUEST STATUS ────────────────────────────────
app.patch('/requests/:requestId', async (req, res) => {
  try {
    const { status } = req.body;
    if (!['accepted', 'declined', 'played'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const docRef = db.collection('requests').doc(req.params.requestId);
    const docSnap = await docRef.get();

    if (!docSnap.exists) {
      return res.status(404).json({ error: 'Request not found' });
    }

    const requestData = docSnap.data();

    if (status === 'declined' && requestData.paymentIntentId && requestData.tipAmount > 0) {
      try {
        const accessToken = await getAccessToken();
        await axios.post(
          `${PAYPAL_API}/v2/payments/captures/${requestData.paymentIntentId}/refund`,
          {},
          { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
        );
        console.log(`PayPal refund issued for capture: ${requestData.paymentIntentId}`);
      } catch (refundError) {
        console.error('PayPal refund failed:', refundError.response?.data || refundError.message);
      }
    }

    await docRef.update({
      status,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.json({ success: true, status });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── GET SINGLE REQUEST STATUS ────────────────────────────
app.get('/request-status/:requestId', async (req, res) => {
  try {
    const doc = await db.collection('requests').doc(req.params.requestId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Request not found' });
    const data = doc.data();
    res.set('Cache-Control', 'no-store');
    res.json({ id: doc.id, status: data.status, songName: data.song });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── FOLLOW DJ ────────────────────────────────────────────
app.post('/follow', async (req, res) => {
  try {
    const { djId, email } = req.body;
    if (!djId || !email) {
      return res.status(400).json({ error: 'djId and email are required' });
    }
    await db.collection('followers').add({
      djId,
      email,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── HEALTH CHECK ─────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'PrimeDJ Server running!' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

// ---- PayPal Multiparty: Onboarding Completion ----
app.get('/api/paypal/onboarding-complete', async (req, res) => {
  try {
    const { dj: djId, merchantId, merchantIdInPayPal } = req.query;
    const finalMerchantId = merchantIdInPayPal || merchantId;

    if (!djId || !finalMerchantId) {
      return res.status(400).send('Missing DJ ID or merchant ID');
    }

    await db.collection('users').doc(djId).update({
      paypalMerchantId: finalMerchantId,
    });

    res.redirect(`https://primedj.app/dj/${djId}?onboarding=success`);
  } catch (err) {
    console.error('PayPal onboarding-complete error:', err.message);
    res.status(500).send('Onboarding completion failed');
  }
});

const axios = require('axios');
const { getAccessToken, PAYPAL_API } = require('./paypalClient');

// ---- PayPal Multiparty: DJ Onboarding ----
app.post('/api/paypal/onboard-dj', async (req, res) => {
  try {
    const { djId, email } = req.body;
    const accessToken = await getAccessToken();

    const response = await axios.post(
      `${PAYPAL_API}/v2/customer/partner-referrals`,
      {
        tracking_id: djId,
        partner_config_override: {
          return_url: `https://primedj-server-production.up.railway.app/api/paypal/onboarding-complete?dj=${djId}`,
        },
        operations: [{
          operation: 'API_INTEGRATION',
          api_integration_preference: {
            rest_api_integration: {
              integration_method: 'PAYPAL',
              integration_type: 'THIRD_PARTY',
              third_party_details: {
                features: ['PAYMENT', 'REFUND'],
              },
            },
          },
        }],
        products: ['EXPRESS_CHECKOUT'],
        legal_consents: [{ type: 'SHARE_DATA_CONSENT', granted: true }],
      },
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    const links = response.data.links;
    const actionUrl = links.find(l => l.rel === 'action_url')?.href;

    res.json({ onboardingUrl: actionUrl });
  } catch (err) {
    console.error('PayPal onboarding error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to create onboarding link' });
  }
});

// ---- PayPal Payouts: Batched DJ Payouts ----
app.post('/api/paypal/run-payouts', async (req, res) => {
  try {
    const accessToken = await getAccessToken();

    // Get all tip requests not yet paid out
    const snap = await db.collection('requests')
      .where('tipAmount', '>', 0)
      .get();

    const owedByDj = {};
    const requestIdsByDj = {};

    snap.forEach(doc => {
      const data = doc.data();
      if (data.paypalPayoutStatus === 'paid') return;
      const djId = data.djId;
      if (!djId) return;
      owedByDj[djId] = (owedByDj[djId] || 0) + data.tipAmount;
      requestIdsByDj[djId] = requestIdsByDj[djId] || [];
      requestIdsByDj[djId].push(doc.id);
    });

    const djIds = Object.keys(owedByDj);
    if (djIds.length === 0) {
      return res.json({ message: 'No unpaid tips found.' });
    }

    const items = [];
    for (const djId of djIds) {
      const djDoc = await db.collection('users').doc(djId).get();
      const djData = djDoc.data();
      if (!djData || !djData.paypalEmail) continue;

      const grossAmount = owedByDj[djId];
      const platformFee = grossAmount * 0.05;
      const netAmount = (grossAmount - platformFee).toFixed(2);

      items.push({
        recipient_type: 'EMAIL',
        amount: { value: netAmount, currency: 'USD' },
        receiver: djData.paypalEmail,
        note: `PrimeDJ tip payout (${requestIdsByDj[djId].length} requests)`,
        sender_item_id: djId,
      });
    }

    if (items.length === 0) {
      return res.json({ message: 'No DJs with a PayPal email on file.' });
    }

    const response = await axios.post(
      `${PAYPAL_API}/v1/payments/payouts`,
      {
        sender_batch_header: {
          sender_batch_id: `primedj_batch_${Date.now()}`,
          email_subject: 'You have a PrimeDJ tip payout!',
        },
        items,
      },
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    // Mark all included requests as paid
    const batch = db.batch();
    for (const djId of djIds) {
      if (!requestIdsByDj[djId]) continue;
      for (const reqId of requestIdsByDj[djId]) {
        batch.update(db.collection('requests').doc(reqId), { paypalPayoutStatus: 'paid' });
      }
    }
    await batch.commit();

    res.json({
      message: 'Payout batch sent successfully.',
      batchId: response.data.batch_header.payout_batch_id,
      djsPaid: items.length,
    });
  } catch (err) {
    console.error('PayPal payout error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to process payouts' });
  }
});

// ---- PayPal Standard Checkout: Create Order ----
app.post('/api/paypal/create-order', async (req, res) => {
  try {
    const { tipAmount } = req.body;
    if (!tipAmount || tipAmount <= 0) {
      return res.status(400).json({ error: 'A positive tipAmount is required' });
    }
    const accessToken = await getAccessToken();

    const response = await axios.post(
      `${PAYPAL_API}/v2/checkout/orders`,
      {
        intent: 'CAPTURE',
        purchase_units: [{
          amount: {
            currency_code: 'USD',
            value: Number(tipAmount).toFixed(2),
          },
        }],
      },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );

    res.json({ orderId: response.data.id });
  } catch (err) {
    console.error('PayPal create-order error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to create PayPal order' });
  }
});

// ---- PayPal Standard Checkout: Capture Order ----
app.post('/api/paypal/capture-order', async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ error: 'orderId is required' });
    const accessToken = await getAccessToken();

    const response = await axios.post(
      `${PAYPAL_API}/v2/checkout/orders/${orderId}/capture`,
      {},
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );

    const captureId = response.data.purchase_units?.[0]?.payments?.captures?.[0]?.id || response.data.id;
    res.json({ id: captureId, status: response.data.status });
  } catch (err) {
    console.error('PayPal capture-order error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Failed to capture PayPal order' });
  }
});
