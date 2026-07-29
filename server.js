const express = require('express');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
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

app.post('/create-payment-intent', async (req, res) => {
  try {
    const { amount, stripeAccountId } = req.body;
    const amountCents = amount * 100;
    const platformFee = Math.round(amountCents * 0.05);

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: 'usd',
      automatic_payment_methods: { enabled: true },
      ...(stripeAccountId && {
        application_fee_amount: platformFee,
        transfer_data: { destination: stripeAccountId },
      }),
    });

    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ─── STRIPE CONNECT LINK (for DJ payout settings) ────────
app.post('/stripe-connect-link', async (req, res) => {
  try {
    const { uid, email } = req.body;
    if (!uid) return res.status(400).json({ error: 'uid is required' });

    const djDoc = await db.collection('users').doc(uid).get();
    const djData = djDoc.exists ? djDoc.data() : {};
    let stripeAccountId = djData.stripeAccountId || null;

    if (!stripeAccountId) {
      const account = await stripe.accounts.create({
        controller: {
          stripe_dashboard: { type: 'express' },
          fees: { payer: 'application' },
          losses: { payments: 'application' },
          requirement_collection: 'stripe',
        },
        capabilities: {
          card_payments: { requested: true },
          transfers: { requested: true },
        },
        country: 'US',
        email: email || undefined,
      });
      stripeAccountId = account.id;
      await db.collection('users').doc(uid).update({ stripeAccountId });
    }

    let url;
    try {
      const loginLink = await stripe.accounts.createLoginLink(stripeAccountId);
      url = loginLink.url;
    } catch (e) {
      const accountLink = await stripe.accountLinks.create({
        account: stripeAccountId,
        refresh_url: 'https://primedj.app/stripe-refresh',
        return_url: 'https://primedj.app/stripe-return',
        type: 'account_onboarding',
      });
      url = accountLink.url;
    }

    res.json({ url });
  } catch (error) {
    console.error('Stripe connect error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

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
      stripeAccountId: data.stripeAccountId || null,
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
        await stripe.refunds.create({
          payment_intent: requestData.paymentIntentId,
        });
        console.log(`Refund issued for paymentIntent: ${requestData.paymentIntentId}`);
      } catch (refundError) {
        console.error('Refund failed:', refundError.message);
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
