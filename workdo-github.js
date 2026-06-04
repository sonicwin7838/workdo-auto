// WorkDo 自動打卡 - GitHub Actions 版
// 用法：node workdo-github.js morning | node workdo-github.js evening
// 帳密從環境變數讀取：WORKDO_EMAIL, WORKDO_PASSWORD

const { chromium } = require('./node_modules/playwright');

const MODE = process.argv[2];
if (!['morning', 'evening'].includes(MODE)) {
    console.error('用法：node workdo-github.js morning  或  node workdo-github.js evening');
    process.exit(1);
}

const ATTENDANCE_URL = 'https://www.workdo.co/!#/aa7x48qm/aa7x48qm/C/ccn?cp=%2FCCN002W%2FCreate002W4';
const LVS_URL        = 'https://www.workdo.co/!#/aa7x48qm/aa7x48qm/C/lvs?cp=%2FLVS001W%2FQuery001W1';
const LOGIN_URL      = 'https://www.workdo.co/Login?userLang=zh_TW';

// ── 打卡時間設定 ─────────────────────────────────────────────────
const MORNING_RANDOM_MIN   = 1;
const MORNING_RANDOM_RANGE = 4;

const EVENING_RANDOM_MIN   = 1;
const EVENING_RANDOM_RANGE = 4;

// ── 時間容許範圍（分鐘）─────────────────────────────────────────
// 超過此範圍代表 GitHub Actions 延遲太久，直接跳出避免異常打卡時間
// morning 預期 08:50 CST，最多容許到 09:30 CST（+40 分鐘）
// evening 預期 17:30 CST，最多容許到 18:10 CST（+40 分鐘）
const MORNING_EXPECTED_CST = { h: 8,  m: 50 };
const EVENING_EXPECTED_CST = { h: 17, m: 30 };
const TOLERANCE_MINUTES    = 40;

const email = process.env.WORKDO_EMAIL;
const pwd   = process.env.WORKDO_PASSWORD;

const sleep = ms => new Promise(r => setTimeout(r, ms));

function log(msg) {
    const t = new Date().toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei' });
    console.log(`[${t}] ${msg}`);
}

function todayStr() {
    return new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
}

// ── 檢查現在是否在容許的打卡時間範圍內 ──────────────────────────
function checkTimeWindow(mode) {
    const now = new Date();
    // 取得台灣時間的時與分
    const cstStr = now.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit', hour12: false });
    // cstStr 格式例如 "08:50" 或 "17:30"
    const [cstH, cstM] = cstStr.split(':').map(Number);
    const nowMinutes = cstH * 60 + cstM;

    const expected = mode === 'morning' ? MORNING_EXPECTED_CST : EVENING_EXPECTED_CST;
    const expectedMinutes = expected.h * 60 + expected.m;
    const diff = nowMinutes - expectedMinutes;

    const nowDisplay = `${String(cstH).padStart(2,'0')}:${String(cstM).padStart(2,'0')}`;
    const expDisplay = `${String(expected.h).padStart(2,'0')}:${String(expected.m).padStart(2,'0')}`;
    log(`時間檢查：現在 CST ${nowDisplay}，預期 ${expDisplay}，差距 ${diff} 分鐘`);

    if (diff < 0) {
        log(`觸發時間比預期早 ${Math.abs(diff)} 分鐘，繼續執行`);
        return true;
    }
    if (diff > TOLERANCE_MINUTES) {
        log(`❌ 已超過容許範圍 ${TOLERANCE_MINUTES} 分鐘（實際延遲 ${diff} 分鐘），跳過本次打卡`);
        return false;
    }
    return true;
}

