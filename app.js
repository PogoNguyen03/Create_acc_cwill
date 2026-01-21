const express = require('express');
const ExcelJS = require('exceljs');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const axios = require('axios');

puppeteer.use(StealthPlugin());
const app = express();
app.use(express.json());
app.set('view engine', 'ejs');

let progress = { total: 0, current: 0, success: 0, log: "", isRunning: false };
const dir = './data';
const filePath = path.join(dir, 'results.xlsx');

// --- HÀM GIẢI CAPTCHA ---
async function solveCaptcha(apiKey, siteKey, pageUrl) {
    try {
        const resp = await axios.get(`http://2captcha.com/in.php?key=${apiKey}&method=userrecaptcha&googlekey=${siteKey}&pageurl=${pageUrl}&json=1`);
        if (resp.data.status !== 1) return null;
        const requestId = resp.data.request;
        for (let i = 0; i < 20; i++) { // Thử tối đa 100s
            await new Promise(r => setTimeout(r, 5000));
            const check = await axios.get(`http://2captcha.com/res.php?key=${apiKey}&action=get&id=${requestId}&json=1`);
            if (check.data.status === 1) return check.data.request;
        }
    } catch (e) { return null; }
    return null;
}

// --- HÀM LƯU EXCEL ---
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
                { header: 'Họ', key: 'ho', width: 10 }, { header: 'Tên', key: 'ten', width: 10 },
                { header: 'Email', key: 'email', width: 30 }, { header: 'Mật khẩu', key: 'pass', width: 20 },
                { header: 'Ngày tạo', key: 'time', width: 20 }
            ];
        }
        sheet.addRow(rowData);
        await workbook.xlsx.writeFile(filePath);
    } catch (err) {} finally { fileLock = false; }
}

async function createOneAccount(hoList, tenList, captchaKey) {
    let isSuccess = false;
    const ho = hoList[Math.floor(Math.random() * hoList.length)];
    const ten = tenList[Math.floor(Math.random() * tenList.length)];
    const email = `${ho}${ten}${crypto.randomInt(1000, 9999)}@gmail.com`.toLowerCase().replace(/\s/g, '');
    const password = "At" + crypto.randomBytes(3).toString('hex') + "@123";

    const browser = await puppeteer.launch({
        headless: "new",
        args: [
            '--no-sandbox', 
            '--disable-setuid-sandbox', 
            '--disable-dev-shm-usage',
            '--disable-gpu'
        ]
    });

    try {
        const page = await browser.newPage();
        await page.goto('https://accounts.shopify.com/signup', { waitUntil: 'networkidle2', timeout: 60000 });

        await page.waitForSelector('#account_email');
        await page.type('#account_email', email);
        await page.click('button[name="commit"]');

        await page.waitForSelector('#account_first_name', { timeout: 15000 });
        await page.type('#account_first_name', ten);
        await page.type('#account_last_name', ho);
        await page.type('#account_password', password);
        await page.type('#password-confirmation', password);

        // Xử lý Captcha nếu có Key
        if (captchaKey) {
            const siteKey = await page.evaluate(() => {
                const el = document.querySelector('.g-recaptcha, .h-captcha');
                return el ? el.getAttribute('data-sitekey') : null;
            });
            if (siteKey) {
                progress.log = `🔄 Đang giải Captcha cho: ${email}`;
                const token = await solveCaptcha(captchaKey, siteKey, page.url());
                if (token) {
                    await page.evaluate(t => {
                        if(document.getElementsByName('g-recaptcha-response')[0]) document.getElementsByName('g-recaptcha-response')[0].innerHTML = t;
                        if(document.getElementsByName('h-captcha-response')[0]) document.getElementsByName('h-captcha-response')[0].innerHTML = t;
                    }, token);
                }
            }
        }

        const submitBtn = 'button.captcha__submit';
        await page.waitForFunction(s => {
            const b = document.querySelector(s);
            return b && !b.disabled && b.getAttribute('aria-disabled') !== 'true';
        }, { timeout: 300000 }, submitBtn);

        await page.click(submitBtn);
        await page.waitForFunction(() => window.location.href.includes('/personal') || window.location.href.includes('/setup'), { timeout: 60000 });

        await safeSaveExcel([ho, ten, email, password, new Date().toLocaleString()]);
        progress.success++;
        progress.log = `✅ THÀNH CÔNG: ${email} | Pass: ${password}`;
        isSuccess = true;
    } catch (e) {
        progress.log = `❌ Thất bại: ${email} - Lỗi: ${e.message.substring(0, 30)}`;
    } finally {
        await browser.close();
    }
}

app.post('/start', async (req, res) => {
    const { hoList, tenList, quantity, concurrency, captchaKey } = req.body;
    if (progress.isRunning) return res.json({ status: 'busy' });
    progress = { total: quantity, current: 0, success: 0, log: "🚀 Khởi động...", isRunning: true };
    
    const worker = async () => {
        while (progress.current < quantity && progress.isRunning) {
            progress.current++;
            await createOneAccount(hoList, tenList, captchaKey);
        }
        if (progress.current >= quantity) progress.isRunning = false;
    };

    for (let i = 0; i < Math.min(concurrency, quantity); i++) worker();
    res.json({ status: 'started' });
});

app.get('/status', (req, res) => res.json(progress));
app.get('/download', (req, res) => res.download(filePath));
app.get('/', (req, res) => res.render('index'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
