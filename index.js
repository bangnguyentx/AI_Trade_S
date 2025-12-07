// index.js - V5 Pro
require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const moment = require('moment-timezone');
const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { analyzeSymbol } = require('./analysis');

// ---------- CẤU HÌNH ----------
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || 'YOUR_TELEGRAM_BOT_TOKEN_HERE';
const PORT = process.env.PORT || 3000;
const USERS_FILE = process.env.USERS_FILE || path.join(__dirname, 'users.json');
const LAST_SIGNALS_FILE = process.env.LAST_SIGNALS_FILE || path.join(__dirname, 'last_signals.json');

// --- BOT POLLING (SAFE) ---
const bot = new TelegramBot(TOKEN, {
    polling: {
        interval: 300,
        autoStart: true,
        params: {
            timeout: 10
        }
    }
});

// Bắt lỗi polling để không crash
bot.on("polling_error", (err) => {
    console.error(`[Polling Error] ${err.code || ''}: ${err.message}`);
});

// ---------- SERVER EXPRESS (KEEP-ALIVE) ----------
const app = express();
app.use(express.json());
app.get('/', async (req, res) => {
    const users = await loadUsers();
    const lastSignals = await loadLastSignals();
    res.json({
        status: 'AI Trading Bot V5 Pro is Running...',
        subscribers: Object.keys(users).length,
        lastSignalsSaved: Object.keys(lastSignals).length
    });
});
app.get('/health', (req, res) => {
    res.json({ status: 'healthy', uptime: process.uptime() });
});
app.listen(PORT, () => console.log(`🚀 Server is running on port ${PORT}`));

// ---------- TARGET COINS (50 coins) ----------
const TARGET_COINS = [
  'BTCUSDT','ETHUSDT','BNBUSDT','SOLUSDT','XRPUSDT','ADAUSDT','AVAXUSDT','DOTUSDT','LINKUSDT','MATICUSDT',
  'LTCUSDT','BCHUSDT','ATOMUSDT','ETCUSDT','XLMUSDT','FILUSDT','ALGOUSDT','NEARUSDT','UNIUSDT','DOGEUSDT',
  'ZECUSDT','PEPEUSDT','ZENUSDT','HYPEUSDT','WIFUSDT','MEMEUSDT','BOMEUSDT','POPCATUSDT','MYROUSDT','DOGUSDT',
  'TOSHIUSDT','MOGUSDT','TURBOUSDT','PEOPLEUSDT','ARCUSDT','DASHUSDT','APTUSDT','ARBUSDT','OPUSDT','SUIUSDT',
  'SEIUSDT','TIAUSDT','INJUSDT','RNDRUSDT','FETUSDT','AGIXUSDT','OCEANUSDT','JASMYUSDT','GALAUSDT','SANDUSDT'
];

// ---------- STATE & SETTINGS ----------
let signalCountToday = 0;
let isAutoAnalysisRunning = false;
let consecutiveErrors = 0;
const MAX_CONSECUTIVE_ERRORS = 5;

// interval: 1.5 hours
const ANALYSIS_INTERVAL = 1.5 * 60 * 60 * 1000; // in ms
const START_DELAY_MS = 10 * 1000; // run after 10s

// duplicate suppression: do not resend same symbol within 1 hour
const DUPLICATE_WINDOW_SECONDS = 60 * 60; // 3600s = 1 hour

// ---------- Utilities: persistent storage for users & last signals ----------
async function ensureFile(filePath, defaultData) {
    try {
        await fs.access(filePath);
    } catch {
        await fs.writeFile(filePath, JSON.stringify(defaultData, null, 2), 'utf8');
    }
}

async function loadUsers() {
    await ensureFile(USERS_FILE, {});
    try {
        const raw = await fs.readFile(USERS_FILE, 'utf8');
        return JSON.parse(raw || '{}');
    } catch (e) {
        console.error('Failed load users:', e.message);
        return {};
    }
}

