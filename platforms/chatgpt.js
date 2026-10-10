const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

// =====================================================================
// 🔑 FUNGSI SEDOT NATIVE (Menggunakan Context Playwright)
// =====================================================================
async function sedotNative(urlTarget, destPath, context) {
    const cookiesArray = await context.cookies();
    const cookieStr = cookiesArray.map(c => `${c.name}=${c.value}`).join('; ');
    
    return new Promise((resolve, reject) => {
        const lib = urlTarget.startsWith('https') ? https : http;
        const req = lib.get(urlTarget, { 
            headers: { 
                'Cookie': cookieStr, 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:130.0) Gecko/20100101 Firefox/130.0', 
                'Referer': 'https://chatgpt.com/'
            } 
        }, (res) => {
            if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                sedotNative(res.headers.location, destPath, context).then(resolve).catch(reject);
            } else if (res.statusCode === 200 || res.statusCode === 206) {
                const file = fs.createWriteStream(destPath);
                res.pipe(file); file.on('finish', () => { file.close(); resolve(true); });
            } else { reject(new Error(`HTTP Status ${res.statusCode}`)); }
        });
        req.on('error', reject); req.setTimeout(30000, () => { req.destroy(); reject(new Error("Timeout")); });
    });
}

// =====================================================================
// 📸 STEP SHOT (dari Script 2)
// =====================================================================
async function stepShot(page, folderHasil, label) {
    try {
        if (!folderHasil) return;
        const safe = String(label || 'step').replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60);
        const fp = path.join(folderHasil, `step_${Date.now()}_${safe}.png`);
        await page.screenshot({ path: fp, fullPage: false }).catch(() => {});
        console.log(`[CHATGPT] 📸 ${label} → ${path.basename(fp)}`);
    } catch (_) {}
}

// =====================================================================
// 👤 TUNGGU PROFIL SIAP (dari Script 2)
// =====================================================================
async function deteksiLoginAtauSignup(page) {
    return page.evaluate(() => {
        const texts = [];
        document.querySelectorAll('button, a, [role="button"]').forEach((el) => {
            const t = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
            if (t && t.length < 40) texts.push(t);
        });
        const body = (document.body && document.body.innerText) ? document.body.innerText.slice(0, 4000) : '';
        const joined = texts.join(' | ').toLowerCase();
        const bodyL = body.toLowerCase();

        const patterns = [
            /^log\s*in$/i,
            /^sign\s*up$/i,
            /^sign\s*up\s*\/?\s*log\s*in$/i,
            /^create\s*account$/i,
            /^masuk$/i,
            /^daftar$/i,
            /^log\s*in\s*\/\s*sign\s*up$/i,
        ];
        for (const t of texts) {
            for (const re of patterns) {
                if (re.test(t.trim())) return { hit: true, via: 'btn:' + t };
            }
        }
        // Auth wall umum di chatgpt.com
        if (/log in or sign up/i.test(body) || /welcome to chatgpt/i.test(body) && /log in/i.test(body)) {
            return { hit: true, via: 'body-auth-wall' };
        }
        // data-testid auth
        if (document.querySelector('[data-testid="login-button"], [data-testid="signup-button"]')) {
            return { hit: true, via: 'testid-auth' };
        }
        return { hit: false, via: '' };
    });
}

/**
 * Validasi sesi cookie: BUKAN lewat profil.
 * - Ada Login/Sign up → cookie invalid → throw COOKIE_INVALID
 * - Composer siap / tidak ada auth wall → lanjut
 */
