import axios from 'axios';
import fs from 'fs';

const CONFIG_FILE = './config.json';
let isAutoLoginRunning = false;

/**
 * Auto-login ke SSO UNS via HTTP murni (tanpa browser/Puppeteer).
 * Flow SAML: Siakad → SSO Form → POST Credentials → SAMLResponse → Siakad ACS → Cookies!
 */
export async function performAutoLogin() {
  if (isAutoLoginRunning) {
    console.log('[AUTO-LOGIN] ⏳ Sedang berjalan, skip.');
    return { success: false, reason: 'Auto-login sedang berjalan' };
  }

  isAutoLoginRunning = true;
  console.log('\n[🔄 AUTO-LOGIN] Memulai login SSO UNS via HTTP...');

  try {
    if (!fs.existsSync(CONFIG_FILE)) {
      return { success: false, reason: 'config.json tidak ditemukan' };
    }

    const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    const { ssoUsername: username, ssoPassword: password, pinBank } = config;

    if (!username || !password || username.includes('EMAIL_UNS_ANDA')) {
      return { success: false, reason: 'Kredensial SSO belum diisi di config.json' };
    }

    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    const cookieJar = {};

    // ═══ STEP 1: GET /saml/login → redirect ke SSO IdP (manual redirect) ═══
    console.log('[AUTO-LOGIN] Step 1: Memulai SAML redirect chain...');

    const step1 = await axios.get('https://siakad.uns.ac.id/saml/login', {
      headers: { 'User-Agent': UA },
      maxRedirects: 0,
      validateStatus: () => true,
      timeout: 20000
    });
    collectCookies(cookieJar, step1);

    // Follow redirect ke SSO IdP
    const idpUrl = step1.headers.location;
    if (!idpUrl) {
      return { success: false, reason: 'Tidak ada redirect dari /saml/login' };
    }

    const step2 = await axios.get(idpUrl, {
      headers: { 'User-Agent': UA, 'Cookie': buildCookieString(cookieJar) },
      maxRedirects: 0,
      validateStatus: () => true,
      timeout: 20000
    });
    collectCookies(cookieJar, step2);

    // Follow redirect ke login form page
    const loginFormUrl = step2.headers.location;
    if (!loginFormUrl) {
      return { success: false, reason: 'Tidak ada redirect ke form login SSO' };
    }

    const resolvedLoginUrl = new URL(loginFormUrl, idpUrl).toString();
    const step3 = await axios.get(resolvedLoginUrl, {
      headers: { 'User-Agent': UA, 'Cookie': buildCookieString(cookieJar) },
      maxRedirects: 0,
      validateStatus: () => true,
      timeout: 20000
    });
    collectCookies(cookieJar, step3);

    // Parse AuthState dari form
    const authStateMatch = step3.data.match(/name="AuthState"\s+value="([^"]+)"/);
    if (!authStateMatch) {
      return { success: false, reason: 'Gagal menemukan AuthState di form SSO.' };
    }
    const authState = decodeHtmlEntities(authStateMatch[1]);
    console.log('[AUTO-LOGIN] Step 1: ✅ Form SSO ditemukan.');

    // ═══ STEP 2: POST credentials ke SSO ═══
    console.log(`[AUTO-LOGIN] Step 2: Login sebagai ${username}...`);

    const postUrl = resolvedLoginUrl.split('?')[0];
    const step4 = await axios.post(postUrl, new URLSearchParams({
      username,
      password,
      AuthState: authState
    }).toString(), {
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': buildCookieString(cookieJar),
        'Referer': resolvedLoginUrl
      },
      maxRedirects: 0,
      validateStatus: () => true,
      timeout: 20000
    });
    collectCookies(cookieJar, step4);

    let samlHtml = step4.data;

    // Cek login gagal (masih di form login)
    if (step4.status === 200 && samlHtml.includes('name="username"') && !samlHtml.includes('SAMLResponse')) {
      return { success: false, reason: 'Username atau Password SSO salah!' };
    }

    // Ikuti redirect jika status 302
    if (step4.status >= 300 && step4.status < 400 && step4.headers.location) {
      const redirectUrl = new URL(step4.headers.location, postUrl).toString();
      const step4b = await axios.get(redirectUrl, {
        headers: { 'User-Agent': UA, 'Cookie': buildCookieString(cookieJar) },
        maxRedirects: 5,
        validateStatus: () => true,
        timeout: 20000
      });
      collectCookies(cookieJar, step4b);
      samlHtml = step4b.data;
    }

    console.log('[AUTO-LOGIN] Step 2: ✅ Credentials diterima.');

    // ═══ STEP 3: Parse SAMLResponse & POST ke Siakad ACS ═══
    console.log('[AUTO-LOGIN] Step 3: Memproses SAML response...');

    const samlResponseMatch = samlHtml.match(/name="SAMLResponse"\s+value="([^"]+)"/);
    const relayStateMatch = samlHtml.match(/name="RelayState"\s+value="([^"]+)"/);
    const actionMatch = samlHtml.match(/action="([^"]+)"/);

    if (!samlResponseMatch || !actionMatch) {
      return { success: false, reason: 'Gagal parse SAMLResponse.' };
    }

    const samlResponse = samlResponseMatch[1];
    const relayState = relayStateMatch ? decodeHtmlEntities(relayStateMatch[1]) : '';
    const acsUrl = decodeHtmlEntities(actionMatch[1]);

    const postData = new URLSearchParams({ SAMLResponse: samlResponse });
    if (relayState) postData.append('RelayState', relayState);

    const step5 = await axios.post(acsUrl, postData.toString(), {
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': buildCookieString(cookieJar)
      },
      maxRedirects: 0,
      validateStatus: () => true,
      timeout: 20000
    });
    collectCookies(cookieJar, step5);

    // Follow redirect chain dari ACS
    let loc = step5.headers.location || '';
    for (let i = 0; i < 5 && loc; i++) {
      const resolved = new URL(loc, acsUrl).toString();
      const r = await axios.get(resolved, {
        headers: { 'User-Agent': UA, 'Cookie': buildCookieString(cookieJar) },
        maxRedirects: 0,
        validateStatus: () => true,
        timeout: 20000
      });
      collectCookies(cookieJar, r);
      loc = r.headers.location || '';
    }

    console.log('[AUTO-LOGIN] Step 3: ✅ SAML berhasil diproses, cookies Siakad didapatkan!');

    // ═══ STEP 4: Akses halaman Input KRS ═══
    console.log('[AUTO-LOGIN] Step 4: Mengakses halaman Input KRS...');

    const krsRes = await axios.get('https://siakad.uns.ac.id/registrasi/input-krs/index', {
      headers: { 'User-Agent': UA, 'Cookie': buildCookieString(cookieJar) },
      maxRedirects: 5,
      validateStatus: () => true,
      timeout: 20000
    });
    collectCookies(cookieJar, krsRes);

    const krsUrl = krsRes.request?.res?.responseUrl || '';
    const krsHtml = krsRes.data || '';

    // ═══ STEP 5: Handle PIN Bank ═══
    let pinRequiredWithoutValue = false;

    if (krsUrl.includes('cek-pin') || krsHtml.includes('mhsfix-pin_baru')) {
      if (pinBank) {
        console.log(`[AUTO-LOGIN] Step 5: Mengisi PIN Bank (${pinBank})...`);
        const csrfMatch = krsHtml.match(/name="_csrf"\s+value="([^"]+)"/);
        const csrfToken = csrfMatch ? csrfMatch[1] : '';

        const pinRes = await axios.post(
          'https://siakad.uns.ac.id/registrasi/biodata/cek-pin-krs',
          new URLSearchParams({ _csrf: csrfToken, 'MhsFix[pin_baru]': pinBank }).toString(),
          {
            headers: {
              'User-Agent': UA,
              'Content-Type': 'application/x-www-form-urlencoded',
              'Cookie': buildCookieString(cookieJar),
              'Referer': krsUrl
            },
            maxRedirects: 5,
            validateStatus: () => true,
            timeout: 20000
          }
        );
        collectCookies(cookieJar, pinRes);

        // Re-akses input-krs setelah PIN Bank dikirim agar cookies final
        const krsRes2 = await axios.get('https://siakad.uns.ac.id/registrasi/input-krs/index', {
          headers: { 'User-Agent': UA, 'Cookie': buildCookieString(cookieJar) },
          maxRedirects: 5,
          validateStatus: () => true,
          timeout: 20000
        });
        collectCookies(cookieJar, krsRes2);

        console.log('[AUTO-LOGIN] Step 5: ✅ PIN Bank dikirim.');
      } else {
        console.log('ℹ️ [AUTO-LOGIN] PIN Bank diperlukan. Isi "pinBank" di config.json.');
        pinRequiredWithoutValue = true;
      }
    }

    // ═══ STEP 6: Simpan cookies ═══
    const formattedCookies = Object.values(cookieJar)
      .filter(c => c.domain && c.domain.includes('uns.ac.id'))
      .map(c => ({
        domain: c.domain, name: c.name, value: c.value,
        path: c.path || '/', secure: c.secure || false, httpOnly: c.httpOnly || false
      }));

    config.cookies = formattedCookies;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
    console.log(`[AUTO-LOGIN] 💾 ${formattedCookies.length} cookies disimpan ke config.json!\n`);

    return { success: true, pinRequiredWithoutValue };

  } catch (err) {
    console.error(`❌ [AUTO-LOGIN] Error: ${err.message}`);
    return { success: false, reason: `Error: ${err.message}` };
  } finally {
    isAutoLoginRunning = false;
  }
}

