/**
 * StreetSync — DeFlock.me Scraper Server
 * =======================================
 * Runs a real Chromium browser (Playwright) to bypass Cloudflare,
 * intercepts deflock.me's internal API calls, caches the camera data,
 * and serves it as a clean JSON API for StreetSync to consume.
 *
 * Deploy free on Railway: railway.app
 * One-click: railway new → connect this folder → deploy
 */

const express  = require('express');
const cors     = require('cors');
const cron     = require('node-cron');
const fs       = require('fs');
const path     = require('path');
const { chromium } = require('playwright');

const app  = express();
const PORT = process.env.PORT || 3000;
const CACHE_FILE = path.join(__dirname, 'cameras_cache.json');

// ── CORS — allow all origins explicitly ───────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());

// ── CACHE ─────────────────────────────────────────────
let cameraCache = {
  cameras:    [],
  fetchedAt:  null,
  count:      0,
  source:     'none',
  error:      null,
};

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = fs.readFileSync(CACHE_FILE, 'utf8');
      cameraCache = JSON.parse(raw);
      console.log(`[cache] Loaded ${cameraCache.count} cameras from disk`);
    }
  } catch(e) {
    console.warn('[cache] Could not load cache file:', e.message);
  }
}

function saveCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cameraCache, null, 2));
  } catch(e) {
    console.warn('[cache] Could not save cache:', e.message);
  }
}

// ── SCRAPER ────────────────────────────────────────────
async function scrapeDeFlock() {
  console.log('[scraper] Starting DeFlock.me scrape…');
  let browser;
  const intercepted = [];
  let apiEndpointFound = null;

  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
      ]
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
      locale: 'en-US',
      timezoneId: 'America/Chicago',
    });

    const page = await context.newPage();

    // Intercept all network responses to find API calls
    page.on('response', async response => {
      const url  = response.url();
      const ct   = response.headers()['content-type'] || '';
      // Look for JSON responses from deflock.me
      if (url.includes('deflock.me') && (ct.includes('json') || ct.includes('geo'))) {
        try {
          const body = await response.json();
          const parsed = parseCameraData(body);
          if (parsed.length > 0) {
            console.log(`[intercept] Found ${parsed.length} cameras at: ${url}`);
            apiEndpointFound = url;
            intercepted.push(...parsed);
          }
        } catch(e) { /* not valid JSON or no cameras */ }
      }
    });

    // Navigate to deflock.me
    console.log('[scraper] Navigating to deflock.me…');
    await page.goto('https://deflock.me', {
      waitUntil: 'networkidle',
      timeout: 30000
    });

    // Wait for map to load
    await page.waitForTimeout(3000);

    // Try panning the map to trigger data loads in different regions
    // (some map apps load tiles as you pan)
    try {
      const mapEl = await page.$('canvas, #map, .mapboxgl-map, .leaflet-container, [class*="map"]');
      if (mapEl) {
        const box = await mapEl.boundingBox();
        if (box) {
          // Pan around to trigger more data loads
          await page.mouse.move(box.x + box.width/2, box.y + box.height/2);
          await page.mouse.wheel(0, -300); // zoom in
          await page.waitForTimeout(1500);
          await page.mouse.wheel(0, -300);
          await page.waitForTimeout(1500);
        }
      }
    } catch(e) { /* map interaction failed, that's ok */ }

    // Also try to find and click any "load all" or "export" buttons
    try {
      const exportBtn = await page.$('[class*="export"], [class*="download"], button:has-text("Export"), button:has-text("Download"), a:has-text("GeoJSON")');
      if (exportBtn) {
        await exportBtn.click();
        await page.waitForTimeout(2000);
      }
    } catch(e) {}

    // Wait for any pending requests
    await page.waitForTimeout(2000);

    // Try directly hitting known API paths via page.evaluate
    // (runs in browser context — passes Cloudflare since browser is real)
    const paths = [
      '/api/cameras', '/api/v1/cameras', '/cameras.geojson',
      '/data/cameras.json', '/api/locations', '/api/markers',
      '/api/pins', '/api/v2/cameras', '/export/geojson'
    ];

    for (const p of paths) {
      if (intercepted.length > 10) break; // already have data
      try {
        const result = await page.evaluate(async (apiPath) => {
          try {
            const r = await fetch(apiPath, {
              headers: { 'Accept': 'application/json, application/geo+json, */*' }
            });
            if (!r.ok) return null;
            return await r.json();
          } catch(e) { return null; }
        }, p);

        if (result) {
          const parsed = parseCameraData(result);
          if (parsed.length > 0) {
            console.log(`[eval] Found ${parsed.length} cameras at ${p}`);
            apiEndpointFound = 'https://deflock.me' + p;
            intercepted.push(...parsed);
            break;
          }
        }
      } catch(e) {}
    }

    await browser.close();
    browser = null;

    // Deduplicate
    const deduped = deduplicateCameras(intercepted);
    console.log(`[scraper] Done. ${deduped.length} unique cameras found.`);

    if (deduped.length > 0) {
      cameraCache = {
        cameras:   deduped,
        fetchedAt: new Date().toISOString(),
        count:     deduped.length,
        source:    apiEndpointFound || 'intercepted',
        error:     null,
      };
      saveCache();
      return { success: true, count: deduped.length };
    } else {
      console.warn('[scraper] No cameras found — site may have changed structure');
      cameraCache.error = 'Scrape completed but no cameras found — deflock.me may have changed their API';
      cameraCache.fetchedAt = new Date().toISOString();
      return { success: false, count: 0 };
    }

  } catch(err) {
    console.error('[scraper] Error:', err.message);
    if (browser) { try { await browser.close(); } catch(e) {} }
    cameraCache.error = err.message;
    cameraCache.fetchedAt = new Date().toISOString();
    return { success: false, error: err.message };
  }
}

