import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import fs from 'fs';
import { checkKrsWithPuppeteer } from './autoLogin.js';

const CONFIG_FILE = './config.json';
let waSock = null;
let isMonitoringStarted = false;
let isAlertSent = false;

// Error Tracking & Rate Limiting
let isServerDownAlertSent = false;
let lastErrorWaSentTime = 0;
let lastHourlyStatusWaSentTime = Date.now();
const ERROR_WA_COOL_DOWN_MS = 15 * 60 * 1000; // Minimal 15 menit antar pesan error sejenis
const HOURLY_STATUS_INTERVAL_MS = 60 * 60 * 1000; // 1 Jam untuk update status rutin

function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    console.error(`[!] File ${CONFIG_FILE} tidak ditemukan!`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
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
  const config = loadConfig();
  const timestamp = new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' });

  const result = await checkKrsWithPuppeteer(config);

  if (result.skipped) return;

  if (!result.success) {
    const now = Date.now();
    console.error(`[${timestamp}] ❌ Error Pengecekan Siakad: ${result.reason}`);
    if (now - lastErrorWaSentTime > ERROR_WA_COOL_DOWN_MS) {
      await sendWaMessage(`⚠️ [KONEKSI/LOGIN SIAKAD GAGAL]\n\nError: ${result.reason}\nBot akan terus mencoba ulang.`);
      lastErrorWaSentTime = now;
    }
    return;
  }

  if (result.isCekPin) {
    console.log(`[${timestamp}] ⏳ Halaman PIN Bank (sudah login, menunggu PIN). Status: Belum bisa akses KRS.`);
    isAlertSent = false;
  } else if (result.isNotOpen) {
    console.log(`[${timestamp}] ⏳ KRS BELUM MULAI (Status: Bukan Jadwal Input KRS)`);
    isAlertSent = false;

    const now = Date.now();
    if (now - lastHourlyStatusWaSentTime >= HOURLY_STATUS_INTERVAL_MS) {
      lastHourlyStatusWaSentTime = now;
      await sendWaMessage(
        `ℹ️ [STATUS UPDATE]\n\nWaktu: ${timestamp}\nStatus: KRS Belum Dimulai (Bukan Jadwal Input KRS).\nBot tetap aktif memantau setiap ${config.checkIntervalSeconds || 10} detik.`
      );
    }
  } else if (result.isKrsOpen) {
    console.log(`[${timestamp}] 🎉 PERHATIAN: KRS SUDAH DIMULAI / ADA PERUBAHAN TAMPILAN HALAMAN!`);
    process.stdout.write('\x07');

    if (!isAlertSent) {
      const targetUrl = config.targetUrl || 'https://siakad.uns.ac.id/registrasi/input-krs/index';
      const msg = (
        `🚨 [ALERT KRS SIAKAD UNS]\n\n` +
        `⚡ KRS SUDAH DIMULAI ATAU TERJADI PERUBAHAN TAMPILAN HALAMAN!\n` +
        `Waktu: ${timestamp}\n` +
        `Link Siakad: ${targetUrl}\n\n` +
        `Segera login & ambil mata kuliah pilihanmu! 🎯`
      );
      await sendWaMessage(msg);
      isAlertSent = true;
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
