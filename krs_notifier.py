import json
import time
import os
import sys
from datetime import datetime
import requests

# Set terminal encoding to UTF-8 for Windows compatibility
sys.stdout.reconfigure(encoding='utf-8')

CONFIG_FILE = "config.json"

def load_config():
    if not os.path.exists(CONFIG_FILE):
        print(f"[!] File {CONFIG_FILE} tidak ditemukan!")
        sys.exit(1)
    with open(CONFIG_FILE, "r", encoding="utf-8") as f:
        return json.load(f)

def play_alarm():
    """Memutar suara alarm di komputer lokal (Windows)"""
    try:
        import winsound
        for _ in range(5):
            winsound.Beep(1000, 500) # 1000Hz selama 500ms
            time.sleep(0.1)
    except Exception:
        print("\a") # Bell fallback

def send_whatsapp_notification(config, message):
    provider = config.get("wa_provider", "fonnte").lower()
    target = config.get("wa_target_phone", "")
    token = config.get("wa_api_token", "")

    if not target or target.startswith("628xxxxxxxxxx"):
        print("[!] Nomor WhatsApp target belum diatur di config.json!")
        return False

    print(f"[*] Mengirim notifikasi WhatsApp via {provider.upper()} ke {target}...")

    try:
        if provider == "fonnte":
            # Gateway Fonnte (https://fonnte.com)
            url = "https://api.fonnte.com/send"
            headers = {"Authorization": token}
            payload = {
                "target": target,
                "message": message,
                "countryCode": "62"
            }
            res = requests.post(url, data=payload, headers=headers, timeout=10)
            res_data = res.json()
            if res_data.get("status"):
                print("[✓] WhatsApp berhasil dikirim via Fonnte!")
                return True
            else:
                print(f"[X] Gagal kirim Fonnte: {res_data}")

        elif provider == "whacenter":
            # Gateway Whacenter (https://whacenter.com)
            url = "https://app.whacenter.com/api/send"
            payload = {
                "device_id": token,
                "number": target,
                "message": message
            }
            res = requests.post(url, data=payload, timeout=10)
            print(f"[✓] Response Whacenter: {res.text}")
            return True

        elif provider == "callmebot":
            # CallMeBot (Gratis untuk nomor pribadi)
            # URL format: https://api.callmebot.com/whatsapp.php?phone=[phone]&text=[text]&apikey=[apikey]
            url = f"https://api.callmebot.com/whatsapp.php"
            params = {
                "phone": target,
                "text": message,
                "apikey": token
            }
            res = requests.get(url, params=params, timeout=15)
            if res.status_code == 200:
                print("[✓] Notifikasi berhasil dikirim via CallMeBot!")
                return True
            else:
                print(f"[X] Gagal CallMeBot (HTTP {res.status_code}): {res.text}")

        else:
            print(f"[!] Provider WhatsApp '{provider}' tidak dikenali. Pilih: fonnte, whacenter, atau callmebot.")
    except Exception as e:
        print(f"[X] Error saat mengirim pesan WhatsApp: {e}")
    
    return False

def check_krs():
    config = load_config()
    url = config.get("url", "https://siakad.uns.ac.id/registrasi/input-krs/index")
    cookies = config.get("cookies", {})
    interval = config.get("check_interval_seconds", 10)

    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7'
    }

    print("==================================================")
    print("      🚀 NOTIFIER JADWAL KRS SIAKAD UNS 🚀      ")
    print("==================================================")
    print(f"Target URL: {url}")
    print(f"Interval Check: Setiap {interval} detik")
    print("Monitoring dimulai... (Tekan Ctrl+C untuk berhenti)\n")

    alert_sent = False
    session_expired_alerted = False

    while True:
        timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        try:
            res = requests.get(url, headers=headers, cookies=cookies, timeout=15, allow_redirects=True)
            
            # 1. Cek apakah session/cookie kedaluwarsa
            if "login" in res.url.lower() or "Logout" not in res.text:
                print(f"[{timestamp}] ⚠️ WARNING: Cookie/Session Siakad sepertinya sudah EXPIRED (di-redirect ke login page)!")
                if not session_expired_alerted:
                    send_whatsapp_notification(
                        config, 
                        f"⚠️ [KRS NOTIFIER]\nCookie / Session Siakad kamu sudah Expired!\nHarap update cookie di config.json."
                    )
                    session_expired_alerted = True
            else:
                session_expired_alerted = False

                # 2. Analisis indikator jadwal KRS
                # Indikator belum mulai: Terdapat teks "Saat ini bukan jadwal input KRS" atau gambar "bukan-jadwal-krs.webp"
                is_not_open = ("Saat ini bukan jadwal input KRS" in res.text) or ("bukan-jadwal-krs.webp" in res.text)

                if is_not_open:
                    print(f"[{timestamp}] ⏳ KRS BELUM MULAI (Status: Bukan Jadwal Input KRS)")
                    alert_sent = False # Reset flag jika status kembali belum mulai
                else:
                    print(f"[{timestamp}] 🎉 PERHATIAN: KRS SUDAH DIMULAI / ADA PERUBAHAN TAMPILAN HALAMAN!")
                    play_alarm()
                    
                    if not alert_sent:
                        msg = (
                            f"🚨 [ALERT KRS UNTUK MAHASISWA]\n\n"
                            f"⚡ KRS SUDAH DIMULAI ATAU TERJADI PERUBAHAN PADA SIAKAD!\n"
                            f"Waktu: {timestamp}\n"
                            f"Segera buka Siakad: {url}\n\n"
                            f"Semoga dapet matkul idaman! 🎯"
                        )
                        send_whatsapp_notification(config, msg)
                        alert_sent = True # Supaya tidak spam pesan terus menerus

        except requests.RequestException as req_err:
            print(f"[{timestamp}] ❌ Gagal koneksi ke server: {req_err}")
        except Exception as err:
            print(f"[{timestamp}] ❌ Error tidak terduga: {err}")

        time.sleep(interval)

if __name__ == "__main__":
    check_krs()
