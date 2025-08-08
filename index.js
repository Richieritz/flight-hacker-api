import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import ky from 'ky';
import { format } from 'date-fns';

const app = express();
app.use(cors());
app.use(express.json());

// ENV
const AMADEUS_KEY = process.env.AMADEUS_KEY;
const AMADEUS_SECRET = process.env.AMADEUS_SECRET;

// helpers
function parseISODurationToMinutes(iso) {
  const m = String(iso).match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  const h = m?.[1] ? parseInt(m[1], 10) : 0;
  const min = m?.[2] ? parseInt(m[2], 10) : 0;
  return h * 60 + min;
}

async function getAccessToken() {
  const res = await ky.post('https://test.api.amadeus.com/v1/security/oauth2/token', {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: AMADEUS_KEY,
      client_secret: AMADEUS_SECRET
    }).toString()
  }).json();
  return res.access_token;
}

// core search
async function searchAmadeus(q) {
  const token = await getAccessToken();

  const params = new URLSearchParams({
    originLocationCode: q.from,
    destinationLocationCode: q.to,
    departureDate: format(new Date(q.start), 'yyyy-MM-dd'),
    adults: String(q.pax || 1),
    currencyCode: 'USD',
    max: '30'
    // no sort param – API doesn't accept it
  });
  if (q.end) params.set('returnDate', format(new Date(q.end), 'yyyy-MM-dd'));

  const res = await ky.get('https://test.api.amadeus.com/v2/shopping/flight-offers', {
    headers: { Authorization: `Bearer ${token}` },
    searchParams: params
  }).json();

  if (res.errors?.length) {
    const msg = res.errors.map(e => e.detail || e.title || JSON.stringify(e)).join(' | ');
    throw new Error(`Amadeus error: ${msg}`);
  }

  const data = Array.isArray(res.data) ? res.data : [];

  const mapped = data.map((offer, idx) => {
    const itin = offer.itineraries[0];
    const legs = itin.segments.map(seg => ({
      from: seg.departure.iataCode,
      to: seg.arrival.iataCode,
      depart: seg.departure.at,
      arrive: seg.arrival.at,
      airline: seg.carrierCode,
      flightNo: `${seg.carrierCode}${seg.number}`,
      durationMin: parseISODurationToMinutes(seg.duration)
    }));
    const totalDurationMin = parseISODurationToMinutes(itin.duration);
    return {
      id: offer.id || `am-${idx}`,
      provider: 'AMADEUS',
      price: parseFloat(offer.price.total),
      currency: offer.price.currency,
      legs,
      totalDurationMin,
      transfers: Math.max(0, legs.length - 1),
      notes: []
    };
  });

  // local sort
  const optimize = q.optimize || 'balanced';
  if (optimize === 'shortest') mapped.sort((a, b) => a.totalDurationMin - b.totalDurationMin);
  else if (optimize === 'cheapest') mapped.sort((a, b) => a.price - b.price);
  else {
    const minP = Math.min(...mapped.map(m => m.price));
    const maxP = Math.max(...mapped.map(m => m.price));
    const minT = Math.min(...mapped.map(m => m.totalDurationMin));
    const maxT = Math.max(...mapped.map(m => m.totalDurationMin));
    mapped.forEach(m => {
      const pN = (m.price - minP) / Math.max(1, maxP - minP);
      const tN = (m.totalDurationMin - minT) / Math.max(1, maxT - minT);
      m._score = 0.5 * pN + 0.5 * tN;
    });
    mapped.sort((a, b) => (a._score ?? 0) - (b._score ?? 0));
    mapped.forEach(m => delete m._score);
  }

  return mapped;
}

// routes
app.post('/api/search', async (req, res) => {
  try {
    const q = req.body || {};
    if (!q.from || !q.to || !q.start) {
      return res.status(400).json({ ok: false, error: 'from, to, start are required' });
    }
    const options = await searchAmadeus(q);
    res.json({ ok: true, options });
  } catch (e) {
    console.error('Search error:', e);
    res.status(500).json({ ok: false, error: e.message || 'Server error' });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true }));

const port = process.env.PORT || 8787;
app.listen(port, () => console.log(`Amadeus API server running on :${port}`));