/**
 * pool_browser.js — 5 slot Camoufox siap di chatgpt.com (profil OK + Got it)
 *
 * Boot MIRIP gateway QC / cold path:
 *  - launch lewat gateway.launchGatewayBrowser (proxy + prefs sama)
 *  - cookie lewat gateway.dapatkanSesiCookie
 *  - satu per satu (bukan 5 parallel) agar tidak tabrak resource Codespace
 *  - bootstrap: goto → popup Got it → profil (timeout longgar)
 *  - profil gagal → cookie berikutnya, ulangi
 */
const path = require('path');

const POOL_SIZE = parseInt(process.env.POOL_SIZE || '5', 10);
const PROFIL_TIMEOUT_MS = parseInt(process.env.POOL_PROFIL_TIMEOUT_MS || '90000', 10);
const REBUILD_DELAY_MS = parseInt(process.env.POOL_REBUILD_DELAY_MS || '5000', 10);
const BOOT_GAP_MS = parseInt(process.env.POOL_BOOT_GAP_MS || '4000', 10);

/** Di-inject gateway agar launch/cookie identik */
let deps = {
  launchGatewayBrowser: null,
  dapatkanSesiCookie: null,
  chatgptModule: null,
};

/** @type {Array<object>} */
const slots = [];
let started = false;
let bootQueueRunning = false;

function setDeps(d) {
  deps = { ...deps, ...d };
}

