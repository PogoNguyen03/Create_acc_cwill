const express = require('express');
const ExcelJS = require('exceljs');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

puppeteer.use(StealthPlugin());
const app = express();
app.use(express.json());
app.set('view engine', 'ejs');

let progress = { total: 0, current: 0, success: 0, log: "", isRunning: false };
const dir = './data';
const filePath = path.join(dir, 'results.xlsx');

// Hàm lưu Excel giữ nguyên logic cũ
let fileLock = false;
async function safeSaveExcel(rowData) {
    while (fileLock) { await new Promise(r => setTimeout(r, 500)); }
    fileLock = true;
    try {
        const workbook = new ExcelJS.Workbook();
        if (!fs.existsSync(dir)) fs.mkdirSync(dir);
        if (fs.existsSync(filePath)) await workbook.xlsx.readFile(filePath);
        let sheet = workbook.getWorksheet('Results') || workbook.addWorksheet('Results');
        if (sheet.rowCount === 0) {
            sheet.columns = [
                { header: 'Họ', key: 'ho', width: 15 }, { header: 'Tên', key: 'ten', width: 15 },
                { header: 'Email', key: 'email', width: 35 }, { header: 'Mật khẩu', key: 'pass', width: 25 },
                { header: 'Ngày tạo', key: 'time', width: 20 }
            ];
        }
        sheet.addRow(rowData);
        await workbook.xlsx.writeFile(filePath);
    } catch (err) { } finally { fileLock = false; }
}

async function createOneAccount(hoList, tenList) {
    let isSuccess = false;
    let attempt = 0;

    while (!isSuccess && attempt < 2) {
        attempt++;
        const ho = hoList[Math.floor(Math.random() * hoList.length)];
        const ten = tenList[Math.floor(Math.random() * tenList.length)];
        const email = `${ho}${ten}${crypto.randomInt(1000, 99999)}@gmail.com`.toLowerCase();
        const password = "At" + crypto.randomBytes(3).toString('hex') + "@123";

        // LUÔN CHẠY ẨN (HEADLESS: TRUE)
        const browser = await puppeteer.launch({
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        try {
            const page = await browser.newPage();
            await page.goto('https://accounts.shopify.com/signup', { waitUntil: 'networkidle2' });

            await page.type('#account_email', email);
            await page.click('button[name="commit"]');

            await page.waitForSelector('#account_first_name', { timeout: 10000 });
            await page.type('#account_first_name', ten);
            await page.type('#account_last_name', ho);
            await page.type('#account_password', password);
            await page.type('#password-confirmation', password);

            progress.log = `Đang đợi giải captcha cho: ${email}`;

            const submitBtn = 'button.captcha__submit';
            await page.waitForFunction((s) => {
                const b = document.querySelector(s);
                return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true';
            }, { timeout: 0 }, submitBtn);

            await page.click(submitBtn);

            await page.waitForFunction(() => window.location.href.includes('/personal') || window.location.href.includes('/setup'), { timeout: 60000 });

            await safeSaveExcel([ho, ten, email, password, new Date().toLocaleString()]);
            progress.success++;
            isSuccess = true;
            // BÁO CẢ GMAIL VÀ PASS KHI THÀNH CÔNG
            progress.log = `✅ OK: ${email} | Pass: ${password}`;

        } catch (e) {
            progress.log = `❌ Lỗi tại: ${email} (Thử lại...)`;
        } finally {
            await browser.close();
        }
    }
}

app.post('/start', async (req, res) => {
    const { hoList, tenList, quantity, concurrency } = req.body;
    if (progress.isRunning) return res.json({ status: 'busy' });
    progress = { total: quantity, current: 0, success: 0, log: "Bắt đầu tiến trình...", isRunning: true };

    const worker = async () => {
        while (progress.current < quantity && progress.isRunning) {
            progress.current++;
            await createOneAccount(hoList, tenList);
        }
        if (progress.current >= quantity) progress.isRunning = false;
    };

    for (let i = 0; i < Math.min(concurrency, quantity); i++) worker();
    res.json({ status: 'started' });
});

app.get('/status', (req, res) => res.json(progress));
app.get('/download', (req, res) => res.download(filePath));
app.get('/', (req, res) => res.render('index'));
app.listen(3000);