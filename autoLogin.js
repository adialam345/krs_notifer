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

export async function performAutoLogin() {
  console.log('\n[🔄 AUTO-LOGIN] Memulai proses login otomatis ke SSO UNS...');

  if (!fs.existsSync(CONFIG_FILE)) {
    return { success: false, reason: 'File config.json tidak ditemukan' };
  }

  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
  const username = config.ssoUsername;
  const password = config.ssoPassword;

  if (!username || !password || username.includes('EMAIL_UNS_ANDA')) {
    return { success: false, reason: 'Kredensial ssoUsername/ssoPassword belum diisi di config.json' };
  }

  const executablePath = config.executablePath || findChromeExecutable();
  if (!executablePath) {
    const errorMsg = 'Executable Browser (Chrome/Edge/Chromium) tidak ditemukan di sistem!';
    console.error(`❌ [AUTO-LOGIN] ${errorMsg}`);
    return { success: false, reason: errorMsg };
  }

  console.log(`[AUTO-LOGIN] Menggunakan browser: ${executablePath}`);

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    console.log('[AUTO-LOGIN] Membuka halaman login SAML SSO UNS...');
    await page.goto('https://siakad.uns.ac.id/saml/login', { waitUntil: 'networkidle2', timeout: 35000 });

    // Tunggu input username & password SSO
    await page.waitForSelector('input[name="username"]', { timeout: 15000 });
    await page.waitForSelector('input[name="password"]', { timeout: 15000 });

    console.log(`[AUTO-LOGIN] Mengisi kredensial untuk akun: ${username}`);
    await page.type('input[name="username"]', username);
    await page.type('input[name="password"]', password);

    console.log('[AUTO-LOGIN] Menekan tombol Masuk...');
    await page.click('button[type="submit"]').catch(() => {});

    // Polling tunggu redirect dari SAML SSO ke SIAKAD selesai (maks 15 detik)
    for (let i = 0; i < 15; i++) {
      await new Promise(r => setTimeout(r, 1000));
      const currentUrl = page.url();
      if (currentUrl.includes('siakad.uns.ac.id') && !currentUrl.includes('saml/login')) {
        break;
      }
    }

    const currentUrl = page.url();
    console.log(`[AUTO-LOGIN] URL setelah login: ${currentUrl}`);

    if (currentUrl.includes('sso.uns.ac.id')) {
      const pageText = await page.content();
      let failReason = 'Username atau Password SSO UNS salah!';
      if (pageText.includes('Captcha') || pageText.includes('captcha')) {
        failReason = 'SSO UNS meminta Verifikasi Captcha.';
      }
      console.error(`❌ [AUTO-LOGIN] Gagal Login SSO: ${failReason}`);
      await browser.close();
      return { success: false, reason: failReason };
    }

    console.log('[AUTO-LOGIN] Menavigasi ke halaman Input KRS untuk mengaktifkan sesi...');
    await page.goto('https://siakad.uns.ac.id/registrasi/input-krs/index', { waitUntil: 'networkidle2', timeout: 35000 });

    let pinRequiredWithoutValue = false;
    if (page.url().includes('cek-pin-krs') || (await page.$('#mhsfix-pin_baru'))) {
      if (config.pinBank) {
        console.log('[AUTO-LOGIN] Menemukan form PIN Bank, mengisi PIN Bank...');
        await page.type('#mhsfix-pin_baru', config.pinBank);
        await Promise.all([
          page.click('button[type="submit"]'),
          page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 35000 })
        ]);
      } else {
        console.log('ℹ️ [AUTO-LOGIN] Halaman memerlukan PIN Bank. Jika ada, isi "pinBank" di config.json.');
        pinRequiredWithoutValue = true;
      }
    }

    // Ambil cookies terbaru dari browser
    const cookies = await page.cookies();
    console.log(`[AUTO-LOGIN] ✅ Login Berhasil! Mendapatkan ${cookies.length} cookies.`);

    // Map cookies ke format config.json
    const formattedCookies = cookies.map(c => ({
      domain: c.domain,
      name: c.name,
      value: c.value,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly
    }));

    // Update config.json
    config.cookies = formattedCookies;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
    console.log('[AUTO-LOGIN] 💾 config.json berhasil diperbarui dengan cookie terbaru!\n');

    await browser.close();
    return { success: true, pinRequiredWithoutValue };

  } catch (err) {
    console.error(`❌ [AUTO-LOGIN] Error saat auto-login: ${err.message}`);
    if (browser) await browser.close();
    return { success: false, reason: `Error: ${err.message}` };
  }
}
