/**
 * pool_browser.js
 * - Boot slot: langkah sama seperti chatgpt.js (goto → stepShot → profil → composer) lalu HOLD page
 * - Saat tugas: JANGAN goto ulang. Pakai page yang sudah READY → suntik prompt / mode / upload → radar
 */
const path = require('path');
const fs = require('fs');

const POOL_SIZE = parseInt(process.env.POOL_SIZE || '5', 10);
// Timeout cek sesi (login/signup vs composer) — 15 detik, lalu cookie berikutnya
const SESI_TIMEOUT_MS = parseInt(process.env.POOL_SESI_TIMEOUT_MS || '15000', 10);
const PROFIL_TIMEOUT_MS = parseInt(process.env.POOL_PROFIL_TIMEOUT_MS || String(SESI_TIMEOUT_MS), 10);
const REBUILD_DELAY_MS = parseInt(process.env.POOL_REBUILD_DELAY_MS || '5000', 10);
const BOOT_GAP_MS = parseInt(process.env.POOL_BOOT_GAP_MS || '4000', 10);

let deps = {
  launchGatewayBrowser: null,
  dapatkanSesiCookie: null,
  chatgptModule: null,
};

const slots = [];
let started = false;

function setDeps(d) {
  deps = { ...deps, ...d };
}

async function stepShot(page, folderHasil, label) {
  try {
    if (!folderHasil || !page) return;
    const safe = String(label || 'step').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60);
    const fp = path.join(folderHasil, `pool_${Date.now()}_${safe}.png`);
    await page.screenshot({ path: fp, fullPage: false }).catch(() => {});
    console.log(`[POOL] 📸 ${label} → ${path.basename(fp)}`);
  } catch (_) {}
}

async function installPopupKiller(page) {
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
        if (
          t.includes('More relevant') ||
          t.includes('personalized replies') ||
          t.includes('个性化') ||
          t.includes('already uploaded')
        ) {
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
    if (!window.__poolPopupKillerInstalled) {
      window.__poolPopupKillerInstalled = true;
      const observer = new MutationObserver(() => dismissPopups());
      observer.observe(document.documentElement, { childList: true, subtree: true });
      setInterval(dismissPopups, 800);
    }
    dismissPopups();
  });
}

/** Node-side: tetap klik Got it selama slot READY (pending tunggu tugas) */
function startKeepAlivePopupGuard(slot) {
  stopKeepAlivePopupGuard(slot);
  const tick = async () => {
    if (slot.state !== 'ready' || !slot.page) return;
    try {
      if (typeof slot.page.isClosed === 'function' && slot.page.isClosed()) return;
      await klikAreaKosong(slot.page);
    } catch (_) {}
  };
  // jarang: jaga page hangat + tutup NUX tanpa deteksi
  slot._keepAliveTimer = setInterval(tick, 8000);
}
function stopKeepAlivePopupGuard(slot) {
  if (slot && slot._keepAliveTimer) {
    clearInterval(slot._keepAliveTimer);
    slot._keepAliveTimer = null;
  }
}

async function deteksiLoginAtauSignup(page) {
  return page.evaluate(() => {
    const texts = [];
    document.querySelectorAll('button, a, [role="button"]').forEach((el) => {
      const t = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
      if (t && t.length < 40) texts.push(t);
    });
    const body = (document.body && document.body.innerText) ? document.body.innerText.slice(0, 4000) : '';
    for (const t of texts) {
      if (/^(log\s*in|sign\s*up|create\s*account|masuk|daftar)$/i.test(t.trim())) {
        return { hit: true, via: 'btn:' + t };
      }
    }
    if (/log in or sign up/i.test(body)) return { hit: true, via: 'body-auth' };
    if (document.querySelector('[data-testid="login-button"], [data-testid="signup-button"]')) {
      return { hit: true, via: 'testid' };
    }
    return { hit: false, via: '' };
  });
}

async function klikAreaKosong(page) {
  try {
    const vp = page.viewportSize() || { width: 1920, height: 1080 };
    await page.mouse.click(Math.floor(vp.width * 0.92), Math.floor(vp.height * 0.5), { delay: 40 });
    await page.waitForTimeout(120);
    await page.mouse.click(Math.floor(vp.width * 0.5), Math.floor(vp.height * 0.92), { delay: 40 });
    await page.waitForTimeout(150);
  } catch (_) {}
}

