#!/usr/bin/env node
// 英译中翻译管线（LLM 版）
// 读 whisper JSON，按批带上下文翻译，输出双语 SRT。
//
// 用法:
//   node translate-llm.mjs <in.json> <out-prefix> [选项]
//
// 选项:
//   --batch N        每批条数（默认 20）
//   --context N      前后各带几条语境（默认 2）
//   --model NAME     模型名（默认 deepseek-v4.1-flash）
//   --base URL       接口地址（默认 https://api.llmgo.net/v1）
//   --glossary FILE  术语表 JSON（{"source":"target"}）
//
// 环境变量:
//   LLM_API_KEY      必填

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const inPath = argv[0];
const outPrefix = argv[1];
if (!inPath || !outPrefix) {
  console.error('usage: node translate-llm.mjs <in.json> <out-prefix> [--batch N] [--context N] [--model NAME] [--base URL] [--glossary FILE]');
  process.exit(2);
}
const opt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const BATCH = Number(opt('--batch', '20'));
const CTX = Number(opt('--context', '2'));
const MODEL = opt('--model', 'deepseek-v4.1-flash');
const BASE = opt('--base', 'https://api.llmgo.net/v1');
const GLOSSARY_FILE = opt('--glossary', '');
const API_KEY = process.env.LLM_API_KEY;

if (!API_KEY) {
  console.error('错误：需要设置 LLM_API_KEY 环境变量');
  process.exit(2);
}

const glossary = GLOSSARY_FILE && existsSync(GLOSSARY_FILE)
  ? JSON.parse(readFileSync(GLOSSARY_FILE, 'utf8'))
  : {};

// ---------- 读取输入 ----------
const data = JSON.parse(readFileSync(inPath, 'utf8'));
const segs = Object.keys(data.transcription)
  .sort((a, b) => Number(a) - Number(b))
  .map(k => ({
    id: Number(k),
    start: data.transcription[k].offsets.from,
    end: data.transcription[k].offsets.to,
    en: data.transcription[k].text.trim(),
  }))
  .filter(s => s.en && !/^\[.*\]$/.test(s.en));

console.log(`读取 ${segs.length} 段，模型 ${MODEL}，每批 ${BATCH} 条`);

const glossaryText = Object.keys(glossary).length
  ? Object.entries(glossary).map(([k, v]) => `  ${k} → ${v}`).join('\n')
  : '（无）';

// ---------- 提示词 ----------
function buildPrompt(items, before, after) {
  const numbered = items.map(s => `${s.id}\t${s.en}`).join('\n');
  const beforeText = before.map(s => `  ${s.en}`).join('\n') || '（无）';
  const afterText = after.map(s => `  ${s.en}`).join('\n') || '（无）';

  return `你是专业影视字幕译者。把下面的英文字幕翻译成简体中文。

【必须遵守】
1. 只输出 JSON 数组，格式：[{"id": <输入id>, "zh": "<译文>"}]
2. id 必须与输入完全一致，不得增加、删除、合并、重排
3. 每条译文尽量不超过 20 个汉字；超长时压缩冗余，不丢关键信息
4. 口语化、简洁，符合字幕阅读习惯；不加解释、不加引号
5. 数字、单位、时间、URL、代码、人名保持原样或通用译法
6. 必须使用术语表译法
7. 前后语境仅用于理解，不要翻译语境条目
8. 不要输出 Markdown 代码块或任何前言

【术语表】
${glossaryText}

【前文语境（只读）】
${beforeText}

【后文语境（只读）】
${afterText}

【待翻译】
${numbered}`;
}

// ---------- 调用 ----------
async function callLLM(prompt, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: MODEL,
          temperature: 0.3,
          max_tokens: 4000,
          messages: [{ role: 'user', content: prompt }],
        }),
      });
      if (!r.ok) {
        const t = await r.text();
        throw new Error(`HTTP ${r.status}: ${t.slice(0, 200)}`);
      }
      const j = await r.json();
      const content = j.choices?.[0]?.message?.content;
      if (!content) throw new Error('空响应');
      return content;
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastErr;
}

