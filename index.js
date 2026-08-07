import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import axios from 'axios';
import fs from 'fs';
import { performAutoLogin } from './autoLogin.js';

const CONFIG_FILE = './config.json';
let waSock = null;
let isMonitoringStarted = false;
let isAlertSent = false;
let isAutoLoggingIn = false;

// Error Tracking & Rate Limiting
let consecutiveErrors = 0;
let isServerDownAlertSent = false;
let isAutoLoginFailAlertSent = false;
let isPinRequiredAlertSent = false;
let lastErrorWaSentTime = 0;
let lastHourlyStatusWaSentTime = Date.now();
const ERROR_WA_COOL_DOWN_MS = 15 * 60 * 1000; // Minimal 15 menit antar pesan error sejenis untuk cegah spam
const HOURLY_STATUS_INTERVAL_MS = 60 * 60 * 1000; // 1 Jam untuk update status rutin

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    console.error(`[!] File ${CONFIG_FILE} tidak ditemukan!`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
}

function getCookieString(cookies) {
  if (Array.isArray(cookies)) {
    return cookies.map(c => `${c.name}=${c.value}`).join('; ');
  } else if (typeof cookies === 'object') {
    return Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  }
  return '';
}

function formatJid(phone) {
  let cleaned = phone.replace(/[^0-9]/g, '');
  if (cleaned.startsWith('0')) {
    cleaned = '62' + cleaned.slice(1);
  }
  return `${cleaned}@s.whatsapp.net`;
}

function getTargetPhones(config) {
  if (Array.isArray(config.targetPhones)) {
    return config.targetPhones.filter(p => p && !p.includes('8xxxxxxxxxx'));
  }
  if (Array.isArray(config.targetPhone)) {
    return config.targetPhone.filter(p => p && !p.includes('8xxxxxxxxxx'));
  }
  if (config.targetPhone && typeof config.targetPhone === 'string' && !config.targetPhone.includes('8xxxxxxxxxx')) {
    return [config.targetPhone];
  }
  return [];
}

async function sendWaMessage(message) {
  const config = loadConfig();
  const targetPhones = getTargetPhones(config);

  if (targetPhones.length === 0) {
    console.log('⚠️ [WA] Belum ada nomor HP target yang diatur di config.json (targetPhones)');
    return false;
  }

  let sentCount = 0;
  if (waSock && waSock.user) {
    for (const phone of targetPhones) {
      const jid = formatJid(phone);
      try {
        await waSock.sendMessage(jid, { text: message });
        console.log(`[✓] Notifikasi WA berhasil terkirim ke ${phone}`);
        sentCount++;
      } catch (err) {
        console.error(`[X] Gagal mengirim pesan WA ke ${phone}: ${err.message}`);
      }
    }
  } else {
    console.error('[X] Socket WhatsApp belum terhubung / belum siap');
  }
  return sentCount > 0;
}

