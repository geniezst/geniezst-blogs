#!/usr/bin/env node
/**
 * [SHARED] LLM 호출 계층 (Gemini 네이티브 단일 경로)
 *
 * [왜 필요한가]
 * 1) Groq API 키가 401 Invalid API Key를 반환하는데도 매 세션마다 1순위로 호출되어
 *    의미 없는 요청 + 지연을 발생시켰다. (로그 전 기간 지속) → Groq 단계 제거.
 * 2) 저녁 심층글은 아직 OpenAI 호환 엔드포인트에 `max_tokens` 하드캡을 두었고
 *    `finish_reason` 을 전혀 검사하지 않아, 잘린 글이 "성공"으로 발행되었다.
 *    실제 사례: 2,020자 / H2 3개 글이 심층 가이드로 D1에 등록됨.
 * 3) 오전 다이제스트만 이미 네이티브 API + thinkingBudget:0 으로 이식되어 있었으나
 *    저녁 글은 뒤처져 있었다. → 양쪽을 이 모듈 하나로 통일.
 *
 * [핵심]
 * - thinkingConfig.thinkingBudget = 0 으로 추론 토큰 낭비/잘림 원천 차단
 * - finishReason === 'MAX_TOKENS' 를 감지해 truncated=true 로 표면화 (조용한 성공 금지)
 *
 * 공용 모듈: /workspace/projects/{blog,blogs}/scripts/lib/llm.mjs (동일 사본)
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * 다중 경로 .env 로더 (기존 loadEnvConfig 와 동일 규약)
 * @param {string[]} candidates
 */
export function loadEnvConfig(candidates) {
  const env = { ...process.env };
  for (const envPath of candidates) {
    if (!envPath || !fs.existsSync(envPath)) continue;
    try {
      for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq === -1) continue;
        const key = trimmed.slice(0, eq).trim();
        let val = trimmed.slice(eq + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1);
        }
        if (!env[key]) env[key] = val;
      }
    } catch (_) {}
  }
  return env;
}

/** 블로그 표준 .env 탐색 경로 */
export function blogEnvCandidates(blogRoot) {
  return [
    path.resolve('/workspace/.env'),
    path.resolve('/workspace/scripts/.env'),
    path.join(blogRoot, '.env'),
    path.resolve(process.cwd(), '.env'),
  ];
}

// gemini-2.5-* 계열은 신규 계정에서 404(deprecated)로 차단되어 제거함 (2026-09-29).
// flash-latest는 3.8 Flash로 매핑되며, 3.8을 명시 폴백으로 두어 alias 일시적 503에 대비한다.
const DEFAULT_MODELS = ['gemini-flash-latest', 'gemini-3.8-flash'];

// 503/429/5xx 는 모델 문제가 아니라 엔드포인트의 일시적 수치 부족이다.
// 모델을 바꿔도 동일하게 실패하므로, 다음 모델로 넘어가기 전에 같은 모델을 재시도해야 한다.
const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Gemini 네이티브 API 단일 호출 (모델 fallback 체인 내장)
 *
 * @param {object} p
 * @param {string} p.systemPrompt
 * @param {string} p.userPrompt
 * @param {object} p.env
 * @param {number} [p.maxOutputTokens=16384]
 * @param {number} [p.temperature=0.6]
 * @param {number} [p.timeoutMs=180000]
 * @param {number} [p.transientRetry=3] 503/429 등 일시 오류 시 동일 모델 backoff 재시도 횟수
 * @param {(msg: string) => void} [p.log]
 * @returns {Promise<{ text: string, model: string, usage: object }>}
 * @throws {Error} 모든 모델 실패 시. 잘림(MAX_TOKENS)이면 `err.truncated === true`
 */
