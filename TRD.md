# SubBridge 技术需求文档（TRD）

| 项目 | 内容 |
| --- | --- |
| 项目 | SubBridge（字幕桥） |
| 版本 | v0.1（草案） |
| 日期 | 2026-10-19 |
| 关联文档 | [PRD.md](./PRD.md)、[TRD-rust.md](./TRD-rust.md)（Rust 方案） |
| 目标平台 | Windows 10/11 x64（主），macOS/Linux 源码可运行 |

> **运行时选型说明**：本文为 Python（FastAPI + faster-whisper）方案，适合快速出原型、ASR 质量优先。若正式交付要求小体积、免运行时依赖、长期维护，请采用 [TRD-rust.md](./TRD-rust.md)（Tauri + whisper-rs）。两版共用 PRD、数据库 schema、断句算法与验收标准；Rust 版把 ASR 换成 whisper.cpp，需先通过词级时间戳 Spike。

## 1. 设计目标与约束

### 1.1 技术目标

1. **本地优先**：音视频不出本机；只有字幕文本可选择性外发。
2. **可恢复**：每个阶段产物落盘，任务失败从断点续跑。
3. **可替换**：ASR、翻译、导出三个边界用接口隔离，新增引擎不改管线。
4. **单机单进程可用**：不依赖 Docker、Redis、外部数据库。
5. **开箱即用**：打包后双击运行，自动检测并修复环境缺失。

### 1.2 本机基线（已实测）

| 项 | 值 | 影响 |
| --- | --- | --- |
| GPU | NVIDIA RTX 3060，12 GB | 可跑 `large-v3` int8_float16 |
| 驱动 | 610.88 | 支持 CUDA 12.x 运行时 |
| Node | v24.18.0 | 前端构建可用 |
| Python | **未安装** | 需在安装器中引导或打包内置 |
| ffmpeg | **未安装** | 必须随应用打包静态二进制 |

> 结论：交付形态采用「内置 Python 运行时 + 内置 ffmpeg」的独立安装包，用户机器无需预装 Python/ffmpeg。

## 2. 总体架构

```
┌─────────────────────────────────────────────────────────────┐
│                     桌面外壳（pywebview / 浏览器）            │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  React + TypeScript 前端（Vite 构建，静态资源内嵌）     │  │
│  │  项目列表 │ 任务队列 │ 双语时间轴编辑器 │ 设置 │ 日志   │  │
│  └──────────────────────────┬────────────────────────────┘  │
└─────────────────────────────┼───────────────────────────────┘
                              │ HTTP + WebSocket (127.0.0.1)
┌─────────────────────────────┴───────────────────────────────┐
│                    FastAPI 后端（单进程）                     │
│  ┌──────────┬──────────┬──────────┬──────────┬───────────┐  │
│  │ 项目管理  │ 任务队列  │ 管线编排  │ 导出服务  │ 设置/密钥  │  │
│  └──────────┴────┬─────┴─────┬────┴──────────┴───────────┘  │
│                  │           │                               │
│  ┌───────────────┴──┐  ┌─────┴──────────┐  ┌─────────────┐  │
│  │ MediaService     │  │ Pipeline       │  │ LLM Client  │  │
│  │ ffprobe/ffmpeg   │  │ probe→extract  │  │ OpenAI 兼容  │  │
│  │ 音频提取/烧录     │  │ →asr→segment   │  │ Ollama      │  │
│  └──────────────────┘  │ →translate→qc  │  └─────────────┘  │
│                        │ →export        │                    │
│  ┌──────────────────┐  └────────────────┘                    │
│  │ SQLite (WAL)     │   ┌──────────────────┐                 │
│  │ projects/cues/   │   │ 文件缓存（哈希）  │                 │
│  │ jobs/glossary    │   │ work/<job_id>/   │                 │
│  └──────────────────┘   └──────────────────┘                 │
└──────────────────────────────────────────────────────────────┘
```

### 2.1 技术选型