async function bootstrapPageToProfile(page, timeoutMs) {
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

  console.log('[POOL]   goto chatgpt.com...');
  await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 90000 }).catch((e) => {
    console.log('[POOL]   goto warn:', e.message);
  });
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(1500);

  // Composer dulu (lebih stabil daripada profil saja di UI baru)
  console.log('[POOL]   tunggu composer...');
  await page.waitForSelector('#prompt-textarea, [data-testid="prompt-textarea"], div.ProseMirror[contenteditable="true"]', {
    state: 'visible',
    timeout: 60000,
  }).catch(() => {});

  const t0 = Date.now();
  let ok = false;
  let lastLog = 0;
  while (Date.now() - t0 < timeoutMs) {
    if (page.isClosed && page.isClosed()) throw new Error('page closed');

    await page.evaluate(() => {
      document.querySelectorAll('[role="dialog"] button').forEach((b) => {
        if (/^\s*got it\s*$/i.test((b.textContent || '').trim())) {
          try { b.click(); } catch (e) {}
        }
      });
      document.querySelectorAll('button').forEach((b) => {
        const t = (b.textContent || '').trim().toLowerCase();
        if (t === 'got it' || t === 'okay' || t === 'ok' || t === 'continue') {
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

      // Sidebar plan text (Free/Plus) dekat Upgrade
      let sidebarOk = false;
      const upgradeBtn = Array.from(document.querySelectorAll('button, a, span')).find((el) =>
        /^(Upgrade|Tingkatkan)$/i.test((el.textContent || '').trim())
      );
      if (upgradeBtn) {
        let root = upgradeBtn.closest('div');
        for (let i = 0; i < 6 && root; i++) {
          const t = (root.innerText || '').replace(/\s+/g, ' ').trim();
          if (/\b(Free|Plus|Pro|Team|Bebas)\b/i.test(t) && t.length < 80) {
            sidebarOk = true;
            break;
          }
          root = root.parentElement;
        }
      }

      const composer = !!(
        document.querySelector('#prompt-textarea') ||
        document.querySelector('[data-testid="prompt-textarea"]') ||
        document.querySelector('div.ProseMirror[contenteditable="true"]')
      );

      return {
        hasBtn: !!btn,
        hasImg: !!(src && src.startsWith('http')),
        ariaHasName,
        sidebarOk,
        composer,
      };
    }).catch(() => ({ hasBtn: false, hasImg: false, ariaHasName: false, sidebarOk: false, composer: false }));

    // Profil ketat ATAU (composer + tombol profil) setelah cookie inject
    if (info.hasImg || info.ariaHasName || info.sidebarOk) {
      ok = true;
      console.log(`[POOL]   profil OK ${Date.now() - t0}ms img=${info.hasImg} aria=${info.ariaHasName} side=${info.sidebarOk}`);
      break;
    }
    // Fallback longgar: composer + profile button ada (kadang avatar lambat load)
    if (info.composer && info.hasBtn && Date.now() - t0 > 20000) {
      ok = true;
      console.log(`[POOL]   profil soft-OK (composer+btn) ${Date.now() - t0}ms`);
      break;
    }

    if (Date.now() - lastLog > 5000) {
      lastLog = Date.now();
      console.log(`[POOL]   menunggu profil… ${Date.now() - t0}ms btn=${info.hasBtn} composer=${info.composer}`);
    }
    await page.waitForTimeout(500);
  }

  if (!ok) throw new Error('PROFIL_TIMEOUT');
}

async function destroySlot(slot) {
  const page = slot.page;
  const context = slot.context;
  const browser = slot.browser;
  slot.page = null;
  slot.context = null;
  slot.browser = null;
  slot.cookieId = null;
  slot.readyAt = null;
  slot.state = 'dead';
  try { if (page) await page.close().catch(() => {}); } catch (_) {}
  try { if (context) await context.close().catch(() => {}); } catch (_) {}
  try { if (browser) await browser.close().catch(() => {}); } catch (_) {}
}

async function bootSlotOnce(slot) {
  if (!deps.launchGatewayBrowser || !deps.dapatkanSesiCookie) {
    throw new Error('pool deps belum di-set (launchGatewayBrowser / dapatkanSesiCookie)');
  }

  slot.state = 'booting';
  slot.task = null;
  console.log(`[POOL] slot#${slot.id} booting (cara gateway)...`);

  await destroySlot(slot);

  const sesi = await deps.dapatkanSesiCookie();
  console.log(`[POOL] slot#${slot.id} cookie=${sesi.id}`);

  const launched = await deps.launchGatewayBrowser();
  const browser = launched.browser;
  const context = await browser.newContext({ acceptDownloads: true });
  await context.addCookies(sesi.cookies);
  const page = await context.newPage();
  await page.setViewportSize({ width: 1920, height: 1080 });

  try {
    await bootstrapPageToProfile(page, PROFIL_TIMEOUT_MS);
  } catch (e) {
    try { await page.close().catch(() => {}); } catch (_) {}
    try { await context.close().catch(() => {}); } catch (_) {}
    try { await browser.close().catch(() => {}); } catch (_) {}
    throw e;
  }

  slot.browser = browser;
  slot.context = context;
  slot.page = page;
  slot.cookieId = sesi.id;
  slot.readyAt = Date.now();
  slot.state = 'ready';
  console.log(`[POOL] slot#${slot.id} READY cookie=${sesi.id} net=${launched.label}`);
}

async function bootSlotLoop(slot) {
  for (;;) {
    if (slot.state === 'busy') return;
    try {
      await bootSlotOnce(slot);
      return;
    } catch (e) {
      console.log(`[POOL] slot#${slot.id} boot gagal (${e.message}) — cookie lain dalam ${REBUILD_DELAY_MS}ms`);
      await destroySlot(slot);
      await new Promise((r) => setTimeout(r, REBUILD_DELAY_MS));
    }
  }
}

/** Boot slot berurutan — hindari 5 Camoufox parallel di Codespace */
async function bootAllSequential() {
  if (bootQueueRunning) return;
  bootQueueRunning = true;
  try {
    for (const slot of slots) {
      if (slot.state === 'ready' || slot.state === 'busy') continue;
      await bootSlotLoop(slot);
      await new Promise((r) => setTimeout(r, BOOT_GAP_MS));
    }
  } finally {
    bootQueueRunning = false;
  }
  console.log(`[POOL] boot batch selesai:`, poolStats());
}

function acquireReadySlot() {
  const slot = slots.find((s) => s.state === 'ready');
  if (!slot) return null;
  slot.state = 'busy';
  return slot;
}

function poolStats() {
  const c = { ready: 0, busy: 0, booting: 0, dead: 0 };
  for (const s of slots) {
    if (c[s.state] !== undefined) c[s.state]++;
    else c[s.state] = 1;
  }
  return c;
}

async function runTaskOnSlot(slot, { action, prompt, isThinkingMode, translatedFiles, folderHasil }) {
  if (!slot || slot.state !== 'busy') throw new Error('slot tidak busy');
  if (!deps.chatgptModule) throw new Error('chatgptModule deps belum di-set');

  // Page bootstrap ditutup; eksekusiChatGPT buka page baru di context yang sama (cookie tetap)
  try {
    if (slot.page) await slot.page.close().catch(() => {});
    slot.page = null;
  } catch (_) {}

  try {
    const hasil = await deps.chatgptModule.eksekusiChatGPT(
      action,
      prompt,
      isThinkingMode,
      translatedFiles || [],
      folderHasil,
      slot.context
    );
    return { hasil, cookieId: slot.cookieId };
  } finally {
    const id = slot.id;
    console.log(`[POOL] slot#${id} selesai tugas → rebuild sequential`);
    slot.state = 'dead';
    destroySlot(slot)
      .then(() => bootSlotLoop(slot))
      .catch((e) => console.error(`[POOL] rebuild slot#${id}:`, e.message));
  }
}

async function startPool() {
  if (started) {
    console.log('[POOL] sudah started, skip');
    return;
  }
  if (!deps.launchGatewayBrowser || !deps.dapatkanSesiCookie) {
    console.error('[POOL] start ditolak: deps belum di-set dari gateway');
    return;
  }
  started = true;
  console.log(`[POOL] start size=${POOL_SIZE} (sequential, launch=gateway)`);
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
  await bootAllSequential();
}

function isPoolReady() {
  return started && slots.some((s) => s.state === 'ready');
}

module.exports = {
  setDeps,
  startPool,
  acquireReadySlot,
  runTaskOnSlot,
  poolStats,
  isPoolReady,
  POOL_SIZE,
};