// ═══ HELPER FUNCTIONS ═══

function collectCookies(jar, response) {
  const setCookies = response.headers['set-cookie'];
  if (!setCookies) return;
  const arr = Array.isArray(setCookies) ? setCookies : [setCookies];
  for (const raw of arr) {
    const parts = raw.split(';').map(s => s.trim());
    const [nameVal, ...attrs] = parts;
    const eqIdx = nameVal.indexOf('=');
    if (eqIdx < 0) continue;
    const name = nameVal.substring(0, eqIdx);
    const value = nameVal.substring(eqIdx + 1);
    let domain = '', path = '/', secure = false, httpOnly = false;
    for (const attr of attrs) {
      const lower = attr.toLowerCase();
      if (lower.startsWith('domain=')) domain = attr.substring(7).replace(/^\./, '');
      if (lower.startsWith('path=')) path = attr.substring(5) || '/';
      if (lower === 'secure') secure = true;
      if (lower === 'httponly') httpOnly = true;
    }
    if (!domain) {
      try { domain = new URL(response.config.url).hostname; } catch { domain = 'siakad.uns.ac.id'; }
    }
    jar[`${domain}:${name}`] = { name, value, domain, path, secure, httpOnly };
  }
}

function buildCookieString(jar) {
  return Object.values(jar).map(c => `${c.name}=${c.value}`).join('; ');
}

function decodeHtmlEntities(str) {
  return str.replace(/&amp;/g, '&').replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>').replace(/&quot;/g, '"')
            .replace(/&#039;/g, "'");
}