/** Cookie invalid jika Login/Sign up. Timeout = COOKIE_INVALID (tidak dipaksa lanjut). */
async function tungguSesiValid(page, timeoutMs) {
  const limit = timeoutMs || SESI_TIMEOUT_MS;
  console.log(`[POOL] 🔐 Cek sesi (max ${limit}ms; login/signup = invalid)...`);
  const t0 = Date.now();
  let lastLog = 0;
  while (Date.now() - t0 < limit) {
    const auth = await deteksiLoginAtauSignup(page);
    if (auth.hit) throw new Error('COOKIE_INVALID: ' + auth.via);

    const composer = await page.evaluate(() => {
      const a = document.querySelector('#prompt-textarea');
      if (a) {
        const st = window.getComputedStyle(a);
        if (st && st.display !== 'none' && st.visibility !== 'hidden') return true;
      }
      return !!(
        document.querySelector('[data-testid="prompt-textarea"]') ||
        document.querySelector('div.ProseMirror[contenteditable="true"]') ||
        document.querySelector('[contenteditable="true"][aria-label="Ask ChatGPT"]')
      );
    }).catch(() => false);
    if (composer) {
      console.log(`[POOL] ✅ Sesi OK ${Date.now() - t0}ms`);
      return;
    }
    if (Date.now() - lastLog > 2500) {
      lastLog = Date.now();
      console.log(`[POOL] sesi… ${Date.now() - t0}ms`);
    }
    await page.waitForTimeout(400);
  }
  const auth2 = await deteksiLoginAtauSignup(page);
  if (auth2.hit) throw new Error('COOKIE_INVALID: ' + auth2.via);
  // Jangan paksa lanjut — anggap cookie tidak aktif
  throw new Error('COOKIE_INVALID: sesi timeout ' + limit + 'ms (composer tidak siap)');
}

async function tungguComposerSiap(page, timeoutMs) {
  console.log('[POOL] ⏳ Menunggu kolom teks (composer) siap...');
  await page.waitForFunction(() => {
    const a = document.querySelector('#prompt-textarea');
    if (a) {
      const st = window.getComputedStyle(a);
      if (st && st.display !== 'none' && st.visibility !== 'hidden') return true;
    }
    return !!(
      document.querySelector('[data-testid="prompt-textarea"]') ||
      document.querySelector('div.ProseMirror[contenteditable="true"]') ||
      document.querySelector('[contenteditable="true"][aria-label="Ask ChatGPT"]')
    );
  }, { timeout: timeoutMs });
  console.log('[POOL] ✅ Composer siap');
}

/** Disalin dari chatgpt.js — fokus nyata + insertText / keyboard */
async function suntikPromptKeComposer(page, promptTeks) {
  const clicked = await page.evaluate(() => {
    const visible = (el) => {
      if (!el) return false;
      const st = window.getComputedStyle(el);
      if (!st || st.display === 'none' || st.visibility === 'hidden') return false;
      const r = el.getBoundingClientRect();
      return r.width > 20 && r.height > 10;
    };
    const list = [];
    const add = (el) => {
      if (visible(el)) list.push(el);
    };
    add(document.querySelector('#prompt-textarea'));
    add(document.querySelector('[data-testid="prompt-textarea"]'));
    document.querySelectorAll('div.ProseMirror[contenteditable="true"], [contenteditable="true"]').forEach(add);
    document.querySelectorAll('textarea').forEach(add);
    if (!list.length) return null;
    list.sort((a, b) => b.getBoundingClientRect().y - a.getBoundingClientRect().y);
    const el = list[0];
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + Math.min(r.height / 2, 24) };
  });

  if (clicked) {
    await page.mouse.click(clicked.x, clicked.y, { delay: 30 });
    await page.waitForTimeout(150);
  }

  const ok = await page.evaluate((teks) => {
    const visible = (el) => {
      if (!el) return false;
      const st = window.getComputedStyle(el);
      if (!st || st.display === 'none' || st.visibility === 'hidden') return false;
      const r = el.getBoundingClientRect();
      return r.width > 20 && r.height > 10;
    };
    const list = [];
    const add = (el) => {
      if (visible(el)) list.push(el);
    };
    add(document.querySelector('#prompt-textarea'));
    add(document.querySelector('[data-testid="prompt-textarea"]'));
    document.querySelectorAll('div.ProseMirror[contenteditable="true"], [contenteditable="true"]').forEach(add);
    document.querySelectorAll('textarea').forEach(add);
    if (!list.length) return false;
    list.sort((a, b) => b.getBoundingClientRect().y - a.getBoundingClientRect().y);
    const el = list[0];
    el.focus();
    try {
      document.execCommand('selectAll', false, null);
      document.execCommand('insertText', false, teks);
    } catch (e) {
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        el.value = teks;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        el.textContent = teks;
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: teks }));
      }
    }
    return (el.innerText || el.textContent || el.value || '').trim().length > 0;
  }, promptTeks);

  if (!ok) {
    await page.keyboard.type(promptTeks, { delay: 8 });
  }
  return true;
}