async function tungguSesiValid(page, timeoutMs = 45000) {
    console.log('[CHATGPT] 🔐 Cek sesi (login/signup = cookie invalid)...');
    const t0 = Date.now();
    let lastLog = 0;

    while (Date.now() - t0 < timeoutMs) {
        const auth = await deteksiLoginAtauSignup(page);
        if (auth.hit) {
            console.log(`[CHATGPT] ❌ Auth wall: ${auth.via}`);
            throw new Error('COOKIE_INVALID: terdeteksi tombol/halaman Login atau Sign up (' + auth.via + ')');
        }

        // Composer muncul = sesi cukup untuk lanjut (tanpa wajib profil)
        const composer = await page.evaluate(() => {
            const a = document.querySelector('#prompt-textarea');
            if (a) {
                const st = window.getComputedStyle(a);
                if (st && st.display !== 'none' && st.visibility !== 'hidden') return true;
            }
            return !!(
                document.querySelector('[data-testid="prompt-textarea"]') ||
                document.querySelector('div.ProseMirror[contenteditable="true"]')
            );
        }).catch(() => false);

        if (composer) {
            console.log(`[CHATGPT] ✅ Sesi OK (composer ada, tanpa login wall) ${Date.now() - t0}ms`);
            return;
        }

        if (Date.now() - lastLog > 2500) {
            lastLog = Date.now();
            console.log(`[CHATGPT] sesi… ${Date.now() - t0}ms (tunggu composer / cek auth)`);
        }
        await page.waitForTimeout(400);
    }

    // Timeout: cek auth sekali lagi
    const auth2 = await deteksiLoginAtauSignup(page);
    if (auth2.hit) {
        throw new Error('COOKIE_INVALID: terdeteksi Login/Sign up (' + auth2.via + ')');
    }
    // Tidak ada auth wall — biarkan tungguComposerSiap yang memutuskan
    console.log('[CHATGPT] ⚠️ Timeout cek sesi tanpa auth wall — lanjut ke composer');
}

/** Klik nyata di area kosong (pinggir kanan tengah / bawah tengah) untuk menutup NUX/overlay */
async function klikAreaKosong(page) {
    try {
        const vp = page.viewportSize() || { width: 1920, height: 1080 };
        // Tengah-kanan (bukan di atas dialog tengah)
        const x1 = Math.floor(vp.width * 0.92);
        const y1 = Math.floor(vp.height * 0.50);
        // Bawah-tengah
        const x2 = Math.floor(vp.width * 0.50);
        const y2 = Math.floor(vp.height * 0.92);

        await page.mouse.click(x1, y1, { delay: 40 });
        await page.waitForTimeout(120);
        await page.mouse.click(x2, y2, { delay: 40 });
        await page.waitForTimeout(150);
    } catch (_) {}
}

// =====================================================================
// ⏳ TUNGGU COMPOSER SIAP (dari Script 2)
// =====================================================================
/** Cari elemen composer di semua varian UI ChatGPT */
function composerFinderScript() {
    return (() => {
        const visible = (el) => {
            if (!el) return false;
            const st = window.getComputedStyle(el);
            if (!st || st.display === 'none' || st.visibility === 'hidden' || st.opacity === '0') return false;
            const r = el.getBoundingClientRect();
            return r.width > 20 && r.height > 10;
        };
        const candidates = [];
        const push = (el, how) => { if (el && visible(el)) candidates.push({ el, how }); };

        push(document.querySelector('#prompt-textarea'), 'id');
        push(document.querySelector('[data-testid="prompt-textarea"]'), 'testid');
        document.querySelectorAll('div.ProseMirror[contenteditable="true"], [contenteditable="true"].ProseMirror').forEach((el) => push(el, 'prose'));
        // UI penuh: placeholder "Ask ChatGPT" / "Tanyakan apa saja" — contenteditable di form utama
        document.querySelectorAll('[contenteditable="true"]').forEach((el) => {
            const ph = (el.getAttribute('data-placeholder') || el.getAttribute('aria-placeholder') || el.getAttribute('placeholder') || '').toLowerCase();
            const al = (el.getAttribute('aria-label') || '').toLowerCase();
            if (/ask chatgpt|tanyakan|message|pesan|prompt/i.test(ph + ' ' + al)) push(el, 'ph');
            else if (visible(el) && el.closest('form')) push(el, 'form-ce');
        });
        // textarea biasa
        document.querySelectorAll('textarea').forEach((el) => {
            const ph = (el.getAttribute('placeholder') || '').toLowerCase();
            if (/ask|tanya|message|chatgpt/i.test(ph) || el.id === 'prompt-textarea') push(el, 'textarea');
        });

        if (!candidates.length) return null;
        // prioritaskan yang di tengah bawah viewport (composer utama)
        candidates.sort((a, b) => {
            const rb = b.el.getBoundingClientRect();
            const ra = a.el.getBoundingClientRect();
            return (rb.y + rb.height) - (ra.y + ra.height);
        });
        return candidates[0].how;
    })();
}