| 层 | 选型 | 理由 |
| --- | --- | --- |
| 前端 | React 18 + TypeScript + Vite | 生态成熟、构建快 |
| UI | Tailwind CSS + shadcn/ui | 可控样式、无重型组件库 |
| 状态 | Zustand + TanStack Query | 本地 UI 状态与服务端缓存分离 |
| 后端 | Python 3.11 + FastAPI + Uvicorn | ASR 生态在 Python；异步任务友好 |
| ASR | faster-whisper（CTranslate2） | 比 openai-whisper 快 4 倍、显存占用低 |
| VAD | Silero VAD（faster-whisper 内置） | 过滤静音、降低幻觉 |
| 翻译 | OpenAI 兼容 Chat Completions / Ollama | 一套客户端覆盖多数服务 |
| 数据库 | SQLite + WAL | 零部署、单文件、并发够用 |
| 媒体处理 | ffmpeg/ffprobe 静态构建 | 解码、提取、烧录统一入口 |
| 桌面壳 | pywebview（可选）+ 系统浏览器回退 | 避免 Electron 体积 |
| 打包 | PyInstaller（one-dir）+ Inno Setup | one-dir 启动快、便于替换 DLL |
| 测试 | pytest + Playwright（E2E） | 后端单测 + 前端关键流程 |

### 2.2 目录结构

```
SubBridge/
├─ PRD.md
├─ TRD.md
├─ backend/
│  ├─ app/
│  │  ├─ main.py                 # FastAPI 入口、静态资源挂载
│  │  ├─ config.py               # 路径、默认参数、环境检测
│  │  ├─ db.py                   # SQLite 连接、迁移
│  │  ├─ models.py               # Pydantic / ORM 模型
│  │  ├─ api/
│  │  │  ├─ projects.py
│  │  │  ├─ jobs.py
│  │  │  ├─ cues.py
│  │  │  ├─ export.py
│  │  │  ├─ settings.py
│  │  │  └─ ws.py                # 进度推送
│  │  ├─ services/
│  │  │  ├─ media.py             # ffprobe、音频提取、烧录
│  │  │  ├─ asr.py               # faster-whisper 封装
│  │  │  ├─ segmenter.py         # 断句算法
│  │  │  ├─ translator/
│  │  │  │  ├─ base.py           # Translator 接口
│  │  │  │  ├─ openai_compat.py
│  │  │  │  ├─ ollama.py
│  │  │  │  └─ offline_nllb.py   # P1
│  │  │  ├─ glossary.py
│  │  │  ├─ qc.py
│  │  │  └─ exporter.py          # SRT/ASS/VTT
│  │  ├─ pipeline/
│  │  │  ├─ orchestrator.py      # 阶段调度、断点续跑
│  │  │  ├─ stages.py            # 各阶段实现
│  │  │  └─ queue.py             # 串行队列 + GPU 锁
│  │  └─ utils/
│  │     ├─ atomic.py            # 原子写
│  │     ├─ hashing.py
│  │     └─ timecode.py
│  ├─ tests/
│  ├─ pyproject.toml
│  └─ requirements.lock
├─ frontend/
│  ├─ src/
│  │  ├─ pages/ (Projects, Editor, Settings, Queue)
│  │  ├─ components/ (SubtitleTable, VideoPlayer, Waveform)
│  │  ├─ lib/api.ts
│  │  └─ store/
│  ├─ package.json
│  └─ vite.config.ts
├─ vendor/
│  ├─ ffmpeg/ (ffmpeg.exe, ffprobe.exe)
│  └─ models/ (首次启动下载，不入库)
├─ scripts/
│  ├─ build.ps1
│  └─ fetch_models.py
└─ installer/
   └─ subbridge.iss
```

## 3. 数据模型

### 3.1 SQLite 表

