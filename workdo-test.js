// 手動測試腳本
// 模擬「有上班卡、沒下班卡」情境，下班時間設為 2 分鐘後
// 用法：node workdo-test.js

const { chromium } = require('./node_modules/playwright');
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const fs   = require('fs');
const path = require('path');

const LOGIN_URL      = 'https://www.workdo.co/Login?userLang=zh_TW';
const ATTENDANCE_URL = 'https://www.workdo.co/!#/aa7x48qm/aa7x48qm/C/ccn?cp=%2FCCN002W%2FCreate002W4';
const STATE_FILE     = path.join(__dirname, 'workdo-state.json');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function log(msg) {
    const t = new Date().toLocaleTimeString('zh-TW');
    console.log(`[${t}] ${msg}`);
}

function todayStr() {
    return new Date().toISOString().slice(0, 10);
}

function loadState() {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
    catch { return {}; }
}

function saveState(state) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function loadConfig() {
    const res = await fetch('http://localhost:8765/config');
    if (!res.ok) throw new Error(`Config server 回應 ${res.status}`);
    return res.json();
}

async function sendTelegram(token, chatId, text) {
    log(`送出 Telegram：${text.replace(/<[^>]+>/g, '')}`);
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
    });
    log(`Telegram 回應 ${res.status}`);
}

async function waitForFrame(page, urlSubstr, timeout = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        const frame = page.frames().find(f => f.url().includes(urlSubstr));
        if (frame) return frame;
        await sleep(500);
    }
    throw new Error(`等待 iframe(${urlSubstr}) 逾時`);
}

