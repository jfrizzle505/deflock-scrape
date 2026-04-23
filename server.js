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
  console.log('[scraper] Starting DeFlock scrape…');
  let browser;
  const intercepted = [];
  let apiEndpointFound = null;
  const allRequests = [];

  try {
    // ── Strategy 1: Hit CDN directly (no browser needed) ──
    // deflock.me CDN serves alpr-counts.json and likely camera GeoJSON
    const cdnUrls = [
      'https://cdn.deflock.me/alpr-counts.json',
      'https://cdn.deflock.me/cameras.json',
      'https://cdn.deflock.me/cameras.geojson',
      'https://cdn.deflock.me/locations.json',
      'https://cdn.deflock.me/flock-cameras.json',
      'https://cdn.deflock.me/flock-cameras.geojson',
      'https://cdn.deflock.me/data.json',
      'https://cdn.deflock.me/markers.json',
    ];

    const { default: fetch } = await import('node-fetch').catch(() => ({ default: global.fetch }));
    const nodeFetch = fetch || global.fetch;

    for (const url of cdnUrls) {
      try {
        console.log(`[cdn] Trying ${url}…`);
        const r = await nodeFetch(url, {
          headers: {
            'Accept': 'application/json, application/geo+json, */*',
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36',
            'Referer': 'https://deflock.org/',
            'Origin': 'https://deflock.org',
          }
        });
        if (!r.ok) { console.log(`[cdn] ${url} → ${r.status}`); continue; }
        const data = await r.json();
        console.log(`[cdn] ${url} → 200, keys: ${Object.keys(data).slice(0,8).join(',')}`);
        const parsed = parseCameraData(data);
        if (parsed.length > 0) {
          console.log(`[cdn] ✓ ${parsed.length} cameras from ${url}`);
          apiEndpointFound = url;
          intercepted.push(...parsed);
          break;
        } else {
          // Log the raw structure so we can see what format it's in
          console.log(`[cdn] Data structure: ${JSON.stringify(data).slice(0, 300)}`);
        }
      } catch(e) {
        console.log(`[cdn] ${url} error: ${e.message}`);
      }
    }

    // ── Strategy 2: Browser — target deflock.org directly ──
    if (intercepted.length === 0) {
      console.log('[scraper] CDN direct failed — launching browser targeting deflock.org…');

      browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-web-security']
      });

      const context = await browser.newContext({
        userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        viewport: { width: 1440, height: 900 },
        locale: 'en-US',
      });

      const page = await context.newPage();

      // Intercept ALL responses from any domain
      page.on('response', async response => {
        const url = response.url();
        const ct  = response.headers()['content-type'] || '';
        allRequests.push(url);

        if (ct.includes('json') || ct.includes('geo') || url.endsWith('.json') || url.endsWith('.geojson')) {
          try {
            const body = await response.json().catch(() => null);
            if (!body) return;
            // Log raw structure for debugging
            if (typeof body === 'object') {
              console.log(`[intercept] ${url} → keys: ${Object.keys(body).slice(0,6).join(',')}, sample: ${JSON.stringify(body).slice(0,200)}`);
            }
            const parsed = parseCameraData(body);
            if (parsed.length > 0) {
              console.log(`[intercept] ✓ ${parsed.length} cameras from ${url}`);
              apiEndpointFound = url;
              intercepted.push(...parsed);
            }
          } catch(e) {}
        }
      });

      // Go directly to deflock.org (that's where it redirects)
      console.log('[scraper] Navigating to deflock.org…');
      try {
        await page.goto('https://deflock.org', { waitUntil: 'networkidle', timeout: 45000 });
      } catch(e) {
        console.log('[scraper] networkidle timeout, continuing…');
      }
      await page.waitForTimeout(4000);

      // Try to navigate to the map page specifically
      try {
        await page.goto('https://deflock.org/map', { waitUntil: 'networkidle', timeout: 20000 });
        await page.waitForTimeout(4000);
      } catch(e) {}

      // Try clicking any map/explore links
      try {
        const mapLink = await page.$('a[href*="map"], a:has-text("Map"), a:has-text("Explore"), button:has-text("Map")');
        if (mapLink) { await mapLink.click(); await page.waitForTimeout(3000); }
      } catch(e) {}

      // In-browser fetches from deflock.org context (passes CORS)
      if (intercepted.length === 0) {
        const orgPaths = [
          '/api/cameras', '/api/v1/cameras', '/cameras.geojson', '/cameras.json',
          '/api/locations', '/api/markers', '/api/map/data', '/api/data',
          '/api/flock', '/api/alpr', '/api/reports',
        ];
        for (const p of orgPaths) {
          if (intercepted.length > 0) break;
          try {
            const result = await page.evaluate(async (path) => {
              try {
                const r = await fetch(path, { credentials: 'include', headers: { 'Accept': 'application/json,*/*' } });
                if (!r.ok) return null;
                return await r.json();
              } catch(e) { return null; }
            }, p);
            if (result) {
              console.log(`[org-fetch] ${p} → ${JSON.stringify(result).slice(0,200)}`);
              const parsed = parseCameraData(result);
              if (parsed.length > 0) { apiEndpointFound = 'https://deflock.org' + p; intercepted.push(...parsed); }
            }
          } catch(e) {}
        }
      }

      // Also try cdn.deflock.me from browser context
      if (intercepted.length === 0) {
        try {
          const cdnResult = await page.evaluate(async () => {
            const urls = [
              'https://cdn.deflock.me/alpr-counts.json',
              'https://cdn.deflock.me/cameras.json',
              'https://cdn.deflock.me/cameras.geojson',
            ];
            for (const url of urls) {
              try {
                const r = await fetch(url, { headers: { 'Accept': 'application/json,*/*' } });
                if (r.ok) {
                  const data = await r.json();
                  return { url, data };
                }
              } catch(e) {}
            }
            return null;
          });
          if (cdnResult) {
            console.log(`[cdn-browser] ${cdnResult.url} → ${JSON.stringify(cdnResult.data).slice(0,300)}`);
            const parsed = parseCameraData(cdnResult.data);
            if (parsed.length > 0) { apiEndpointFound = cdnResult.url; intercepted.push(...parsed); }
          }
        } catch(e) {}
      }

      await browser.close();
      browser = null;
    }

    const deduped = deduplicateCameras(intercepted);
    console.log(`[scraper] Done — ${deduped.length} unique cameras.`);

    if (deduped.length > 0) {
      cameraCache = {
        cameras: deduped, fetchedAt: new Date().toISOString(),
        count: deduped.length, source: apiEndpointFound || 'intercepted', error: null,
      };
      saveCache();
      return { success: true, count: deduped.length };
    } else {
      const errMsg = `0 cameras found. Requests seen: ${allRequests.slice(0,10).join(' | ')}`;
      console.warn('[scraper]', errMsg);
      cameraCache.error = errMsg;
      cameraCache.fetchedAt = new Date().toISOString();
      saveCache();
      return { success: false, count: 0 };
    }

  } catch(err) {
    console.error('[scraper] Fatal:', err.message);
    if (browser) { try { await browser.close(); } catch(e) {} }
    cameraCache.error = err.message;
    cameraCache.fetchedAt = new Date().toISOString();
    return { success: false, error: err.message };
  }
}

    // ── Strategy 1: Intercept ALL network responses ────
    page.on('response', async response => {
      const url = response.url();
      const ct  = response.headers()['content-type'] || '';
      allRequests.push({ url, ct, status: response.status() });

      // Catch any JSON from any domain (deflock may use a CDN or separate API domain)
      if (ct.includes('json') || ct.includes('geo') || url.endsWith('.json') || url.endsWith('.geojson')) {
        try {
          const body = await response.json().catch(() => null);
          if (!body) return;
          const parsed = parseCameraData(body);
          if (parsed.length > 0) {
            console.log(`[intercept] ✓ ${parsed.length} cameras from: ${url}`);
            apiEndpointFound = url;
            intercepted.push(...parsed);
          }
        } catch(e) {}
      }
    });

    // ── Navigate ───────────────────────────────────────
    console.log('[scraper] Navigating to deflock.me…');
    try {
      await page.goto('https://deflock.me', { waitUntil: 'networkidle', timeout: 45000 });
    } catch(e) {
      console.log('[scraper] networkidle timeout — continuing anyway');
    }

    await page.waitForTimeout(5000);

    // ── Strategy 2: Read page source for embedded data ─
    if (intercepted.length === 0) {
      console.log('[scraper] Trying embedded data extraction…');
      try {
        const embedded = await page.evaluate(() => {
          // Look for window.__data, window.__INITIAL_STATE__, window.mapData etc.
          const candidates = [
            window.__data, window.__INITIAL_STATE__, window.__NEXT_DATA__,
            window.mapData, window.cameras, window.cameraData,
            window.__nuxt__, window.__NUXT__, window.initialData,
          ];
          // Also search all script tags for JSON arrays with lat/lng
          const scripts = Array.from(document.querySelectorAll('script:not([src])'));
          for (const s of scripts) {
            const text = s.textContent || '';
            // Look for arrays with latitude/longitude patterns
            const match = text.match(/\[[\s\S]*?"(?:lat|latitude)"[\s\S]*?"(?:lng|lon|longitude)"[\s\S]*?\]/);
            if (match) {
              try { candidates.push(JSON.parse(match[0])); } catch(e) {}
            }
            // Look for GeoJSON
            const geoMatch = text.match(/\{[\s\S]*?"FeatureCollection"[\s\S]*?\}/);
            if (geoMatch) {
              try { candidates.push(JSON.parse(geoMatch[0])); } catch(e) {}
            }
          }
          return candidates.filter(Boolean);
        });
        for (const candidate of embedded) {
          const parsed = parseCameraData(candidate);
          if (parsed.length > 0) {
            console.log(`[embedded] ✓ ${parsed.length} cameras from page data`);
            apiEndpointFound = 'embedded-page-data';
            intercepted.push(...parsed);
          }
        }
      } catch(e) { console.log('[embedded] error:', e.message); }
    }

    // ── Strategy 3: Try API paths from within browser context ──
    if (intercepted.length === 0) {
      console.log('[scraper] Trying in-browser API fetch…');
      const paths = [
        '/api/cameras', '/api/v1/cameras', '/api/v2/cameras',
        '/cameras.geojson', '/cameras.json', '/data/cameras.json',
        '/api/locations', '/api/markers', '/api/pins',
        '/export/geojson', '/export/cameras',
        '/api/camera-locations', '/api/flock-cameras',
        '/api/map/cameras', '/api/map/markers',
        '/trpc/cameras.list', '/trpc/cameras.getAll',
      ];
      for (const p of paths) {
        if (intercepted.length > 0) break;
        try {
          const result = await page.evaluate(async (apiPath) => {
            try {
              const r = await fetch(apiPath, {
                credentials: 'include',
                headers: { 'Accept': 'application/json, application/geo+json, */*' }
              });
              if (!r.ok) return null;
              const ct = r.headers.get('content-type') || '';
              if (!ct.includes('json') && !ct.includes('geo')) return null;
              return await r.json();
            } catch(e) { return null; }
          }, p);
          if (result) {
            const parsed = parseCameraData(result);
            if (parsed.length > 0) {
              console.log(`[api-fetch] ✓ ${parsed.length} cameras at ${p}`);
              apiEndpointFound = 'https://deflock.me' + p;
              intercepted.push(...parsed);
            }
          }
        } catch(e) {}
        await new Promise(r => setTimeout(r, 200));
      }
    }

    // ── Strategy 4: Pan map to trigger tile/data loads ─
    if (intercepted.length === 0) {
      console.log('[scraper] Panning map to trigger data loads…');
      try {
        // Try clicking around the map to trigger data fetches
        const w = 1440, h = 900;
        const points = [
          [w/2, h/2], [w*0.25, h/2], [w*0.75, h/2],
          [w/2, h*0.25], [w/2, h*0.75]
        ];
        for (const [x, y] of points) {
          await page.mouse.move(x, y);
          await page.mouse.wheel(0, -500);
          await page.waitForTimeout(2000);
        }
        // Wait for any triggered network requests
        await page.waitForTimeout(3000);
      } catch(e) {}
    }

    // ── Strategy 5: Check all logged request URLs for data ─
    if (intercepted.length === 0) {
      console.log('[scraper] Checking all intercepted URLs…');
      console.log('[scraper] All requests seen:', allRequests.map(r => `${r.status} ${r.url}`).join('\n'));
    }

    // ── Strategy 6: Try GraphQL ────────────────────────
    if (intercepted.length === 0) {
      console.log('[scraper] Trying GraphQL…');
      const queries = [
        '{ cameras { lat lng description address } }',
        '{ locations { latitude longitude name } }',
        '{ markers { lat lon label } }',
        'query { cameras { id lat lng label createdAt } }',
      ];
      for (const query of queries) {
        if (intercepted.length > 0) break;
        try {
          const result = await page.evaluate(async (q) => {
            try {
              const r = await fetch('/graphql', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body: JSON.stringify({ query: q })
              });
              if (!r.ok) return null;
              return await r.json();
            } catch(e) { return null; }
          }, query);
          if (result) {
            const parsed = parseCameraData(result);
            if (parsed.length > 0) {
              console.log(`[graphql] ✓ ${parsed.length} cameras`);
              apiEndpointFound = 'graphql';
              intercepted.push(...parsed);
            }
          }
        } catch(e) {}
      }
    }

    await browser.close();
    browser = null;

    const deduped = deduplicateCameras(intercepted);
    console.log(`[scraper] Done. ${deduped.length} unique cameras found.`);
    console.log(`[scraper] All network requests made: ${allRequests.length}`);

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
      // Log what we saw to help debug
      const urlLog = allRequests.slice(0, 30).map(r => `${r.status} ${r.url}`).join(' | ');
      const errMsg = `Scrape found 0 cameras. Network requests seen: ${allRequests.length}. URLs: ${urlLog}`;
      console.warn('[scraper]', errMsg);
      cameraCache.error = errMsg;
      cameraCache.fetchedAt = new Date().toISOString();
      saveCache();
      return { success: false, count: 0 };
    }

  } catch(err) {
    console.error('[scraper] Fatal error:', err.message);
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

// Debug — fetch CDN directly and show raw response
app.get('/debug', async (req, res) => {
  const results = {};
  const urls = [
    'https://cdn.deflock.me/alpr-counts.json',
    'https://cdn.deflock.me/cameras.json',
    'https://cdn.deflock.me/cameras.geojson',
    'https://deflock.org/api/cameras',
  ];
  for (const url of urls) {
    try {
      const r = await fetch(url, {
        headers: {
          'Accept': 'application/json, */*',
          'Referer': 'https://deflock.org/',
          'Origin': 'https://deflock.org',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/121.0.0.0 Safari/537.36',
        }
      });
      const text = await r.text();
      results[url] = {
        status: r.status,
        contentType: r.headers.get('content-type'),
        // First 500 chars of response so we can see the structure
        preview: text.slice(0, 500),
      };
    } catch(e) {
      results[url] = { error: e.message };
    }
  }
  res.json(results);
});

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
    tip: cameraCache.count === 0 ? 'POST /scrape to trigger a fresh attempt' : null,
  });
});

// Manual trigger — works as both GET and POST
app.get('/scrape', async (req, res) => {
  const token = req.headers['x-scrape-token'] || req.query.token;
  if (process.env.SCRAPE_TOKEN && token !== process.env.SCRAPE_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json({ message: 'Scrape started — check /status in 60 seconds' });
  scrapeDeFlock().catch(console.error);
});

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