// ── PARSERS ────────────────────────────────────────────
function parseCameraData(data) {
  if (!data) return [];

  // GeoJSON FeatureCollection
  if (data.type === 'FeatureCollection' && Array.isArray(data.features)) {
    return data.features
      .filter(f => f.geometry?.type === 'Point')
      .map(f => ({
        lat:   f.geometry.coordinates[1],
        lng:   f.geometry.coordinates[0],
        label: f.properties?.name || f.properties?.description || f.properties?.label || f.properties?.address || 'Flock Camera',
        id:    f.properties?.id || f.id || null,
        tags:  f.properties || {},
      })).filter(c => isValidCoord(c.lat, c.lng));
  }

  // Array of camera objects
  if (Array.isArray(data)) {
    return data.map(c => {
      const lat = c.lat ?? c.latitude  ?? c.y ?? c.location?.lat ?? c.point?.lat;
      const lng = c.lng ?? c.longitude ?? c.x ?? c.location?.lng ?? c.point?.lng ?? c.lon;
      if (!isValidCoord(lat, lng)) return null;
      return {
        lat:   parseFloat(lat),
        lng:   parseFloat(lng),
        label: c.name || c.description || c.label || c.address || c.street || 'Flock Camera',
        id:    c.id || c._id || null,
        tags:  c,
      };
    }).filter(Boolean);
  }

  // Wrapped { cameras: [...] } or { data: [...] } etc.
  const list = data.cameras || data.data || data.results || data.markers || data.pins || data.locations || data.features;
  if (Array.isArray(list)) return parseCameraData(list);

  // GraphQL { data: { cameras: [...] } }
  if (data.data && typeof data.data === 'object') return parseCameraData(data.data);

  return [];
}

function isValidCoord(lat, lng) {
  return lat != null && lng != null &&
    !isNaN(parseFloat(lat)) && !isNaN(parseFloat(lng)) &&
    parseFloat(lat) >= -90 && parseFloat(lat) <= 90 &&
    parseFloat(lng) >= -180 && parseFloat(lng) <= 180;
}

