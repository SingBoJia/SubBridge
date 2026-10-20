#!/usr/bin/env node
// WER 评测：对比 whisper 输出与参考字幕。
// 用法: node wer.mjs <hyp.json> <ref.vtt> [--skip-credits N]
//
// hyp.json 是 whisper-cli -oj 的输出（含 transcription 对象）。
// ref.vtt  是 WebVTT 参考字幕（人工或自动）。

import { readFileSync } from 'node:fs';

const [hypPath, refPath, ...rest] = process.argv.slice(2);
if (!hypPath || !refPath) {
  console.error('usage: node wer.mjs <hyp.json> <ref.vtt> [--skip-credits N]');
  process.exit(2);
}
const skipCredits = rest.includes('--skip-credits')
  ? Number(rest[rest.indexOf('--skip-credits') + 1]) || 0
  : 0;

// ---------- 读取 whisper 输出 ----------
const hyp = JSON.parse(readFileSync(hypPath, 'utf8'));
const hypText = Object.values(hyp.transcription).map(s => s.text).join(' ');

// ---------- 读取 VTT ----------
function parseVtt(raw) {
  // 去掉内联词级时间标签 <00:00:07.720> 和 <c>...</c>
  let vtt = raw
    .replace(/<\d\d:\d\d:\d\d\.\d+>/g, '')
    .replace(/<\/?c>/g, '')
    .replace(/align:start position:0%/g, '');

  const lines = vtt.split(/\r?\n/);
  const out = [];
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    if (/^\d\d:\d\d:\d\d\.\d+ -->/.test(t)) continue;
    if (/^(WEBVTT|Kind:|Language:|NOTE|STYLE|REGION)/.test(t)) continue;
    out.push(t);
  }

  // 自动字幕是滚动窗口，会有大量重复；按"未见过的整行"去重
  const seen = new Set();
  const dedup = [];
  for (const l of out) {
    if (seen.has(l)) continue;
    seen.add(l);
    dedup.push(l);
  }
  return dedup.join(' ');
}

const refRaw = parseVtt(readFileSync(refPath, 'utf8'));

// ---------- 归一化 ----------
const NUM = {
  '0': 'zero', '1': 'one', '2': 'two', '3': 'three', '4': 'four',
  '5': 'five', '6': 'six', '7': 'seven', '8': 'eight', '9': 'nine',
  '10': 'ten', '11': 'eleven', '12': 'twelve', '13': 'thirteen',
  '14': 'fourteen', '15': 'fifteen', '16': 'sixteen', '17': 'seventeen',
  '18': 'eighteen', '19': 'nineteen', '20': 'twenty', '30': 'thirty',
  '40': 'forty', '50': 'fifty', '100': 'one hundred',
};
const NON_SPEECH = new Set([
  'applause', 'laughter', 'music', 'laughs', 'cheering', 'inaudible',
]);
const FILLERS = new Set(['uh', 'um', 'ah', 'huh', 'er', 'erm']);

function normalize(text) {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9' ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);

  const out = [];
  for (let w of words) {
    if (NON_SPEECH.has(w)) continue;
    if (FILLERS.has(w)) continue;
    if (w === 'cause' || w === 'cuz') w = 'because';
    if (w === 'gonna') { out.push('going', 'to'); continue; }
    if (w === 'wanna') { out.push('want', 'to'); continue; }
    if (w === 'gotta') { out.push('got', 'to'); continue; }
    if (w === 'dammit') { out.push('damn', 'it'); continue; }
    if (NUM[w]) { out.push(...NUM[w].split(' ')); continue; }
    out.push(w);
  }
  return out;
}

let R = normalize(refRaw);
let H = normalize(hypText);

if (skipCredits > 0) {
  R = R.slice(skipCredits);
  H = H.slice(skipCredits);
}

// ---------- Levenshtein ----------
const n = R.length, m = H.length;
const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
for (let i = 0; i <= n; i++) dp[i][0] = i;
for (let j = 0; j <= m; j++) dp[0][j] = j;

for (let i = 1; i <= n; i++) {
  for (let j = 1; j <= m; j++) {
    const cost = R[i - 1] === H[j - 1] ? 0 : 1;
    dp[i][j] = Math.min(
      dp[i - 1][j] + 1,
      dp[i][j - 1] + 1,
      dp[i - 1][j - 1] + cost,
    );
  }
}

let i = n, j = m, S = 0, D = 0, I = 0;
const errors = [];
while (i > 0 || j > 0) {
  if (i > 0 && j > 0 && R[i - 1] === H[j - 1]) { i--; j--; continue; }
  if (i > 0 && j > 0 && dp[i][j] === dp[i - 1][j - 1] + 1) {
    S++; errors.push(`SUB  "${H[j - 1]}" <- "${R[i - 1]}"`); i--; j--; continue;
  }
  if (i > 0 && dp[i][j] === dp[i - 1][j] + 1) {
    D++; errors.push(`DEL  "${R[i - 1]}"`); i--; continue;
  }
  I++; errors.push(`INS  "${H[j - 1]}"`); j--;
}

const wer = (S + D + I) / n;
console.log(`ref words : ${n}`);
console.log(`hyp words : ${m}`);
console.log(`SUB=${S}  DEL=${D}  INS=${I}`);
console.log(`WER       : ${(wer * 100).toFixed(2)}%`);
console.log(`accuracy  : ${((1 - wer) * 100).toFixed(2)}%`);
if (process.env.SHOW_ERRORS) {
  console.log('\n--- errors ---');
  errors.slice(0, 40).forEach(e => console.log('  ' + e));
}
