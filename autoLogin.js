import puppeteer from 'puppeteer-core';
import fs from 'fs';
import os from 'os';

const CONFIG_FILE = './config.json';

function findChromeExecutable() {
  const platform = os.platform();

  if (platform === 'win32') {
    const possiblePaths = [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
    ];
    for (const p of possiblePaths) {
      if (p && fs.existsSync(p)) return p;
    }
  } else if (platform === 'linux') {
    const possiblePaths = [
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable'
    ];
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) return p;
    }
  }
  return null;
}

let isAutoLoginRunning = false;

export async function performAutoLogin() {
  // ═══ MUTEX LOCK: Hanya 1 instance auto-login yang boleh berjalan ═══
  if (isAutoLoginRunning) {
    console.log('[AUTO-LOGIN] ⏳ Sedang berjalan di proses lain, skip.');
    return { success: false, reason: 'Auto-login sedang berjalan' };
  }

  isAutoLoginRunning = true;
  console.log('\n[🔄 AUTO-LOGIN] Memulai proses login otomatis ke SSO UNS...');

  if (!fs.existsSync(CONFIG_FILE)) {
    isAutoLoginRunning = false;
    return { success: false, reason: 'File config.json tidak ditemukan' };
  }

  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  const { ssoUsername: username, ssoPassword: password } = config;

  if (!username || !password || username.includes('EMAIL_UNS_ANDA')) {
    isAutoLoginRunning = false;
    return { success: false, reason: 'Kredensial SSO belum diisi di config.json' };
  }

  const executablePath = config.executablePath || findChromeExecutable();
  if (!executablePath) {
    isAutoLoginRunning = false;
    return { success: false, reason: 'Browser (Chrome/Chromium) tidak ditemukan!' };
  }

  console.log(`[AUTO-LOGIN] Browser: ${executablePath}`);

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      pipe: true,
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote',
        '--disable-gpu', '--disable-extensions', '--single-process'
      ]
    });

    // ═══ STEP 1: Login SSO UNS ═══
    const loginPage = await browser.newPage();
    await loginPage.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    console.log('[AUTO-LOGIN] Membuka halaman SSO UNS...');
    await loginPage.goto('https://siakad.uns.ac.id/saml/login', {
      waitUntil: 'domcontentloaded', timeout: 40000
    });

    await loginPage.waitForSelector('input[name="username"]', { timeout: 15000 });
    console.log(`[AUTO-LOGIN] Mengisi kredensial: ${username}`);
    await loginPage.type('input[name="username"]', username);
    await loginPage.type('input[name="password"]', password);

    console.log('[AUTO-LOGIN] Menekan tombol Masuk...');
    await loginPage.click('button[type="submit"]').catch(() => {});

    // Polling: tunggu redirect SSO → Siakad selesai (maks 20 detik)
    let ssoSuccess = false;
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        const url = loginPage.url();
        if (url.includes('siakad.uns.ac.id') && !url.includes('saml/login')) {
          ssoSuccess = true;
          break;
        }
      } catch {
        // Context mungkin sudah destroyed karena redirect - cek via browser target
        const pages = await browser.pages();
        for (const p of pages) {
          try {
            const u = p.url();
            if (u.includes('siakad.uns.ac.id') && !u.includes('saml/login')) {
              ssoSuccess = true;
              break;
            }
          } catch { /* skip */ }
        }
        if (ssoSuccess) break;
      }
    }

    if (!ssoSuccess) {
      // Cek apakah masih di SSO (password salah / captcha)
      let failReason = 'Timeout: Redirect SSO ke Siakad tidak berhasil.';
      try {
        const content = await loginPage.content();
        if (content.includes('Captcha') || content.includes('captcha')) {
          failReason = 'SSO UNS meminta Captcha.';
        } else if (loginPage.url().includes('sso.uns.ac.id')) {
          failReason = 'Username atau Password SSO salah!';
        }
      } catch { /* page mungkin sudah destroyed */ }
      console.error(`❌ [AUTO-LOGIN] ${failReason}`);
      await browser.close();
      return { success: false, reason: failReason };
    }

    console.log('[AUTO-LOGIN] ✅ SSO Login berhasil! Redirect ke Siakad selesai.');

    // ═══ STEP 2: Buka TAB BARU untuk navigasi ke Input KRS ═══
    // Ini menghindari "Execution context was destroyed" karena tab lama
    // mungkin masih punya pending redirect/navigation dari SSO.
    await new Promise(r => setTimeout(r, 2000)); // Tunggu sesi server stabil

    const krsPage = await browser.newPage();
    await krsPage.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    console.log('[AUTO-LOGIN] Membuka halaman Input KRS di tab baru...');
    await krsPage.goto('https://siakad.uns.ac.id/registrasi/input-krs/index', {
      waitUntil: 'domcontentloaded', timeout: 40000
    });

    // ═══ STEP 3: Handle PIN Bank jika diperlukan ═══
    let pinRequiredWithoutValue = false;
    const krsUrl = krsPage.url();

    if (krsUrl.includes('cek-pin-krs') || krsUrl.includes('cek-pin')) {
      if (config.pinBank) {
        console.log(`[AUTO-LOGIN] Form PIN Bank terdeteksi, mengisi PIN (${config.pinBank})...`);
        const pinInput = await krsPage.waitForSelector('#mhsfix-pin_baru', { timeout: 10000 }).catch(() => null);
        if (pinInput) {
          await krsPage.type('#mhsfix-pin_baru', config.pinBank);
          await krsPage.click('button[type="submit"]').catch(() => {});
          // Tunggu halaman berpindah dari cek-pin
          for (let i = 0; i < 10; i++) {
            await new Promise(r => setTimeout(r, 1000));
            if (!krsPage.url().includes('cek-pin')) break;
          }
        }
      } else {
        console.log('ℹ️ [AUTO-LOGIN] Halaman memerlukan PIN Bank. Isi "pinBank" di config.json.');
        pinRequiredWithoutValue = true;
      }
    }

    // ═══ STEP 4: Ambil cookies dari tab KRS (yang sudah fresh & valid) ═══
    const cookies = await krsPage.cookies('https://siakad.uns.ac.id');
    console.log(`[AUTO-LOGIN] Mendapatkan ${cookies.length} cookies dari tab KRS.`);

    const formattedCookies = cookies.map(c => ({
      domain: c.domain, name: c.name, value: c.value,
      path: c.path, secure: c.secure, httpOnly: c.httpOnly
    }));

    config.cookies = formattedCookies;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
    console.log('[AUTO-LOGIN] 💾 config.json diperbarui dengan cookie terbaru!\n');

    await browser.close();
    return { success: true, pinRequiredWithoutValue };

  } catch (err) {
    console.error(`❌ [AUTO-LOGIN] Error: ${err.message}`);
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
    return { success: false, reason: `Error: ${err.message}` };
  } finally {
    isAutoLoginRunning = false;
  }
}