/** Disalin dari chatgpt.js + marker UI baru (Stop / Working) */
async function klikSendAtauEnter(page) {
  const isGenerating = async () => {
    return page.evaluate(() => {
      return !!(
        document.querySelector('button[aria-label="Stop"]') ||
        document.querySelector('[role="status"][aria-label="Working"]') ||
        document.querySelector('[data-testid="stop-button"]') ||
        document.querySelector('.result-streaming')
      );
    }).catch(() => false);
  };

  // 1) Enter di composer (paling andal di UI lingkaran biru)
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  if (await isGenerating()) return 'enter';

  // 2) Klik send — berbagai selector
  const locs = [
    page.locator('[data-testid="send-button"]'),
    page.getByRole('button', { name: /send prompt|kirim perintah|^send$|^kirim$/i }),
    page.locator('button[aria-label*="Send" i]'),
    page.locator('button[aria-label*="Kirim" i]'),
    // Tombol bulat composer (sering tanpa teks) — primary di kanan composer
    page.locator('form button.bg-composer-primary, button[class*="composer"][class*="rounded-full"]').last(),
  ];
  for (const loc of locs) {
    try {
      if (!(await loc.count())) continue;
      const btn = loc.first();
      if (!(await btn.isVisible().catch(() => false))) continue;
      await btn.click({ timeout: 2500, force: true });
      await page.waitForTimeout(400);
      if (await isGenerating()) return 'click';
    } catch (_) {}
  }

  // 3) Enter sekali lagi
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  if (await isGenerating()) return 'enter-retry';
  return 'enter-retry';
}