async function saveUsers(obj) {
    try {
        await fs.writeFile(USERS_FILE, JSON.stringify(obj, null, 2), 'utf8');
    } catch (e) {
        console.error('Failed save users:', e.message);
    }
}

async function loadLastSignals() {
    await ensureFile(LAST_SIGNALS_FILE, {});
    try {
        const raw = await fs.readFile(LAST_SIGNALS_FILE, 'utf8');
        return JSON.parse(raw || '{}');
    } catch (e) {
        console.error('Failed load last_signals:', e.message);
        return {};
    }
}

async function saveLastSignals(obj) {
    try {
        await fs.writeFile(LAST_SIGNALS_FILE, JSON.stringify(obj, null, 2), 'utf8');
    } catch (e) {
        console.error('Failed save last_signals:', e.message);
    }
}

// ---------- Helper: vietnam time ----------
function getVietnamTime() {
    return moment().tz("Asia/Ho_Chi_Minh");
}

// ---------- Message formatting ----------
function fmtNum(num) {
    if (num === undefined || num === null || isNaN(Number(num))) return 'N/A';
    const v = Number(num);
    if (v >= 1) return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
    return v.toFixed(8).replace(/\.?0+$/, '');
}

function formatSignalMessage(data, signalIndex) {
    const icon = data.direction === 'LONG' ? '🟢' : '🔴';
    const conf = data.confidence !== undefined ? `${data.confidence}%` : (data.meta && data.meta.confidence ? `${data.meta.confidence}%` : 'N/A');

    const msg = `🤖 Tín hiệu [${signalIndex} trong ngày] - AI TRADING V5 Pro
#${data.symbol.replace('USDT','')} – [${data.direction}] 📌

${icon} Entry: ${fmtNum(data.entry)}
🆗 Take Profit: ${fmtNum(data.tp)}
🙅‍♂️ Stop-Loss: ${fmtNum(data.sl)}
🪙 Tỉ lệ RR: ${data.rr || '-'} (Conf: ${conf})

🧠 By Bot [AI TRADING V5 Pro]

⚠️ Quy tắc: tối đa 2% risk/lệnh. Bot là tham khảo — không thay quản lý vốn. Bot cố gắng giữ RR trong khoảng 1.5 - 3.0 (ưu tiên 2.0).`;

    return msg;
}

// ---------- Broadcast with retries & prune blocked users ----------
async function broadcastToAllUsers(message) {
    const users = await loadUsers();
    let success = 0, fail = 0;
    const userIds = Object.keys(users);
    for (const id of userIds) {
        let retries = 0, sent = false;
        while (retries < 3 && !sent) {
            try {
                await bot.sendMessage(Number(id), message);
                sent = true;
                success++;
                await new Promise(r => setTimeout(r, 80));
            } catch (e) {
                retries++;
                console.warn(`Failed to send to ${id} (attempt ${retries}): ${e.message}`);
                if (e.response && (e.response.statusCode === 403 || e.response.statusCode === 410)) {
                    delete users[id];
                    await saveUsers(users);
                    console.log(`Removed blocked user ${id}`);
                    sent = true;
                    fail++;
                    break;
                }
                if (retries < 3) await new Promise(r => setTimeout(r, 1000 * retries));
                else fail++;
            }
        }
    }
    return { success, fail };
}

// ---------- Duplicate suppression ----------
async function shouldSendSignal(symbol) {
    const lastSignals = await loadLastSignals();
    const key = symbol.toUpperCase();
    if (!lastSignals[key]) return true;
    const lastTs = lastSignals[key]; // epoch seconds
    const now = Math.floor(Date.now() / 1000);
    if ((now - lastTs) < DUPLICATE_WINDOW_SECONDS) return false;
    return true;
}

async function markSignalSent(symbol) {
    const lastSignals = await loadLastSignals();
    lastSignals[symbol.toUpperCase()] = Math.floor(Date.now() / 1000);
    await saveLastSignals(lastSignals);
}

