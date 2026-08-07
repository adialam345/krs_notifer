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

let browserInstance = null;
let pageInstance = null;
let isCheckRunning = false;

/**
 * Mendapatkan atau menginisialisasi single browser page instance yang persistent.
 */
async function getOrInitPage(config) {
  if (browserInstance && pageInstance && !pageInstance.isClosed()) {
    return pageInstance;
  }

  const executablePath = config?.executablePath || findChromeExecutable();
  if (!executablePath) {
    throw new Error('Executable Browser (Chrome/Chromium) tidak ditemukan di sistem!');
  }

  console.log(`[PUPPETEER] Inisialisasi headless browser: ${executablePath}`);

  if (browserInstance) {
    try { await browserInstance.close(); } catch { /* ignore */ }
  }

  browserInstance = await puppeteer.launch({
    executablePath,
    headless: true,
    pipe: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
      '--disable-extensions'
    ]
  });

  pageInstance = await browserInstance.newPage();
  await pageInstance.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  );

  return pageInstance;
}

/**
 * Melakukan pemeriksaan halaman KRS Siakad UNS menggunakan Chromium persistent.
 * Secara otomatis menangani SSO Login & PIN Bank jika diperlukan.
 */
export async function checkKrsWithPuppeteer(config) {
  if (isCheckRunning) {
    return { skipped: true, reason: 'Pengecekan sebelumnya masih berjalan.' };
  }

  isCheckRunning = true;

  try {
    const page = await getOrInitPage(config);
    let currentUrl = page.url();

    // 1. Cek jika memerlukan SSO Login
    const needsSso = currentUrl === 'about:blank' ||
                     currentUrl.includes('login') ||
                     currentUrl.includes('saml') ||
                     currentUrl.includes('sso.uns.ac.id');

    if (needsSso) {
      console.log('[AUTO-LOGIN] Membuka halaman login SSO UNS...');
      await page.goto('https://siakad.uns.ac.id/saml/login', { waitUntil: 'domcontentloaded', timeout: 35000 });

      const userInput = await page.waitForSelector('input[name="username"]', { timeout: 15000 }).catch(() => null);
      if (userInput) {
        console.log(`[AUTO-LOGIN] Mengisi kredensial SSO untuk akun: ${config.ssoUsername}`);
        await page.type('input[name="username"]', config.ssoUsername);
        await page.type('input[name="password"]', config.ssoPassword);
        await page.click('button[type="submit"]').catch(() => {});
        await new Promise(r => setTimeout(r, 4000));
      }
    }

    // 2. Navigasi ke Halaman Input KRS
    await page.goto('https://siakad.uns.ac.id/registrasi/input-krs/index', { waitUntil: 'domcontentloaded', timeout: 35000 });
    await new Promise(r => setTimeout(r, 1500));

    currentUrl = page.url();
    let html = await page.content();

    // Jika setelah navigasi krs malah terlempar ke SSO lagi, lakukan re-login sekali lagi
    if (currentUrl.includes('sso.uns.ac.id') || currentUrl.includes('saml/login')) {
      console.log('[AUTO-LOGIN] Sesi expired, melakukan login SSO ulang...');
      await page.goto('https://siakad.uns.ac.id/saml/login', { waitUntil: 'domcontentloaded', timeout: 35000 });
      const userInput = await page.waitForSelector('input[name="username"]', { timeout: 15000 }).catch(() => null);
      if (userInput) {
        await page.type('input[name="username"]', config.ssoUsername);
        await page.type('input[name="password"]', config.ssoPassword);
        await page.click('button[type="submit"]').catch(() => {});
        await new Promise(r => setTimeout(r, 4000));
        await page.goto('https://siakad.uns.ac.id/registrasi/input-krs/index', { waitUntil: 'domcontentloaded', timeout: 35000 });
        await new Promise(r => setTimeout(r, 1500));
        currentUrl = page.url();
        html = await page.content();
      }
    }

    // 3. Cek & Handle Form PIN Bank
    if ((currentUrl.includes('cek-pin') || html.includes('mhsfix-pin_baru')) && config.pinBank) {
      console.log(`[AUTO-LOGIN] Memasukkan PIN Bank (${config.pinBank})...`);
      const pinInput = await page.waitForSelector('#mhsfix-pin_baru', { timeout: 8000 }).catch(() => null);
      if (pinInput) {
        await page.type('#mhsfix-pin_baru', config.pinBank);
        await page.click('button[type="submit"]').catch(() => {});
        await new Promise(r => setTimeout(r, 3000));
        currentUrl = page.url();
        html = await page.content();
      }
    }

    // 4. Update cookies di config.json untuk keperluan backup
    try {
      const cookies = await page.cookies();
      const formatted = cookies.map(c => ({
        domain: c.domain, name: c.name, value: c.value, path: c.path, secure: c.secure, httpOnly: c.httpOnly
      }));
      config.cookies = formatted;
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
    } catch { /* ignore cookie save errors */ }

    // 5. Analisis Hasil Tampilan Halaman
    const hasLogout = html.includes('Logout');
    const isNotOpen = html.includes('Saat ini bukan jadwal input KRS') || html.includes('bukan-jadwal-krs.webp');
    const isCekPin = currentUrl.includes('cek-pin') || html.includes('mhsfix-pin_baru');
    const isKrsOpen = hasLogout && !isNotOpen && !isCekPin;

    return {
      success: true,
      currentUrl,
      htmlLength: html.length,
      hasLogout,
      isNotOpen,
      isCekPin,
      isKrsOpen
    };

  } catch (err) {
    console.error(`❌ [PUPPETEER ERROR] ${err.message}`);
    // Reset instance jika terjadi error agar bisa dire-init pada loop berikutnya
    if (browserInstance) {
      try { await browserInstance.close(); } catch { /* ignore */ }
      browserInstance = null;
      pageInstance = null;
    }
    return { success: false, reason: err.message };
  } finally {
    isCheckRunning = false;
  }
}
