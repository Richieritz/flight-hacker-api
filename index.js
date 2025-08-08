import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import ky from 'ky';
import { format } from 'date-fns';

const app = express();
app.use(cors());
app.use(express.json());

const AMADEUS_KEY = process.env.AMADEUS_KEY;
const AMADEUS_SECRET = process.env.AMADEUS_SECRET;

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

function parseISODurationToMinutes(iso) {
  const m = String(iso).match(/PT(?:(\d+)H)?(?:(\d+)M)?/);
  const h = m?.[1] ? parseInt(m[1], 10) : 0;
  const min = m?.[2] ? parseInt(m[2], 10) : 0;
  return h * 60 + min;
}

async function searchAmadeus(q) {
  const token = await getAccessToken();

  const params = new URLSearchParams({
    originLocationCode: q.from,
    destinationLocationCode: q.to,
    departureDate: format(new Date(q.start), 'yyyy-MM-dd'),
    adults: String(q.pax || 1),
    currencyCode: 'USD',
    max: '30',
    sort: q.optimize === 'shortest' ? 'DURATION' : 'PRICE'
  });

  const res = await ky.get(`https://test.api.amadeus.com/v2/shopping/flight-offers?${params}`, {
    headers: { Authorization: `Bearer ${token}` }
  }).json();

  const data = Array.isArray(res.data) ? res.data : [];
  return data.map((offer, idx) => {
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
}

app.post('/api/search', async (req, res) => {
  try {
    const q = req.body || {};
    if (!q.from || !q.to || !q.start) {
      return res.status(400).json({ ok: false, error: 'from, to, start are required' });
    }
    const options = await searchAmadeus(q);
    res.json({ ok: true, options });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message || 'Server error' });
  }
});

app.get('/health', (_, res) => res.json({ ok: true }));

const port = process.env.PORT || 8787;
app.listen(port, () => console.log(`Amadeus API server running on :${port}`));