async function main() {
    const today = todayStr();

    // 清掉今天的 state，強制重新執行
    const state = loadState();
    delete state[`wd_evening_${today}`];
    delete state[`wd_lvs_checked_${today}`];
    delete state[`wd_has_leave_${today}`];
    saveState(state);
    log('✅ 已清除今天的 state 快取');

    const config = await loadConfig();
    const { TELEGRAM_BOT_TOKEN: tgToken, TELEGRAM_CHAT_ID: tgChatId,
            WORKDO_EMAIL: email, WORKDO_PASSWORD: pwd } = config;

    log('啟動瀏覽器...');
    let browserClosed = false;
    const browser = await chromium.launch({ headless: true, executablePath: CHROME_PATH });
    const context = await browser.newContext({
        geolocation: { latitude: 22.649368, longitude: 120.303737, accuracy: 50 },
        permissions: ['geolocation']
    });
    const page = await context.newPage();

    try {
        // 登入
        await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
        log('登入中...');
        await page.waitForSelector('input[name="loginEmail"]', { timeout: 15000 });
        const emailTab = page.locator('#LoginTabs li:first-child a');
        if (await emailTab.count()) await emailTab.click();
        await sleep(300);
        await page.fill('input[name="loginEmail"]', email);
        await page.fill('input[name="password"]',   pwd);
        await sleep(400);
        await page.locator('#email button.btn-login').click();
        await page.waitForURL(url => !url.toString().includes('/Login'), { timeout: 20000 });
        log('登入成功');

        // 出勤頁
        await page.goto(ATTENDANCE_URL, { waitUntil: 'domcontentloaded' });
        await sleep(4000);
        const ccnFrame = await waitForFrame(page, 'ccnaweb', 20000);
        try { await ccnFrame.waitForSelector('img[src*="ic-clockin"]', { timeout: 10000 }); }
        catch { log('⚠️ 等待打卡區塊逾時，嘗試繼續'); }

        // 解析實際上班時間
        const info = await ccnFrame.evaluate(() => {
            const result = { clockInTime: null, clockOutTime: null };
            const clockInRow = document.querySelector('img[src*="ic-clockin"]')?.closest('.flexbox-align-center');
            if (clockInRow) {
                const punchedDiv = Array.from(clockInRow.querySelectorAll('.time'))
                    .find(d => d.textContent.includes('已打卡'));
                if (punchedDiv) {
                    const t = punchedDiv.querySelector('span:last-child')?.textContent?.trim();
                    if (t && /^\d{1,2}:\d{2}$/.test(t)) result.clockInTime = t;
                }
            }
            const clockOutRow = document.querySelector('img[src*="ic-clockoff"]')?.closest('.flexbox-align-center');
            if (clockOutRow) {
                const spans = Array.from(clockOutRow.querySelectorAll('span'));
                const punchedSpan = spans.find(s => s.textContent.trim() === '已打卡');
                if (punchedSpan?.nextElementSibling) {
                    const t = punchedSpan.nextElementSibling.textContent.trim();
                    if (/^\d{1,2}:\d{2}$/.test(t)) result.clockOutTime = t;
                }
            }
            return result;
        });

        log(`實際打卡狀態 → 上班:${info.clockInTime||'未打'} 下班:${info.clockOutTime||'未打'}`);

        if (!info.clockInTime) {
            log('❌ 沒有上班打卡紀錄，無法測試');
            return;
        }

        // 測試用：下班時間設為 2 分鐘後
        const TEST_DELAY_MS = 2 * 60 * 1000;
        const clockOutReq = new Date(Date.now() + TEST_DELAY_MS);
        const clockOutStr = `${String(clockOutReq.getHours()).padStart(2,'0')}:${String(clockOutReq.getMinutes()).padStart(2,'0')}`;
        const delayMin = 1; // 測試用：打卡延遲固定 1 分鐘

        log(`⚙️  測試模式：下班時間設為 ${clockOutStr}（2 分鐘後），打卡延遲 ${delayMin} 分鐘`);

        // 發 Telegram
        await sendTelegram(tgToken, tgChatId,
            `🧪 <b>[測試] WorkDo 下班打卡提醒</b>\n\n你 <b>${info.clockInTime}</b> 上班，下班時間 ${clockOutStr}。\n⏱️ 將於下班後 ${delayMin} 分鐘自動打卡`
        );

        // 關閉瀏覽器，等下班時間
        log(`關閉瀏覽器，等待 ${Math.ceil((TEST_DELAY_MS + delayMin * 60 * 1000) / 60000)} 分鐘後重開打卡...`);
        await browser.close();
        browserClosed = true;

        await sleep(TEST_DELAY_MS + delayMin * 60 * 1000);

        // 重開瀏覽器打卡
        log('重新開啟瀏覽器，準備打下班卡...');
        const browser2 = await chromium.launch({ headless: true, executablePath: CHROME_PATH });
        const context2 = await browser2.newContext({
            geolocation: { latitude: 22.649368, longitude: 120.303737, accuracy: 50 },
            permissions: ['geolocation']
        });
        const page2 = await context2.newPage();
        try {
            await page2.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
            await page2.waitForSelector('input[name="loginEmail"]', { timeout: 15000 });
            const emailTab2 = page2.locator('#LoginTabs li:first-child a');
            if (await emailTab2.count()) await emailTab2.click();
            await sleep(300);
            await page2.fill('input[name="loginEmail"]', email);
            await page2.fill('input[name="password"]',   pwd);
            await sleep(400);
            await page2.locator('#email button.btn-login').click();
            await page2.waitForURL(url => !url.toString().includes('/Login'), { timeout: 20000 });
            log('重新登入成功');

            await page2.goto(ATTENDANCE_URL, { waitUntil: 'domcontentloaded' });
            await sleep(4000);
            const ccnFrame2 = await waitForFrame(page2, 'ccnaweb', 20000);
            try { await ccnFrame2.waitForSelector('img[src*="ic-clockin"]', { timeout: 10000 }); }
            catch { log('⚠️ 等待打卡區塊逾時'); }

            const btn = await ccnFrame2.$('button[name="btnSaveFromCreate002W4"]');
            if (btn) {
                await ccnFrame2.evaluate(b => b.removeAttribute('disabled'), btn);
                await btn.click();
                log('✅ 已自動點擊下班打卡按鈕');
                await sleep(2000);
            } else {
                log('❌ 找不到打卡按鈕');
            }
        } finally {
            await browser2.close();
            log('瀏覽器已關閉');
        }

    } finally {
        if (!browserClosed) {
            await browser.close();
            log('瀏覽器已關閉');
        }
    }
}

main().catch(e => {
    log(`❌ 未預期錯誤：${e.message}`);
    console.error(e);
    process.exit(1);
});
