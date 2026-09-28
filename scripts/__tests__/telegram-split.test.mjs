import { splitMessage } from '../telegram-notify.mjs';
let pass=0, fail=0;
const ok=(n,c,extra='')=>{ c?(pass++,console.log('  ✅',n,extra)):(fail++,console.log('  ❌',n,extra)); };

const short = '짧은 메시지';
ok('짧은 메시지는 그대로', splitMessage(short).length===1);

const long = '가'.repeat(20000);
const parts = splitMessage(long);
ok('20,000자를 분할', parts.length>1, `-> ${parts.length}개`);
ok('모든 청크가 3900자 이하', parts.every(p=>p.length<=3900), `최대 ${Math.max(...parts.map(p=>p.length))}자`);
ok('청크 합계가 원본 보존', parts.join('').replace(/\n/g,'')===long, `(줄바꿈 정규화 제외)`);

const withFence = ['```html','<div>code</div>','```','본문 텍스트 '.repeat(400)].join('\n');
const fparts = splitMessage(withFence);
ok('코드펜스 포함 메시지 분할', fparts.every(p=>(p.match(/```/g)||[]).length % 2 === 0), `-> ${fparts.length}개`);

const exact = 'x'.repeat(3900);
ok('정확히 3900자는 분할 안 함', splitMessage(exact).length===1);
ok('3901자는 분할', splitMessage('x'.repeat(3901)).length===2);

console.log(`\n===== ${pass} 통과 / ${fail} 실패 =====`);
process.exit(fail?1:0);