```sql
-- 项目
CREATE TABLE projects (
  id            TEXT PRIMARY KEY,           -- uuid
  name          TEXT NOT NULL,
  source_path   TEXT NOT NULL,
  file_hash     TEXT NOT NULL,              -- sha256(内容)，用于去重/缓存
  duration_ms   INTEGER NOT NULL,
  width         INTEGER,
  height        INTEGER,
  fps           REAL,
  audio_streams INTEGER DEFAULT 1,
  language      TEXT DEFAULT 'en',
  status        TEXT NOT NULL,              -- created|running|done|failed|canceled
  settings_json TEXT NOT NULL,              -- 本项目参数快照
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_projects_hash ON projects(file_hash);

-- 字幕条目（双语共用一条记录）
CREATE TABLE cues (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  idx         INTEGER NOT NULL,             -- 顺序，从 0 开始
  start_ms    INTEGER NOT NULL,
  end_ms      INTEGER NOT NULL,
  text_en     TEXT NOT NULL DEFAULT '',
  text_zh     TEXT NOT NULL DEFAULT '',
  words_json  TEXT,                         -- 词级时间戳（可选，压缩存储）
  flags       TEXT DEFAULT '',              -- needs_review|machine|edited
  qc_json     TEXT,                         -- 该条质检问题
  UNIQUE(project_id, idx)
);
CREATE INDEX idx_cues_project_time ON cues(project_id, start_ms);

-- 任务
CREATE TABLE jobs (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  stage        TEXT NOT NULL,               -- 当前/最后阶段
  status       TEXT NOT NULL,               -- queued|running|paused|failed|done|canceled
  progress     REAL DEFAULT 0,
  attempts     INTEGER DEFAULT 0,
  error        TEXT,
  started_at   TEXT,
  finished_at  TEXT,
  created_at   TEXT NOT NULL
);

-- 术语表
CREATE TABLE glossary (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  TEXT,                         -- NULL = 全局
  source      TEXT NOT NULL,
  target      TEXT NOT NULL,
  case_sensitive INTEGER DEFAULT 1,
  UNIQUE(project_id, source)
);

-- 设置（非密钥）
CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

### 3.2 阶段产物（文件系统）

```
%LOCALAPPDATA%\SubBridge\
├─ subbridge.db
├─ models\                        # faster-whisper 模型
├─ cache\
│  └─ <file_hash>\
│     ├─ audio-16k.flac           # 提取音频（可复用）
│     └─ asr-<model>-<params>.jsonl
└─ work\<project_id>\
   ├─ probe.json
   ├─ words.jsonl                 # 词级时间戳
   ├─ cues_segmented.jsonl        # 断句结果（英）
   ├─ cues_translated.jsonl       # 翻译结果（中英）
   ├─ qc.json
   ├─ subtitle.zh-en.srt
   ├─ subtitle.zh-en.ass
   └─ job.log
```

**原子写**：所有 `.jsonl/.json` 先写 `<name>.tmp`，`fsync` 后 `os.replace`；中途崩溃不会留下半截文件。

## 4. 管线设计

### 4.1 阶段划分

| 阶段 | 输入 | 输出 | 可跳过条件 |
| --- | --- | --- | --- |
| probe | 视频路径 | probe.json | 已有且源文件哈希一致 |
| extract | 视频 | audio-16k.flac | 缓存存在 |
| asr | 音频 | words.jsonl | 缓存命中（模型+参数一致） |
| segment | words.jsonl | cues_segmented.jsonl | 已有且算法版本一致 |
| translate | cues_segmented | cues_translated.jsonl | 已有且术语/模型/提示词版本一致 |
| qc | 双语 cues | qc.json | 每次重算（快） |
| export | 双语 cues | srt/ass | 导出时按需 |

每个阶段带 `stage_version` 常量；算法或提示词变更时版本号 +1，缓存自动失效。

### 4.2 状态机

```
queued ──▶ running ──▶ done
  ▲           │
  │           ├──▶ failed ──(retry)──▶ queued
  │           └──▶ canceled
  └──(resume)── paused
