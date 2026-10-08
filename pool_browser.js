/**
 * pool_browser.js — 5 slot Camoufox siap di chatgpt.com (profil OK + Got it)
 * 1 slot = 1 cookie valid + 1 browser + 1 context (pending sampai tugas)
 *
 * Dipakai gateway.js: acquireReadySlot() → runTaskOnSlot() → release/rebuild
 */
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { Redis } = require('@upstash/redis');
const { launchCamoufox } = require('./camoufox_launch');
const chatgptModule = require('./platforms/chatgpt');

const POOL_SIZE = parseInt(process.env.POOL_SIZE || '5', 10);
const PROFIL_TIMEOUT_MS = parseInt(process.env.POOL_PROFIL_TIMEOUT_MS || '45000', 10);
const REBUILD_DELAY_MS = parseInt(process.env.POOL_REBUILD_DELAY_MS || '3000', 10);
const MAX_COOKIES = 150;

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Reuse proxy prefs style dari gateway (subset)
const BD_PROXY_HOST = process.env.BD_PROXY_HOST || process.env.BRIGHTDATA_HOST || '';
const BD_PROXY_PORT = parseInt(process.env.BD_PROXY_PORT || process.env.BRIGHTDATA_PORT || '0', 10);
const BD_PROXY_USER = process.env.BD_PROXY_USER || process.env.BRIGHTDATA_USER || '';
const BD_PROXY_PASS = process.env.BD_PROXY_PASS || process.env.BRIGHTDATA_PASS || '';
const STATIC_PROXY_HOST = process.env.STATIC_PROXY_HOST || '';
const STATIC_PROXY_PORT = parseInt(process.env.STATIC_PROXY_PORT || '0', 10);
const STATIC_PROXY_USER = process.env.STATIC_PROXY_USER || '';
const STATIC_PROXY_PASS = process.env.STATIC_PROXY_PASS || '';

/** @type {Array<{
 *  id: number,
 *  state: 'booting'|'ready'|'busy'|'dead',
 *  browser: any,
 *  context: any,
 *  page: any,
 *  cookieId: string|null,
 *  readyAt: number|null,
 *  task: any
 * }>} */
const slots = [];

let started = false;

async function dapatkanSesiCookie() {
  let index = await redis.incr('global_chatgpt_index');
  if (index > MAX_COOKIES) {
    await redis.set('global_chatgpt_index', 1);
    index = 1;
  }
  const cookieKey = `cookie_chatgpt_${index}`;
  const rawData = await redis.get(cookieKey);
  if (!rawData) throw new Error(`[POOL] Redis kosong: ${cookieKey}`);

  const formattedCookies = Object.entries(rawData).map(([key, value]) => ({
    name: key,
    value: String(value),
    domain: '.chatgpt.com',
    path: '/',
    secure: true,
    sameSite: 'Lax',
  }));
  return { id: cookieKey, cookies: formattedCookies };
}

async function launchBrowserForPool() {
  const prefs = {
    'webgl.force-enabled': true,
    'webgl.disabled': false,
    'dom.maxHardwareConcurrency': 8,
    'pdfjs.disabled': true,
  };
  const opts = {
    headless: true,
    width: 1280,
    height: 720,
    firefoxUserPrefs: prefs,
    block_images: false,
    humanize: false,
    i_know_what_im_doing: true,
  };

  if (BD_PROXY_HOST && BD_PROXY_PORT) {
    opts.geoip = true;
    opts.proxy = { server: `http://${BD_PROXY_HOST}:${BD_PROXY_PORT}` };
    if (BD_PROXY_USER) opts.proxy.username = BD_PROXY_USER;
    if (BD_PROXY_PASS) opts.proxy.password = BD_PROXY_PASS;
  } else if (STATIC_PROXY_HOST && STATIC_PROXY_PORT) {
    opts.geoip = true;
    opts.proxy = { server: `http://${STATIC_PROXY_HOST}:${STATIC_PROXY_PORT}` };
    if (STATIC_PROXY_USER) opts.proxy.username = STATIC_PROXY_USER;
    if (STATIC_PROXY_PASS) opts.proxy.password = STATIC_PROXY_PASS;
  } else {
    prefs['network.proxy.type'] = 0;
    opts.geoip = false;
  }

  return launchCamoufox(opts);
}

