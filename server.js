'use strict';

const express = require('express');
const cron    = require('node-cron');
const fs      = require('fs');
const path    = require('path');
const { chromium } = require('playwright');

const app  = express();
const PORT = process.env.PORT || 3000;
const CACHE_FILE = path.join(__dirname, 'cameras_cache.json');

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());

let cache = { cameras: [], count: 0, fetchedAt: null, source: 'none', error: null };

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      console.log('[cache] Loaded', cache.count, 'cameras');
    }
  } catch(e) { console.warn('[cache] Load failed:', e.message); }
}

function saveCache() {
  try { fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2)); }
  catch(e) { console.warn('[cache] Save failed:', e.message); }
}

function isValidCoord(lat, lng) {
  return lat != null && lng != null &&
    !isNaN(parseFloat(lat)) && !isNaN(parseFloat(lng)) &&
    parseFloat(lat) >= -90 && parseFloat(lat) <= 90 &&
    parseFloat(lng) >= -180 && parseFloat(lng) <= 180;
}

function parseCameras(data) {
  if (!data) return [];
  if (data.type === 'FeatureCollection' && Array.isArray(data.features)) {
    return data.features
      .filter(f => f.geometry && f.geometry.type === 'Point')
      .map(f => ({
        lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0],
        label: (f.properties && (f.properties.name || f.properties.description || f.properties.address)) || 'Flock Camera',
        id: (f.properties && f.properties.id) || null,
      })).filter(c => isValidCoord(c.lat, c.lng));
  }
  if (Array.isArray(data)) {
    return data.map(c => {
      const lat = c.lat || c.latitude  || c.y || (c.location && c.location.lat);
      const lng = c.lng || c.longitude || c.x || c.lon || (c.location && c.location.lng);
      if (!isValidCoord(lat, lng)) return null;
      return { lat: parseFloat(lat), lng: parseFloat(lng), label: c.name || c.description || c.label || c.address || 'Flock Camera', id: c.id || null };
    }).filter(Boolean);
  }
  const keys = ['cameras','data','results','markers','pins','locations','features','items'];
  for (const k of keys) {
    if (Array.isArray(data[k])) { const p = parseCameras(data[k]); if (p.length > 0) return p; }
  }
  if (data.data && typeof data.data === 'object') return parseCameras(data.data);
  return [];
}