```

- 队列**串行**消费，GPU 阶段持有全局 `asyncio.Lock`，避免显存争抢。
- 翻译阶段是网络 I/O，可与下一个任务的 ASR 并行（P1 引入 2 个 worker，ASR 仍串行）。
- 取消通过 `asyncio.Event` + 子进程终止实现；ffmpeg 子进程必须显式 `terminate()`。

### 4.3 断点续跑规则

1. 启动时扫描 `jobs.status in (running, paused)`，标记为 `paused` 并允许恢复。
2. 恢复时从 `job.stage` 开始，校验该阶段输入产物存在且哈希/版本匹配。
3. 翻译阶段按 `idx` 粒度缓存：已成功条目直接复用，只补失败/缺失条目。

## 5. 关键技术方案

### 5.1 媒体探测与音频提取

```bash
ffprobe -v error -print_format json -show_format -show_streams input.mp4
ffmpeg -y -i input.mp4 -vn -map 0:a:0 -ac 1 -ar 16000 -c:a flac audio-16k.flac
```

- 多音轨：默认取第一条；界面允许选择音轨（P1）。
- 无音轨：直接失败，错误码 `E_NO_AUDIO`。
- 路径含中文/空格：统一传参数组，不拼 shell 字符串；Windows 下避免 `shell=True`。

### 5.2 ASR（faster-whisper）

```python
from faster_whisper import WhisperModel

model = WhisperModel(
    "large-v3",
    device="cuda" if cuda_available else "cpu",
    compute_type="int8_float16" if cuda_available else "int8",
    download_root=str(MODELS_DIR),
)

segments, info = model.transcribe(
    audio_path,
    language="en",
    beam_size=5,
    vad_filter=True,
    vad_parameters={"min_silence_duration_ms": 500},
    word_timestamps=True,
    condition_on_previous_text=False,   # 降低重复幻觉
    no_speech_threshold=0.6,
    compression_ratio_threshold=2.4,
    log_prob_threshold=-1.0,
)
```

**幻觉抑制后处理**：

- 丢弃 `no_speech_prob > 0.6` 且 `avg_logprob < -1.0` 的段。
- 丢弃与上一段文本相似度 > 0.9 且时长 < 1.5s 的重复段。
- 丢弃纯标点/纯音乐符号/空文本。
- 被丢弃区间若夹在两条有效字幕之间，按静音处理，不生成字幕。

**模型选择**：

| 模型 | 显存 | 相对速度 | 适用 |
| --- | --- | --- | --- |
| large-v3 | ~4.7 GB (int8_float16) | 1.0x | 默认，质量优先 |
| large-v3-turbo | ~3.0 GB | ~4x | 快速草稿 |
| distil-large-v3 | ~2.4 GB | ~5x | 英文专用，质量接近 large |
| medium / small | < 2 GB | 更快 | CPU 或低显存 |

首次使用下载模型，显示进度；国内网络支持 `HF_ENDPOINT=https://hf-mirror.com`。

### 5.3 断句算法

输入：词级时间戳 `[{word, start, end, prob}]`。输出：满足约束的 cue 列表。

**约束常量**（可配置）：

```python
MAX_LINE_ZH = 20          # 汉字/行
MAX_LINES = 2
MAX_CUE_MS = 7000
MIN_CUE_MS = 1000
MIN_GAP_MS = 40
MAX_CPS_ZH = 9            # 字/秒
MAX_CPS_EN = 17           # 字符/秒
PAUSE_SPLIT_MS = 350      # 词间停顿阈值
```

**算法**（贪心 + 回溯修正）：

1. 以句末标点（`.?!` 及引号收尾）为强切点，先切成语义块。
2. 块内按停顿 ≥350ms 切分；无停顿则按逗号/分号切分。
3. 对超长块（预计中文长度 > 容量）按词边界均匀切分，优先在介词/连词前断开。
4. 对过短块（<1s 或 <6 字）与相邻块合并，前提是合并后不超时长/行长。
5. 时间轴修正：
   - 条目前后各留 60–120ms 呼吸空间，但不与相邻条重叠。
   - `end = min(next.start - MIN_GAP_MS, last_word.end + 200ms)`。
   - 若 `end - start < MIN_CUE_MS`，向后借时间，最多借到 `next.start - MIN_GAP_MS`。
6. 若最终仍违反 CPS，标记 `needs_review`，不强行截断语义。

> 中文容量预估：断句阶段还没有译文，用 `估算中文长度 = 英文词数 × 1.6`（可调）作为代理；翻译后再做一次容量校验与二次切分。

### 5.4 翻译

#### 5.4.1 接口

