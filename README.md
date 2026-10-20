# SubBridge 字幕桥

本地优先的视频字幕工作台：导入本地视频，自动识别英文语音、按字幕阅读习惯断句、调用大模型翻译成简体中文，产出可直接使用的双语字幕，并支持逐条校对与批量处理。

音视频全程不出本机，只有字幕文本会发给翻译模型。

> 当前状态：**技术验证完成，产品待开发**。PRD 与两套 TRD 已定稿，Rust 方案的核心链路（ASR / VAD / DTW / GPU 后端）已在本机实测跑通。

---

## 实测结果

硬件：RTX 3060 12GB / Ryzen 9 7950X / 63GB RAM / Windows 11
模型：`ggml-large-v3-turbo-q5_0`（547MB）

### 英文真实素材（YouTube）

| 素材 | 时长 | ASR 耗时 | 实时倍率 | WER |
| --- | --- | --- | --- | --- |
| TED 演讲（人工英文字幕作参考） | 5m55s | 8.75s | **40.6x** | **3.56%** |
| 斯坦福毕业演讲（自动字幕作参考） | 15m04s | 19.35s | **46.7x** | 1.99%\* |

\* 参考字幕本身由 ASR 生成，与 Whisper 同源，数字偏乐观，不作为质量证明。

### 中文真实素材

| 后端 | 时长 | ASR 耗时 | 实时倍率 |
| --- | --- | --- | --- |
| Vulkan（whisper-rs 自构建） | 1m34s | 2.35s | 40.2x |
| CUDA（官方 CLI） | 1m34s | 2.33s | 40.6x |
| Vulkan 首次运行（编译着色器） | 1m34s | 15.65s | 6.0x |

### 端到端翻译（TED 演讲，104 段）

| 渠道 | 耗时 | 请求数 | 质量 |
| --- | --- | --- | --- |
| MyMemory（免费） | 56.3s | 104 | 逐句检索无上下文，`remotely` 误译成“远程” |
| **deepseek-v4.1-flash** | **25.6s** | 6 | 批量+上下文，空译 0、超长 3、数字保真 |

LLM 版译文示例：

```
I have nothing, nada, zip, zilch, zippo.
→ 我一无所有，空空如也，什么都没有。

nothing even remotely researched at all.
→ 甚至没做过半点研究。
```

### CPU 对照

| 模型 | 60s 音频 | 实时倍率 |
| --- | --- | --- |
| base.en（16 线程） | 8.96s | 6.7x |
| large-v3-turbo-q5（16 线程） | 276s | 0.2x |

**large 系列在 CPU 上不可用，GPU 是硬需求。**

### 其他指标

| 项 | 值 |
| --- | --- |
| 显存占用 | 1299 MiB / 12288 MiB |
| 模型加载 | 0.48s（常驻后不重复） |
| VAD 开销 | **负**：跳过静音后总耗时 −22% |
| DTW token 覆盖率 | 100%（1134 / 1134） |
| DTW 开销 | +46%（8.75s → 12.77s） |

### 性能结论

60 分钟视频的 ASR 约 **1.5 分钟**。翻译实测 **25.6 秒/104 段**（约 6 分钟视频的量），按比例外推 60 分钟视频约 **4 分钟**，仍是全流程最大开销，优化重点应放在批处理并发上。

端到端（355 秒 TED 视频）：**转写 8.75s + 翻译 25.6s ≈ 34 秒**，约 10 倍实时。

---

## 三个必须知道的坑

### 1. VAD 必须默认开启

纯 BGM / 静音素材不启用 VAD 时，Whisper 会持续输出重复幻觉。实测两段视频分别输出了 11 次 `Thank you.` 和 15 次 `*cute*` / `I'm going to go.`。启用 VAD 后这些段被完全跳过，**而且总耗时下降 22%**。

### 2. DTW 与 flash attention 互斥，且静默失效

whisper.cpp 默认 `flash_attn = true`，此时 DTW 被静默禁用，日志里只有一行警告：

```
whisper_init_with_params_no_state: dtw_token_timestamps is not supported with flash_attn - disabling
```

必须显式关闭：

```bash
whisper-cli -m model.bin -f audio.wav -dtw large.v3.turbo -nfa
```