function deduplicateCameras(cams) {
  const seen = new Set();
  return cams.filter(c => {
    const key = `${parseFloat(c.lat).toFixed(5)},${parseFloat(c.lng).toFixed(5)}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
}

// ── ROUTES ─────────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
  res.json({
    service: 'StreetSync DeFlock Scraper',
    status:  'running',
    cameras: cameraCache.count,
    fetchedAt: cameraCache.fetchedAt,
    source:    cameraCache.source,
    error:     cameraCache.error || null,
    endpoints: ['/cameras', '/cameras/nearby', '/status', '/scrape'],
  });
});

// All cameras (full dataset)
app.get('/cameras', (req, res) => {
  res.json({
    type:      'FeatureCollection',
    count:     cameraCache.count,
    fetchedAt: cameraCache.fetchedAt,
    source:    cameraCache.source,
    features:  cameraCache.cameras.map(c => ({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [c.lng, c.lat] },
      properties: { label: c.label, id: c.id, source: 'deflock.me' }
    }))
  });
});

// Cameras near a point — most useful for StreetSync
// Usage: /cameras/nearby?lat=35.68&lng=-105.93&radius=16
app.get('/cameras/nearby', (req, res) => {
  const lat    = parseFloat(req.query.lat);
  const lng    = parseFloat(req.query.lng);
  const radius = parseFloat(req.query.radius) || 16; // miles

  if (isNaN(lat) || isNaN(lng)) {
    return res.status(400).json({ error: 'lat and lng required' });
  }

  const nearby = cameraCache.cameras.filter(c => {
    const d = haversine(lat, lng, c.lat, c.lng);
    return d <= radius;
  });

  res.json({
    count:     nearby.count,
    lat, lng, radius,
    fetchedAt: cameraCache.fetchedAt,
    cameras:   nearby.map(c => ({ ...c, dist: Math.round(haversine(lat, lng, c.lat, c.lng) * 10) / 10 }))
      .sort((a, b) => a.dist - b.dist)
  });
});

// Status endpoint
app.get('/status', (req, res) => {
  res.json({
    cameras:   cameraCache.count,
    fetchedAt: cameraCache.fetchedAt,
    source:    cameraCache.source,
    error:     cameraCache.error || null,
    nextScrape:'Every 6 hours (cron)',
  });
});

// Manual trigger (protected by simple token)
app.post('/scrape', async (req, res) => {
  const token = req.headers['x-scrape-token'] || req.query.token;
  if (process.env.SCRAPE_TOKEN && token !== process.env.SCRAPE_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json({ message: 'Scrape started in background' });
  scrapeDeFlock().catch(console.error);
});

// Community camera submission (from StreetSync users)
app.post('/cameras/report', (req, res) => {
  const { lat, lng, label, userId } = req.body;
  if (!isValidCoord(lat, lng)) {
    return res.status(400).json({ error: 'Invalid coordinates' });
  }
  // Add to cache if not duplicate
  const key = `${parseFloat(lat).toFixed(5)},${parseFloat(lng).toFixed(5)}`;
  const exists = cameraCache.cameras.some(c =>
    `${c.lat.toFixed(5)},${c.lng.toFixed(5)}` === key
  );
  if (!exists) {
    cameraCache.cameras.push({
      lat: parseFloat(lat), lng: parseFloat(lng),
      label: label || 'Community Report', id: null,
      reportedBy: userId || 'anonymous',
      reportedAt: new Date().toISOString(),
      source: 'community'
    });
    cameraCache.count = cameraCache.cameras.length;
    saveCache();
    console.log(`[community] New camera reported at ${lat},${lng} — total: ${cameraCache.count}`);
  }
  res.json({ success: true, total: cameraCache.count });
});

// ── HELPERS ────────────────────────────────────────────
function haversine(lat1, lng1, lat2, lng2) {
  const R = 3958.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 +
    Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── CRON ───────────────────────────────────────────────
// Scrape deflock.me every 6 hours
cron.schedule('0 */6 * * *', () => {
  console.log('[cron] Scheduled scrape starting…');
  scrapeDeFlock().catch(console.error);
});

// ── START ──────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`\n🔮 StreetSync DeFlock Scraper running on port ${PORT}`);
  console.log(`   GET /cameras          — full dataset`);
  console.log(`   GET /cameras/nearby   — near lat/lng`);
  console.log(`   GET /status           — cache status`);
  console.log(`   POST /scrape          — manual trigger\n`);

  loadCache();

  // Scrape on startup if cache is empty or stale (>6h old)
  const cacheAge = cameraCache.fetchedAt
    ? (Date.now() - new Date(cameraCache.fetchedAt).getTime()) / 3600000
    : Infinity;

  if (cameraCache.count === 0 || cacheAge > 6) {
    console.log('[startup] Cache empty or stale — running initial scrape…');
    setTimeout(() => scrapeDeFlock().catch(console.error), 2000);
  } else {
    console.log(`[startup] Cache fresh (${Math.round(cacheAge * 10)/10}h old) — skipping initial scrape`);
  }
});