export async function callGemini({
  systemPrompt,
  userPrompt,
  env,
  maxOutputTokens = 16384,
  temperature = 0.6,
  timeoutMs = 180000,
  transientRetry = 3,
  log = () => {},
}) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY가 설정되지 않았습니다. /workspace/.env 또는 프로젝트 .env 를 확인하세요.');
  }

  const base = (env.GEMINI_API_URL || 'https://generativelanguage.googleapis.com/v1beta')
    .replace(/\/+$/, '')
    .replace(/\/openai$/i, '');

  // GEMINI_MODEL이 DEFAULT_MODELS와 겹칠 수 있으므로 중복 제거 (동일 모델 재시도 방지)
  const models = [...new Set([env.GEMINI_MODEL, ...DEFAULT_MODELS].filter(Boolean))];
  let lastError = null;

  for (const model of models) {
    const url = `${base}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;

    for (let attempt = 0; attempt <= transientRetry; attempt++) {
      log(
        attempt === 0
          ? `🧠 [LLM] Gemini 네이티브 호출 (${model}, thinkingBudget: 0, maxOutputTokens: ${maxOutputTokens})...`
          : `🔄 [LLM] 일시 오류 재시도 ${attempt}/${transientRetry} (${model})...`
      );

      try {
        const body = {
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig: {
            temperature,
            maxOutputTokens,
            thinkingConfig: { thinkingBudget: 0 },
          },
        };
        if (systemPrompt) {
          body.systemInstruction = { parts: [{ text: systemPrompt }] };
        }

        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (!res.ok) {
          const errText = (await res.text().catch(() => '')).slice(0, 200);
          lastError = new Error(`Gemini ${model} HTTP ${res.status}: ${errText}`);

          // 503/429 등은 전체 엔드포인트의 일시적 수치 부족이며 모델을 바꿔도 동일하다.
          // 다음 모델로 넘어가기 전에 동일 모델을 backoff 로 재시도한다.
          if (TRANSIENT_STATUS.has(res.status) && attempt < transientRetry) {
            const waitMs = 2000 * 2 ** attempt;
            log(`⚠️ [LLM] ${res.status} 일시 오류 — ${waitMs}ms 후 동일 모델 재시도`);
            await sleep(waitMs);
            continue;
          }

          log(`⚠️ [LLM] Gemini ${model} HTTP ${res.status}: ${errText} → 다음 모델 시도`);
          break;
        }

        const data = await res.json();
        const candidate = data?.candidates?.[0];
        const finishReason = candidate?.finishReason;
        const text = (candidate?.content?.parts || [])
          .map((p) => p.text || '')
          .join('')
          .trim();

        log(
          `📊 [LLM] Gemini ${model} 응답 완료 — finishReason: ${finishReason}, ` +
            `글자 수: ${text.length}, usage:`,
          data?.usageMetadata || {}
        );

        if (!text) {
          lastError = new Error(`Gemini ${model} 이 빈 응답을 반환했습니다. (${errBlock(data)})`);
          log(`⚠️ [LLM] ${lastError.message} → 다음 모델 시도`);
          break;
        }

        if (finishReason === 'MAX_TOKENS') {
          // 조용히 성공시키지 않는다. 호출자가 재시도/중단을 결정할 수 있게 표면화한다.
          const err = new Error(
            `Gemini ${model} 응답이 maxOutputTokens(${maxOutputTokens}) 에서 잘렸습니다 ` +
              `(수신 ${text.length}자). 분량을 줄이거나 maxOutputTokens 를 늘려 재시도해야 합니다.`
          );
          err.truncated = true;
          err.model = model;
          err.partialText = text;
          log(`⛔ [LLM] ${err.message}`);
          throw err;
        }

        return { text, model, usage: data?.usageMetadata || {} };
      } catch (err) {
        if (err.truncated) throw err; // 잘림은 다음 모델로 넘기지 않고 즉시 표면화
        lastError = err;
        if (attempt < transientRetry) {
          const waitMs = 2000 * 2 ** attempt;
          log(`⚠️ [LLM] ${model} 예외: ${err.message} — ${waitMs}ms 후 동일 모델 재시도`);
          await sleep(waitMs);
          continue;
        }
        log(`⚠️ [LLM] Gemini ${model} 예외: ${err.message} → 다음 모델 시도`);
        break;
      }
    }
  }

  throw lastError || new Error('모든 Gemini 모델 호출이 실패했습니다.');
}

function errBlock(data) {
  const p = data?.promptFeedback?.blockReason || data?.error?.message;
  return p ? String(p).slice(0, 160) : '사유 미상';
}

export default callGemini;