```python
class Translator(Protocol):
    async def translate_batch(
        self,
        items: list[tuple[int, str]],      # (idx, english)
        context_before: list[str],
        context_after: list[str],
        glossary: dict[str, str],
    ) -> dict[int, str]: ...
```

#### 5.4.2 批处理与上下文

- 每批 20–30 条，按 token 预算（默认 3000）动态调整。
- 携带前后各 2 条作为**只读语境**，提示词明确“只翻译目标条目”。
- 输出 JSON 数组：`[{"id": 12, "zh": "..."}]`，要求**只输出 JSON**。
- 校验：返回 ID 集合必须与请求完全一致；缺失项单独重试（最多 3 次）；仍失败则标记 `needs_review` 并保留英文。

#### 5.4.3 提示词模板（要点）

```
你是专业影视字幕译者。将下列英文字幕翻译成简体中文。

规则：
1. 只输出 JSON 数组，每项 {"id": <输入id>, "zh": "<译文>"}，不得增删 id。
2. 译文口语化、简洁，符合字幕阅读习惯；不添加解释。
3. 每条中文不超过 {max_chars} 字；超长时优先压缩冗余，不丢关键信息。
4. 数字、单位、时间、URL、代码、人名保持原样或通用译法。
5. 必须使用术语表译法：{glossary}
6. 语境仅用于理解，不要翻译语境条目。
7. 不输出任何前言、注释或 Markdown 代码块。
```

#### 5.4.4 术语表

- 翻译前：将术语表注入提示词。
- 翻译后：对 `source` 做大小写敏感/不敏感匹配，若译文未包含 `target`，执行强制替换并记录 `glossary_override` 标记。
- 冲突处理：同一 source 多个 target 时，项目级优先于全局。

#### 5.4.5 本地翻译（P1）

- Ollama：`POST /api/chat`，模型 `qwen2.5:7b-instruct` 或 `qwen2.5:14b`。
- 纯离线 NLLB：`facebook/nllb-200-distilled-600M`，CTranslate2 量化，质量标注“基础”。
- 本地模式不发送任何网络请求；启动时检测 Ollama 可用性。

### 5.5 质检规则

| 规则 | 判定 | 级别 |
| --- | --- | --- |
| 空译文 | `text_zh.strip() == ""` | error |
| 超长 | 任一行 > 20 汉字 或 > 2 行 | warn |
| CPS 超标 | 中文字数 / 时长 > 9 | warn |
| 时长异常 | < 1.0s 或 > 7.0s | warn |
| 重叠 | `start < prev.end + 40ms` | error |
| 数字不一致 | 原文数字集合 ⊄ 译文数字集合 | warn |
| 疑似漏译 | 译文与原文相同，或中文占比 < 20% | warn |
| 套话 | 命中“作为 AI/抱歉/无法翻译”等 | error |

质检结果写 `qc.json`，编辑器按 `cue.id` 聚合展示。

### 5.6 导出

#### SRT

```
1
00:00:01,234 --> 00:00:03,456
Hello world.
你好，世界。
```

- 编码：UTF-8 **带 BOM**（Windows 播放器兼容性最好）。
- 换行：`\r\n`。
- 双语顺序可配（默认英上中下）。
- 时间格式：`HH:MM:SS,mmm`；超过 99 小时按实际位数输出。

#### ASS

- 使用 libass 渲染；样式：`Fontname=Microsoft YaHei`，`Fontsize=20`（1080p），`Outline=2`，`Shadow=0`，底部居中 `Alignment=2`。
- 中文与英文两条 Dialogue 或一条带 `\N`，由配置决定。

#### 烧录

```bash
ffmpeg -y -i input.mp4 \
  -vf "subtitles=sub.ass:fontsdir=fonts" \
  -c:v libx264 -preset medium -crf 18 -c:a copy \
  output.mp4
```

- Windows 路径转义：优先把 ASS 放到工作目录并用相对路径，避免 `C\:` 转义问题。
- 无 libass 的 ffmpeg 构建不可用；打包时必须选 `--enable-libass` 的静态构建。
- 硬件编码（NVENC）作为可选加速，默认 x264 保证兼容。

