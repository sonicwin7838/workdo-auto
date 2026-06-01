# WorkDo 自動打卡 (GitHub Actions 版)

用 Playwright 自動登入 WorkDo，每天排程檢查打卡狀態並自動打卡。

## 檔案說明

| 檔案 | 說明 |
|------|------|
| `workdo-github.js` | **主腳本**，所有邏輯都在這裡 |
| `.github/workflows/workdo.yml` | GitHub Actions 排程設定 |
| `package.json` | Node.js 相依套件 |

## 使用方式

### 1. Fork 這個 repo

### 2. 設定 GitHub Secrets
到 **Settings → Secrets and variables → Actions → New repository secret**，新增：

| Secret 名稱 | 說明 |
|-------------|------|
| `WORKDO_EMAIL` | WorkDo 登入信箱 |
| `WORKDO_PASSWORD` | WorkDo 登入密碼 |

### 3. 確認排程時間
`.github/workflows/workdo.yml` 預設：
- **早上 08:50**（台灣時間）→ morning mode
- **下午 17:30**（台灣時間）→ evening mode

可依需求自行調整 cron 時間。

### 4. 手動測試
到 **Actions → WorkDo 自動打卡 → Run workflow**，選 `morning` 或 `evening` 測試。

## 主腳本邏輯（workdo-github.js）

```
啟動
 ├─ 檢查台灣假日 → 假日直接結束
 ├─ 登入 WorkDo
 ├─ 查 LVS 請假 → 有請假直接結束
 ├─ 讀取出勤頁打卡狀態
 │
 ├─ morning mode
 │    ├─ 已打上班卡 → 結束
 │    └─ 未打上班卡 → ⚠️ TODO：在此加入你要的動作
 │
 └─ evening mode
      ├─ 未打上班卡 → 警告 log，結束
      ├─ 已完成打卡 → 結束
      └─ 打了上班卡但沒下班卡
           └─ 等到 上班時間 + 9小時 + 隨機5~10分鐘
               → 自動點下班打卡按鈕
```

## 需要修改的地方

**morning mode 的動作**在 `workdo-github.js` 第 175 行附近：

```js
// ── 早上時段 ──────────────────────────────────────────────
if (MODE === 'morning') {
    if (info.clockInTime) {
        log(`✅ 已打上班卡 ${info.clockInTime}，結束`);
        return;
    }
    // TODO：同事版早上動作請在此修改
    log('⚠️ 尚未打上班卡');
    return;
}
```

## 公司資訊

- WorkDo 公司代碼：`aa7x48qm`
- 打卡定位：`22.649368, 120.303737`（高雄）
- 上班時數：9 小時