Rust 侧对应 `WhisperContextParameters::default().flash_attn(false)`。

另外 `t_dtw` 给的是 token 的**起点时刻**，不是 `[start, end]` 区间。直接当结束时间用会得到零长度词，实测 1134 个 token 只剩 254 个有效。

### 3. Vulkan 首次运行慢 6.7 倍

首次推理需要编译着色器：94.5s 音频耗时 15.65s，第二次起降到 2.35s。产品必须做启动预热，否则用户第一次任务会莫名慢 6.7 倍。

---

## 仓库结构

```
SubBridge/
├─ PRD.md                    产品需求（264 行）
├─ TRD.md                    Python 方案技术文档（677 行）
├─ TRD-rust.md               Rust 方案技术文档（944 行，主交付物）
├─ spike/
│  ├─ asr-smoke/             Rust 最小验证工程
│  │  ├─ src/main.rs         转写 + token 时间戳
│  │  └─ src/bin/
│  │     ├─ vad.rs           Silero VAD 语音段检测
│  │     └─ bench.rs         多线程吞吐基准
│  └─ wer/                   WER 评测
│     ├─ wer.mjs             评测脚本（含完整归一化规则）
│     ├─ ted_out.json        实测转写输出（104 段）
│     └─ ted.en.vtt          人工字幕参考
├─ spike/translate/          英译中管线
│  ├─ translate-llm.mjs      LLM 版（推荐，批量+上下文+术语表）
│  ├─ translate.mjs          MyMemory 版（链路验证）
│  ├─ ted-llm.zh-en.srt      LLM 实测双语字幕
│  └─ ted-mymemory.zh-en.srt 对照结果
├─ samples/                  测试素材（视频/音频，不入库）
│  └─ README.md              素材获取与复现步骤
└─ vendor/
   ├─ README.md              依赖安装与构建说明
   └─ pdl.mjs                并行分段下载器
```

模型、ffmpeg、Vulkan SDK、CUDA 包、测试视频等大文件不入库，安装与获取方法见 [vendor/README.md](vendor/README.md) 和 [samples/README.md](samples/README.md)。

---

## 技术选型

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 桌面壳 | Tauri 2 | 系统 WebView，IPC 替代本地 HTTP，无端口暴露 |
| 前端 | React 18 + TypeScript + Vite | 虚拟滚动字幕表、视频同步高亮 |
| 后端 | Rust + tokio | 单可执行文件分发，无运行时依赖 |
| ASR | whisper-rs 0.16（whisper.cpp） | 词级时间戳、VAD、DTW 齐全 |
| GPU | **Vulkan 默认**，CUDA 可选 | 实测两者性能持平，Vulkan 包体小 30 倍 |
| 媒体 | ffmpeg 9.0.2 sidecar | 含 libass，可烧录硬字幕 |
| 数据库 | rusqlite（WAL） | 单文件，零部署 |
| 翻译 | OpenAI 兼容接口 / Ollama | 本地模式可完全断网 |

**为什么默认 Vulkan**：实测 Vulkan 40.2x vs CUDA 40.6x，性能持平，但 Vulkan 安装包只多 10–20MB（复用系统 `vulkan-1.dll`），而 CUDA 预编译包要 653MB。Vulkan 也不绑定 NVIDIA。

---

## 快速开始（复现实测）

### 1. 准备依赖

```bash
cd vendor
# ffmpeg（含 libass）
curl -L "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" -o ff.zip
unzip -oq ff.zip -d ffmpeg/

# whisper.cpp CUDA 预编译（自带 CUDA 运行库，无需装 Toolkit）
node pdl.mjs \
  "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-win-cuda-12.4.0-x64.zip" \
  "whisper-cuda/cuda.zip" 8 4
unzip -oq whisper-cuda/cuda.zip -d whisper-cuda/

# 模型
curl -L "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin" \
     -o models/ggml-large-v3-turbo-q5_0.bin
curl -L "https://hf-mirror.com/ggml-org/whisper-vad/resolve/main/ggml-silero-v6.2.0.bin" \
     -o models/ggml-silero-v6.2.0.bin
```

### 2. 转写

