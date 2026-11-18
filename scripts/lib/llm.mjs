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
  const env = {};
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
  // 프로세스 환경변수는 .env에 없는 키만 보충
  for (const [k, v] of Object.entries(process.env)) {
    if (!env[k] && v) env[k] = v;
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

// 블로그 자동 글 발행 모델: gemini-2.5-flash 단일 사용
const DEFAULT_MODELS = ['gemini-2.5-flash'];

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
 * @param {string[]} [p.models] 모델 체인을 직접 지정 (지정 시 GEMINI_MODEL/DEFAULT_MODELS 무시)
 * @param {number} [p.thinkingBudget=0] 추론 토큰 예산 (리서치·팩트체크 단계에서만 사용)
 * @param {number} [p.backoffBaseMs=2000] 503/429 재시도 대기 시작값 (지수 증가)
 * @param {boolean} [p.googleSearch=false] Google 검색 그라운딩 사용 (2026-10 기준 무료 키는 2.5-flash 만 허용)
 * @param {number} [p.frequencyPenalty=0] 같은 토큰 반복 억제 (0~2)
 *   ※ 2026-11-18 실측: 이 키의 gemini-2.5-flash 는 "Penalty is not enabled" 400 을 반환한다.
 *     기본값 0 이면 본문에 포함되지 않으므로 안전하다.
 * @param {number} [p.presencePenalty=0] 이미 등장한 토큰 재등장 억제 (0~2)
 * @param {boolean} [p.stream=true] SSE 스트리밍으로 받아 폭주(반복 문자)를 조기 차단
 * @param {number} [p.maxRepeatRun=400] 같은 문자 연속 허용 상한. 초과 시 runaway 로 즉시 중단
 * @param {number} [p.maxOutputChars=120000] 스트리밍 중 누적 글자 상한 (백스톱)
 * @returns {Promise<{ text: string, model: string, usage: object, grounding: { chunks: Array<{title: string, uri: string}>, queries: string[] } }>}
 * @throws {Error} 모든 모델 실패 시. 잘림(MAX_TOKENS)이면 `err.truncated === true`
 */
export async function callGemini({
  systemPrompt,
  userPrompt,
  env,
  maxOutputTokens = 16384,
  temperature = 0.6,
  timeoutMs = 180000,
  transientRetry = 4,
  log = () => {},
  models: modelChain = null,
  thinkingBudget = 0,
  googleSearch = false,
  backoffBaseMs = 2000,
  frequencyPenalty = 0,
  presencePenalty = 0,
  stream = true,
  maxRepeatRun = 400,
  maxOutputChars = 120000,
}) {
  const apiKey = env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY가 설정되지 않았습니다. /workspace/.env 또는 프로젝트 .env 를 확인하세요.');
  }

  const base = (env.GEMINI_API_URL || 'https://generativelanguage.googleapis.com/v1beta')
    .replace(/\/+$/, '')
    .replace(/\/openai$/i, '');

  // GEMINI_MODEL이 DEFAULT_MODELS와 겹칠 수 있으므로 중복 제거 (동일 모델 재시도 방지)
  const models = modelChain?.length
    ? [...new Set(modelChain)]
    : [...new Set([env.GEMINI_MODEL, ...DEFAULT_MODELS].filter(Boolean))];
  let lastError = null;

  for (const model of models) {
    // 스트리밍(alt=sse)으로 받아야 반복 문자 폭주를 생성 도중에 끊을 수 있다.
    // (2026-11-17: 비스트리밍에서는 641,551자 폭주가 끝난 뒤에야 감지되어 출력 토큰을 전부 낭비)
    const endpoint = stream ? 'streamGenerateContent?alt=sse' : 'generateContent';
    const url = `${base}/models/${model}:${endpoint}${endpoint.includes('?') ? '&' : '?'}key=${encodeURIComponent(apiKey)}`;

    for (let attempt = 0; attempt <= transientRetry; attempt++) {
      log(
        attempt === 0
          ? `🧠 [LLM] Gemini 네이티브 호출 (${model}, thinkingBudget: ${thinkingBudget}, maxOutputTokens: ${maxOutputTokens}${googleSearch ? ', google_search' : ''})...`
          : `🔄 [LLM] 일시 오류 재시도 ${attempt}/${transientRetry} (${model})...`
      );

      try {
        const body = {
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig: {
            temperature,
            maxOutputTokens,
            thinkingConfig: { thinkingBudget },
          },
        };
        if (frequencyPenalty) body.generationConfig.frequencyPenalty = frequencyPenalty;
        if (presencePenalty) body.generationConfig.presencePenalty = presencePenalty;
        if (googleSearch) body.tools = [{ google_search: {} }];
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
          const fullText = await res.text().catch(() => '');
          const errText = fullText.slice(0, 200);
          lastError = new Error(`Gemini ${model} HTTP ${res.status}: ${errText}`);
          if (TRANSIENT_STATUS.has(res.status)) lastError.transient = true;

          // 일일 한도(PerDay) 429 는 재시도해도 풀리지 않는다 — 호출만 낭비하므로 즉시 다음 모델로 넘어간다.
          if (res.status === 429 && /PerDay/i.test(fullText)) {
            lastError.dailyQuota = true;
            log(`⛔ [LLM] ${model} 일일 호출 한도 소진 — 재시도 없이 다음 모델로 전환`);
            break;
          }

          // 503/429 등은 전체 엔드포인트의 일시적 수치 부족이며 모델을 바꿔도 동일하다.
          // 다음 모델로 넘어가기 전에 동일 모델을 backoff 로 재시도한다.
          if (TRANSIENT_STATUS.has(res.status) && attempt < transientRetry) {
            // 503 "high demand" 급증은 보통 수 분 지속된다 (2026-11-15 실측: 약 3분). 초 단위 backoff 로는 못 넘기므로 15→30→60→90초로 늘린다.
            const waitMs = res.status === 503 ? Math.min(90000, 15000 * 2 ** attempt) : backoffBaseMs * 2 ** attempt;
            log(`⚠️ [LLM] ${res.status} 일시 오류 — ${waitMs}ms 후 동일 모델 재시도`);
            await sleep(waitMs);
            continue;
          }

          log(`⚠️ [LLM] Gemini ${model} HTTP ${res.status}: ${errText} → 다음 모델 시도`);
          break;
        }

        let text;
        let finishReason;
        let usage;
        let gm;
        let promptFeedback = null;

        if (stream) {
          const parsed = await readGeminiStream(res, { model, maxRepeatRun, maxOutputChars });
          text = parsed.text;
          finishReason = parsed.finishReason;
          usage = parsed.usage;
          gm = parsed.groundingMetadata;
          promptFeedback = parsed.promptFeedback;
        } else {
          const data = await res.json();
          const candidate = data?.candidates?.[0];
          finishReason = candidate?.finishReason;
          text = (candidate?.content?.parts || [])
            .map((p) => (p.thought ? '' : p.text || ''))
            .join('')
            .trim();
          usage = data?.usageMetadata || {};
          gm = candidate?.groundingMetadata || {};
        }

        log(
          `📊 [LLM] Gemini ${model} 응답 완료 — finishReason: ${finishReason}, ` +
            `글자 수: ${text.length}, usage:`,
          usage || {}
        );

        if (!text) {
          lastError = new Error(`Gemini ${model} 이 빈 응답을 반환했습니다. (${errBlock({ promptFeedback })})`);
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

          // 원인 진단: 반복 문자 폭주인지, 단순 분량 초과인지 구분한다.
          // 같은 문자 200자 이상 연속은 정상 마크다운에서 나올 수 없다.
          const run = /([ \t\-*#_~=])\1{199,}/.exec(text);
          const ratio = usage?.candidatesTokenCount ? text.length / usage.candidatesTokenCount : 0;
          if (run) {
            const label = run[1] === ' ' || run[1] === '\t' ? '공백' : `'${run[1]}'`;
            err.runaway = true;
            err.message +=
              ` 원인: ${label} 문자가 ${run[0].length}자 연속 출력되어 출력 토큰을 소진했습니다.` +
              ' 표 구분선은 |---| 로만 쓰고, 칸 사이는 공백 한 칸만 두세요(정렬용 공백/하이픈 금지).';
          } else if (ratio > 8) {
            err.runaway = true;
            err.message += ` 원인: 반복 출력으로 글자/토큰 비율이 ${ratio.toFixed(1)} 입니다(정상 1.5~2.0).`;
          }
          err.model = model;
          err.partialText = text;
          log(`⛔ [LLM] ${err.message}`);
          throw err;
        }

        const grounding = {
          chunks: (gm?.groundingChunks || []).map((c) => ({ title: c.web?.title || '', uri: c.web?.uri || '' })).filter((c) => c.uri),
          queries: gm?.webSearchQueries || [],
        };
        return { text, model, usage: usage || {}, grounding };
      } catch (err) {
        if (err.truncated) throw err; // 잘림은 다음 모델로 넘기지 않고 즉시 표면화
        lastError = err;
        if (attempt < transientRetry) {
          const waitMs = backoffBaseMs * 2 ** attempt;
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

/**
 * Gemini SSE 스트림을 읽으면서 반복 문자 폭주를 생성 도중에 차단한다.
 *
 * 비스트리밍 호출은 폭주가 끝난 뒤에야 응답을 돌려주므로, 641,551자를 받고 나서야
 * 잘림을 알 수 있었다(출력 토큰 24,576개 전부 낭비). 스트리밍이면 같은 문자 연속이
 * maxRepeatRun 에 닿는 순간 연결을 끊고 재시도로 넘어간다.
 *
 * @returns {Promise<{ text: string, finishReason: string|null, usage: object|null, groundingMetadata: object }>}
 */
async function readGeminiStream(res, { model, maxRepeatRun, maxOutputChars }) {
  if (!res.body) {
    throw new Error(`Gemini ${model} 스트림 본문이 없습니다.`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const gm = {};
  let buffer = '';
  let text = '';
  let finishReason = null;
  let usage = null;
  let promptFeedback = null;
  let lastChar = '';
  let runLength = 0;

  const runawayError = () => {
    const label = lastChar === ' ' || lastChar === '\t' ? '공백' : `'${lastChar}'`;
    const err = new Error(
      `Gemini ${model} 응답이 표 정렬용 ${label} 문자 ${runLength}자 연속 출력으로 중단되었습니다 (누적 ${text.length}자). ` +
        '표 구분선은 |---| 로만 쓰고, 칸 사이는 공백 한 칸만 두세요.'
    );
    err.truncated = true; // 호출자(재시도·부분응답 덤프) 경로를 그대로 태운다
    err.runaway = true;
    err.model = model;
    err.partialText = text;
    return err;
  };

  const consumeLine = (line) => {
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') return;

    let json;
    try {
      json = JSON.parse(payload);
    } catch (_) {
      return; // 부분 JSON 조각은 무시 (다음 청크에서 이어짐)
    }

    if (json?.usageMetadata) usage = json.usageMetadata;
    if (json?.promptFeedback) promptFeedback = json.promptFeedback;
    const candidate = json?.candidates?.[0];
    if (!candidate) return;
    if (candidate.finishReason) finishReason = candidate.finishReason;
    if (candidate.groundingMetadata) {
      if (candidate.groundingMetadata.webSearchQueries?.length) {
        gm.webSearchQueries = candidate.groundingMetadata.webSearchQueries;
      }
      if (candidate.groundingMetadata.groundingChunks?.length) {
        gm.groundingChunks = candidate.groundingMetadata.groundingChunks;
      }
    }

    for (const part of candidate.content?.parts || []) {
      if (part.thought) continue;
      const chunk = part.text || '';
      if (!chunk) continue;
      text += chunk;
      for (const ch of chunk) {
        if (ch === lastChar) runLength += 1;
        else {
          lastChar = ch;
          runLength = 1;
        }
        if (runLength >= maxRepeatRun) throw runawayError();
      }
      if (text.length > maxOutputChars) {
        const err = new Error(
          `Gemini ${model} 응답이 ${text.length}자를 넘어 중단되었습니다 (상한 ${maxOutputChars}자).`
        );
        err.truncated = true;
        err.runaway = true;
        err.model = model;
        err.partialText = text;
        throw err;
      }
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        consumeLine(line);
      }
    }
    // 마지막 개행 없이 끝난 잔여 버퍼 처리
    buffer += decoder.decode();
    if (buffer.trim()) consumeLine(buffer.trim());
  } finally {
    try {
      await reader.cancel();
    } catch (_) {}
  }

  return { text: text.trim(), finishReason, usage, promptFeedback, groundingMetadata: gm };
}

function errBlock(data) {
  const p = data?.promptFeedback?.blockReason || data?.error?.message;
  return p ? String(p).slice(0, 160) : '사유 미상';
}

export default callGemini;