// ---------- Auto analysis main loop ----------
async function runAutoAnalysis() {
    if (isAutoAnalysisRunning) {
        console.log('⏳ Auto analysis already running, skip this cycle.');
        return;
    }
    isAutoAnalysisRunning = true;

    try {
        const now = getVietnamTime();
        const hour = now.hours();
        const minute = now.minutes();

        // Operating hours: keep same 04:00 - 23:30
        if (hour < 4 || (hour === 23 && minute > 30)) {
            console.log('💤 Out of operating hours (04:00 - 23:30), skip.');
            isAutoAnalysisRunning = false;
            return;
        }

        const users = await loadUsers();
        if (Object.keys(users).length === 0) {
            console.log('👥 No subscribers, skipping analysis.');
            isAutoAnalysisRunning = false;
            return;
        }

        console.log(`🔄 Starting Auto Analysis at ${now.format('HH:mm')} for ${Object.keys(users).length} users`);
        let signalsFound = 0;

        for (let i = 0; i < TARGET_COINS.length; i++) {
            const coin = TARGET_COINS[i];
            try {
                console.log(`🔍 Analyzing ${coin} (${i+1}/${TARGET_COINS.length})`);
                const result = await analyzeSymbol(coin);

                if (result && result.direction && result.direction !== 'NO_TRADE' && result.direction !== 'NEUTRAL') {
                    const conf = result.confidence || (result.meta && result.meta.confidence) || 0;
                    if (conf >= 60) {
                        const okToSend = await shouldSendSignal(result.symbol);
                        if (!okToSend) {
                            console.log(`⏭️ Skip ${result.symbol}: recently signaled within ${DUPLICATE_WINDOW_SECONDS/60} minutes`);
                        } else {
                            signalCountToday++;
                            signalsFound++;
                            const msg = formatSignalMessage(result, signalCountToday);
                            await broadcastToAllUsers(msg);
                            await markSignalSent(result.symbol);
                            console.log(`✅ Sent signal for ${result.symbol} (${result.direction}) conf=${conf}%`);
                            await new Promise(r => setTimeout(r, 2000));
                        }
                    } else {
                        console.log(`⏭️ ${coin}: confidence ${conf}% < 60%`);
                    }
                } else {
                    console.log(`➖ No signal for ${coin}: ${result?.direction || 'NO_TRADE'}`);
                }
            } catch (coinErr) {
                console.error(`❌ Error analyzing ${coin}: ${coinErr.message}`);
                if (String(coinErr.message).includes('429') || String(coinErr.message).includes('418')) {
                    consecutiveErrors++;
                    console.log(`🚨 Consecutive errors: ${consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}`);
                    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
                        console.log('🔌 Circuit breaker triggered — sleeping 10 minutes before next cycles');
                        setTimeout(() => { consecutiveErrors = 0; console.log('🔋 Circuit breaker reset'); }, 10 * 60 * 1000);
                        break;
                    }
                } else {
                    consecutiveErrors = 0;
                }
            }

            // politeness delay between coins (3s)
            await new Promise(r => setTimeout(r, 3000));
        }

        console.log(`🎯 Auto analysis finished — signalsFound=${signalsFound}`);
    } catch (err) {
        console.error('💥 Critical error in runAutoAnalysis:', err.message);
    } finally {
        isAutoAnalysisRunning = false;
    }
}

// ---------- Scheduling ----------
setInterval(runAutoAnalysis, ANALYSIS_INTERVAL);
setTimeout(() => { runAutoAnalysis(); }, START_DELAY_MS);

