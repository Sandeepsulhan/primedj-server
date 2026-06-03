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
    const { amount } = req.body;
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount * 100,
      currency: 'usd',
      automatic_payment_methods: { enabled: true },
    });
    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get('/dj/:djId', async (req, res) => {
  try {
    const doc = await db.collection('users').doc(req.params.djId).get();
    if (!doc.exists) return res.status(404).json({ error: 'DJ not found' });
    const data = doc.data();
    res.json({
      id: doc.id,
      name: data.name || data.displayName || 'DJ',
      photo: data.photoURL || null,
      isLive: data.isLive || false,
      minTip: data.minTip || 0,
      freeRequests: data.freeRequests || 2,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/requests', async (req, res) => {
  try {
    const { djId, songName, artistName, tipAmount, guestName, message } = req.body;
    if (!djId || !songName) {
      return res.status(400).json({ error: 'djId and songName are required' });
    }
    const request = {
      djId,
      songName,
      artistName: artistName || '',
      tipAmount: tipAmount || 0,
      guestName: guestName || 'Anonymous',
      message: message || '',
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    const ref = await db.collection('requests').add(request);
    res.json({ id: ref.id, ...request });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

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

app.patch('/requests/:requestId', async (req, res) => {
  try {
    const { status } = req.body;
    if (!['accepted', 'declined', 'played'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    await db.collection('requests').doc(req.params.requestId).update({
      status,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    res.json({ success: true, status });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/request-status/:requestId', async (req, res) => {
  try {
    const doc = await db.collection('requests').doc(req.params.requestId).get();
    if (!doc.exists) return res.status(404).json({ error: 'Request not found' });
    const data = doc.data();
    res.json({ id: doc.id, status: data.status, songName: data.songName });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'PrimeDJ Server running!' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