async function tungguComposerSiap(page, timeoutMs = 60000) {
    console.log('[CHATGPT] ⏳ Menunggu kolom teks (composer) siap...');
    await page.waitForFunction(() => {
        const visible = (el) => {
            if (!el) return false;
            const st = window.getComputedStyle(el);
            if (!st || st.display === 'none' || st.visibility === 'hidden') return false;
            const r = el.getBoundingClientRect();
            return r.width > 20 && r.height > 10;
        };
        if (visible(document.querySelector('#prompt-textarea'))) return true;
        if (visible(document.querySelector('[data-testid="prompt-textarea"]'))) return true;
        if (document.querySelector('div.ProseMirror[contenteditable="true"]')) return true;
        for (const el of document.querySelectorAll('[contenteditable="true"]')) {
            if (!visible(el)) continue;
            const ph = (el.getAttribute('data-placeholder') || el.getAttribute('aria-label') || '').toLowerCase();
            if (/ask|tanya|message|chatgpt|prompt/i.test(ph) || el.closest('form')) return true;
        }
        for (const el of document.querySelectorAll('textarea')) {
            if (visible(el)) return true;
        }
        // UI "Ask ChatGPT" pill: ada tombol mic/send di bar yang sama
        if (document.querySelector('[data-testid="send-button"], button[aria-label*="Send" i], button[aria-label*="Kirim" i]')) {
            if (document.querySelector('[contenteditable="true"], textarea')) return true;
        }
        return false;
    }, { timeout: timeoutMs });
    console.log('[CHATGPT] ✅ Composer siap');
}