// ---------- Morning greeting (daily at 07:00 Asia/Ho_Chi_Minh) ----------
async function sendMorningGreetingIfNeeded() {
    try {
        const now = getVietnamTime();
        const hour = now.hours(), minute = now.minutes();
        // target 07:00
        if (hour === 7 && minute === 0) {
            const lastSignals = await loadLastSignals();
            const lastMorning = lastSignals.lastMorningSent || null;
            const today = now.format('YYYY-MM-DD');
            if (lastMorning === today) return; // already sent today
            const users = await loadUsers();
            if (Object.keys(users).length === 0) return;
            const message = [
                "🌅 Chào buổi sáng, Traders!",
                "Bot AI Trading V5 Pro chúc bạn một phiên giao dịch hiệu quả.",
                "Hãy tuân thủ quản lý rủi ro (khuyến nghị ≤ 2% mỗi lệnh). Gõ /analyzeall để yêu cầu phân tích toàn bộ danh sách, /analyzesymbol SYMBOL để phân tích 1 coin.",
                "Chúc một ngày thắng lợi! 🚀"
            ].join('\n\n');
            await broadcastToAllUsers(message);
            lastSignals.lastMorningSent = today;
            await saveLastSignals(lastSignals);
            console.log('🌞 Morning greeting sent to subscribers');
        }
    } catch (e) {
        console.error('Morning greeting error:', e.message);
    }
}
// check every minute
setInterval(sendMorningGreetingIfNeeded, 60 * 1000);

// ---------- Bot commands ----------

// /start - đăng ký nhận tin
bot.onText(/\/start/, async (msg) => {
    try {
        const chatId = msg.chat.id;
        const user = msg.from;
        const users = await loadUsers();
        users[chatId] = {
            id: user.id,
            username: user.username || null,
            first_name: user.first_name || null,
            addedAt: new Date().toISOString()
        };
        await saveUsers(users);

        const welcome = `👋 Chào ${user.first_name || 'Trader'}!\n\n` +
            `Bạn đã được đăng ký nhận tín hiệu tự động từ AI Trading Bot V5 Pro.\n` +
            `Gõ /analyzesymbol SYMBOL để phân tích thủ công hoặc /analyzeall để quét toàn bộ danh sách.\n\n` +
            `⚠️ Bot chỉ gửi tín hiệu tham khảo — luôn tuân thủ quản lý rủi ro.`;

        await bot.sendMessage(chatId, welcome);
        console.log(`✅ Subscribed user ${chatId} (${user.username || user.first_name})`);
    } catch (e) {
        console.error('/start handler error:', e.message);
    }
});

// /stop - hủy đăng ký
bot.onText(/\/stop/, async (msg) => {
    try {
        const chatId = msg.chat.id;
        const users = await loadUsers();
        if (users[chatId]) {
            delete users[chatId];
            await saveUsers(users);
            await bot.sendMessage(chatId, '🗑️ Bạn đã hủy đăng ký nhận tín hiệu. Gõ /start để đăng ký lại.');
            console.log(`User unsubscribed ${chatId}`);
        } else {
            await bot.sendMessage(chatId, 'Bạn chưa đăng ký nhận tín hiệu. Gõ /start để đăng ký.');
        }
    } catch (e) {
        console.error('/stop handler error:', e.message);
    }
});

// /analyzesymbol SYMBOL - phân tích thủ công 1 coin
bot.onText(/\/analyzesymbol (.+)/, async (msg, match) => {
    const chatId = msg.chat.id;
    const symbolRaw = match[1].toUpperCase().trim();
    let symbol = symbolRaw.endsWith('USDT') ? symbolRaw : `${symbolRaw}USDT`;
    try {
        const processing = await bot.sendMessage(chatId, `⏳ Đang phân tích ${symbol}...`);
        const result = await analyzeSymbol(symbol);
        if (result && result.direction && result.direction !== 'NO_TRADE' && result.direction !== 'NEUTRAL') {
            const content = formatSignalMessage(result, 'MANUAL');
            await bot.deleteMessage(chatId, processing.message_id).catch(()=>{});
            await bot.sendMessage(chatId, content);
        } else {
            await bot.editMessageText(`❌ Không tìm thấy tín hiệu cho ${symbol}\nReason: ${result?.reason || 'No trade'}`, { chat_id: chatId, message_id: processing.message_id });
        }
    } catch (e) {
        console.error('/analyzesymbol error:', e.message);
        try { await bot.sendMessage(chatId, `❌ Lỗi phân tích ${symbol}: ${e.message}`); } catch {}
    }
});