async function destroySlot(slot) {
  stopKeepAlivePopupGuard(slot);
  const { page, context, browser } = slot;
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

/**
 * Boot sampai profil+composer — page TETAP HIDUP (HOLD).
 * folderHasil untuk stepShot (opsional).
 */
async function bootSlotOnce(slot, folderHasil) {
  if (!deps.launchGatewayBrowser || !deps.dapatkanSesiCookie) {
    throw new Error('pool deps belum di-set');
  }

  slot.state = 'booting';
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
  await installPopupKiller(page);

  try {
    console.log(`\n[POOL] 🌐 Membuka ChatGPT...`);
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
    await stepShot(page, folderHasil, '01_after_goto');

    await klikAreaKosong(page);
    await tungguSesiValid(page, SESI_TIMEOUT_MS);
    await klikAreaKosong(page);
    await stepShot(page, folderHasil, '02_after_profile');

    await tungguComposerSiap(page, 60000);
    await stepShot(page, folderHasil, '03_composer_ready');
    await page.waitForTimeout(500);
  } catch (e) {
    try { await page.close().catch(() => {}); } catch (_) {}
    try { await context.close().catch(() => {}); } catch (_) {}
    try { await browser.close().catch(() => {}); } catch (_) {}
    throw e;
  }

  slot.browser = browser;
  slot.context = context;
  slot.page = page; // HOLD — jangan ditutup
  slot.cookieId = sesi.id;
  slot.readyAt = Date.now();
  slot.state = 'ready';
  startKeepAlivePopupGuard(slot);
  console.log(`[POOL] slot#${slot.id} READY cookie=${sesi.id} net=${launched.label} (page held, popup guard on)`);
}

async function bootSlotLoop(slot, folderHasil) {
  for (;;) {
    if (slot.state === 'busy') return;
    try {
      await bootSlotOnce(slot, folderHasil);
      return;
    } catch (e) {
      console.log(`[POOL] slot#${slot.id} boot gagal (${e.message}) — cookie lain dalam ${REBUILD_DELAY_MS}ms`);
      await destroySlot(slot);
      await new Promise((r) => setTimeout(r, REBUILD_DELAY_MS));
    }
  }
}

async function bootAllSequential(folderHasil) {
  for (const slot of slots) {
    if (slot.state === 'ready' || slot.state === 'busy') continue;
    await bootSlotLoop(slot, folderHasil);
    await new Promise((r) => setTimeout(r, BOOT_GAP_MS));
  }
  console.log(`[POOL] boot batch selesai:`, poolStats());
}

function acquireReadySlot() {
  const slot = slots.find((s) => s.state === 'ready' && slotPageAlive(s));
  if (!slot) return null;
  stopKeepAlivePopupGuard(slot);
  slot.state = 'busy';
  return slot;
}

function slotPageAlive(slot) {
  try {
    if (!slot.page || !slot.context || !slot.browser) return false;
    if (typeof slot.page.isClosed === 'function' && slot.page.isClosed()) return false;
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Kerjakan tugas di PAGE YANG SUDAH READY — tanpa goto / tanpa cek profil ulang.
 * Logika tugas disalin ringkas dari chatgpt.js (thinking, gambar mode, upload, prompt, send, radar, download).
 */
async function runTaskOnSlot(slot, { action, prompt, isThinkingMode, translatedFiles, folderHasil }) {
  if (!slot || slot.state !== 'busy') throw new Error('slot tidak busy');
  const page = slot.page;
  const context = slot.context;
  if (!page || !context) throw new Error('slot page/context hilang');

  const tipeTugas = action || 'CHAT';
  const promptTeks = prompt || '';
  const validFiles = (translatedFiles || []).filter((f) => fs.existsSync(f));
  let fileTersimpanArray = [];

  try {
    // Pastikan masih di chatgpt + composer hidup
    const url = page.url();
    if (!/chatgpt\.com/i.test(url)) {
      throw new Error('page tidak di chatgpt.com — rebuild');
    }

    // Bersihkan popup yang sempat muncul saat pending
    await page.evaluate(() => {
      document.querySelectorAll('button').forEach((b) => {
        const t = (b.textContent || '').trim().toLowerCase();
        if (t === 'got it' || t === 'okay' || t === 'ok' || t === 'continue') {
          try { b.click(); } catch (e) {}
        }
      });
    }).catch(() => {});

    // Composer harus ada
    await page.waitForSelector('#prompt-textarea, [data-testid="prompt-textarea"], div.ProseMirror[contenteditable="true"]', {
      state: 'visible',
      timeout: 15000,
    });

    if (isThinkingMode) {
      console.log(`[POOL] 🧠 Thinking Mode...`);
      await page.keyboard.press('Control+Shift+M');
      await page.waitForTimeout(800);
    }

    if (tipeTugas === 'GAMBAR') {
      console.log(`[POOL] 🎨 Mode Generasi Gambar...`);
      try {
        const plusBtnSelector = '[data-testid="composer-plus-btn"], #composer-plus-btn';
        await page.waitForSelector(plusBtnSelector, { state: 'visible', timeout: 5000 });
        const plusBox = await page.evaluate((sel) => {
          const btn = document.querySelector(sel);
          if (!btn) return null;
          const rect = btn.getBoundingClientRect();
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        }, plusBtnSelector);
        if (plusBox) await page.mouse.click(plusBox.x, plusBox.y);
        else await page.click(plusBtnSelector);
        await page.waitForTimeout(1500);
        const imgMenuBox = await page.evaluate(() => {
          const spans = Array.from(document.querySelectorAll('span'));
          const targetSpan = spans.find(
            (s) =>
              s.textContent.trim().toLowerCase() === 'buat gambar' ||
              s.textContent.trim().toLowerCase() === 'create image'
          );
          if (!targetSpan) return null;
          const clickableDiv =
            targetSpan.closest('.__menu-item') ||
            targetSpan.closest('div[tabindex="0"]') ||
            targetSpan.parentElement;
          const rect = clickableDiv.getBoundingClientRect();
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        });
        if (imgMenuBox) {
          await page.mouse.move(imgMenuBox.x, imgMenuBox.y, { steps: 5 });
          await page.waitForTimeout(200);
          await page.mouse.click(imgMenuBox.x, imgMenuBox.y);
        }
        await page.waitForTimeout(800);
      } catch (err) {
        console.log(`[POOL] ⚠️ mode gambar: ${err.message}`);
      }
    }

    // Upload (sama JURUS chatgpt.js)
    if (validFiles.length > 0) {
      const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.heic'];
      const imageFiles = validFiles.filter((f) => imageExtensions.includes(path.extname(f).toLowerCase()));
      const docFiles = validFiles.filter((f) => !imageExtensions.includes(path.extname(f).toLowerCase()));

      if (docFiles.length > 0) {
        console.log(`[POOL] 📄 Upload dokumen ${docFiles.length}...`);
        try {
          await page.locator('#composer-plus-btn, [data-testid="composer-plus-btn"]').click({ timeout: 3000 }).catch(() => {});
          await page.waitForTimeout(400);
          await page.evaluate(() => {
            document.querySelectorAll('input[type="file"]').forEach((input) => {
              input.removeAttribute('accept');
              input.removeAttribute('capture');
            });
          });
          const fileInputs = await page.locator('input[type="file"]').all();
          for (const input of fileInputs) {
            try {
              await input.setInputFiles(docFiles, { force: true });
            } catch (_) {}
          }
        } catch (e) {
          console.log(`[POOL] ❌ doc: ${e.message}`);
        }
      }

      if (imageFiles.length > 0) {
        console.log(`[POOL] 🖼️ Upload gambar ${imageFiles.length}...`);
        try {
          await page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 5000 }).catch(() => {});
          const fileInputs = await page.locator('input[type="file"]').all();
          for (const input of fileInputs) {
            try {
              await input.setInputFiles(imageFiles);
              break;
            } catch (_) {}
          }
        } catch (e) {
          console.log(`[POOL] ❌ img: ${e.message}`);
        }
      }
      await page.waitForTimeout(1500);
    }

    await klikAreaKosong(page);
    console.log(`[POOL] ⚡ Menyuntikkan Prompt...`);
    // Sama seperti chatgpt.js → suntikPromptKeComposer
    await suntikPromptKeComposer(page, promptTeks);
    await page.waitForTimeout(500);

    await klikAreaKosong(page);
    console.log(`[POOL] 🚀 Mengirim tugas...`);
    // Sama seperti chatgpt.js → klikSendAtauEnter (Enter + Stop/Working + klik send)
    const how = await klikSendAtauEnter(page);
    console.log(`[POOL] 📤 Send method: ${how}`);
    await stepShot(page, folderHasil, '08_after_send');

    // ===== RADAR DOM (sama seperti chatgpt.js — dari HTML send.html vs done.html) =====
    // Generating: button[aria-label="Stop"] | [role="status"][aria-label="Working"]
    // Done: Stop hilang + teks asisten via data-conversation-role / legacy / Copy
    const baseline = await page.evaluate(() => {
      const genImages = Array.from(document.querySelectorAll('img[src*="backend-api/estuary"]')).filter((img) => {
        if (img.closest('.group\\/message-image')) return false;
        const altText = (img.getAttribute('alt') || '').toLowerCase();
        return img.closest('.group\\/imagegen-image') || altText.includes('generated') || altText.includes('dibuat');
      });
      const assistantRoles = document.querySelectorAll('[data-conversation-role="assistant"]').length;
      const legacyAssist = document.querySelectorAll('[data-message-author-role="assistant"]').length;
      return {
        jumlahBubbleAwal: Math.max(assistantRoles, legacyAssist),
        jumlahGambarAwal: genImages.length,
        assistantRoles,
        legacyAssist,
      };
    });
    const jumlahBubbleAwal = baseline.jumlahBubbleAwal;
    const jumlahGambarAwal = baseline.jumlahGambarAwal;
    console.log(
      `[POOL] 📊 Baseline radar roles=${baseline.assistantRoles} legacy=${baseline.legacyAssist} gambar=${jumlahGambarAwal}`
    );

    try {
      await page.waitForFunction(() => {
        return !!(
          document.querySelector('button[aria-label="Stop"]') ||
          document.querySelector('[role="status"][aria-label="Working"]') ||
          document.querySelector('[data-testid="stop-button"]') ||
          document.querySelector('.result-streaming')
        );
      }, { timeout: 25000 });
      console.log('[POOL] ⏳ Generasi dimulai (Stop/Working)...');
    } catch (_) {
      console.log('[POOL] ⚠️ Marker generate belum muncul cepat — radar tetap jalan');
    }

    console.log('\n[POOL] ⏳ Radar DOM...');
    let hasilEktraksi = null;
    const waktuMulai = Date.now();
    let lastTextLen = 0;
    let stableTicks = 0;

    while (Date.now() - waktuMulai < 300000) {
      const state = await page.evaluate((args) => {
        const { bAwal, gAwal, mode } = args;
        const bodyText = (document.body.innerText || '').toLowerCase();
        if (bodyText.includes("you've reached our limit") || bodyText.includes('batas penggunaan')) {
          return { status: 'error', msg: 'LIMIT_AKUN_TERCAPAI' };
        }

        const stopBtn = document.querySelector('button[aria-label="Stop"]');
        const working = document.querySelector('[role="status"][aria-label="Working"]');
        const legacyStop = document.querySelector('[data-testid="stop-button"], .result-streaming');
        const isGenerating = !!(stopBtn || working || legacyStop);
        if (isGenerating) {
          return { status: 'loading', via: stopBtn ? 'aria-Stop' : working ? 'Working' : 'legacy' };
        }

        const isDoubleText = Array.from(document.querySelectorAll('p')).some((p) =>
          (p.innerText || '').includes('Which image do you like more?')
        );
        const skipSpans = Array.from(document.querySelectorAll('span')).filter(
          (s) => (s.innerText || '').trim().toLowerCase() === 'skip'
        );
        if (isDoubleText && skipSpans.length > 0) {
          const skipBtn = skipSpans[0].closest('button');
          if (skipBtn) {
            skipBtn.click();
            return { status: 'force_refresh', msg: 'A/B Test dilewati.' };
          }
        }

        const getGenImages = () =>
          Array.from(document.querySelectorAll('img[src*="backend-api/estuary"]')).filter((img) => {
            if (img.closest('.group\\/message-image')) return false;
            return (
              img.closest('.group\\/imagegen-image') ||
              (img.getAttribute('alt') || '').toLowerCase().includes('generated') ||
              (img.getAttribute('alt') || '').toLowerCase().includes('dibuat')
            );
          });

        const extractAssistantText = () => {
          const legacy = Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
          if (legacy.length) {
            const last = legacy[legacy.length - 1];
            const box = last.querySelector('.markdown.prose, .markdown') || last;
            return { text: (box.innerText || '').trim(), count: legacy.length, via: 'legacy-role' };
          }
          const headers = Array.from(document.querySelectorAll('[data-conversation-role="assistant"]'));
          if (headers.length) {
            const h = headers[headers.length - 1];
            let root = h.closest('.group') || h.parentElement;
            for (let i = 0; i < 4 && root; i++) {
              const t = (root.innerText || '').replace(/^ChatGPT said:\s*/i, '').trim();
              if (t.length > 20) return { text: t, count: headers.length, via: 'conversation-role' };
              root = root.parentElement;
            }
            const t = ((h.parentElement && h.parentElement.innerText) || '')
              .replace(/^ChatGPT said:\s*/i, '')
              .trim();
            return { text: t, count: headers.length, via: 'conversation-role-fallback' };
          }
          const copyBtns = Array.from(document.querySelectorAll('button')).filter((b) => {
            const a = (b.getAttribute('aria-label') || b.innerText || '').toLowerCase();
            return a === 'copy' || a.includes('copy');
          });
          if (copyBtns.length) {
            const btn = copyBtns[copyBtns.length - 1];
            let root = btn.closest('.group') || btn.parentElement;
            for (let i = 0; i < 8 && root; i++) {
              const t = (root.innerText || '').trim();
              if (t.length > 40 && !t.includes('Ask ChatGPT')) {
                return { text: t, count: copyBtns.length, via: 'copy-button-root' };
              }
              root = root.parentElement;
            }
          }
          return { text: '', count: 0, via: 'none' };
        };

        if (mode === 'GAMBAR') {
          const allGenImages = getGenImages();
          if (allGenImages.length > gAwal) {
            let uniqueImageUrls = [...new Set(allGenImages.slice(gAwal).map((img) => img.src))];
            if (uniqueImageUrls.length > 1 || isDoubleText) uniqueImageUrls = [uniqueImageUrls[0]];
            return { status: 'done', images: uniqueImageUrls, text: null, via: 'gambar' };
          }
          const extracted = extractAssistantText();
          if (extracted.count > bAwal && extracted.text.length > 10) {
            return {
              status: 'done',
              text: `⚠️ Peringatan (Gambar gagal dibuat AI):\n${extracted.text}`,
              images: [],
              via: extracted.via,
            };
          }
          return { status: 'waiting', phase: 'gambar' };
        }

        const extracted = extractAssistantText();
        const hasNew = extracted.count > bAwal || (bAwal === 0 && extracted.text.length > 15);
        if (hasNew && extracted.text.length > 0) {
          return {
            status: 'done',
            text: extracted.text,
            images: [...new Set(getGenImages().map((img) => img.src))],
            via: extracted.via,
            textLen: extracted.text.length,
            count: extracted.count,
          };
        }
        return {
          status: 'waiting',
          textLen: extracted.text.length,
          count: extracted.count,
          via: extracted.via,
        };
      }, { bAwal: jumlahBubbleAwal, gAwal: jumlahGambarAwal, mode: tipeTugas });

      if (state.status === 'loading') {
        stableTicks = 0;
      } else if (state.status === 'done') {
        if (state.textLen && state.textLen !== lastTextLen) {
          lastTextLen = state.textLen;
          stableTicks = 0;
        } else {
          stableTicks++;
        }
        if (stableTicks >= 1 || !state.textLen) {
          console.log(`[POOL] ✅ Radar done via=${state.via || '?'} len=${state.textLen || 0}`);
          hasilEktraksi = state;
          break;
        }
      } else if (state.status === 'error') {
        throw new Error(state.msg);
      } else if (state.status === 'force_refresh') {
        console.log(`\n[POOL] ⚡ ${state.msg}`);
        break;
      }

      await page.waitForTimeout(1200);
    }

    if (!hasilEktraksi) throw new Error('TIMEOUT: ChatGPT gagal memuat respon.');

    // Download gambar jika ada
    if (hasilEktraksi.images && hasilEktraksi.images.length > 0 && folderHasil) {
      const https = require('https');
      const http = require('http');
      for (let i = 0; i < hasilEktraksi.images.length; i++) {
        const imgUrl = hasilEktraksi.images[i];
        const fileName = `chatgpt_IMG_${Date.now()}_${i + 1}.webp`;
        const dest = path.join(folderHasil, fileName);
        try {
          const cookiesArray = await context.cookies();
          const cookieStr = cookiesArray.map((c) => `${c.name}=${c.value}`).join('; ');
          await new Promise((resolve, reject) => {
            const lib = imgUrl.startsWith('https') ? https : http;
            const req = lib.get(
              imgUrl,
              {
                headers: {
                  Cookie: cookieStr,
                  'User-Agent': 'Mozilla/5.0',
                  Referer: 'https://chatgpt.com/',
                },
              },
              (res) => {
                if (res.statusCode === 200 || res.statusCode === 206) {
                  const file = fs.createWriteStream(dest);
                  res.pipe(file);
                  file.on('finish', () => {
                    file.close();
                    resolve(true);
                  });
                } else reject(new Error('HTTP ' + res.statusCode));
              }
            );
            req.on('error', reject);
            req.setTimeout(30000, () => {
              req.destroy();
              reject(new Error('Timeout'));
            });
          });
          if (fs.existsSync(dest)) fileTersimpanArray.push(fileName);
        } catch (_) {}
      }
    }

    return {
      hasil: { text: hasilEktraksi.text, files: fileTersimpanArray },
      cookieId: slot.cookieId,
    };
  } finally {
    // Setelah tugas: rebuild slot (page bekas chat tidak di-hold ulang)
    const id = slot.id;
    console.log(`[POOL] slot#${id} selesai tugas → rebuild`);
    slot.state = 'dead';
    const fh = folderHasil;
    destroySlot(slot)
      .then(() => bootSlotLoop(slot, fh))
      .catch((e) => console.error(`[POOL] rebuild slot#${id}:`, e.message));
  }
}

async function startPool(folderHasil) {
  if (started) {
    console.log('[POOL] sudah started, skip');
    return;
  }
  if (!deps.launchGatewayBrowser || !deps.dapatkanSesiCookie) {
    console.error('[POOL] start ditolak: deps belum di-set');
    return;
  }
  started = true;
  console.log(`[POOL] start size=${POOL_SIZE} (sequential, hold page setelah profil)`);
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
  await bootAllSequential(folderHasil);
}

function poolStats() {
  const c = { ready: 0, busy: 0, booting: 0, dead: 0 };
  for (const s of slots) {
    if (c[s.state] !== undefined) c[s.state]++;
  }
  return c;
}

function isPoolReady() {
  return started && slots.some((s) => s.state === 'ready' && slotPageAlive(s));
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
