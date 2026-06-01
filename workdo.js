// WorkDo 自動登入 + 打卡提醒 (Playwright 版)
// 用法：node workdo.js morning | node workdo.js evening

const { chromium } = require('./node_modules/playwright');
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const fs   = require('fs');
const path = require('path');

const MODE = process.argv[2]; // 'morning' | 'evening'
if (!['morning', 'evening'].includes(MODE)) {
    console.error('用法：node workdo.js morning  或  node workdo.js evening');
    process.exit(1);
}

const ATTENDANCE_URL = 'https://www.workdo.co/!#/aa7x48qm/aa7x48qm/C/ccn?cp=%2FCCN002W%2FCreate002W4';
const LVS_URL        = 'https://www.workdo.co/!#/aa7x48qm/aa7x48qm/C/lvs?cp=%2FLVS001W%2FQuery001W1';
const LOGIN_URL      = 'https://www.workdo.co/Login?userLang=zh_TW';
const WORK_HOURS     = 9;
const STATE_FILE     = path.join(__dirname, 'workdo-state.json');

const sleep = ms => new Promise(r => setTimeout(r, ms));

function log(msg) {
    const t = new Date().toLocaleTimeString('zh-TW');
    console.log(`[${t}] ${msg}`);
}

function todayStr() {
    return new Date().toISOString().slice(0, 10);
}

// ── 狀態檔（取代 GM_setValue / GM_getValue）─────────────────────
function loadState() {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
    catch { return {}; }
}

function saveState(state) {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function getVal(key, def = '') {
    return loadState()[key] ?? def;
}

function setVal(key, value) {
    const state = loadState();
    state[key] = value;
    saveState(state);
}

// ── Config server ────────────────────────────────────────────────
async function loadConfig() {
    const res = await fetch('http://localhost:8765/config');
    if (!res.ok) throw new Error(`Config server 回應 ${res.status}`);
    return res.json();
}

// ── 台灣假日 API ─────────────────────────────────────────────────
async function checkTaiwanHoliday(dateStr) {
    const year    = dateStr.slice(0, 4);
    const compact = dateStr.replace(/-/g, '');
    try {
        const res  = await fetch(`https://cdn.jsdelivr.net/gh/ruyut/TaiwanCalendar/data/${year}.json`);
        const data = await res.json();
        const entry = data.find(d => d.date === compact);
        if (entry) {
            log(`假日 API：${dateStr} isHoliday=${entry.isHoliday} (${entry.description || ''})`);
            return { isHoliday: !!entry.isHoliday, description: entry.description || '' };
        }
        log(`假日 API：${dateStr} 查無資料，視為工作日`);
        return { isHoliday: false, description: '' };
    } catch (e) {
        log(`假日 API 失敗：${e.message}，保守視為工作日`);
        return { isHoliday: false, description: '' };
    }
}

// ── 送 Telegram ──────────────────────────────────────────────────
async function sendTelegram(token, chatId, text) {
    log(`送出 Telegram：${text.replace(/<[^>]+>/g, '')}`);
    try {
        const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
        });
        log(`Telegram 回應 ${res.status}`);
    } catch (e) {
        log(`Telegram 失敗：${e.message}`);
    }
}

// ── 自動登入 ─────────────────────────────────────────────────────
async function doLogin(page, email, pwd) {
    log('登入頁，開始自動填入...');
    await page.waitForSelector('input[name="loginEmail"]', { timeout: 15000 });

    const emailTab = page.locator('#LoginTabs li:first-child a');
    if (await emailTab.count()) await emailTab.click();
    await sleep(300);

    await page.fill('input[name="loginEmail"]', email);
    await page.fill('input[name="password"]',   pwd);
    await sleep(400);

    const loginBtn = page.locator('#email button.btn-login');
    if (await loginBtn.count()) {
        await loginBtn.click();
        log('點擊登入按鈕');
    } else {
        log('找不到登入按鈕');
    }
}