// /analyzeall - phân tích toàn bộ TARGET_COINS (accessible to any user)
bot.onText(/\/analyzeall/, async (msg) => {
    const chatId = msg.chat.id;
    try {
        const processing = await bot.sendMessage(chatId, `⏳ Đang phân tích ${TARGET_COINS.length} coins... Vui lòng chờ (có thể lâu vài phút).`);
        let results = [];
        for (let i = 0; i < TARGET_COINS.length; i++) {
            const coin = TARGET_COINS[i];
            try {
                const res = await analyzeSymbol(coin);
                if (res && res.direction && res.direction !== 'NO_TRADE' && res.confidence >= 60) {
                    results.push(res);
                }
            } catch (e) {
                console.warn(`Analyze ${coin} failed: ${e.message}`);
            }
            await new Promise(r => setTimeout(r, 1200));
        }
        await bot.deleteMessage(chatId, processing.message_id).catch(()=>{});
        if (results.length === 0) {
            await bot.sendMessage(chatId, '❌ Không tìm thấy tín hiệu (confidence ≥ 60%) trên toàn bộ danh sách.');
        } else {
            results = results.sort((a,b)=> (b.confidence||0)-(a.confidence||0)).slice(0, 20);
            let text = `🔍 KẾT QUẢ PHÂN TÍCH TOÀN BỘ (${results.length} tín hiệu, hiển thị tối đa 20)\n\n`;
            for (const r of results) {
                text += `#${r.symbol.replace('USDT','')} - ${r.direction} - Conf: ${r.confidence}%\nEntry: ${fmtNum(r.entry)} | SL: ${fmtNum(r.sl)} | TP: ${fmtNum(r.tp)} | RR: ${r.rr}\n\n`;
            }
            await bot.sendMessage(chatId, text);
        }
    } catch (e) {
        console.error('/analyzeall error:', e.message);
        try { await bot.sendMessage(chatId, `❌ Lỗi: ${e.message}`); } catch {}
    }
});

// /morning - gửi chào buổi sáng thủ công cho requester (và có thể broadcast nếu admin muốn)
bot.onText(/\/morning/, async (msg) => {
    try {
        const chatId = msg.chat.id;
        const message = [
            "🌅 Chào buổi sáng!",
            "Bot AI Trading V5 Pro chúc bạn phiên giao dịch hiệu quả. Gõ /analyzeall để quét danh sách hoặc /analyzesymbol SYMBOL để phân tích 1 coin.",
            "Tuân thủ quản lý rủi ro (khuyến nghị ≤ 2% mỗi lệnh)."
        ].join('\n\n');
        await bot.sendMessage(chatId, message);
    } catch (e) {
        console.error('/morning error:', e.message);
    }
});

// /users - list subscribers (for owner only if you want, currently open)
bot.onText(/\/users/, async (msg) => {
    try {
        const users = await loadUsers();
        const total = Object.keys(users).length;
        let text = `📊 Subscribers: ${total}\n\n`;
        for (const id of Object.keys(users).slice(0, 100)) {
            const u = users[id];
            text += `- ${id} ${u.username ? `(@${u.username})` : ''} added: ${u.addedAt}\n`;
        }
        await bot.sendMessage(msg.chat.id, text);
    } catch (e) {
        console.error('/users error:', e.message);
    }
});

console.log('🤖 Bot running. Auto analysis every 1.5 hours (active window 04:00-23:30). V5 Pro with morning greeting.');