/** Sama konsep tungguProfilSiap + popup Got it (inline, tanpa tutup page) */
async function bootstrapPageToProfile(page, timeoutMs) {
  // Popup killer di page ini
  await page.addInitScript(() => {
    const dismissPopups = () => {
      const btns = document.querySelectorAll('button');
      for (const btn of btns) {
        const txt = (btn.textContent || '').trim().toLowerCase();
        if (
          txt === 'got it' ||
          txt === '知道了' ||
          txt === 'okay' ||
          txt === 'ok' ||
          txt === 'stay logged out' ||
          txt === 'continue'
        ) {
          try { btn.click(); } catch (e) {}
        }
      }
      document.querySelectorAll('[role="dialog"]').forEach((d) => {
        const t = d.innerText || '';
        if (t.includes('More relevant') || t.includes('personalized replies') || t.includes('个性化')) {
          const gotIt = Array.from(d.querySelectorAll('button')).find((b) =>
            /^\s*got it\s*$/i.test((b.textContent || '').trim())
          );
          if (gotIt) {
            try { gotIt.click(); } catch (e) {}
          } else {
            try { d.remove(); } catch (e) {}
          }
        }
      });
    };
    const observer = new MutationObserver(() => dismissPopups());
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setInterval(dismissPopups, 800);
    dismissPopups();
  });

  await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

  const t0 = Date.now();
  let ok = false;
  while (Date.now() - t0 < timeoutMs) {
    // klik Got it aktif (selain init script)
    await page.evaluate(() => {
      document.querySelectorAll('[role="dialog"] button').forEach((b) => {
        if (/^\s*got it\s*$/i.test((b.textContent || '').trim())) {
          try { b.click(); } catch (e) {}
        }
      });
    }).catch(() => {});

    const info = await page.evaluate(() => {
      const btn = document.querySelector('[data-testid="accounts-profile-button"]');
      const img = btn && (
        btn.querySelector('img[alt="Profile image"]') ||
        btn.querySelector('img[src*="auth0.com/avatars"]') ||
        btn.querySelector('img[src^="http"]')
      );
      const src = img ? (img.getAttribute('src') || img.currentSrc || '') : '';
      const aria = btn ? (btn.getAttribute('aria-label') || '') : '';
      const ariaHasName =
        aria &&
        !/^(open profile menu|buka menu profil)$/i.test(aria.trim()) &&
        aria.trim().length > 5;
      return {
        hasImg: !!(src && src.startsWith('http')),
        ariaHasName,
      };
    });

    if (info.hasImg || info.ariaHasName) {
      ok = true;
      break;
    }
    await page.waitForTimeout(400);
  }

  if (!ok) throw new Error('PROFIL_TIMEOUT');

  // Composer minimal siap (tidak wajib gagal total)
  await page.waitForSelector('#prompt-textarea', { state: 'visible', timeout: 30000 }).catch(() => {});
}

async function destroySlot(slot) {
  try { if (slot.page) await slot.page.close().catch(() => {}); } catch (_) {}
  try { if (slot.context) await slot.context.close().catch(() => {}); } catch (_) {}
  try { if (slot.browser) await slot.browser.close().catch(() => {}); } catch (_) {}
  slot.page = null;
  slot.context = null;
  slot.browser = null;
  slot.cookieId = null;
  slot.readyAt = null;
  slot.state = 'dead';
}

async function bootSlot(slot) {
  slot.state = 'booting';
  slot.task = null;
  console.log(`[POOL] slot#${slot.id} booting...`);

  for (;;) {
    try {
      await destroySlot(slot);
      const sesi = await dapatkanSesiCookie();
      const browser = await launchBrowserForPool();
      const context = await browser.newContext({ acceptDownloads: true });
      await context.addCookies(sesi.cookies);
      const page = await context.newPage();
      await page.setViewportSize({ width: 1920, height: 1080 });

      await bootstrapPageToProfile(page, PROFIL_TIMEOUT_MS);

      slot.browser = browser;
      slot.context = context;
      slot.page = page;
      slot.cookieId = sesi.id;
      slot.readyAt = Date.now();
      slot.state = 'ready';
      console.log(`[POOL] slot#${slot.id} READY cookie=${sesi.id}`);
      return;
    } catch (e) {
      console.log(`[POOL] slot#${slot.id} boot gagal (${e.message}) — cookie lain...`);
      await destroySlot(slot);
      await new Promise((r) => setTimeout(r, REBUILD_DELAY_MS));
      // ulangi sampai dapat profil valid
    }
  }
}

/**
 * Ambil satu slot ready (atomik). Return null jika tidak ada.
 */
function acquireReadySlot() {
  const slot = slots.find((s) => s.state === 'ready');
  if (!slot) return null;
  slot.state = 'busy';
  return slot;
}

function poolStats() {
  const c = { ready: 0, busy: 0, booting: 0, dead: 0 };
  for (const s of slots) c[s.state] = (c[s.state] || 0) + 1;
  return c;
}

/**
 * Jalankan tugas pada slot yang sudah di-acquire.
 * Setelah selesai slot di-rebuild (browser bekas tidak dipakai ulang untuk tugas berikutnya).
 */
async function runTaskOnSlot(slot, { action, prompt, isThinkingMode, translatedFiles, folderHasil }) {
  if (!slot || slot.state !== 'busy') throw new Error('slot tidak busy');

  // Tutup page bootstrap — eksekusiChatGPT buka page baru di context yang sama (cookies tetap)
  try {
    if (slot.page) await slot.page.close().catch(() => {});
    slot.page = null;
  } catch (_) {}

  try {
    const hasil = await chatgptModule.eksekusiChatGPT(
      action,
      prompt,
      isThinkingMode,
      translatedFiles || [],
      folderHasil,
      slot.context
    );
    return { hasil, cookieId: slot.cookieId };
  } finally {
    // Selalu rebuild slot setelah tugas (sukses/gagal) agar state bersih + cookie baru
    const id = slot.id;
    console.log(`[POOL] slot#${id} selesai tugas → rebuild`);
    bootSlot(slot).catch((e) => console.error(`[POOL] rebuild slot#${id}:`, e.message));
  }
}

async function startPool() {
  if (started) return;
  started = true;
  console.log(`[POOL] start size=${POOL_SIZE}`);
  for (let i = 0; i < POOL_SIZE; i++) {
    slots.push({
      id: i + 1,
      state: 'dead',
      browser: null,
      context: null,
      page: null,
      cookieId: null,
      readyAt: null,
      task: null,
    });
  }
  // boot paralel
  await Promise.all(slots.map((s) => bootSlot(s)));
  console.log(`[POOL] semua slot siap:`, poolStats());
}

function isPoolReady() {
  return started && slots.some((s) => s.state === 'ready');
}

module.exports = {
  startPool,
  acquireReadySlot,
  runTaskOnSlot,
  poolStats,
  isPoolReady,
  POOL_SIZE,
};
