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
const QRCode = require('qrcode');

// otplibの実装
const { authenticator } = require('@otplib/preset-default');

const configPath = path.join(__dirname, 'config.json');

const defaultConfig = {
    photoReplyMessage: '📷 画像を受け取りました！ありがとうございます。\n他にも画像があれば続けて送ってください。',
    orderMessageTemplate: '📋 注文番号: {orderId}\n\n📷 この後に画像を送ってください。\n複数枚でも OK です。\n\nご利用ありがとうございます。',
    totpSecret: null // Google Authenticatorの秘密鍵
};

// ==========================================
// 簡易セッショントークン（メモリ管理: 再起動でリセットされるが静的ページ用としては十分）
// ==========================================
const validTokens = new Set();
const TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24時間

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

// ==========================================
// TOTP 認証関連のエンドポイント
// ==========================================

// 1. 初回設定（秘密鍵の生成とQRコードの返却）
app.get('/api/auth/setup', async (req, res) => {
    // 既に設定済みの場合は既存のシークレットを返す（再設定用）
    const secret = currentConfig.totpSecret || authenticator.generateSecret();

    if (!currentConfig.totpSecret) {
        currentConfig.totpSecret = secret;
        saveConfig(currentConfig);
    }

    const otpauthUrl = authenticator.keyuri('Admin', 'LINE Order System', secret);

    try {
        const qrImageUrl = await QRCode.toDataURL(otpauthUrl);

        // ブラウザから直接アクセスされた場合はHTML画面を返す
        if (req.accepts('html')) {
            return res.send(`
                <!DOCTYPE html>
                <html lang="ja">
                <head>
                    <meta charset="UTF-8">
                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                    <title>TOTP 初期設定</title>
                    <style>
                        body { font-family: sans-serif; background: #0f1724; color: #fff; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
                        .card { background: white; color: #333; padding: 32px; border-radius: 12px; text-align: center; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
                        img { max-width: 250px; margin: 16px 0; }
                    </style>
                </head>
                <body>
                    <div class="card">
                        <h2>🔒 認証アプリの設定</h2>
                        <p>Google Authenticator 等で以下のQRコードを読み取ってください。</p>
                        <img src="${qrImageUrl}" alt="TOTP QR Code">
                        <p style="font-size: 0.85rem; color: #666;">読み取ったら、元のQRコード生成ページに戻って<br>アプリに表示された6桁の数字を入力してください。</p>
                    </div>
                </body>
                </html>
            `);
        }

        // アプリからのAPIアクセスの場合はJSON
        res.json({ success: true, qr: qrImageUrl, secret });
    } catch (e) {
        console.error('Failed to generate TOTP QR:', e);
        if (req.accepts('html')) return res.status(500).send('エラーが発生しました');
        res.status(500).json({ error: 'QRコードの生成に失敗しました' });
    }
});

// 2. 認証（Authenticatorの6桁コードを検証してトークンを発行）
app.use('/api/auth/verify', express.json());
app.post('/api/auth/verify', (req, res) => {
    const { token } = req.body; // 6桁のコード

    if (!currentConfig.totpSecret) {
        return res.status(400).json({ error: 'まだ初期設定が完了していません' });
    }

    try {
        const isValid = authenticator.verify({ token, secret: currentConfig.totpSecret });
        if (isValid) {
            // ランダムな認証済みトークンを発行
            const sessionToken = Math.random().toString(36).substring(2) + Date.now().toString(36);
            validTokens.add(sessionToken);

            // 24時間後に無効化
            setTimeout(() => validTokens.delete(sessionToken), TOKEN_EXPIRY_MS);

            return res.json({ success: true, sessionToken });
        }
    } catch (e) {
        console.error('TOTP verification error:', e);
    }

    return res.status(401).json({ error: 'コードが正しくありません' });
});

// 設定の取得 (認証不要・UI表示用)
app.get('/api/config', (req, res) => {
    // シークレットは返さない
    const safeConfig = { ...currentConfig };
    delete safeConfig.totpSecret;
    res.json(safeConfig);
});

// 設定の更新
app.use('/api/config', express.json());
app.post('/api/config', (req, res) => {
    // 簡易トークンチェック
    const authHeader = req.headers.authorization;
    const sessionToken = authHeader && authHeader.split(' ')[1];

    if (!sessionToken || !validTokens.has(sessionToken)) {
        console.log('❌ Unauthorized config update attempt');
        return res.status(401).json({ error: '認証の有効期限が切れています' });
    }

    if (req.body.photoReplyMessage !== undefined) {
        currentConfig.photoReplyMessage = req.body.photoReplyMessage;
    }
    if (req.body.orderMessageTemplate !== undefined) {
        currentConfig.orderMessageTemplate = req.body.orderMessageTemplate;
    }
    saveConfig(currentConfig);
    console.log('✅ Config updated and saved');
    // シークレットは返さない
    const safeConfig = { ...currentConfig };
    delete safeConfig.totpSecret;
    res.json({ success: true, config: safeConfig });
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