### 5.7 缓存键

```python
cache_key = sha256(json.dumps({
    "file_hash": file_hash,
    "stage": stage,
    "stage_version": STAGE_VERSION,
    "params": relevant_params,
    "model": model_name,
    "prompt_version": PROMPT_VERSION,   # 仅翻译阶段
}, sort_keys=True))
```

### 5.8 并发与资源

- ASR 全局单实例，`WhisperModel` 常驻内存，切换模型时显式 `del` + `gc.collect()` + `torch.cuda.empty_cache()`（若使用 torch）。
- 翻译并发默认 4，可配 1–8；带指数退避（1s/2s/4s，最多 3 次）。
- 批量任务串行；UI 仍可操作已完成项目。
- 内存上限：音频流式读取，不把整段 PCM 读入内存。

## 6. API 设计

Base：`http://127.0.0.1:8765/api`。仅监听回环地址；启动时生成一次性 token，前端通过注入的 `window.__SUB_BRIDGE_TOKEN__` 携带。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 环境自检（ffmpeg、CUDA、模型、磁盘） |
| GET | `/projects` | 项目列表（分页/筛选） |
| POST | `/projects` | 创建项目（路径或上传） |
| GET | `/projects/{id}` | 详情 |
| PATCH | `/projects/{id}` | 重命名/改设置 |
| DELETE | `/projects/{id}` | 删除（含产物，需 `?purge=true`） |
| POST | `/projects/{id}/jobs` | 入队（指定起始阶段） |
| GET | `/jobs` | 队列状态 |
| POST | `/jobs/{id}/cancel` | 取消 |
| POST | `/jobs/{id}/retry` | 重试失败阶段 |
| GET | `/projects/{id}/cues` | 字幕列表（支持 `?flagged=1`） |
| PATCH | `/cues/{id}` | 更新文本/时间 |
| POST | `/projects/{id}/cues/split` | 拆分 |
| POST | `/projects/{id}/cues/merge` | 合并 |
| GET | `/projects/{id}/qc` | 质检结果 |
| POST | `/projects/{id}/export` | 导出（格式/语言/烧录） |
| GET | `/projects/{id}/download/{artifact}` | 下载产物 |
| GET/PUT | `/glossary` | 术语表 |
| GET/PUT | `/settings` | 设置（密钥脱敏返回） |
| GET | `/models` | 模型列表/下载状态 |
| WS | `/ws/jobs` | 进度、日志、状态变更推送 |

**WebSocket 消息**：

```json
{"type":"job.progress","job_id":"...","stage":"asr","progress":0.42,"eta_sec":95}
{"type":"job.log","job_id":"...","level":"info","line":"..."}
{"type":"job.state","job_id":"...","status":"failed","error":"E_LLM_TIMEOUT"}
```

## 7. 前端设计要点

### 7.1 页面

1. **项目页**：拖拽区 + 项目卡片列表（状态色、进度条、缩略图）。
2. **任务队列**：当前任务阶段条（probe→extract→asr→segment→translate→qc）、日志抽屉、取消/重试。
3. **编辑器**：
   - 左侧视频播放器（`<video>` + 绝对定位字幕层）。
   - 右侧虚拟滚动字幕表（`@tanstack/react-virtual`），万条不卡。
   - 行内编辑：英文/中文两个 textarea，失焦保存（debounce 500ms）。
   - 时间轴：起止时间输入 + 波形图（`wavesurfer.js`，P1）。
   - 质检侧栏：问题计数与跳转。
4. **设置**：模型、设备、翻译提供商、并发、导出默认值、术语表管理、模型管理。

### 7.2 性能

- 字幕表虚拟化，仅渲染可视区 ±10 行。
- 视频与字幕同步用 `requestAnimationFrame` + 二分查找当前 cue。
- 大量更新用 WebSocket 增量推送，不轮询。

### 7.3 可访问性

- 全键盘操作：`Space` 播放/暂停，`Ctrl+Enter` 保存，`Alt+↑/↓` 跳条。
- 对比度 ≥ 4.5:1；焦点可见。