// ---------- 解析 ----------
function parseResponse(content, wantIds) {
  let s = content.trim();
  // 剥离可能的 ```json 围栏
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  // 取第一个 [ 到最后一个 ]
  const a = s.indexOf('[');
  const b = s.lastIndexOf(']');
  if (a < 0 || b < 0) throw new Error('响应中找不到 JSON 数组');
  const arr = JSON.parse(s.slice(a, b + 1));

  const got = new Map();
  for (const item of arr) {
    if (typeof item.id !== 'number' || typeof item.zh !== 'string') continue;
    got.set(item.id, item.zh.trim());
  }

  const missing = wantIds.filter(id => !got.has(id));
  const extra = [...got.keys()].filter(id => !wantIds.includes(id));
  return { got, missing, extra };
}

// ---------- SRT ----------
function srtTime(ms) {
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const milli = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(milli).padStart(3, '0')}`;
}

// ---------- 主流程 ----------
const result = new Map();
const startedAt = Date.now();
let failedBatches = 0;

for (let start = 0; start < segs.length; start += BATCH) {
  const items = segs.slice(start, start + BATCH);
  const ids = items.map(s => s.id);
  const before = segs.slice(Math.max(0, start - CTX), start);
  const after = segs.slice(start + items.length, start + items.length + CTX);
  const prompt = buildPrompt(items, before, after);

  const batchNo = Math.floor(start / BATCH) + 1;
  const totalBatches = Math.ceil(segs.length / BATCH);
  process.stdout.write(`批次 ${batchNo}/${totalBatches} (${items.length} 条) ... `);

  try {
    const content = await callLLM(prompt);
    let { got, missing, extra } = parseResponse(content, ids);

    // 缺失的单独重试
    if (missing.length) {
      console.log(`缺 ${missing.length} 条，单条重试`);
      for (const id of missing) {
        const it = items.find(x => x.id === id);
        try {
          const c = await callLLM(buildPrompt([it], [], []));
          const one = parseResponse(c, [id]);
          if (one.got.has(id)) got.set(id, one.got.get(id));
        } catch { /* 留给后续标记 */ }
      }
    }

    for (const it of items) {
      result.set(it.id, got.get(it.id) || '');
    }
    const empty = ids.filter(id => !(result.get(id) || '').trim()).length;
    console.log(`完成${empty ? `（${empty} 条空译）` : ''}${extra.length ? `（多余 ${extra.length} 条已丢弃）` : ''}`);
  } catch (e) {
    failedBatches++;
    console.log(`失败：${e.message}`);
    for (const it of items) result.set(it.id, '');
  }
}

const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
const emptyCount = [...result.values()].filter(v => !v.trim()).length;
console.log(`\n完成：${segs.length} 段，空译 ${emptyCount}，失败批次 ${failedBatches}，耗时 ${elapsed}s`);

// ---------- 输出 ----------
const merged = segs.map(s => ({ ...s, zh: result.get(s.id) || '' }));

function buildSrt(items, bilingual) {
  const lines = [];
  items.forEach((s, i) => {
    lines.push(String(i + 1));
    lines.push(`${srtTime(s.start)} --> ${srtTime(s.end)}`);
    if (bilingual) {
      lines.push(s.en);
      lines.push(s.zh);
    } else {
      lines.push(s.zh || s.en);
    }
    lines.push('');
  });
  return lines.join('\r\n');
}

writeFileSync(`${outPrefix}.zh-en.srt`, '\uFEFF' + buildSrt(merged, true), 'utf8');
writeFileSync(`${outPrefix}.zh.srt`, '\uFEFF' + buildSrt(merged, false), 'utf8');
writeFileSync(`${outPrefix}.json`, JSON.stringify(merged, null, 2), 'utf8');

console.log(`\n已写出：`);
console.log(`  ${outPrefix}.zh-en.srt`);
console.log(`  ${outPrefix}.zh.srt`);
console.log(`  ${outPrefix}.json`);