function dedup(cameras) {
  const seen = new Set();
  return cameras.filter(c => {
    const key = parseFloat(c.lat).toFixed(5) + ',' + parseFloat(c.lng).toFixed(5);
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

function haversine(lat1, lng1, lat2, lng2) {
  const R = 3958.8, dLat = (lat2-lat1)*Math.PI/180, dLng = (lng2-lng1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36',
  'Accept': 'application/json, application/geo+json, */*',
  'Referer': 'https://deflock.org/',
  'Origin': 'https://deflock.org',
};

async function scrape() {
  console.log('[scraper] Starting…');
  const found = [];
  let source = null;

  // Step 1: Direct CDN fetch
  const cdnUrls = [
    'https://cdn.deflock.me/alpr-counts.json',
    'https://cdn.deflock.me/cameras.json',
    'https://cdn.deflock.me/cameras.geojson',
    'https://cdn.deflock.me/flock-cameras.json',
    'https://cdn.deflock.me/data.json',
  ];
  for (const url of cdnUrls) {
    try {
      console.log('[cdn] Trying', url);
      const res  = await fetch(url, { headers: BROWSER_HEADERS });
      const text = await res.text();
      console.log('[cdn]', url, '->', res.status, text.slice(0, 200));
      if (!res.ok) continue;
      let data;
      try { data = JSON.parse(text); } catch(e) { continue; }
      const cameras = parseCameras(data);
      if (cameras.length > 0) {
        console.log('[cdn] Found', cameras.length, 'cameras at', url);
        found.push(...cameras);
        source = url;
        break;
      }
    } catch(e) { console.log('[cdn] Error', url, e.message); }
  }

  // Step 2: Browser scrape
  if (found.length === 0) {
    console.log('[browser] Launching…');
    let browser = null;
    try {
      browser = await chromium.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'] });
      const ctx  = await browser.newContext({ userAgent: BROWSER_HEADERS['User-Agent'], viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();

      page.on('response', async response => {
        const url = response.url();
        const ct  = response.headers()['content-type'] || '';
        if (!ct.includes('json') && !ct.includes('geo') && !url.endsWith('.json')) return;
        try {
          const text = await response.text();
          console.log('[intercept]', url, text.slice(0, 150));
          let data; try { data = JSON.parse(text); } catch(e) { return; }
          const cameras = parseCameras(data);
          if (cameras.length > 0) { console.log('[intercept] Found', cameras.length, 'cameras'); found.push(...cameras); source = url; }
        } catch(e) {}
      });

      try { await page.goto('https://deflock.org', { waitUntil: 'networkidle', timeout: 40000 }); } catch(e) { console.log('[browser] timeout, continuing'); }
      await page.waitForTimeout(5000);

      if (found.length === 0) {
        try { await page.goto('https://deflock.org/map', { waitUntil: 'networkidle', timeout: 20000 }); await page.waitForTimeout(4000); } catch(e) {}
      }

      if (found.length === 0) {
        const paths = ['/api/cameras','/api/v1/cameras','/cameras.geojson','/cameras.json','/api/locations','/api/markers','/api/map/data','/api/flock'];
        for (const p of paths) {
          if (found.length > 0) break;
          try {
            const result = await page.evaluate(async (apiPath) => {
              try {
                const r = await fetch(apiPath, { credentials: 'include', headers: { Accept: 'application/json,*/*' } });
                if (!r.ok) return null;
                return await r.json();
              } catch(e) { return null; }
            }, p);
            if (result) {
              const cameras = parseCameras(result);
              if (cameras.length > 0) { console.log('[eval] Found', cameras.length, 'cameras at', p); found.push(...cameras); source = 'https://deflock.org' + p; }
            }
          } catch(e) {}
        }
      }

      if (found.length === 0) {
        try {
          const r = await page.evaluate(async () => {
            const urls = ['https://cdn.deflock.me/alpr-counts.json','https://cdn.deflock.me/cameras.json','https://cdn.deflock.me/cameras.geojson'];
            for (const url of urls) {
              try { const res = await fetch(url); if (res.ok) return { url, text: await res.text() }; } catch(e) {}
            }
            return null;
          });
          if (r) {
            console.log('[cdn-browser]', r.url, r.text.slice(0, 300));
            try { const d = JSON.parse(r.text); const c = parseCameras(d); if (c.length > 0) { found.push(...c); source = r.url; } } catch(e) {}
          }
        } catch(e) {}
      }

      await browser.close();
    } catch(e) {
      console.error('[browser] Fatal:', e.message);
      if (browser) { try { await browser.close(); } catch(e2) {} }
    }
  }

  const cameras = dedup(found);
  console.log('[scraper] Done -', cameras.length, 'cameras');
  if (cameras.length > 0) {
    cache = { cameras, count: cameras.length, fetchedAt: new Date().toISOString(), source, error: null };
  } else {
    cache.error = 'Scrape returned 0 cameras';
    cache.fetchedAt = new Date().toISOString();
  }
  saveCache();
  return { success: cameras.length > 0, count: cameras.length };
}

// Routes
app.get('/', (req, res) => res.json({ service: 'StreetSync DeFlock Scraper', status: 'running', cameras: cache.count, fetchedAt: cache.fetchedAt, error: cache.error }));
app.get('/status', (req, res) => res.json({ cameras: cache.count, fetchedAt: cache.fetchedAt, source: cache.source, error: cache.error }));
app.get('/cameras', (req, res) => res.json({ type: 'FeatureCollection', count: cache.count, fetchedAt: cache.fetchedAt, features: cache.cameras.map(c => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [c.lng, c.lat] }, properties: { label: c.label, id: c.id } })) }));
app.get('/cameras/nearby', (req, res) => {
  const lat = parseFloat(req.query.lat), lng = parseFloat(req.query.lng), radius = parseFloat(req.query.radius) || 16;
  if (isNaN(lat) || isNaN(lng)) return res.status(400).json({ error: 'lat and lng required' });
  const nearby = cache.cameras.map(c => ({ ...c, dist: haversine(lat, lng, c.lat, c.lng) })).filter(c => c.dist <= radius).sort((a, b) => a.dist - b.dist);
  res.json({ count: nearby.length, cameras: nearby });
});
app.get('/scrape', async (req, res) => { res.json({ message: 'Scrape started — check /status in 60 seconds' }); scrape().catch(console.error); });
app.post('/scrape', async (req, res) => { res.json({ message: 'Scrape started' }); scrape().catch(console.error); });
app.get('/debug', async (req, res) => {
  const results = {};
  for (const url of ['https://cdn.deflock.me/alpr-counts.json','https://cdn.deflock.me/cameras.json','https://cdn.deflock.me/cameras.geojson']) {
    try { const r = await fetch(url, { headers: BROWSER_HEADERS }); const text = await r.text(); results[url] = { status: r.status, preview: text.slice(0, 500) }; }
    catch(e) { results[url] = { error: e.message }; }
  }
  res.json(results);
});
app.post('/cameras/report', (req, res) => {
  const { lat, lng, label } = req.body;
  if (!isValidCoord(lat, lng)) return res.status(400).json({ error: 'Invalid coordinates' });
  const key = parseFloat(lat).toFixed(5) + ',' + parseFloat(lng).toFixed(5);
  if (!cache.cameras.some(c => (parseFloat(c.lat).toFixed(5) + ',' + parseFloat(c.lng).toFixed(5)) === key)) {
    cache.cameras.push({ lat: parseFloat(lat), lng: parseFloat(lng), label: label || 'Community', id: null });
    cache.count = cache.cameras.length;
    saveCache();
  }
  res.json({ success: true, total: cache.count });
});

cron.schedule('0 */6 * * *', () => { console.log('[cron] Scheduled scrape'); scrape().catch(console.error); });

app.listen(PORT, () => {
  console.log('DeFlock Scraper on port', PORT);
  loadCache();
  const age = cache.fetchedAt ? (Date.now() - new Date(cache.fetchedAt).getTime()) / 3600000 : Infinity;
  if (cache.count === 0 || age > 6) { console.log('[startup] Running scrape…'); setTimeout(() => scrape().catch(console.error), 3000); }
  else { console.log('[startup] Cache OK (' + Math.round(age*10)/10 + 'h old)'); }
});