// ── LVS 請假解析 ─────────────────────────────────────────────────
async function parseLvsLeave(frame, today) {
    const rows = await frame.$$('tr[id^="LR"]');
    log(`LVS 共 ${rows.length} 筆請假紀錄`);

    for (const row of rows) {
        const stateEl = await row.$('td.cdk-column-leaveState enumish span') ||
                        await row.$('td.cdk-column-leaveState span');
        if (!stateEl) continue;
        const state = (await stateEl.textContent()).trim();
        if (state !== '已同意') continue;

        const dateEl = await row.$('td.cdk-column-leaveTimeForUi .page-content span') ||
                       await row.$('td.cdk-column-leaveTimeForUi span');
        if (!dateEl) continue;
        const dateText = (await dateEl.textContent()).trim();
        log(`  已同意請假：${dateText}`);

        if (dateText.includes('~')) {
            const parts    = dateText.split('~');
            const startRaw = parts[0].trim();
            const endRaw   = parts[1].trim();
            const startDate = startRaw.slice(0, 10);

            if (/^\d{4}-\d{2}-\d{2}/.test(endRaw)) {
                const endDate = endRaw.slice(0, 10);
                if (today >= startDate && today <= endDate) {
                    log(`  ✅ 今天(${today})在請假範圍 ${startDate}~${endDate}`);
                    return true;
                }
            } else {
                if (today === startDate) {
                    log(`  ✅ 今天(${today})有半天假`);
                    return true;
                }
            }
        } else {
            const date = dateText.slice(0, 10);
            if (today === date) {
                log(`  ✅ 今天(${today})有單日假`);
                return true;
            }
        }
    }
    log(`  今天(${today})無已同意請假`);
    return false;
}

// ── 解析出勤狀態（在 iframe 內執行，與舊腳本邏輯一致）──────────
async function getAttendanceInfo(frame) {
    const info = await frame.evaluate(() => {
        const result = { isVacation: false, clockInTime: null, clockOutTime: null, noClockIn: false };

        // 休假
        const isVacation = Array.from(document.querySelectorAll('span'))
            .some(el => el.childElementCount === 0 && el.textContent.trim() === '休假');
        if (isVacation) { result.isVacation = true; return result; }

        // 上班卡
        const clockInRow = document.querySelector('img[src*="ic-clockin"]')?.closest('.flexbox-align-center');
        if (clockInRow) {
            const punchedDiv = Array.from(clockInRow.querySelectorAll('.time'))
                .find(d => d.textContent.includes('已打卡'));
            if (punchedDiv) {
                const t = punchedDiv.querySelector('span:last-child')?.textContent?.trim();
                if (t && /^\d{1,2}:\d{2}$/.test(t)) result.clockInTime = t;
            }
            if (!result.clockInTime) result.noClockIn = true;
        } else {
            result.noClockIn = true;
        }

        // 下班卡（已打卡不在 .time div 裡，需找所有 span）
        const clockOutRow = document.querySelector('img[src*="ic-clockoff"]')?.closest('.flexbox-align-center');
        if (clockOutRow) {
            const spans = Array.from(clockOutRow.querySelectorAll('span'));
            const punchedSpan = spans.find(s => s.textContent.trim() === '已打卡');
            if (punchedSpan) {
                const nextSpan = punchedSpan.nextElementSibling;
                if (nextSpan) {
                    const t = nextSpan.textContent.trim();
                    if (/^\d{1,2}:\d{2}$/.test(t)) result.clockOutTime = t;
                }
            }
        }

        return result;
    });

    log(`解析結果 → 上班:${info.clockInTime||'未打'} 下班:${info.clockOutTime||'未打'} 休假:${info.isVacation}`);
    return info;
}

// ── 等待 iframe 出現 ─────────────────────────────────────────────
async function waitForFrame(page, urlSubstr, timeout = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        const frame = page.frames().find(f => f.url().includes(urlSubstr));
        if (frame) return frame;
        await sleep(500);
    }
    throw new Error(`等待 iframe(${urlSubstr}) 逾時`);
}