async function suntikPromptKeComposer(page, promptTeks) {
    // Klik nyata ke area composer dulu (aktifkan focus di UI penuh)
    const clicked = await page.evaluate(() => {
        const visible = (el) => {
            if (!el) return false;
            const st = window.getComputedStyle(el);
            if (!st || st.display === 'none' || st.visibility === 'hidden') return false;
            const r = el.getBoundingClientRect();
            return r.width > 20 && r.height > 10;
        };
        const list = [];
        const add = (el) => { if (visible(el)) list.push(el); };
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
        const add = (el) => { if (visible(el)) list.push(el); };
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
        // Fallback keyboard type
        await page.keyboard.type(promptTeks, { delay: 8 });
    }
    return true;
}

async function klikSendAtauEnter(page) {
    // 1) Enter di composer
    await page.keyboard.press('Enter');
    await page.waitForTimeout(500);
    let gen = await page.locator('[data-testid="stop-button"], .result-streaming').count().catch(() => 0);
    if (gen) return 'enter';

    // 2) Klik send berbagai selector
    const locs = [
        page.locator('[data-testid="send-button"]'),
        page.getByRole('button', { name: /send prompt|kirim perintah|^send$|^kirim$/i }),
        page.locator('button[aria-label*="Send" i]'),
        page.locator('button[aria-label*="Kirim" i]'),
    ];
    for (const loc of locs) {
        try {
            if (!(await loc.count())) continue;
            const btn = loc.first();
            if (!(await btn.isVisible().catch(() => false))) continue;
            await btn.click({ timeout: 2500, force: true });
            await page.waitForTimeout(400);
            gen = await page.locator('[data-testid="stop-button"], .result-streaming').count().catch(() => 0);
            if (gen) return 'click';
        } catch (_) {}
    }

    // 3) Enter sekali lagi
    await page.keyboard.press('Enter');
    return 'enter-retry';
}

// =====================================================================
// 🧹 NUX memory (Got it / Mengerti) — minimal, tidak mengganggu composer


// =====================================================================
// 🚀 EKSEKUTOR UTAMA CHATGPT (HIBRIDA MURNI)
// =====================================================================
async function eksekusiChatGPT(tipeTugas, promptTeks, isThinkingMode, fileInputData, folderHasil, context) {
    let fileTersimpanArray = [];
    let arrayFile = Array.isArray(fileInputData) ? fileInputData : (fileInputData ? [fileInputData] : []);
    const validFiles = arrayFile.filter(f => fs.existsSync(f));

    const page = await context.newPage();
    await page.setViewportSize({ width: 1920, height: 1080 });

    // 🌟 SISTEM PEMBUNUH POP-UP OTONOM (selalu nyala, termasuk memory NUX)
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
                if (
                    btn.querySelector('svg') &&
                    (btn.getAttribute('aria-label') === 'Close' || btn.getAttribute('aria-label') === 'Tutup')
                ) {
                    try { btn.click(); } catch (e) {}
                }
            }

            // Dialog radix / memory NUX: "More relevant, personalized replies"
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

        const observer = new MutationObserver(() => dismissPopups());
        observer.observe(document.documentElement, { childList: true, subtree: true });
        setInterval(dismissPopups, 800);
        dismissPopups();
    });

    try {
        // ---------------------------------------------------------
        // 1) Navigasi
        // ---------------------------------------------------------
        console.log(`\n[CHATGPT] 🌐 Membuka ChatGPT...`);
        await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 90000 }).catch(()=>{});
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        await stepShot(page, folderHasil, '01_after_goto');

        // Klik nyata di area kosong — tutup NUX/overlay tanpa deteksi
        await klikAreaKosong(page);

        // ---------------------------------------------------------
        // 2) Validasi cookie: Login/Sign up = invalid
        // ---------------------------------------------------------
        await tungguSesiValid(page, 45000);
        await stepShot(page, folderHasil, '02_after_session');
        await klikAreaKosong(page);

        // ---------------------------------------------------------
        // 3) Composer siap → baru ketik prompt
        // ---------------------------------------------------------
        await tungguComposerSiap(page, 60000);
        await stepShot(page, folderHasil, '03_composer_ready');
        await klikAreaKosong(page);
        await page.waitForTimeout(400);

        if (isThinkingMode) {
            console.log(`[CHATGPT] 🧠 Mengaktifkan Thinking Mode...`);
            await page.keyboard.press('Control+Shift+M');
            await page.waitForTimeout(800);
        }

        if (tipeTugas === 'GAMBAR') {
            console.log(`[CHATGPT] 🎨 Mengaktifkan Mode Generasi Gambar...`);
            try {
                const plusBtnSelector = '[data-testid="composer-plus-btn"], #composer-plus-btn';
                await page.waitForSelector(plusBtnSelector, { state: 'visible', timeout: 5000 });
                
                const plusBox = await page.evaluate((sel) => {
                    const btn = document.querySelector(sel);
                    if (!btn) return null;
                    const rect = btn.getBoundingClientRect();
                    return {x: rect.x + rect.width/2, y: rect.y + rect.height/2};
                }, plusBtnSelector);
                
                if(plusBox) {
                    await page.mouse.click(plusBox.x, plusBox.y);
                } else {
                    await page.click(plusBtnSelector);
                }
                
                await page.waitForTimeout(1500); 
                
                const imgMenuBox = await page.evaluate(() => {
                    const spans = Array.from(document.querySelectorAll('span'));
                    const targetSpan = spans.find(s => s.textContent.trim().toLowerCase() === 'buat gambar' || s.textContent.trim().toLowerCase() === 'create image');
                    if (targetSpan) {
                        const clickableDiv = targetSpan.closest('.__menu-item') || targetSpan.closest('div[tabindex="0"]') || targetSpan.parentElement;
                        const rect = clickableDiv.getBoundingClientRect();
                        return { x: rect.x + rect.width/2, y: rect.y + rect.height/2 };
                    }
                    return null;
                });

                if (imgMenuBox) {
                    await page.mouse.move(imgMenuBox.x, imgMenuBox.y, { steps: 5 });
                    await page.waitForTimeout(200);
                    await page.mouse.click(imgMenuBox.x, imgMenuBox.y);
                } 

                await page.waitForTimeout(1000);
                await page.evaluate(() => { const textarea = document.querySelector('#prompt-textarea'); if (textarea) { textarea.click(); textarea.focus(); } });
                await page.waitForTimeout(500);
            } catch (err) { 
                console.log(`[CHATGPT] ⚠️ Peringatan aktivasi mode gambar: ${err.message}`); 
            }
        }

        // =================================================================
        // 🌟 LOGIKA PELAMPIRAN DUAL-CORE (BERDASARKAN CHATGPT_1 DAN CHATGPT_2)
        // =================================================================
        if (validFiles.length > 0) {
            console.log(`[CHATGPT] 📎 Memproses ${validFiles.length} File...`);
            
            // Pemisahan Jenis File
            const imageExtensions = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.heic'];
            const imageFiles = validFiles.filter(f => imageExtensions.includes(path.extname(f).toLowerCase()));
            const docFiles = validFiles.filter(f => !imageExtensions.includes(path.extname(f).toLowerCase()));

            // -----------------------------------------------------------------
            // JURUS 1: UPLOAD DOKUMEN (Menggunakan logika murni chatgpt_2.js)
            // -----------------------------------------------------------------
            if (docFiles.length > 0) {
                console.log(`[CHATGPT] 📄 Mengunggah Dokumen (Mode chatgpt_2.js)...`);
                try {
                    try {
                        await page.locator('#composer-plus-btn, [data-testid="composer-plus-btn"]').click({ timeout: 3000 });
                        await page.waitForTimeout(500); 
                    } catch(e) {}

                    await page.evaluate(() => {
                        document.querySelectorAll('input[type="file"]').forEach(input => {
                            input.removeAttribute('accept'); 
                            input.removeAttribute('capture');
                        });
                    });

                    let nativeDocUploaded = false;
                    const fileInputs = await page.locator('input[type="file"]').all();
                    
                    for (let i = 0; i < fileInputs.length; i++) {
                        try { 
                            await fileInputs[i].setInputFiles(docFiles, { force: true }); 
                            nativeDocUploaded = true;
                        } catch (e) {}
                    }

                    if (!nativeDocUploaded) {
                        console.log(`[CHATGPT] ⚠️ Menggunakan Injeksi Clipboard untuk Dokumen...`);
                        await page.evaluate(() => {
                            const oldInput = document.getElementById('hacker-doc-input');
                            if (oldInput) oldInput.remove();
                            const input = document.createElement('input');
                            input.type = 'file'; input.multiple = true; input.id = 'hacker-doc-input'; input.style.display = 'none'; document.body.appendChild(input);
                        });
                        
                        const hackerInput = page.locator('#hacker-doc-input');
                        await hackerInput.setInputFiles(docFiles, { force: true });
                        
                        await page.evaluate(() => {
                            const input = document.getElementById('hacker-doc-input');
                            if (input && input.files.length > 0) {
                                const target = document.querySelector('#prompt-textarea');
                                if (target) {
                                    target.focus();
                                    const dt = new DataTransfer(); 
                                    for(let i = 0; i < input.files.length; i++) dt.items.add(input.files[i]);
                                    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
                                }
                            }
                        });
                    }
                } catch (e) { console.log(`[CHATGPT] ❌ Error Dokumen: ${e.message}`); }
            }

            // -----------------------------------------------------------------
            // JURUS 2: UPLOAD GAMBAR (Menggunakan logika murni chatgpt_1.js)
            // -----------------------------------------------------------------
            if (imageFiles.length > 0) {
                console.log(`[CHATGPT] 🖼️ Mengunggah Gambar (Mode chatgpt_1.js)...`);
                try {
                    let nativeImgUploaded = false;
                    await page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 5000 }).catch(()=>{});
                    const fileInputs = await page.locator('input[type="file"]').all();
                    
                    for (const input of fileInputs) {
                        try { 
                            await input.setInputFiles(imageFiles); 
                            nativeImgUploaded = true; 
                            break; // PENTING: Sesuai chatgpt_1.js
                        } catch (e) {}
                    }

                    if (!nativeImgUploaded) {
                        console.log(`[CHATGPT] ⚠️ Menggunakan Injeksi Clipboard untuk Gambar...`);
                        await page.evaluate(() => {
                            const oldInput = document.getElementById('hacker-image-input');
                            if (oldInput) oldInput.remove();
                            const input = document.createElement('input');
                            input.type = 'file'; input.multiple = true; input.id = 'hacker-image-input'; input.style.display = 'none'; document.body.appendChild(input);
                        });
                        
                        const hackerInput = page.locator('#hacker-image-input');
                        await hackerInput.setInputFiles(imageFiles);
                        
                        await page.evaluate(() => {
                            const input = document.getElementById('hacker-image-input');
                            if (input && input.files.length > 0) {
                                const target = document.querySelector('#prompt-textarea');
                                if (target) {
                                    target.focus();
                                    const dt = new DataTransfer(); 
                                    for(let i = 0; i < input.files.length; i++) dt.items.add(input.files[i]);
                                    target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
                                }
                            }
                        });
                    }
                } catch (e) { console.log(`[CHATGPT] ❌ Error Gambar: ${e.message}`); }
            }

            // Pantau lampiran (dari Script 2)
            console.log(`[CHATGPT] ⏳ Menunggu visualisasi file di layar...`);
            try {
                await page.waitForFunction((expected) => {
                    const body = (document.body.innerText || '').toLowerCase();
                    if (body.includes('uploading')) return false;

                    const removeBtns = document.querySelectorAll(
                        'button[aria-label*="Remove" i], button[aria-label*="Hapus" i], button[aria-label*="remove file" i]'
                    );
                    if (removeBtns.length >= expected) return true;

                    const thumbs = document.querySelectorAll(
                        'img[src*="blob:"], img[alt*="attachment" i], div[data-testid*="file-thumbnail" i], div[class*="file-thumbnail"]'
                    );
                    if (thumbs.length >= expected) return true;

                    const composer =
                        document.querySelector('#prompt-textarea')?.closest('form') ||
                        document.querySelector('[data-testid="send-button"]')?.closest('form');
                    if (composer) {
                        const chips = composer.querySelectorAll('[data-testid*="file"], [class*="attachment"], [class*="thumbnail"]');
                        if (chips.length >= expected) return true;
                    }
                    return false;
                }, validFiles.length, { timeout: 45000 });
                console.log('[CHATGPT] ✅ Lampiran terdeteksi');
                await stepShot(page, folderHasil, '04_attachment_ok');
            } catch (e) {
                console.log('[CHATGPT] ⚠️ Timeout pantau lampiran:', e.message);
                await stepShot(page, folderHasil, '04_attachment_timeout');
            }

            // Stabilitas upload
            try {
                await page.waitForFunction(() => {
                    const nodes = Array.from(document.querySelectorAll('div, span, p'));
                    for (const n of nodes) {
                        const t = (n.textContent || '').trim();
                        if (/^Uploading(\.\.\.|…)?$/i.test(t)) return false;
                        if (/^Uploading file/i.test(t) && !/Try using connectors/i.test(t)) return false;
                    }
                    if (document.querySelector('[data-testid*="upload-progress"]')) return false;
                    const sendBtn = document.querySelector('[data-testid="send-button"]');
                    if (!sendBtn) return false;
                    return !(sendBtn.disabled || sendBtn.hasAttribute('disabled') || sendBtn.getAttribute('aria-disabled') === 'true');
                }, { timeout: 120000 });
                console.log('[CHATGPT] ✅ Upload stabil');
            } catch (e) {
                console.log('[CHATGPT] ⚠️ Timeout stabilitas upload');
            }
            await page.waitForTimeout(1000);
        }


        const { jumlahBubbleAwal, jumlahGambarAwal } = await page.evaluate(() => {
            const genImages = Array.from(document.querySelectorAll('img[src*="backend-api/estuary"]')).filter(img => {
                if (img.closest('.group\\/message-image')) return false;
                const altText = (img.getAttribute('alt') || '').toLowerCase();
                return img.closest('.group\\/imagegen-image') || altText.includes('generated') || altText.includes('dibuat');
            });
            return {
                jumlahBubbleAwal: document.querySelectorAll('[data-message-author-role="assistant"], .markdown.prose').length,
                jumlahGambarAwal: genImages.length
            };
        });

        await klikAreaKosong(page);
        console.log(`[CHATGPT] ⚡ Menyuntikkan Prompt...`);
        await suntikPromptKeComposer(page, promptTeks);
        await page.waitForTimeout(500);

        await klikAreaKosong(page);
        console.log(`[CHATGPT] 🚀 Mengirim tugas...`);
        const how = await klikSendAtauEnter(page);
        console.log(`[CHATGPT] 📤 Send method: ${how}`);
        await stepShot(page, folderHasil, '08_after_send');

        console.log('\n[CHATGPT] ⏳ Mulai radar pemantauan DOM...');
        let hasilEktraksi = null;
        let waktuMulai = Date.now();

        while (Date.now() - waktuMulai < 300000) {
            const state = await page.evaluate((args) => {
                const { bAwal, gAwal, mode } = args;
                
                if (document.body.innerText.toLowerCase().includes('you\'ve reached our limit') || document.body.innerText.toLowerCase().includes('batas penggunaan')) return { status: 'error', msg: 'LIMIT_AKUN_TERCAPAI' };

                const isGenerating = document.querySelector('[data-testid="stop-button"]') || document.querySelector('.result-streaming');
                if (isGenerating) { return { status: 'loading' }; }

                const isDoubleText = Array.from(document.querySelectorAll('p')).some(p => p.innerText.includes('Which image do you like more?'));
                const skipSpans = Array.from(document.querySelectorAll('span')).filter(s => s.innerText.trim().toLowerCase() === 'skip');
                if (isDoubleText && skipSpans.length > 0) {
                    const skipBtn = skipSpans[0].closest('button');
                    if (skipBtn) { skipBtn.click(); return { status: 'force_refresh', msg: 'A/B Test dilewati.' }; }
                }

                const getGenImages = () => Array.from(document.querySelectorAll('img[src*="backend-api/estuary"]')).filter(img => {
                    if (img.closest('.group\\/message-image')) return false;
                    return img.closest('.group\\/imagegen-image') || (img.getAttribute('alt') || '').toLowerCase().includes('generated') || (img.getAttribute('alt') || '').toLowerCase().includes('dibuat');
                });

                if (mode === 'GAMBAR') {
                    const allGenImages = getGenImages();
                    if (allGenImages.length > gAwal) {
                        const newestImage = allGenImages[allGenImages.length - 1];
                        const container = newestImage.closest('.group\\/imagegen-image') || newestImage.parentElement.parentElement.parentElement;
                        const actionButtons = container ? container.querySelectorAll('button') : [];
                        
                        if (actionButtons.length >= 2) {
                            let uniqueImageUrls = [...new Set(allGenImages.slice(gAwal).map(img => img.src))];
                            if (uniqueImageUrls.length > 1 || isDoubleText) uniqueImageUrls = [uniqueImageUrls[0]]; 
                            return { status: 'done', images: uniqueImageUrls, text: null };
                        }
                    } 
                    else {
                        const messages = Array.from(document.querySelectorAll('[data-message-author-role="assistant"], .markdown.prose'));
                        if (messages.length > bAwal) {
                            const lastMessage = messages[messages.length - 1];
                            const parentBlock = lastMessage.closest('[data-testid^="conversation-turn"]') || lastMessage.parentElement.parentElement;
                            const actionButtons = parentBlock ? parentBlock.querySelectorAll('button') : [];

                            if (actionButtons.length >= 2 && !document.querySelector('.result-streaming')) {
                                const textContainer = lastMessage.querySelector('.markdown.prose') || lastMessage;
                                let finalTxt = textContainer.innerText.trim();
                                return { status: 'done', text: `⚠️ Peringatan (Gambar gagal dibuat AI):\n${finalTxt}`, images: [] };
                            }
                        }
                    }
                } 
                else {
                    const messages = Array.from(document.querySelectorAll('[data-message-author-role="assistant"], .markdown.prose'));
                    if (messages.length > bAwal) {
                        const lastMessage = messages[messages.length - 1];
                        const parentBlock = lastMessage.closest('[data-testid^="conversation-turn"]') || lastMessage.parentElement.parentElement;
                        const actionButtons = parentBlock ? parentBlock.querySelectorAll('button') : [];

                        if (actionButtons.length >= 2 && !document.querySelector('.result-streaming')) {
                            const hiddenElements = lastMessage.querySelectorAll('details, .thought-process, [data-testid="webpage-citation-pill"], sup');
                            hiddenElements.forEach(el => { el._oldDisplay = el.style.display; el.style.display = 'none'; });
                            
                            const textContainer = lastMessage.querySelector('.markdown.prose') || lastMessage;
                            let finalTxt = textContainer.innerText.trim();
                            
                            hiddenElements.forEach(el => el.style.display = el._oldDisplay || '');

                            const uniqueImageUrls = [...new Set(getGenImages().map(img => img.src))];
                            return { status: 'done', text: finalTxt, images: uniqueImageUrls };
                        }
                    }
                }
                return { status: 'waiting' };
            }, { bAwal: jumlahBubbleAwal, gAwal: jumlahGambarAwal, mode: tipeTugas });

            if (state.status === 'done') { hasilEktraksi = state; break; }
            if (state.status === 'error') throw new Error(state.msg);
            
            if (state.status === 'force_refresh') {
                console.log(`\n[CHATGPT] ⚡ ${state.msg}`);
                break; 
            }
            
            await page.waitForTimeout(2000); 
        }

        if (!hasilEktraksi && tipeTugas === 'GAMBAR') {
            console.log(`[CHATGPT] ⚠️ Menyegarkan (refresh) halaman untuk mengekstrak gambar secara aman...`);
            await page.reload({ waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
            await page.waitForTimeout(8000); 
            
            hasilEktraksi = await page.evaluate(() => {
                const skipSpans = Array.from(document.querySelectorAll('span')).filter(s => s.innerText.trim().toLowerCase() === 'skip');
                if (skipSpans.length > 0 && skipSpans[0].closest('button')) skipSpans[0].closest('button').click();

                const genImages = Array.from(document.querySelectorAll('img[src*="backend-api/estuary"]')).filter(img => {
                    if (img.closest('.group\\/message-image')) return false;
                    const altText = (img.getAttribute('alt') || '').toLowerCase();
                    return img.closest('.group\\/imagegen-image') || altText.includes('generated') || altText.includes('dibuat');
                });
                
                if (genImages.length > 0) {
                    const uniqueImageUrls = [...new Set(genImages.map(img => img.src))];
                    const gambarFinal = [uniqueImageUrls[uniqueImageUrls.length - 1]];
                    return { status: 'done', text: null, images: gambarFinal };
                }
                return null;
            });
        }

        if (!hasilEktraksi) throw new Error("TIMEOUT: ChatGPT gagal memuat respon.");

        if (hasilEktraksi.images && hasilEktraksi.images.length > 0) {
            console.log(`\n[CHATGPT] ✅ Mengunduh ${hasilEktraksi.images.length} gambar buatan AI...`);
            for (let i = 0; i < hasilEktraksi.images.length; i++) {
                const imgUrl = hasilEktraksi.images[i]; const fileName = `chatgpt_IMG_${Date.now()}_${i + 1}.webp`;
                try { await sedotNative(imgUrl, path.join(folderHasil, fileName), context); fileTersimpanArray.push(fileName); } catch (e) {}
            }
            if (tipeTugas === 'GAMBAR' && !hasilEktraksi.text) hasilEktraksi.text = null; 
        } 

        return { text: hasilEktraksi.text, files: fileTersimpanArray };

    } catch (err) {
        console.log(`\n[CHATGPT ❌ CRITICAL ERROR]:`, err.message);
        try {
            const errFilePath = path.join(folderHasil, `error_trace_${Date.now()}.png`);
            await page.screenshot({ path: errFilePath, fullPage: true }).catch(()=>{});
            console.log(`📸 FOTO BUKTI ERROR DISIMPAN DI: ${errFilePath}`);
        } catch (screenshotErr) {}
        throw err;
    } finally {
        await page.close().catch(()=>{});
    }
}

module.exports = { eksekusiChatGPT };