async function checkKrsStatus() {
  if (isAutoLoggingIn) return;

  const config = loadConfig();
  const url = config.targetUrl || 'https://siakad.uns.ac.id/registrasi/input-krs/index';
  const cookieHeader = getCookieString(config.cookies);
  const timestamp = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cookie': cookieHeader
  };

  try {
    const res = await axios.get(url, {
      headers,
      maxRedirects: 5,
      validateStatus: () => true,
      timeout: 20000
    });

    const html = res.data || '';
    const finalUrl = res.request?.res?.responseUrl || url;
    const statusCode = res.status;

    // Reset error counter jika berhasil mendapat respon HTTP 200/302 normal
    if (statusCode < 500) {
      if (isServerDownAlertSent) {
        console.log(`[${timestamp}] ✅ RECOVERY: Server Siakad kembali responsif!`);
        await sendWaMessage(`✅ [RECOVERY]\n\nServer Siakad UNS sudah kembali online & responsif (HTTP ${statusCode}). Monitoring berlanjut...`);
        isServerDownAlertSent = false;
      }
      consecutiveErrors = 0;
    }

    // 1. Cek jika HTTP status code server error (500, 502, 503, 504)
    if (statusCode >= 500) {
      consecutiveErrors++;
      console.log(`[${timestamp}] ⚠️ SERVER ERROR (HTTP ${statusCode}). Upaya gagal ke-${consecutiveErrors}`);
      if (consecutiveErrors >= 3 && !isServerDownAlertSent) {
        await sendWaMessage(
          `⚠️ [SERVER ERROR]\n\nServer Siakad UNS mengalami gangguan/down (HTTP ${statusCode}).\nScript akan terus memantau hingga server pulih kembali.`
        );
        isServerDownAlertSent = true;
      }
      return;
    }

    // 2. Cek Cookie / Session Expired / Form PIN Bank Prompt
    const isLoginPage = finalUrl.toLowerCase().includes('login') ||
                        finalUrl.toLowerCase().includes('cek-pin') ||
                        html.includes('mhsfix-pin_baru') ||
                        !html.includes('Logout');

    if (isLoginPage) {
      console.log(`[${timestamp}] ⚠️ WARNING: Cookie/Session Siakad EXPIRED (di-redirect ke login)!`);

      if (config.ssoUsername && config.ssoPassword && !config.ssoUsername.includes('EMAIL_UNS_ANDA')) {
        isAutoLoggingIn = true;
        console.log(`[${timestamp}] 🔄 Memulai Auto-Login via Puppeteer...`);
        const loginResult = await performAutoLogin();
        isAutoLoggingIn = false;

        if (loginResult.success) {
          console.log(`[${timestamp}] 🎉 Auto-Login BERHASIL! Re-checking status KRS...`);
          isAutoLoginFailAlertSent = false;

          if (loginResult.pinRequiredWithoutValue && !isPinRequiredAlertSent) {
            await sendWaMessage(
              `ℹ️ [PIN BANK REQUIRED]\n\nAuto-login berhasil, tetapi Siakad meminta PIN Bank!\nSilakan isi field 'pinBank' pada config.json agar auto-login dapat memasukkan PIN Bank secara otomatis.`
            );
            isPinRequiredAlertSent = true;
          }

          return checkKrsStatus(); // Langsung periksa ulang dengan cookie baru
        } else {
          console.error(`[${timestamp}] ❌ Auto-Login GAGAL: ${loginResult.reason}`);
          const now = Date.now();
          if (!isAutoLoginFailAlertSent || (now - lastErrorWaSentTime > ERROR_WA_COOL_DOWN_MS)) {
            await sendWaMessage(
              `❌ [AUTO-LOGIN GAGAL]\n\nGagal melakukan login otomatis ke SSO UNS!\nAlasan: ${loginResult.reason}\n\nMohon periksa kembali username/password di config.json.`
            );
            isAutoLoginFailAlertSent = true;
            lastErrorWaSentTime = now;
          }
        }
      } else {
        const now = Date.now();
        if (now - lastErrorWaSentTime > ERROR_WA_COOL_DOWN_MS) {
          await sendWaMessage(
            `⚠️ [COOKIE EXPIRED]\n\nCookie Siakad kamu sudah kedaluwarsa!\nSebab ssoUsername/ssoPassword belum diisi di config.json, mohon perbarui cookie manual atau isi kredensial SSO.`
          );
          lastErrorWaSentTime = now;
        }
      }
      return;
    }

    // 3. Cek Indikator Jadwal KRS
    const isNotOpen = html.includes('Saat ini bukan jadwal input KRS') || html.includes('bukan-jadwal-krs.webp');

    if (isNotOpen) {
      console.log(`[${timestamp}] ⏳ KRS BELUM MULAI (Status: Bukan Jadwal Input KRS)`);
      isAlertSent = false;

      const now = Date.now();
      if (now - lastHourlyStatusWaSentTime >= HOURLY_STATUS_INTERVAL_MS) {
        lastHourlyStatusWaSentTime = now;
        await sendWaMessage(
          `ℹ️ [STATUS UPDATE - SIAKAD NOTIFIER]\n\n` +
          `Waktu: ${timestamp}\n` +
          `Status: ⏳ KRS Belum Mulai (Bukan Jadwal Input KRS).\n\n` +
          `Bot tetap aktif & memantau Siakad UNS setiap ${config.checkIntervalSeconds || 10} detik.`
        );
      }
    } else {
      console.log(`[${timestamp}] 🎉 PERHATIAN: KRS SUDAH DIMULAI / ADA PERUBAHAN TAMPILAN HALAMAN!`);
      process.stdout.write('\x07'); // Beep sound

      if (!isAlertSent) {
        const msg = (
          `🚨 [ALERT KRS SIAKAD UNS]\n\n` +
          `⚡ KRS SUDAH DIMULAI ATAU TERJADI PERUBAHAN TAMPILAN HALAMAN!\n` +
          `Waktu: ${timestamp}\n` +
          `Link Siakad: ${url}\n\n` +
          `Segera login & ambil mata kuliah pilihanmu! 🎯`
        );
        await sendWaMessage(msg);
        isAlertSent = true;
      }
    }

  } catch (err) {
    consecutiveErrors++;
    const errMsg = err.message || err.toString();
    console.error(`[${timestamp}] ❌ Error HTTP / Koneksi: ${errMsg} (Gagal ke-${consecutiveErrors})`);

    if (consecutiveErrors >= 3 && !isServerDownAlertSent) {
      await sendWaMessage(
        `⚠️ [KONEKSI GAGAL]\n\nGagal terhubung ke Siakad UNS (${errMsg}).\nScript tetap berjalan dan akan terus mencoba ulang.`
      );
      isServerDownAlertSent = true;
    }
  }
}