## 8. 安全与隐私

| 项 | 措施 |
| --- | --- |
| 网络暴露 | 仅绑定 `127.0.0.1`；随机端口回退；token 校验 |
| 密钥存储 | Windows Credential Manager（`keyring`），不写 SQLite/日志 |
| 日志脱敏 | 请求头、Key、完整字幕内容默认不写日志 |
| 外发范围 | 仅翻译阶段的字幕文本 + 术语表；音视频永不上传 |
| 离线模式 | 设置项开启后，翻译客户端强制指向本地，网络层拒绝外联（可选防火墙提示） |
| 路径安全 | 所有文件操作限制在项目工作目录内，防路径穿越 |
| 依赖安全 | 锁定版本；构建时 `pip-audit`、`npm audit` |

## 9. 错误码与重试

| 错误码 | 含义 | 处理 |
| --- | --- | --- |
| `E_NO_AUDIO` | 无音轨 | 终止，提示换文件 |
| `E_FFMPEG_MISSING` | ffmpeg 不可用 | 引导修复/重新安装 |
| `E_CUDA_INIT` | CUDA/cuDNN 初始化失败 | 自动回退 CPU，提示原因 |
| `E_MODEL_DOWNLOAD` | 模型下载失败 | 重试 3 次，可切镜像 |
| `E_ASR_OOM` | 显存不足 | 降级模型/分段重试 |
| `E_LLM_AUTH` | 鉴权失败 | 终止翻译，提示检查 Key |
| `E_LLM_RATE_LIMIT` | 限流 | 指数退避，最多 5 次 |
| `E_LLM_BAD_JSON` | 返回非 JSON/ID 不匹配 | 单批重试 3 次，再按条重试 |
| `E_DISK_FULL` | 磁盘不足 | 终止并提示所需空间 |

重试策略：瞬时错误（网络、限流、OOM）自动重试；配置错误（鉴权、路径）不重试，直接提示。

## 10. 环境引导与打包

### 10.1 首次启动自检

```
[1/4] ffmpeg        ✓ 内置
[2/4] CUDA          ✓ RTX 3060 / 12GB
[3/4] Whisper 模型   ✗ 未下载 (large-v3, 3.1GB)  [下载]
[4/4] 翻译服务       ✗ 未配置 API Key            [去设置]
```

### 10.2 打包方案

- **Python**：PyInstaller `--onedir`，收集 `ctranslate2`、`av`、`onnxruntime` 的 DLL。
- **CUDA 运行时**：随包携带 `nvidia-cublas-cu12`、`nvidia-cudnn-cu12` 的 DLL，避免用户装 CUDA Toolkit。
- **ffmpeg**：`vendor/ffmpeg/ffmpeg.exe`、`ffprobe.exe`，构建时校验 `--enable-libass`。
- **前端**：`npm run build` 产物复制到 `backend/app/static`，FastAPI `StaticFiles` 挂载。
- **安装器**：Inno Setup，安装到 `%LOCALAPPDATA%\Programs\SubBridge`，创建开始菜单快捷方式。
- **体积预估**：Python 运行时 ~60MB，依赖 ~250MB，ffmpeg ~80MB，合计 ~400MB（不含模型）。

### 10.3 模型分发

- 不随安装包分发（体积与许可）。
- 首次启动下载到 `%LOCALAPPDATA%\SubBridge\models`。
- 支持断点续传与镜像；提供“导入本地模型目录”入口。

## 11. 测试计划

### 11.1 单元测试

| 模块 | 用例 |
| --- | --- |
| segmenter | 无标点长句、超短句合并、CPS 边界、零时长、重叠修正、中英混排 |
| translator | ID 缺失/多余、非 JSON、超时、术语强制、超长压缩 |
| exporter | SRT 时间格式、BOM、CRLF、ASS 转义、空字幕 |
| qc | 每条规则的命中与不命中 |
| cache | 键稳定性、版本失效、原子写 |

### 11.2 集成测试

- 3 条样例视频（访谈/课程/vlog，各 3–5 分钟）跑完整管线。
- 断网跑离线模式。
- 强制 kill 进程后续跑。
- 批量 10 文件队列。

