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

/** Telegram sendMessage 하드 제한 (서버측 4096 UTF-16 코드유닛) */
const TELEGRAM_MAX_LENGTH = 4096;
/** 마운드다운 파싱 실패를 고려한 안전 여유 (헤더/각주 공간 확보) */
const CHUNK_SIZE = 3900;

/**
 * 메시지를 Telegram 제한 이하로 분할한다.
 * [P0-4] 기존 구현은 청크 분할이 없어 장문 보고가
 *   `Bad Request: message is too long` 로 실패했다. 마크다운 → 평문 재시도도
 *   길이를 줄이지 못해 동일 실패했다.
 * 코드펜스(```)와 굵게/기울임 표식을 쪼개지 않도록 경계를 조정한다.
 * @param {string} message
 * @param {number} [limit]
 * @returns {string[]}
 */
export function splitMessage(message, limit = CHUNK_SIZE) {
  const text = String(message ?? '');
  if (text.length <= limit) return [text];

  const lines = text.split('\n');
  const chunks = [];
  let current = '';
  let inFence = false;

  const flush = () => {
    if (current.trim()) chunks.push(current);
    current = '';
  };

  for (const line of lines) {
    // 코드펜스 개행 균형: 분할 경계가 ``` 사이에 생기면 마크다운이 깨진다
    if (line.trimStart().startsWith('```')) inFence = !inFence;

    // 한 줄이 통째로 limit 을 넘으면(예: 장문 단일 문단) 강제로 잘라낸다
    if (line.length > limit) {
      flush();
      for (let i = 0; i < line.length; i += limit) {
        const piece = line.slice(i, i + limit);
        if (current) {
          flush();
        }
        current = piece;
      }
      continue;
    }

    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > limit && current) {
      flush();
      current = inFence ? '```\n' + line : line;
    } else {
      current = candidate;
    }
  }
  flush();

  // 코드펜스 닫힘 보정
  return chunks.map((c, i) => {
    const opens = (c.match(/```/g) || []).length;
    if (opens % 2 === 1) return c + '\n```';
    return c;
  });
}

/** Telegram API 단일 전송 (마크다운 → 평문 폴백) */
async function sendChunk(botToken, chatId, text, extra) {
  const post = (payload) =>
    fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

  let res = await post({ chat_id: chatId, text, parse_mode: 'Markdown', ...extra });
  let data = await res.json();

  if (!data.ok) {
    // 마크다운 파싱 실패일 수 있으므로 표식을 제거해 1회 재시도
    console.warn('Telegram 마크다운 전송 실패로 일반 텍스트 모드로 재시도합니다:', data.description);
    res = await post({ chat_id: chatId, text: text.replace(/[*_`]/g, ''), ...extra });
    data = await res.json();
  }
  return data;
}

export async function sendTelegramReport(message, extra = {}) {
  const config = getTelegramConfig();
  if (!config) {
    console.warn('⚠️ Telegram 설정이 .env에 없어 알림 발송을 건너뜁니다.');
    return false;
  }

  try {
    const chunks = splitMessage(message);
    if (chunks.length > 1) {
      console.warn(`⚠️ 메시지가 ${TELEGRAM_MAX_LENGTH}자를 초과해 ${chunks.length}개로 분할 전송합니다.`);
    }

    let allOk = true;
    for (let i = 0; i < chunks.length; i++) {
      const total = chunks.length;
      const header = total > 1 ? `📄 *(${i + 1}/${total})*\n\n` : '';
      const footer = total > 1 ? `\n\n_(${i + 1}/${total} 끝)_` : '';
      const body = header + chunks[i] + footer;

      // 분할 후에도 제한을 넘을 경우 (헤더/각주 포함) 방어적으로 재분할
      const parts = body.length > TELEGRAM_MAX_LENGTH ? splitMessage(body, TELEGRAM_MAX_LENGTH - 300) : [body];
      for (const part of parts) {
        const data = await sendChunk(config.botToken, config.chatId, part, extra);
        if (!data.ok) {
          console.error(`Telegram API 오류 (청크 ${i + 1}/${chunks.length}):`, data.description);
          allOk = false;
        }
        // Telegram flood control 회피
        if (parts.length > 1 || i < chunks.length - 1) {
          await new Promise((r) => setTimeout(r, 600));
        }
      }
    }
    return allOk;
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