// ── 主流程 ───────────────────────────────────────────────────────
async function main() {
    const today = todayStr();
    log(`===== WorkDo ${MODE} 開始 (${today}) =====`);

    // 台灣假日檢查
    const holiday = await checkTaiwanHoliday(today);
    if (holiday.isHoliday) {
        log(`✅ 今天是台灣假日（${holiday.description}），結束`);
        return;
    }

    // 載入設定
    let config;
    try {
        config = await loadConfig();
        log('設定載入成功');
    } catch (e) {
        log(`❌ ${e.message}`);
        process.exit(1);
    }

    const { TELEGRAM_BOT_TOKEN: tgToken, TELEGRAM_CHAT_ID: tgChatId,
            WORKDO_EMAIL: email, WORKDO_PASSWORD: pwd } = config;

    if (!tgToken || !tgChatId) { log('❌ 未設定 Telegram'); process.exit(1); }
    if (!email   || !pwd)      { log('❌ 未設定 WorkDo 帳密'); process.exit(1); }

    // 啟動瀏覽器
    let browserClosed = false;
    const browser = await chromium.launch({ headless: true, executablePath: CHROME_PATH });
    const context = await browser.newContext({
        geolocation: { latitude: 22.649368, longitude: 120.303737, accuracy: 50 },
        permissions: ['geolocation']
    });
    const page = await context.newPage();

    try {
        // 登入（每次新開瀏覽器都需要）
        await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
        await doLogin(page, email, pwd);
        await page.waitForURL(url => !url.toString().includes('/Login'), { timeout: 20000 });
        log('登入成功');

        // ── LVS 請假檢查 ──────────────────────────────────────────
        const lvsChecked = getVal(`wd_lvs_checked_${today}`) === '1';
        let hasLeave = getVal(`wd_has_leave_${today}`) === '1';

        if (!lvsChecked) {
            log('前往 LVS 請假頁...');
            await page.goto(LVS_URL, { waitUntil: 'domcontentloaded' });
            await sleep(2000);

            try {
                const lvsFrame = await waitForFrame(page, 'lvsaweb', 15000);
                try { await lvsFrame.waitForSelector('tr[id^="LR"]', { timeout: 12000 }); }
                catch { log('LVS 表格未出現，視為無假'); }
                await sleep(800);
                hasLeave = await parseLvsLeave(lvsFrame, today);
            } catch (e) {
                log(`LVS iframe 失敗：${e.message}，視為無假`);
            }

            setVal(`wd_has_leave_${today}`, hasLeave ? '1' : '0');
            setVal(`wd_lvs_checked_${today}`, '1');
            log(`LVS 解析完成：今天${hasLeave ? '有' : '無'}已同意請假`);
        }

        if (hasLeave) {
            log('✅ 今天有已同意請假，不發送打卡提醒');
            return;
        }

        // ── 出勤頁 ────────────────────────────────────────────────
        log('前往出勤頁...');
        await page.goto(ATTENDANCE_URL, { waitUntil: 'domcontentloaded' });
        await sleep(4000);

        const ccnFrame = await waitForFrame(page, 'ccnaweb', 20000);
        // 等待 Angular 渲染出打卡區塊
        try {
            await ccnFrame.waitForSelector('img[src*="ic-clockin"]', { timeout: 10000 });
        } catch {
            log('⚠️ 等待打卡區塊逾時，嘗試繼續解析');
        }
        const info = await getAttendanceInfo(ccnFrame);

        // 休假
        if (info.isVacation) {
            const key = `wd_vacation_${today}_${MODE}`;
            if (getVal(key) === '1') { log('此時段已通知，跳過'); return; }
            await sendTelegram(tgToken, tgChatId, '🏖️ <b>WorkDo 打卡提醒</b>\n\n今天是<b>休假日</b>，不需要打卡。');
            setVal(key, '1');
            return;
        }

        // ── 早上時段 ──────────────────────────────────────────────
        if (MODE === 'morning') {
            if (info.clockInTime) {
                log(`✅ 已打上班卡 ${info.clockInTime}，不提醒`);
                return;
            }
            const key = `wd_morning_${today}`;
            if (getVal(key) === '1') { log('早上已通知，跳過'); return; }
            await sendTelegram(tgToken, tgChatId, '⏰ <b>WorkDo 上班打卡提醒</b>\n\n還沒打上班卡，記得打卡！');
            setVal(key, '1');
            return;
        }

        // ── 下午時段 ──────────────────────────────────────────────
        if (info.noClockIn) {
            const key = `wd_evening_${today}`;
            if (getVal(key) === '1') { log('下午已通知，跳過'); return; }
            await sendTelegram(tgToken, tgChatId, '⚠️ <b>WorkDo 打卡提醒</b>\n\n今天<b>尚未打上班卡</b>，記得補打！');
            setVal(key, '1');
            return;
        }

        if (info.clockInTime) {
            if (info.clockOutTime) {
                log(`✅ 今天已完成打卡：${info.clockInTime} → ${info.clockOutTime}`);
                return;
            }

            const key = `wd_evening_${today}`;
            if (getVal(key) === '1') { log('已通知，跳過'); return; }

            const [h, m]      = info.clockInTime.split(':').map(Number);
            const clockOutReq = new Date();
            clockOutReq.setHours(h + WORK_HOURS, m, 0, 0);
            const now         = new Date();
            const diffMs      = clockOutReq.getTime() - now.getTime();
            const clockOutStr = `${String(clockOutReq.getHours()).padStart(2,'0')}:${String(clockOutReq.getMinutes()).padStart(2,'0')}`;
            const delayMin    = Math.floor(Math.random() * 6) + 5; // 5~10 分鐘

            // 發 Telegram 通知
            await sendTelegram(tgToken, tgChatId,
                `🔔 <b>WorkDo 下班打卡提醒</b>\n\n你 <b>${info.clockInTime}</b> 上班，下班時間 ${clockOutStr}。\n⏱️ 將於下班後 ${delayMin} 分鐘自動打卡`
            );
            setVal(key, '1');

            // 關閉瀏覽器，等到下班時間 + 隨機延遲
            const waitMs = diffMs + delayMin * 60 * 1000;
            log(`關閉瀏覽器，等待 ${Math.ceil(waitMs/60000)} 分鐘後重新開啟打卡...`);
            await browser.close();
            browserClosed = true;

            if (waitMs > 0) await sleep(waitMs);

            // 重新開瀏覽器打下班卡
            log('重新開啟瀏覽器，準備打下班卡...');
            const browser2 = await chromium.launch({ headless: true, executablePath: CHROME_PATH });
            const context2 = await browser2.newContext({
                geolocation: { latitude: 22.649368, longitude: 120.303737, accuracy: 50 },
                permissions: ['geolocation']
            });
            const page2 = await context2.newPage();
            try {
                await page2.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
                await doLogin(page2, email, pwd);
                await page2.waitForURL(url => !url.toString().includes('/Login'), { timeout: 20000 });
                log('重新登入成功');
                await page2.goto(ATTENDANCE_URL, { waitUntil: 'domcontentloaded' });
                await sleep(4000);
                const ccnFrame2 = await waitForFrame(page2, 'ccnaweb', 20000);
                try { await ccnFrame2.waitForSelector('img[src*="ic-clockin"]', { timeout: 10000 }); }
                catch { log('⚠️ 等待打卡區塊逾時，嘗試繼續'); }

                const btn = await ccnFrame2.$('button[name="btnSaveFromCreate002W4"]');
                if (btn) {
                    await ccnFrame2.evaluate(b => b.removeAttribute('disabled'), btn);
                    await btn.click();
                    log('✅ 已自動點擊下班打卡按鈕');
                    await sleep(2000);
                } else {
                    log('找不到打卡按鈕');
                }
            } finally {
                await browser2.close();
                log('瀏覽器已關閉');
            }
            return; // 避免 finally 再次 close 已關閉的 browser
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