```bash
cd vendor/whisper-cuda/Release
./whisper-cli.exe \
  -m "../../models/ggml-large-v3-turbo-q5_0.bin" \
  -f "audio.wav" -l en -t 8 \
  --vad -vm "../../models/ggml-silero-v6.2.0.bin" \
  -ojf -of out
```

### 3. 带 DTW 词级时间戳

```bash
./whisper-cli.exe \
  -m "../../models/ggml-large-v3-turbo-q5_0.bin" \
  -f "audio.wav" -l en -t 8 \
  -ojf -of out -dtw large.v3.turbo -nfa
```

`-nfa` 关闭 flash attention，否则 DTW 不生效；`-ojf` 输出 token 级数据。

### 4. WER 评测

```bash
cd spike/wer
node wer.mjs ted_out.json ted.en.vtt --skip-credits 10
```

输出：

```
ref words : 814
hyp words : 813
SUB=12  DEL=9  INS=8
WER       : 3.56%
accuracy  : 96.44%
```

设 `SHOW_ERRORS=1` 可打印逐条错误。

### 5. 构建 Vulkan 版（可选）

需要 Vulkan SDK + Ninja，且必须避开三个坑：

```bat
call "D:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat"
set PATH=C:\Users\XiaoMei\.cargo\bin;E:\9_GITHUB_CODE_REPOS\SubBridge\vendor\ninja;%PATH%
set VULKAN_SDK=E:\9_GITHUB_CODE_REPOS\SubBridge\vendor\vulkan-sdk
set CARGO_TARGET_DIR=E:\sbt
set CMAKE_GENERATOR=Ninja
cd /d spike\asr-smoke
cargo build --release --features vulkan
```

1. **必须用 Ninja** —— 默认 MSBuild 生成器会在 `ggml-vulkan` 子项目失败（`MSB6003`）
2. **必须先清空 target** —— 残留的 `CMakeCache.txt` 带 `CMAKE_GENERATOR_INSTANCE`，与 Ninja 冲突
3. **必须在 vcvars64 环境里构建** —— 否则找不到 cl.exe

---

## 产品规划

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| 技术验证 | ASR / VAD / DTW / GPU 后端 / WER 评测 | **已完成** |
| M0 | Tauri 骨架、SQLite、媒体 sidecar、环境自检 | 待开发 |
| M1 | ASR 集成 + 断句 + 纯英 SRT | 待开发 |
| M2 | 翻译管线 + 术语表 + 双语 SRT | 待开发 |
| M3 | 双语时间轴编辑器 + 质检 | 待开发 |
| M4 | 队列/断点续跑 + ASS/烧录 + 批量 | 待开发 |
| M5 | 打包、首启引导、性能调优 | 待开发 |

详细设计见 [TRD-rust.md](TRD-rust.md)。

---

## 文档

| 文档 | 内容 |
| --- | --- |
| [PRD.md](PRD.md) | 产品需求：用户场景、功能清单、验收标准、风险 |
| [TRD.md](TRD.md) | Python 方案：FastAPI + faster-whisper + React |
| [TRD-rust.md](TRD-rust.md) | **Rust 方案（主）**：Tauri + whisper-rs + 完整实测数据 |
| [spike/README.md](spike/README.md) | 验证工程的使用说明与全部实测记录 |
| [spike/wer/README.md](spike/wer/README.md) | WER 评测方法与归一化规则 |
| [spike/translate/README.md](spike/translate/README.md) | 翻译管线设计、渠道对比、质量数据 |
| [vendor/README.md](vendor/README.md) | 依赖安装、Vulkan 构建、许可提醒 |

---

## 局限

- 只测了 2 条标准美式发音素材，未覆盖多说话人、重口音、强噪声环境
- 词边界误差未做人工逐词标注对齐，只验证了 DTW 覆盖率与时间值合理性
- `large-v3` 完整版（3.10GB）未测，结论基于 turbo-q5
- 未做端到端产品验证（编辑器、翻译、烧录尚未实现）
- 仅 Windows x64 验证，macOS/Linux 未测

---

## 许可提醒

- whisper.cpp：MIT
- Whisper 模型权重：MIT（OpenAI）
- ffmpeg essentials：GPL 构建，分发需遵守 GPL
- CUDA 运行库：受 NVIDIA 再分发许可约束
- 本项目不内置视频下载器，仅处理用户本地文件
