require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');

// ==========================================
// LINE Messaging API Configuration
// ==========================================
const config = {
    channelAccessToken: process.env.CHANNEL_ACCESS_TOKEN,
    channelSecret: process.env.CHANNEL_SECRET,
};

const client = new line.messagingApi.MessagingApiClient({
    channelAccessToken: config.channelAccessToken,
});

const app = express();

// CORS
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// ==========================================
// メッセージ設定（ファイル保存）
// ==========================================
const fs = require('fs');
const path = require('path');
const configPath = path.join(__dirname, 'config.json');

const defaultConfig = {
    photoReplyMessage: '📷 画像を受け取りました！ありがとうございます。\n他にも画像があれば続けて送ってください。',
    orderMessageTemplate: '📋 注文番号: {orderId}\n\n📷 この後に画像を送ってください。\n複数枚でも OK です。\n\nご利用ありがとうございます。',
};

// 設定を読み込む関数
function loadConfig() {
    try {
        if (fs.existsSync(configPath)) {
            const data = fs.readFileSync(configPath, 'utf8');
            return { ...defaultConfig, ...JSON.parse(data) };
        }
    } catch (e) {
        console.error('Failed to load config.json:', e);
    }
    return { ...defaultConfig };
}

// 設定を保存する関数
function saveConfig(configData) {
    try {
        fs.writeFileSync(configPath, JSON.stringify(configData, null, 2), 'utf8');
    } catch (e) {
        console.error('Failed to save config.json:', e);
    }
}

// 起動時にロード
let currentConfig = loadConfig();

// 設定の取得
app.get('/api/config', (req, res) => {
    res.json(currentConfig);
});

// 設定の更新
app.use('/api/config', express.json());
app.post('/api/config', (req, res) => {
    const adminPassword = process.env.ADMIN_PASSWORD || 'admin1234'; // 環境変数から取得、なければデフォルト

    // パスワードチェック
    if (req.body.password !== adminPassword) {
        console.log('❌ Unauthorized config update attempt');
        return res.status(401).json({ error: 'パスワードが間違っています' });
    }

    if (req.body.photoReplyMessage !== undefined) {
        currentConfig.photoReplyMessage = req.body.photoReplyMessage;
    }
    if (req.body.orderMessageTemplate !== undefined) {
        currentConfig.orderMessageTemplate = req.body.orderMessageTemplate;
    }
    saveConfig(currentConfig);
    console.log('✅ Config updated and saved');
    res.json({ success: true, config: currentConfig });
});

// ==========================================
// Webhook endpoint (LINE からの通知)
// ==========================================
app.post('/webhook', line.middleware(config), (req, res) => {
    console.log('📥 Webhook received:', JSON.stringify(req.body.events.map(e => ({
        type: e.type,
        messageType: e.message?.type,
    }))));
    Promise.all(req.body.events.map(handleEvent))
        .then(() => res.json({ success: true }))
        .catch((err) => {
            console.error('Webhook error:', err);
            res.status(500).end();
        });
});

// ==========================================
// 注文番号 Push メッセージ送信 (LIFF から呼び出し)
// ==========================================
app.use('/api/send-order', express.json());
app.post('/api/send-order', async (req, res) => {
    const { userId, orderId, orderMessage } = req.body;

    if (!userId || !orderId) {
        return res.status(400).json({ error: 'userId と orderId が必要です' });
    }

    console.log(`📤 Sending order message: orderId=${orderId}, userId=${userId}`);

    // カスタムメッセージがあればそれを使う、なければデフォルト
    let messageText = orderMessage || currentConfig.orderMessageTemplate;
    // {orderId} プレースホルダーを置換
    messageText = messageText.replace(/\{orderId\}/g, orderId);

    try {
        await client.pushMessage({
            to: userId,
            messages: [{ type: 'text', text: messageText }],
        });

        console.log('✅ Push message sent successfully');
        res.json({ success: true });
    } catch (error) {
        console.error('❌ Push message failed:', error);
        res.status(500).json({ error: 'メッセージ送信に失敗しました' });
    }
});

// ==========================================
// Event handler (画像・ファイル受信の自動返信)
// ==========================================
async function handleEvent(event) {
    console.log('🔄 Processing event:', event.type, event.message?.type);

    if (event.type !== 'message') return null;

    // 画像・ファイルのみ自動返信
    if (['image', 'file'].includes(event.message.type)) {
        console.log(`📷 ${event.message.type} received, replying...`);
        return client.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: currentConfig.photoReplyMessage }],
        });
    }

    return null;
}

// ==========================================
// Health check
// ==========================================
app.get('/', (req, res) => {
    res.json({ status: 'ok', message: 'LINE Order Bot is running' });
});

// ==========================================
// Start server
// ==========================================
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`🤖 LINE Order Bot running on port ${PORT}`);
});
