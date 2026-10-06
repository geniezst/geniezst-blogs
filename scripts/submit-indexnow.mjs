#!/usr/bin/env node
/**
 * Bing IndexNow 실시간 색인 제출 CLI 도구
 * 사용법: node scripts/submit-indexnow.mjs [url1] [url2] ...
 * 기본값: 사이트 메인 페이지 및 주요 페이지 제출
 */

const HOST = 'pockemoney.com';
const KEY = '6059e7c7aa31475986bb3547ace2c153';
const KEY_LOCATION = `https://${HOST}/${KEY}.txt`;
const INDEXNOW_API = 'https://api.indexnow.org/IndexNow';

async function main() {
  const args = process.argv.slice(2);
  let urls = args;

  if (urls.length === 0) {
    urls = [
      `https://${HOST}/`,
      `https://${HOST}/blog`,
      `https://${HOST}/blog/26092501-morning-money-digest-housing-debt-economy`,
    ];
  }

  console.log(`🚀 [IndexNow] ${urls.length}개 URL 제출 시작...`);
  console.log(`- Host: ${HOST}`);
  console.log(`- Key: ${KEY}`);
  console.log(`- Key Location: ${KEY_LOCATION}`);

  const payload = {
    host: HOST,
    key: KEY,
    keyLocation: KEY_LOCATION,
    urlList: urls,
  };

  const response = await fetch(INDEXNOW_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(payload),
  });

  if (response.status === 200 || response.status === 202) {
    console.log(`✅ [IndexNow] 제출 성공! (HTTP ${response.status})`);
    for (const u of urls) {
      console.log(`  - ${u}`);
    }
  } else {
    const text = await response.text();
    console.error(`❌ [IndexNow] 제출 실패 (HTTP ${response.status}): ${text}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('IndexNow 오류:', err.message);
  process.exit(1);
});