// ── 台灣假日 API ─────────────────────────────────────────────────
async function checkTaiwanHoliday(dateStr) {
    const year    = dateStr.slice(0, 4);
    const compact = dateStr.replace(/-/g, '');
    try {
        const res   = await fetch(`https://cdn.jsdelivr.net/gh/ruyut/TaiwanCalendar/data/${year}.json`);
        const data  = await res.json();
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

// ── 自動登入 ─────────────────────────────────────────────────────
async function doLogin(page) {
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
            const parts     = dateText.split('~');
            const startDate = parts[0].trim().slice(0, 10);
            const endRaw    = parts[1].trim();
            if (/^\d{4}-\d{2}-\d{2}/.test(endRaw)) {
                const endDate = endRaw.slice(0, 10);
                if (today >= startDate && today <= endDate) {
                    log(`  ✅ 今天(${today})在請假範圍 ${startDate}~${endDate}`);
                    return true;
                }
            } else {
                if (today === startDate) { log(`  ✅ 今天(${today})有半天假`); return true; }
            }
        } else {
            const date = dateText.slice(0, 10);
            if (today === date) { log(`  ✅ 今天(${today})有單日假`); return true; }
        }
    }
    log(`  今天(${today})無已同意請假`);
    return false;
}

// ── 解析出勤狀態 ─────────────────────────────────────────────────
async function getAttendanceInfo(frame) {
    const info = await frame.evaluate(() => {
        const result = { isVacation: false, clockInTime: null, clockOutTime: null, noClockIn: false };

        const isVacation = Array.from(document.querySelectorAll('span'))
            .some(el => el.childElementCount === 0 && el.textContent.trim() === '休假');
        if (isVacation) { result.isVacation = true; return result; }

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

    log(`解析結果 → 上班:${info.clockInTime||'未打'} 下班:${info.clockOutTime||'未打'} 休假:${info.isVacation}`);
    return info;
}

// ── 等待 iframe ───────────────────────────────────────────────────
async function waitForFrame(page, urlSubstr, timeout = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        const frame = page.frames().find(f => f.url().includes(urlSubstr));
        if (frame) return frame;
        await sleep(500);
    }
    throw new Error(`等待 iframe(${urlSubstr}) 逾時`);
}

// ── 執行打卡（上班 & 下班共用）──────────────────────────────────
async function doPunch(page, label) {
    log(`前往出勤頁，準備打${label}卡...`);
    await page.goto(ATTENDANCE_URL, { waitUntil: 'domcontentloaded' });
    await sleep(4000);

    const ccnFrame = await waitForFrame(page, 'ccnaweb', 20000);
    try { await ccnFrame.waitForSelector('img[src*="ic-clockin"]', { timeout: 10000 }); }
    catch { log('⚠️ 等待打卡區塊逾時，嘗試繼續'); }

    const btn = await ccnFrame.$('button[name="btnSaveFromCreate002W4"]');
    if (btn) {
        await ccnFrame.evaluate(b => b.removeAttribute('disabled'), btn);
        await btn.click();
        log(`✅ 已自動點擊${label}打卡按鈕`);
        await sleep(2000);
    } else {
        log(`❌ 找不到${label}打卡按鈕`);
    }
}

// ── 主流程 ───────────────────────────────────────────────────────
async function main() {
    if (!email || !pwd) {
        log('❌ 未設定 WORKDO_EMAIL 或 WORKDO_PASSWORD 環境變數');
        process.exit(1);
    }

    const today = todayStr();
    log(`===== WorkDo ${MODE} 開始 (${today}) =====`);

    // 1. 台灣假日檢查
    const holiday = await checkTaiwanHoliday(today);
    if (holiday.isHoliday) {
        log(`✅ 今天是台灣假日（${holiday.description}），結束`);
        return;
    }

    // 2. 時間範圍檢查（GitHub Actions schedule 延遲保護）
    if (!checkTimeWindow(MODE)) {
        process.exit(0);
    }

    // 3. 隨機 delay 1~5 分鐘（在瀏覽器啟動前先等，節省資源）
    if (MODE === 'morning') {
        const delayMin = MORNING_RANDOM_MIN + Math.floor(Math.random() * (MORNING_RANDOM_RANGE + 1));
        const nowStr = new Date().toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei' });
        log(`上班隨機 delay：${delayMin} 分鐘（現在 ${nowStr}）`);
        await sleep(delayMin * 60 * 1000);
    }

    if (MODE === 'evening') {
        const delayMin = EVENING_RANDOM_MIN + Math.floor(Math.random() * (EVENING_RANDOM_RANGE + 1));
        const nowStr = new Date().toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei' });
        log(`下班隨機 delay：${delayMin} 分鐘（現在 ${nowStr}）`);
        await sleep(delayMin * 60 * 1000);
    }

    // 4. 啟動瀏覽器
    const browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const context = await browser.newContext({
        geolocation: { latitude: 22.649368, longitude: 120.303737, accuracy: 50 },
        permissions: ['geolocation'],
        timezoneId: 'Asia/Taipei'
    });
    const page = await context.newPage();

    try {
        // 5. 登入
        await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
        await doLogin(page);
        try {
            await page.waitForURL(url => !url.toString().includes('/Login'), { timeout: 20000 });
            log('登入成功');
        } catch (e) {
            log(`⚠️ 登入等待逾時，當前 URL：${page.url()}`);
            const bodyText = await page.evaluate(() => document.body?.innerText?.slice(0, 500) || '');
            log(`⚠️ 頁面內容（前500字）：${bodyText}`);
            await page.screenshot({ path: 'login-debug.png', fullPage: false });
            log('截圖已存為 login-debug.png（請至 Actions Artifacts 下載）');
            throw e;
        }

        // 6. LVS 請假檢查
        log('前往 LVS 請假頁...');
        await page.goto(LVS_URL, { waitUntil: 'domcontentloaded' });
        await sleep(2000);

        let hasLeave = false;
        try {
            const lvsFrame = await waitForFrame(page, 'lvsaweb', 15000);
            try { await lvsFrame.waitForSelector('tr[id^="LR"]', { timeout: 12000 }); }
            catch { log('LVS 表格未出現，視為無假'); }
            await sleep(800);
            hasLeave = await parseLvsLeave(lvsFrame, today);
        } catch (e) {
            log(`LVS iframe 失敗：${e.message}，視為無假`);
        }

        if (hasLeave) {
            log('✅ 今天有已同意請假，結束');
            return;
        }

        // 7. 讀取出勤狀態
        log('前往出勤頁，讀取打卡狀態...');
        await page.goto(ATTENDANCE_URL, { waitUntil: 'domcontentloaded' });
        await sleep(4000);

        const ccnFrame = await waitForFrame(page, 'ccnaweb', 20000);
        try { await ccnFrame.waitForSelector('img[src*="ic-clockin"]', { timeout: 10000 }); }
        catch { log('⚠️ 等待打卡區塊逾時，嘗試繼續解析'); }

        const info = await getAttendanceInfo(ccnFrame);

        if (info.isVacation) {
            log('✅ WorkDo 標記休假，結束');
            return;
        }

        // ── 上班打卡 ──────────────────────────────────────────────
        if (MODE === 'morning') {
            if (info.clockInTime) {
                log(`✅ 已打上班卡 ${info.clockInTime}，結束`);
                return;
            }
            await doPunch(page, '上班');
            return;
        }

        // ── 下班打卡 ──────────────────────────────────────────────
        if (MODE === 'evening') {
            if (info.noClockIn) {
                log('⚠️ 今天尚未打上班卡，無法自動打下班卡');
                return;
            }
            if (info.clockOutTime) {
                log(`✅ 今天已打下班卡 ${info.clockOutTime}，結束`);
                return;
            }
            await doPunch(page, '下班');
            return;
        }

    } finally {
        await browser.close();
        log('瀏覽器已關閉');
    }
}

main().catch(e => {
    log(`❌ 未預期錯誤：${e.message}`);
    console.error(e);
    process.exit(1);
});
