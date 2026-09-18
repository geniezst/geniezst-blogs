#!/usr/bin/env node
/**
 * 텔레그램 알림 발송 모듈
 * 사용법: 
 *   node scripts/telegram-notify.mjs "보낼 메시지"
 *   또는 import { sendTelegramReport } from './telegram-notify.mjs'
 */

import fs from 'node:fs';
import path from 'node:path';

function getTelegramConfig() {
  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID) {
    return {
      botToken: process.env.TELEGRAM_BOT_TOKEN.trim(),
      chatId: process.env.TELEGRAM_CHAT_ID.trim(),
    };
  }

  const candidatePaths = [
    path.resolve(import.meta.dirname, '..', '.env'),
    path.resolve('/workspace/.env'),
    path.resolve(process.cwd(), '.env'),
  ];

  for (const envPath of candidatePaths) {
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, 'utf8');
      const tokenMatch = envContent.match(/TELEGRAM_BOT_TOKEN=["']?([^"'\n]+)["']?/);
      const chatMatch = envContent.match(/TELEGRAM_CHAT_ID=["']?([^"'\n]+)["']?/);
      if (tokenMatch && chatMatch) {
        return {
          botToken: tokenMatch[1].trim(),
          chatId: chatMatch[1].trim(),
        };
      }
    }
  }
  return null;
}

export async function sendTelegramReport(message) {
  const config = getTelegramConfig();
  if (!config) {
    console.warn('⚠️ Telegram 설정이 .env에 없어 알림 발송을 건너뜁니다.');
    return false;
  }

  try {
    let res = await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: config.chatId,
        text: message,
        parse_mode: 'Markdown',
      }),
    });

    let data = await res.json();
    if (!data.ok) {
      console.warn('Telegram 마크다운 전송 실패로 일반 텍스트 모드로 재시도합니다:', data.description);
      res = await fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: config.chatId,
          text: message.replace(/[*_`]/g, ''),
        }),
      });
      data = await res.json();
    }

    if (!data.ok) {
      console.error('Telegram API 오류:', data.description);
      return false;
    }
    return true;
  } catch (err) {
    console.error('Telegram 발송 실패:', err.message);
    return false;
  }
}

// CLI 직접 실행 시
if (process.argv[1] && process.argv[1].endsWith('telegram-notify.mjs')) {
  const msg = process.argv[2];
  if (msg) {
    sendTelegramReport(msg).then((success) => {
      process.exit(success ? 0 : 1);
    });
  }
}
