# 🚀 SIAKAD UNS KRS Notifier + Auto-Login (Baileys WA Gateway)

Script otomatis Node.js menggunakan **Baileys** (`@whiskeysockets/baileys`) & **Puppeteer-Core** untuk memantau status Input KRS di **SIAKAD UNS** (`https://siakad.uns.ac.id/registrasi/input-krs/index`) dilengkapi penanganan error & notifikasi WA otomatis.

---

## 🔥 Fitur Unggulan
1. **Baileys WA Gateway**: Notifikasi dikirim langsung via WhatsApp Anda (100% Gratis).
2. **Auto-Login SSO UNS**: Ketika cookie kedaluwarsa, script akan otomatis login sendiri ke **SSO UNS** (`sso.uns.ac.id`) menggunakan Headless Browser dan memperbarui cookie di `config.json` secara otomatis.
3. **Penanganan Error Komprehensif**:
   - 🌐 **Server Down / HTTP 5xx / Timed Out**: Mengirim notifikasi WA jika server Siakad down lebih dari 3 kali berturut-turut, dan mengirim notifikasi *Recovery* saat server kembali normal.
   - ❌ **Gagal Auto-Login**: Mengirim notifikasi WA jika password salah / captcha dipicu.
   - 🔑 **Permintaan PIN Bank**: Mengirim notifikasi WA jika Siakad meminta PIN Bank.
   - 🛡️ **Anti-Crash**: Dilengkapi Global Exception Handler agar script tidak mati walaupun ada koneksi terputus tiba-tiba.
4. **Mendukung VPS Debian 12**: Berjalan 24/7 non-stop di VPS Linux maupun PC Lokal Windows.

---

## ⚙️ Pengaturan di `config.json`

```json
{
  "targetUrl": "https://siakad.uns.ac.id/registrasi/input-krs/index",
  "checkIntervalSeconds": 10,
  "targetPhone": "6289603036419",
  "ssoUsername": "meirisna_16@student.uns.ac.id",
  "ssoPassword": "Octaviaalya16",
  "pinBank": "",
  "cookies": [ ... ]
}
```

---

## 🚀 Cara Menjalankan Script

Jalankan di terminal:

```bash
npm start
```

- Jika baru pertama kali / belum login WA, scan **QR Code** di terminal via WhatsApp -> Perangkat Tertaut.
- Setelah terhubung, monitoring akan berjalan otomatis.