async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

  waSock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false
  });

  waSock.ev.on('creds.update', saveCreds);

  waSock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n==================================================');
      console.log('  📱 SCAN QR CODE DENGAN WHATSAPP ANDA');
      console.log('==================================================\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`[WA] Koneksi terputus (Status: ${statusCode}). Reconnecting: ${shouldReconnect}`);

      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 5000);
      } else {
        console.log('[WA] Sesi WhatsApp logout. Hapus folder auth_info_baileys untuk scan ulang.');
      }
    } else if (connection === 'open') {
      console.log('\n==================================================');
      console.log('  ✅ WHATSAPP BERHASIL TERHUBUNG VIA BAILEYS!');
      console.log('==================================================\n');

      if (!isMonitoringStarted) {
        isMonitoringStarted = true;
        const config = loadConfig();
        const interval = (config.checkIntervalSeconds || 10) * 1000;

        console.log(`🔍 Monitoring Siakad UNS dimulai setiap ${config.checkIntervalSeconds || 10} detik...`);
        console.log(`Target Phone(s): ${getTargetPhones(config).join(', ')}\n`);

        sendWaMessage(
          `🤖 [BOT NOTIFIER AKTIF]\n\n` +
          `Bot KRS UNS Notifier berhasil terhubung & aktif!\n` +
          `Pengecekan KRS: Setiap ${config.checkIntervalSeconds || 10} detik.\n` +
          `Laporan Status: Dikirim ke WA ini setiap 1 jam.`
        );

        // Run initial check
        checkKrsStatus();

        // Interval loop
        setInterval(checkKrsStatus, interval);
      }
    }
  });
}

// Global Exception Handler agar script tidak crash jika ada error tak terduga
process.on('uncaughtException', async (err) => {
  console.error('[CRITICAL] Uncaught Exception:', err);
  await sendWaMessage(`💥 [SYSTEM ERROR]\n\nTerjadi kesalahan tak terduga pada script: ${err.message}\nScript tetap berusaha mempertahankan proses.`);
});

process.on('unhandledRejection', async (reason) => {
  console.error('[CRITICAL] Unhandled Rejection:', reason);
});

connectToWhatsApp();