### 11.3 验收指标

| 指标 | 目标 |
| --- | --- |
| 清晰语音 WER | ≤ 8% |
| 字幕格式违规率 | 0（重叠/零时长/超行） |
| 翻译 ID 对齐成功率 | ≥ 99.9% |
| 术语命中率 | 100% |
| 60min 端到端 | ≤ 12min（3060） |
| 崩溃恢复成功率 | 100% |

### 11.4 E2E

Playwright：创建项目 → 跑任务（mock ASR/翻译）→ 编辑一条 → 导出 → 校验文件内容。

## 12. 性能预算

| 阶段 | 60min 视频（3060, large-v3） | 说明 |
| --- | --- | --- |
| 音频提取 | ~30s | FLAC 16k 单声道 |
| ASR | ~3–4min | int8_float16，beam 5 |
| 断句 | < 2s | 纯 CPU |
| 翻译 | ~4–6min | 30 条/批，并发 4，取决于 API |
| 质检 | < 1s | |
| 导出 | < 1s | |
| 烧录 | ~视频时长的 1.5–3x | x264 medium |

## 13. 运维与可观测性

- **日志**：`%LOCALAPPDATA%\SubBridge\logs\app-YYYYMMDD.log`，按天轮转，保留 7 天；单文件 ≤ 20MB。
- **任务日志**：`work/<project_id>/job.log`，保留至项目删除。
- **诊断包**：设置页“导出诊断信息”，打包环境自检、最近日志、DB 统计（不含字幕内容与密钥）。
- **无遥测**：默认不收集任何使用数据。

## 14. 风险与技术难点

| 难点 | 说明 | 方案 |
| --- | --- | --- |
| Windows 下 ctranslate2 的 cuDNN 依赖 | 用户环境缺 DLL 直接报错 | 随包携带 CUDA 12 运行库；启动自检并回退 CPU |
| ffmpeg libass 缺失 | 烧录失败 | 构建流水线校验 `--enable-libass` |
| LLM 不遵守 JSON/ID | 时间轴错位 | 严格校验 + 单条重试 + 失败标记，绝不按顺序盲配 |
| 长视频 ASR 显存 | OOM | 分段转写（按 10min 切片，重叠 5s），词级时间戳偏移合并 |
| 中文断句与英文语序不一致 | 译文跨条 | 翻译后二次切分：按中文标点重切并重新分配时间 |
| 术语与上下文冲突 | 译文生硬 | 术语优先 + 提示词强约束 + 后置校验 |
| 打包体积 | 安装包大 | one-dir + 按需模型；可选“精简版”不含 CUDA |
| 多显示器/高 DPI | UI 模糊 | pywebview 设置 DPI 感知；CSS 使用相对单位 |

## 15. 开发计划

| 周 | 内容 | 交付 |
| --- | --- | --- |
| W1 | 骨架、DB、媒体服务、环境自检 | 能导入视频并提取音频 |
| W2 | ASR + 断句 + 纯英 SRT | M1 可用闭环 |
| W3 | 翻译管线 + 术语表 + 双语 SRT | M2 |
| W4 | 编辑器 + 质检 | M3 |
| W5 | 队列/续跑 + ASS/烧录 + 批量 | M4 |
| W6 | 打包、引导、性能、验收 | M5 安装包 |

## 16. 开放技术问题

1. **是否引入 torch**：仅用于 `empty_cache` 与部分 VAD；若不用可省 ~2GB 依赖。建议：不引入，改用 CTranslate2 自带显存管理。
2. **分段 ASR 的切点**：按静音切 vs 固定 10min 切。建议：优先静音切，找不到静音再固定切。
3. **翻译后二次切分的策略**：按中文标点重切可能破坏语义。建议：仅当超容量时重切，且优先在逗号/顿号处。
4. **前端视频解码**：Chromium 对 MKV/HEVC 支持有限。建议：预览时用 ffmpeg 转代理（720p H.264），导出仍用原片。
5. **是否需要波形图**：`wavesurfer.js` 增加 ~200KB 与解码开销。建议：P1 再做。
