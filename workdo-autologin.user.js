// ==UserScript==
// @name         WorkDo 自動登入 + 打卡提醒
// @namespace    http://tampermonkey.net/
// @version      7.0
// @description  自動登入 WorkDo，早上提醒上班打卡，下午智慧計算下班提醒（含請假與台灣假日判斷）
// @match        https://www.workdo.co/*
// @match        https://www.workdo.co/ccnaweb/*
// @match        https://www.workdo.co/lvsaweb/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @connect      localhost
// @connect      api.telegram.org
// @connect      cdn.jsdelivr.net
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // 覆寫定位，固定回傳公司座標
    if (typeof navigator !== 'undefined' && 'geolocation' in navigator) {
        navigator.geolocation.getCurrentPosition = function(success) {
            success({
                coords: {
                    latitude: 22.649368,
                    longitude: 120.303737,
                    accuracy: 50
                },
                timestamp: Date.now()
            });
        };
    }

    const ATTENDANCE_URL = 'https://www.workdo.co/!#/aa7x48qm/aa7x48qm/C/ccn?cp=%2FCCN002W%2FCreate002W4';
    const LVS_URL        = 'https://www.workdo.co/!#/aa7x48qm/aa7x48qm/C/lvs?cp=%2FLVS001W%2FQuery001W1';
    const WORK_HOURS     = 9;   // 上班時數

    const sleep = ms => new Promise(r => setTimeout(r, ms));

    function log(msg) {
        console.log(`[WorkDo 自動化] ${msg}`);
    }

    function todayStr() {
        return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    }

    // ── 台灣假日 API ───────────────────────────────────────────────
    // 資料來源：https://cdn.jsdelivr.net/gh/ruyut/TaiwanCalendar/data/YYYY.json
    // 格式：[{"date":"20260101","isHoliday":true,"description":"元旦"}, ...]
    function checkTaiwanHoliday(dateStr) {
        const year    = dateStr.slice(0, 4);
        const compact = dateStr.replace(/-/g, ''); // YYYYMMDD
        return new Promise(resolve => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: `https://cdn.jsdelivr.net/gh/ruyut/TaiwanCalendar/data/${year}.json`,
                onload: res => {
                    try {
                        const data  = JSON.parse(res.responseText);
                        const entry = data.find(d => d.date === compact);
                        if (entry) {
                            log(`假日 API：${dateStr} isHoliday=${entry.isHoliday} (${entry.description || ''})`);
                            resolve({ isHoliday: !!entry.isHoliday, description: entry.description || '' });
                        } else {
                            log(`假日 API：${dateStr} 查無資料，視為工作日`);
                            resolve({ isHoliday: false, description: '' });
                        }
                    } catch (e) {
                        log(`假日 API 解析失敗：${e.message}，保守視為工作日`);
                        resolve({ isHoliday: false, description: '' });
                    }
                },
                onerror: () => {
                    log('無法取得台灣假日資料，保守視為工作日');
                    resolve({ isHoliday: false, description: '' });
                }
            });
        });
    }

    // ── LVS 請假表格解析（在 lvsraweb iframe 裡執行）─────────────
    // 選取器說明：
    //   行：tr[id^="LR"]
    //   狀態：td.cdk-column-leaveState enumish span（或 td.cdk-column-leaveState span）
    //   日期：td.cdk-column-leaveTimeForUi .page-content span（或 td.cdk-column-leaveTimeForUi span）
    //   日期格式：
    //     單日  → '2026-05-21 (四)'
    //     範圍  → '2026-05-19 (二) ~ 2026-05-20 (三)'
    //     半天  → '2026-04-10 (五) 14:00 ~ 18:00'
    function parseLvsLeave(today) {
        const rows = document.querySelectorAll('tr[id^="LR"]');
        log(`LVS 共 ${rows.length} 筆請假紀錄`);

        for (const row of rows) {
            // 狀態欄：只處理「已同意」
            const stateEl = row.querySelector('td.cdk-column-leaveState enumish span') ||
                            row.querySelector('td.cdk-column-leaveState span');
            if (!stateEl) continue;
            const state = stateEl.textContent.trim();
            if (state !== '已同意') continue;

            // 日期欄
            const dateEl = row.querySelector('td.cdk-column-leaveTimeForUi .page-content span') ||
                           row.querySelector('td.cdk-column-leaveTimeForUi span');
            if (!dateEl) continue;
            const dateText = dateEl.textContent.trim();
            log(`  已同意請假：${dateText}`);

            if (dateText.includes('~')) {
                const parts     = dateText.split('~');
                const startRaw  = parts[0].trim(); // '2026-05-19 (二)' 或 '2026-04-10 (五) 14:00'
                const endRaw    = parts[1].trim(); // '2026-05-20 (三)' 或 '18:00'
                const startDate = startRaw.slice(0, 10); // YYYY-MM-DD

                if (/^\d{4}-\d{2}-\d{2}/.test(endRaw)) {
                    // 跨日範圍假
                    const endDate = endRaw.slice(0, 10);
                    if (today >= startDate && today <= endDate) {
                        log(`  ✅ 今天(${today})在請假範圍 ${startDate}~${endDate}`);
                        return true;
                    }
                } else {
                    // 半天假（同一天）
                    if (today === startDate) {
                        log(`  ✅ 今天(${today})有半天假`);
                        return true;
                    }
                }
            } else {
                // 單日假
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

    // ── 工作完成後關閉瀏覽器 ───────────────────────────────────────
    function closeBrowser(ms = 2000) {
        setTimeout(() => {
            log('工作完成，關閉瀏覽器...');
            window.top.close();
        }, ms);
    }

    // ── 自動打下班卡 ───────────────────────────────────────────────
    function autoClockOut() {
        const btn = document.querySelector('button[name="btnSaveFromCreate002W4"]');
        if (!btn) { log('找不到打卡按鈕'); return false; }
        btn.removeAttribute('disabled');
        btn.click();
        log('✅ 已自動點擊下班打卡按鈕');
        return true;
    }

    // ── Config server ─────────────────────────────────────────────
    function loadConfig() {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: 'http://localhost:8765/config',
                onload: res => {
                    try { resolve(JSON.parse(res.responseText)); }
                    catch (e) { reject(new Error('設定伺服器回應格式錯誤')); }
                },
                onerror: () => reject(new Error('無法連線到設定伺服器'))
            });
        });
    }

    // ── 等待 DOM 元素 ──────────────────────────────────────────────
    function waitForElement(selector, timeout = 15000) {
        return new Promise((resolve, reject) => {
            const start = Date.now();
            const check = () => {
                const el = document.querySelector(selector);
                if (el) return resolve(el);
                if (Date.now() - start > timeout) return reject(new Error(`等待 ${selector} 逾時`));
                setTimeout(check, 300);
            };
            check();
        });
    }

    // ── AngularJS 欄位賦值 ─────────────────────────────────────────
    function setAngularValue(selector, value) {
        const el = document.querySelector(selector);
        if (!el) { log(`找不到欄位：${selector}`); return; }
        try {
            const $angular = unsafeWindow.angular || window.angular;
            if ($angular) {
                const $el   = $angular.element(el);
                const scope = $el.scope();
                const model = el.getAttribute('ng-model');
                if (scope && model) {
                    scope.$apply(() => setDeepValue(scope, model, value));
                    return;
                }
            }
        } catch (e) { log('angular.element 失敗，改用事件觸發'); }
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(el, value);
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
    }

    function setDeepValue(obj, path, value) {
        const parts = path.split('.');
        for (let i = 0; i < parts.length - 1; i++) {
            if (obj[parts[i]] === undefined) obj[parts[i]] = {};
            obj = obj[parts[i]];
        }
        obj[parts[parts.length - 1]] = value;
    }

    // ── 解析出勤狀態（在 ccnaweb iframe 裡執行）────────────────────
    function getAttendanceInfo() {
        const info = { isVacation: false, clockInTime: null, clockOutTime: null, noClockIn: false, noClockOut: false };

        const isVacation = Array.from(document.querySelectorAll('span'))
            .some(el => el.childElementCount === 0 && el.textContent.trim() === '休假');
        if (isVacation) { info.isVacation = true; return info; }

        const clockInRow = document.querySelector('img[src*="ic-clockin"]')?.closest('.flexbox-align-center');
        if (clockInRow) {
            const punchedDiv = Array.from(clockInRow.querySelectorAll('.time'))
                .find(d => d.textContent.includes('已打卡'));
            if (punchedDiv) {
                const t = punchedDiv.querySelector('span:last-child')?.textContent?.trim();
                if (t && /^\d{1,2}:\d{2}$/.test(t)) info.clockInTime = t;
            }
            if (!info.clockInTime) info.noClockIn = true;
        } else {
            info.noClockIn = true;
        }

        const clockOutRow = document.querySelector('img[src*="ic-clockoff"]')?.closest('.flexbox-align-center');
        if (clockOutRow) {
            const punchedDiv = Array.from(clockOutRow.querySelectorAll('.time'))
                .find(d => d.textContent.includes('已打卡'));
            if (punchedDiv) {
                const t = punchedDiv.querySelector('span:last-child')?.textContent?.trim();
                if (t && /^\d{1,2}:\d{2}$/.test(t)) info.clockOutTime = t;
            }
            if (!info.clockOutTime) info.noClockOut = true;
        } else {
            info.noClockOut = true;
        }

        const clockOutBtn = document.querySelector('button[name="btnSaveFromCreate002W4"]');
        info.clockOutDisabled = clockOutBtn ? clockOutBtn.disabled : null;
        info.clockOutBtnText  = clockOutBtn?.innerText?.trim() || '';

        log(`解析結果 → 上班:${info.clockInTime||'未打'} 下班:${info.clockOutTime||'未打'} 休假:${info.isVacation}`);
        return info;
    }

    // ── 送 Telegram ────────────────────────────────────────────────
    function sendTelegram(token, chatId, text) {
        return new Promise(resolve => {
            log(`送出 Telegram：${text.replace(/<[^>]+>/g, '')}`);
            GM_xmlhttpRequest({
                method: 'POST',
                url: `https://api.telegram.org/bot${token}/sendMessage`,
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
                onload: res => { log(`Telegram 回應 ${res.status}`); resolve(); },
                onerror: e => { log(`Telegram 失敗：${JSON.stringify(e)}`); resolve(); }
            });
        });
    }

    // ══════════════════════════════════════════════════════════════
    // 情境 LVS：在 lvsraweb / lvsaweb iframe 裡執行
    //   1. 等待請假表格
    //   2. 解析今天有無已同意請假
    //   3. 存入 GM storage
    //   4. 導向出勤頁
    // ══════════════════════════════════════════════════════════════
    async function handleLvsPage() {
        const today = todayStr();
        log(`📋 LVS 請假頁，解析今天（${today}）的請假狀態...`);

        // 等待 Angular 渲染請假表格（可能是空的也沒關係）
        try {
            await waitForElement('tr[id^="LR"]', 12000);
            await sleep(800); // 讓所有行都渲染完
        } catch {
            log('LVS 表格未出現（可能無請假），視為無假');
        }

        const hasLeave = parseLvsLeave(today);
        GM_setValue(`wd_has_leave_${today}`, hasLeave ? '1' : '0');
        GM_setValue(`wd_lvs_checked_${today}`, '1');
        log(`LVS 解析完成：今天${hasLeave ? '有' : '無'}已同意請假，導向打卡頁...`);

        // 由 iframe 導向最上層頁面到出勤 URL
        window.top.location.href = ATTENDANCE_URL;
    }

    // ══════════════════════════════════════════════════════════════
    // 情境 CCN：在 ccnaweb iframe 裡執行
    //   1. 台灣假日檢查
    //   2. LVS 請假狀態檢查
    //   3. 解析今天打卡狀態
    //   4. 早上提醒 / 下午計算下班時間
    // ══════════════════════════════════════════════════════════════
    async function handleAttendancePage(config) {
        const tgToken   = config.TELEGRAM_BOT_TOKEN;
        const tgChatId  = config.TELEGRAM_CHAT_ID;
        const now       = new Date();
        const today     = todayStr();
        const isMorning = now.getHours() < 12;

        if (!tgToken || !tgChatId) { log('❌ 未設定 Telegram'); closeBrowser(); return; }

        // ── 台灣假日檢查 ──────────────────────────────────────────
        log('檢查台灣假日...');
        const holiday = await checkTaiwanHoliday(today);
        if (holiday.isHoliday) {
            log(`✅ 今天是台灣假日（${holiday.description || ''}），不發送打卡提醒`);
            closeBrowser(); return;
        }

        // ── LVS 請假狀態檢查 ──────────────────────────────────────
        const hasLeave = GM_getValue(`wd_has_leave_${today}`, '0') === '1';
        if (hasLeave) {
            log('✅ 今天有已同意請假（LVS），不發送打卡提醒');
            closeBrowser(); return;
        }

        // ── 等待 Angular 渲染出勤頁 ───────────────────────────────
        log('等待出勤資料渲染...');
        await sleep(4000);

        const info = getAttendanceInfo();
        log(`出勤狀態 → 休假:${info.isVacation} 上班:${info.clockInTime||'未打'} 下班:${info.clockOutTime||'未打'} 時段:${isMorning ? '早上' : '下午'}`);

        // ── WorkDo 內部休假標記 ───────────────────────────────────
        if (info.isVacation) {
            const key = `wd_vacation_${today}_${isMorning ? 'am' : 'pm'}`;
            if (GM_getValue(key, '') === '1') { log('此時段已通知，跳過'); closeBrowser(); return; }
            await sendTelegram(tgToken, tgChatId, '🏖️ <b>WorkDo 打卡提醒</b>\n\n今天是<b>休假日</b>，不需要打卡。');
            GM_setValue(key, '1');
            closeBrowser(); return;
        }

        // ── 早上時段（08:50 觸發）──────────────────────────────────
        if (isMorning) {
            if (info.clockInTime) {
                log(`✅ 已打上班卡 ${info.clockInTime}，不提醒`);
                closeBrowser(); return;
            }
            const key = `wd_morning_${today}`;
            if (GM_getValue(key, '') === '1') { log('早上已通知，跳過'); closeBrowser(); return; }
            await sendTelegram(tgToken, tgChatId, '⏰ <b>WorkDo 上班打卡提醒</b>\n\n還沒打上班卡，記得打卡！');
            GM_setValue(key, '1');
            closeBrowser(); return;
        }

        // ── 下午時段（17:00 觸發）──────────────────────────────────

        // 未打上班卡
        if (info.noClockIn) {
            const key = `wd_evening_${today}`;
            if (GM_getValue(key, '') === '1') { log('下午已通知，跳過'); closeBrowser(); return; }
            await sendTelegram(tgToken, tgChatId, '⚠️ <b>WorkDo 打卡提醒</b>\n\n今天<b>尚未打上班卡</b>，記得補打！');
            GM_setValue(key, '1');
            closeBrowser(); return;
        }

        // 已打上班卡
        if (info.clockInTime) {
            if (info.clockOutTime) {
                log(`✅ 今天已完成打卡：${info.clockInTime} → ${info.clockOutTime}`);
                closeBrowser(); return;
            }

            const [h, m]      = info.clockInTime.split(':').map(Number);
            const clockOutReq = new Date();
            clockOutReq.setHours(h + WORK_HOURS, m, 0, 0);
            const diffMs      = clockOutReq.getTime() - now.getTime();
            const clockOutStr = `${String(clockOutReq.getHours()).padStart(2,'0')}:${String(clockOutReq.getMinutes()).padStart(2,'0')}`;

            const notify = async () => {
                const d   = todayStr();
                const key = `wd_evening_${d}`;
                if (GM_getValue(key, '') === '1') { log('已通知，跳過'); return; }

                const delayMin = Math.floor(Math.random() * 6) + 5; // 5~10 分鐘
                await sendTelegram(tgToken, tgChatId,
                    `🔔 <b>WorkDo 下班打卡提醒</b>\n\n你 <b>${info.clockInTime}</b> 上班，現在是下班時間（${clockOutStr}）！\n⏱️ 將於 ${delayMin} 分鐘後自動打下班卡`
                );
                GM_setValue(key, '1');
                setTimeout(() => { autoClockOut(); closeBrowser(); }, delayMin * 60 * 1000);
            };

            if (diffMs <= 0) {
                await notify(); // 已過下班時間，立即提醒
            } else {
                const diffMin = Math.ceil(diffMs / 60000);
                log(`下班時間 ${clockOutStr}，還有 ${diffMin} 分鐘，設定延遲提醒...`);
                setTimeout(notify, diffMs);
                log(`✅ 已排定 ${clockOutStr} 發送 Telegram（${diffMin} 分鐘後）`);
            }
        }
    }

    // ══════════════════════════════════════════════════════════════
    // 主流程
    // ══════════════════════════════════════════════════════════════
    async function main() {
        const href = location.href;

        // ── 情境 LVS：lvsraweb / lvsaweb iframe ──────────────────
        if (href.includes('/lvsraweb/') || href.includes('/lvsaweb/')) {
            log('📋 偵測到 LVS iframe，開始解析請假...');
            await handleLvsPage();
            return;
        }

        // ── 情境 CCN：ccnaweb iframe ─────────────────────────────
        if (href.includes('/ccnaweb/') && href.includes('CCN002W')) {
            log('📍 偵測到 ccnaweb 出勤頁，開始讀取打卡資料...');
            let config;
            try {
                config = await loadConfig();
                log('設定載入成功');
            } catch (e) {
                log(`❌ ${e.message}`);
                return;
            }
            await handleAttendancePage(config);
            return;
        }

        // ── 主框架（非 iframe）───────────────────────────────────
        let config;
        try {
            config = await loadConfig();
            log('設定載入成功');
        } catch (e) {
            log(`❌ ${e.message}`);
            alert(`[WorkDo] ❌ ${e.message}`);
            return;
        }

        const email = config.WORKDO_EMAIL;
        const pwd   = config.WORKDO_PASSWORD;
        if (!email || !pwd) { log('❌ 找不到 WORKDO_EMAIL / WORKDO_PASSWORD'); return; }

        const urlLower = location.pathname.toLowerCase();

        // 登入頁：自動填帳密
        if (urlLower.startsWith('/login')) {
            log('登入頁，開始自動填入...');
            try { await waitForElement('input[name="loginEmail"]'); } catch { log('等待表單逾時'); return; }
            const emailTab = document.querySelector('#LoginTabs li:first-child a');
            if (emailTab) emailTab.click();
            await sleep(300);
            setAngularValue('input[name="loginEmail"]', email);
            setAngularValue('input[name="password"]',   pwd);
            await sleep(400);
            const loginBtn = document.querySelector('#email button.btn-login');
            if (loginBtn) { loginBtn.click(); log('點擊登入按鈕'); }
            else { log('找不到登入按鈕'); }
            return;
        }

        // 主框架決策：先確認今天請假狀態，再去打卡頁
        const today      = todayStr();
        const lvsChecked = GM_getValue(`wd_lvs_checked_${today}`, '0') === '1';

        if (!lvsChecked) {
            // 尚未確認今天請假狀態
            if (href.includes('LVS001W')) {
                // 已在 LVS 頁，等 lvsraweb iframe 解析完成（最多 25 秒後強制繼續）
                log('已在 LVS 頁，等待 iframe 解析請假資料...');
                let waited = 0;
                const fallback = setInterval(() => {
                    waited += 1000;
                    if (GM_getValue(`wd_lvs_checked_${today}`, '0') === '1') {
                        clearInterval(fallback);
                        log('LVS 解析完成，等待 iframe 自動導向...');
                    } else if (waited >= 25000) {
                        clearInterval(fallback);
                        log('⚠️ LVS iframe 超時（可能 URL 不符），強制視為無假繼續');
                        GM_setValue(`wd_has_leave_${today}`, '0');
                        GM_setValue(`wd_lvs_checked_${today}`, '1');
                        location.href = ATTENDANCE_URL;
                    }
                }, 1000);
            } else {
                // 還沒去 LVS 頁，先跳過去
                log('先確認今天請假狀態，跳轉至 LVS 頁...');
                await sleep(1500);
                if (!location.href.includes('LVS001W')) {
                    location.href = LVS_URL;
                }
            }
            return;
        }

        // LVS 已確認，跳轉至出勤頁
        if (!href.includes('CCN002W') && !href.includes('ccn?cp=')) {
            await sleep(1500);
            if (!location.href.includes('CCN002W') && !location.href.includes('ccn?cp=')) {
                log(`跳轉至打卡紀錄：${ATTENDANCE_URL}`);
                location.href = ATTENDANCE_URL;
            }
        }
        // 若已在出勤頁主框架，等 ccnaweb iframe 載入後腳本自動執行
    }

    setTimeout(main, 800);

})();
