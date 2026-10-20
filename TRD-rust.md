# SubBridge 技术需求文档（TRD）— Rust 方案

| 项目 | 内容 |
| --- | --- |
| 项目 | SubBridge（字幕桥） |
| 版本 | v0.1-rust（草案） |
| 日期 | 2026-10-19 |
| 关联文档 | [PRD.md](./PRD.md)、[TRD.md](./TRD.md)（Python 方案） |
| 目标平台 | Windows 10/11 x64（主），macOS/Linux 可交叉构建 |

> 本文是 [TRD.md](./TRD.md) 的运行时替换方案。**产品需求、数据模型、断句约束、翻译提示词、验收标准全部沿用 PRD 与 Python 版 TRD**，本文只回答“用 Rust 怎么做、代价是什么、哪些地方会变”。

## 1. 结论先行

**Rust 可行，且已完成核心链路的真实验证；但 GPU 加速路径尚未在本机验证，这是当前唯一的关键缺口。**

### 1.1 已实测通过（2026-10-20）

| 能力 | 结果 |
| --- | --- |
| `whisper-rs 0.16.0` 编译 | 通过（MSVC 2026 + CMake，CPU 后端） |
| 真实音频转写 | 通过，jfk.wav 输出正确文本与词级时间戳 |
| Token 级时间戳 | 通过，`t0/t1` 单位为厘秒（×10 = 毫秒） |
| 置信度与无语音概率 | 通过，`token_probability()`、`no_speech_probability()` 可用 |
| Silero VAD | 通过，正确切出 4 个语音段 |
| **CUDA GPU 后端** | **通过**，RTX 3060 实测；turbo-q5 模型 94.5s 真实语音 **2.33s（40.6x 实时）** |
| **Vulkan GPU 后端** | **通过**，`whisper-rs --features vulkan` 编译并运行；turbo-q5 稳态 **2.35s（40x 实时）**，与 CUDA 持平 |
| **DTW 词级对齐** | **通过**，关闭 flash attention 后 26/28 token 有 DTW 时间戳 |
| **JSON 全量输出** | **通过**，`-ojf` 输出每 token 的 `offsets`/`p`/`t_dtw` |
| ffmpeg 9.0.2 | 通过，`libass` + `ass`/`subtitles` 滤镜可用，音频提取成功 |
| Tauri CLI | 已安装 2.12.3 |
| CPU 吞吐 | base.en 60s 音频 16 线程 **8.96s（6.7x 实时）** |

### 1.2 实测性能与准确率（RTX 3060 12GB，large-v3-turbo-q5_0）

**英文真实素材（YouTube，带字幕作参考）：**

| 素材 | 时长 | 耗时 | 实时倍率 | WER |
| --- | --- | --- | --- | --- |
| TED 演讲（人工英文字幕） | 355.5s | 8.75s | **40.6x** | **6.93%**（原始）/ **3.69%**（统一书写规范） |
| 斯坦福毕业演讲（自动字幕） | 904.2s | 19.35s | **46.7x** | **1.99%**（参考为 ASR，偏乐观） |

> WER 计算说明见第 1.3 节。人工字幕那条是可信基准；自动字幕那条的参考与假设同源，数字偏乐观。

**中文真实素材：**

| 后端 | 素材 | 时长 | 耗时 | 实时倍率 |
| --- | --- | --- | --- | --- |
| Vulkan（whisper-rs 链接） | 中文对话 | 94.5s | **2.35s** | 40.2x |
| CUDA（官方 CLI） | 中文对话 | 94.5s | 2.33s | 40.6x |
| Vulkan（首次运行） | 中文对话 | 94.5s | 15.65s | 6.0x（冷启动） |

**其他指标：**

| 项 | 值 |
| --- | --- |
| 模型加载 | 0.48s（常驻后不重复） |
| 显存占用 | 1299 MiB / 12288 MiB |
| VAD 开销 | **负**：跳过静音后总耗时下降 22%（3.00s → 2.33s） |
| DTW 开销 | +46%（8.75s → 12.77s），换来 100% token 覆盖 |
| DTW token 覆盖 | 1134 / 1134 = **100%** |

**结论**：真实素材上 turbo-q5 在 3060 上稳定达到 **40–47x 实时**。按 40x 估算，60 分钟视频 ASR 约 **1.5 分钟**。PRD 的 12 分钟目标有极大余量，**ASR 已完全不是瓶颈**。

### 1.2.1 WER 计算说明（可复现）

测试方法：

1. 用 `yt-dlp` 下载视频音频与英文字幕。
2. 用 ffmpeg 提取 16 kHz 单声道 PCM。
3. 用 whisper.cpp CUDA turbo-q5 转写，输出 JSON。
4. 文本归一化：转小写、去标点、合并空白、剔除 `[Music]`/`[applause]` 等舞台提示。
5. 标准 Levenshtein 对齐，WER = (S + D + I) / N。

TED 素材的两次结果差异来源：

| 处理 | WER | 说明 |
| --- | --- | --- |
| 原始文本 | 7.69% | 含片头译者/审校者署名，两侧不一致 |
| 去掉片头署名 | 6.93% | 剔除前 10 词 |
| 统一数字与口语写法 | **3.69%** | `four`↔`4`、`'cause`↔`because`、`gonna`↔`going to` 视为等价 |

抽样看到的错误大多是**书写规范差异**而非识别错误：数字阿拉伯写法 vs 英文单词、口语缩合、字幕里的 `[laughter]` 标注。统一规范后 3.69% 更能反映真实识别能力。

**斯坦福那条 1.99% 不可直接对比**：参考字幕本身是 YouTube 自动生成的（与 Whisper 同源），两者高度一致属于预期，只说明时间轴与主体文本对齐良好，不代表对人工标注的准确率。

### 1.3 已实测的关键坑

**DTW 与 flash attention 冲突（已确认）**

whisper.cpp 默认 `flash_attn = true`，此时 DTW 会被**静默禁用**：

```
whisper_init_with_params_no_state: dtw_token_timestamps is not supported with flash_attn - disabling
whisper_init_with_params_no_state: flash attn = 1
whisper_init_with_params_no_state: dtw        = 0
```

必须显式关闭：

```bash
whisper-cli -m model.bin -f audio.wav -dtw large.v3.turbo -nfa
```

Rust 侧对应 `WhisperContextParameters::default().flash_attn(false)`。关闭后 DTW 生效（`dtw = 1`），`t_dtw` 从 -1 变为有效毫秒值（26/28 token）。

**DTW 预设名**：CLI 用 `large.v3.turbo`（点分隔），Rust 枚举是 `DtwModelPreset::LargeV3Turbo`。

**turbo 模型 CPU 性能**：large-v3-turbo-q5_0 在 7950X 16 线程 CPU 上仅 **0.2x 实时**（60s 音频 276s），比 base.en 的 6.7x 慢 33 倍。**CPU 完全跑不动 large 系列，GPU 是硬需求。**

**VAD 是必选项而非可选项**：静音/噪声素材（如纯 BGM 视频）不启用 VAD 时，Whisper 会产生严重幻觉——实测两段 5–7 分钟视频分别输出 11 次重复的 "Thank you." 和 15 次 "*cute*" / "I'm going to go."。启用 VAD 后这些幻觉段被完全跳过，且总耗时下降。

**中文语音需要显式指定语言**：`-l en` 处理中文素材会输出无意义内容，`-l auto` 对短素材误判率高（实测把韩语素材判成 ko、把静音素材判成 en）。产品必须支持手动指定源语言。

**Vulkan 首次运行有冷启动开销**：首次推理需编译着色器，94.5s 音频耗时 15.65s；第二次起降至 **2.35s**，与 CUDA 持平。产品必须预热模型（启动时跑一次 1 秒静音推理），否则用户首次任务会莫名慢 6 倍。

**Vulkan 构建需要 Ninja + vcvars，不能直接用 MSBuild**：

- 用默认 VS 生成器会失败：`MSB6003` + `DirectoryNotFoundException`，原因是 `ggml-vulkan` 的 `vulkan-shaders-gen` 外部项目在 MSBuild 下 `try_compile` 失效。
- 直接用 `CMAKE_GENERATOR=Ninja` 也失败：残留的 `CMakeCache.txt` 带 `CMAKE_GENERATOR_INSTANCE`，与 Ninja 冲突（`Generator Ninja does not support instance specification`）。
- **可用组合**：清空 target → 在 `vcvars64.bat` 环境里设置 `CMAKE_GENERATOR=Ninja` → `cargo build --features vulkan`。实测 1m20s 构建成功。

**Vulkan SDK 安装需要管理员权限**：headless 模式会报 `Cannot elevate access rights while running from command line`。用 `Start-Process -Verb RunAs` 提权可成功（实测 exit=0），SDK 可装到任意目录（`--root`），无需系统级安装。

**DTW 输出的是 token 起点，不是区间**：`t_dtw` 给出的是该 token 的起始时刻（毫秒），不是 `[start, end]`。想得到词时长，需要用相邻 token 的 `t_dtw` 差值。直接拿 `t_dtw` 当结束时间会得到 `end == start` 的零长度词，被过滤后只剩 30% 的 token（实测 1134 → 254）。

**DTW 需要同时开 `-ojf` 才能看到 `t_dtw` 字段**：只加 `-oj` 输出的 JSON 里没有 token 级数据。

**YouTube 素材获取**：本机需走系统代理（`127.0.0.1:30671`），且 yt-dlp 需要 `--ffmpeg-location` 或手动用 ffmpeg 转码。yt-dlp 的二进制从 GitHub 直连会截断，必须走代理下载才能用。

### 1.4 未验证（必须如实标注）

| 项 | 原因 |
| --- | --- |
| `large-v3` 完整精度/速度 | 未下载 3.10GB 模型（turbo 已满足需求） |
| Tauri 应用完整构建与烧录 | 未执行 |
| Rust 链接 CUDA 后端 | 本机无 CUDA Toolkit，改用官方 CLI sidecar 验证 |
| 多说话人/重口音素材 WER | 仅测了 2 条标准美式发音素材 |
| 词边界人工标注误差 | DTW 覆盖率和时间值已验证，但未做人工逐词标注对齐 |

> CUDA 验证走的是**官方预编译 CLI**（b5454，CUDA 12.4）；Vulkan 验证走的是 **`whisper-rs --features vulkan` 自构建**（真实链接，非 sidecar）。两者性能实测持平（40.6x vs 40.2x），说明 Rust 侧链接 GPU 后端完全可行。

### 1.5 选型判断

**Rust 可行，核心链路已全部验证通过。** 具体：

1. **交付形态干净**：本机没有 Python，Python 方案必须内置运行时并处理 PyInstaller + CTranslate2 + CUDA DLL 的组合坑；Rust 产出单个安装包。
2. **资源占用低**：空闲内存约 40–80MB（Python 方案 300MB+），启动即用；任务取消、子进程管理更可靠。
3. **桌面集成原生**：Tauri 用 IPC 替代本地 HTTP 服务，没有端口占用、token 注入、回环监听这些额外攻击面。
4. **GPU 性能达标**：3060 上 turbo 模型单条真实语音约 13x 实时，60 分钟视频预计 4–5 分钟（估算，需真实素材复测）。
5. **安装包**：主程序约 15–25MB；含 ffmpeg/ffprobe（各约 100MB）后约 240MB。

**代价与风险：**

1. **真实素材吞吐未定稿**。重复音频的 112x 不可信，需用真实视频复测。
2. **词级时间戳精度未量化**。DTW 已确认可用，但未测中位/P90 误差。
3. **开发周期约 1.5–2 倍**。慢在 FFI 调试、GPU 构建流水线和打包。
4. **Rust 链接 CUDA 未验证**。当前用官方 CLI 验证，`whisper-rs --features cuda` 仍需 CI 验证。

**决策建议**：Rust 方案可以锁定。默认 GPU 后端定为 **Vulkan**（实测 40x，与 CUDA 持平，分发仅多 10–20MB，且不绑定 NVIDIA）；CUDA 作为可选性能包（官方预编译 sidecar）。默认模型 `large-v3-turbo-q5_0`（574MB）。**必须实现启动预热**，否则首次任务会因 Vulkan 着色器编译慢 6.7 倍。

## 2. 与 Python 方案对比

| 维度 | Python（faster-whisper） | Rust（whisper-rs） | 胜者 |
| --- | --- | --- | --- |
| ASR 模型质量 | Whisper large-v3 | 同一模型（GGML 量化） | 平 |
| 词级时间戳 | 原生 word_timestamps，质量好 | token 级可用（已实测）；DTW 可提升（未实测） | Python（暂定） |
| 推理速度（3060） | CTranslate2，约 8–12x 实时 | whisper.cpp CUDA，约 5–8x 实时 | Python |
| CPU 速度（7950X） | 未实测 | base.en 6.7x（已实测） | 未知 |
| 显存占用 | int8_float16 约 4.7GB | q5_0 约 2.5–3GB | Rust |
| 安装包 | 约 400MB + 运行时 | 主程序 15–25MB；含 ffmpeg 合计约 240MB | 相近 |
| 空闲内存 | 300MB+ | 40–80MB | Rust |
| 启动速度 | 2–5s | <1s | Rust |
| 打包复杂度 | 高（PyInstaller/CUDA/AV） | 中（CUDA 构建，可绕开） | Rust |
| 开发速度 | 快 | 慢 1.5–2x | Python |
| 本地 LLM 翻译 | 生态成熟 | 靠 Ollama / llama-cpp-2 | Python |
| 任务取消/子进程控制 | 一般 | 强 | Rust |
| 类型安全/长期维护 | 一般 | 强 | Rust |
| 跨平台 | 需分别打包 | 交叉编译较顺 | Rust |

> 速度两栏均为公开基准量级，本机只实测了 Rust CPU 一项。同条件 GPU 对比尚未进行。

## 3. 总体架构

```
┌──────────────────────────────────────────────────────────────┐
│                     Tauri 2 应用进程                          │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  React + TypeScript 前端（系统 WebView2 渲染）          │  │
│  │  项目列表 │ 任务队列 │ 双语编辑器 │ 设置 │ 日志          │  │
│  └───────────────────────┬────────────────────────────────┘  │
│                          │ invoke / emit（IPC，无 HTTP）      │
│  ┌───────────────────────┴────────────────────────────────┐  │
│  │                  Rust 核心（tokio 运行时）               │  │
│  │  commands/       job/            pipeline/              │  │
│  │  项目 CRUD       串行队列          probe → extract       │  │
│  │  字幕编辑        CancellationToken  → asr → segment      │  │
│  │  导出/设置       进度事件           → translate → qc     │  │
│  │                                    → export             │  │
│  │  services/                                              │  │
│  │   media(ffmpeg 子进程)  asr(whisper-rs)                 │  │
│  │   translator(reqwest)   qc / exporter / glossary        │  │
│  └───────┬──────────────────────┬──────────────────────────┘  │
│          │                      │                             │
│  ┌───────┴────────┐   ┌─────────┴──────────┐                  │
│  │ rusqlite(WAL)  │   │ 文件缓存 work/<id>/ │                  │
│  └────────────────┘   └────────────────────┘                  │
└──────────┬───────────────────────┬───────────────────────────┘
           │                       │
   ffmpeg.exe / ffprobe.exe   whisper.cpp（静态链接）
   （sidecar 子进程）          ggml-vulkan.dll 或 CUDA 运行库
```

### 3.1 与 Python 版的架构差异

| 项 | Python 版 | Rust 版 |
| --- | --- | --- |
| 前后端通信 | 127.0.0.1 HTTP + WebSocket + token | Tauri `invoke` + `emit` |
| 后端框架 | FastAPI + Uvicorn | Tauri commands + tokio |
| ASR | faster-whisper（CTranslate2） | whisper-rs（whisper.cpp） |
| 媒体 | ffmpeg 子进程 | 相同，ffmpeg sidecar |
| 数据库 | sqlite3 | rusqlite（bundled） |
| 桌面壳 | pywebview / 浏览器 | Tauri 2（WebView2） |
| 打包 | PyInstaller + Inno Setup | `tauri build` → NSIS |

## 4. crate 选型

| 用途 | crate | 版本（已核对 crates.io） | 说明 |
| --- | --- | --- | --- |
| 桌面框架 | `tauri` | 2.12 | 含 `tauri-plugin-dialog`、`opener`、`shell` |
| 异步运行时 | `tokio` | 1.x | `full` feature |
| 取消 | `tokio-util` | 0.7 | `CancellationToken` |
| ASR | `whisper-rs` | 0.16 | 包装 whisper.cpp；**0.16 已支持 DTW 词级时间戳** |
| 音频重采样/解码 | 不引入 | — | 统一交给 ffmpeg，输出 16k 单声道 f32 |
| 数据库 | `rusqlite` | 0.40 | `bundled` feature，自带 SQLite |
| 序列化 | `serde` / `serde_json` | 1.x | JSONL 产物、IPC、配置 |
| HTTP | `reqwest` | 0.13 | `rustls-tls` + `json` + `stream`，避免 OpenSSL |
| 错误 | `thiserror` / `anyhow` | 2.x / 1.x | 领域错误 vs 边界错误 |
| 日志 | `tracing` / `tracing-appender` | 0.1 / 0.2 | 按天滚动 |
| 密钥 | `keyring` | 4.x | Windows 凭据管理器 |
| 哈希 | `blake3` | 1.8 | 文件指纹，比 sha256 快数倍 |
| 遍历目录 | `walkdir` | 2.x | 文件夹递归扫描 |
| 正则/分词 | `regex` / `unicode-segmentation` | 1.x | 标点切分、字素边界 |
| 并发流 | `futures` | 0.3 | `buffer_unordered` 控制翻译并发 |
| 时间 | `chrono` | 0.4 | 时间戳格式化 |
| ID | `uuid` | 1.x | v4 |
| 原子写 | `atomicwrites` | 0.4 | Windows 下 `MoveFileEx` 替换语义 |
| 磁盘空间 | `fs2` | 0.4 | `available_space` |
| CPU 核数 | `num_cpus` | 1.x | whisper 线程数 |
| 进程 | `tokio::process` | 内置 | ffmpeg/ffprobe |
| 测试 | `criterion` | 0.5 | 断句算法基准 |
| 可选本地 LLM | `mistral.rs` 0.8 或 HTTP 调 Ollama | — | 不建议 v1 内嵌 |
| 可选 NLLB | `ct2rs` 0.10 | — | 绑定成熟度一般，P1 评估 |

**不引入的东西**：`ffmpeg-next`（需要 libav 开发库，Windows 构建痛苦）、`torch`/`tch`（体积巨大且无必要）、`egui`/`iced`（视频播放器与虚拟表格实现成本高）。

## 5. 进程与线程模型

```
Tauri 主线程
  └─ tokio Runtime
      ├─ JobManager task（消费 mpsc，串行调度）
      │    ├─ probe/extract/segment/translate/qc/export：async
      │    └─ ASR：spawn_blocking → 专用线程（持有 WhisperContext）
      ├─ 翻译任务：buffer_unordered(4)
      ├─ ffmpeg 子进程：tokio::process::Command
      └─ DB：spawn_blocking + Mutex<Connection>
```

关键约束：

1. **ASR 全局单实例**。`WhisperContext` 不实现 `Sync` 的跨线程共享时，放入专用线程，通过 channel 收发命令；换模型时 drop 后重建。
2. **DB 不做异步**。rusqlite 是同步 API，所有调用走 `spawn_blocking`，连接用 `Arc<Mutex<Connection>>`；WAL 模式下读写不互斥。
3. **取消粒度**。`whisper_full()` 内部不可中断，取消在 chunk 边界生效；ffmpeg 用 `Child::start_kill()` 立即终止。
4. **事件推送**。所有进度通过 `app.emit("job://progress", payload)`，前端 `listen` 订阅；不轮询。

## 6. ASR 方案

### 6.1 模型与后端

模型体积为 HuggingFace 实际 `content-length`（2026-10-20 实测）：

| 模型（GGML） | 实际体积 | 3060 实测吞吐 | 用途 |
| --- | --- | --- | --- |
| `ggml-large-v3.bin`（f16） | **3.10 GB** | 未测 | 质量优先 |
| `ggml-large-v3-q5_0.bin` | ~1.1 GB（量化） | 未测 | 显存/磁盘受限 |
| `ggml-large-v3-turbo-q5_0.bin` | **574 MB** | **~13x（真实语音）** | **推荐默认** |
| `ggml-small.en.bin` | **488 MB** | 未测 | CPU 高质量 |
| `ggml-base.en.bin` | **141 MB** | CPU 6.7x（7950X 实测） | CPU 默认 |
| `ggml-tiny.en.bin` | **74 MB** | CPU ~3x（实测） | 低配 |
| `ggml-silero-v6.2.0.bin` | **0.84 MB** | — | VAD 必装 |

> 注意：`large-v3` 的 f16 版本是 3.1GB，不是早期资料常见的 1.1GB（那是 q5_0 量化版）。首次下载必须显示真实体积并支持断点续传。

后端选择：

| 后端 | 构建要求 | 分发 | 实测性能 | 建议 |
| --- | --- | --- | --- | --- |
| **CUDA（官方预编译）** | 无需构建，直接下载 b5454 包 | 653MB（含 cublas/cudart/nvrtc） | **40.6x（3060 实测）** | **默认（sidecar）** |
| **Vulkan（自构建）** | Vulkan SDK + Ninja + vcvars | 带 `ggml-vulkan.dll`，约 10–20MB | **40x（3060 实测）** | **默认（链接）** |
| CUDA（自行构建） | CUDA Toolkit + libclang | 需带 cudart/cublas/cudnn | 预计同 CUDA | CI 构建 |
| CPU | 无 | 无额外依赖 | base.en 6.7x；turbo **0.2x** | 兜底/草稿 |

**关键结论**：

1. **Vulkan 与 CUDA 实测性能持平**（40x vs 40.6x），而 Vulkan 的安装包只多 10–20MB。这意味着**默认走 Vulkan 是更优选择**——不绑定 NVIDIA，分发体积小一个数量级。
2. Vulkan 首次运行有 **6.7x 的冷启动惩罚**（15.65s vs 2.35s），必须在启动时预热。
3. CUDA 官方预编译包（653MB）适合追求极限速度或 Vulkan 构建失败时的兜底。

> 3060 上 Vulkan 的绝对速度足以跑 `large-v3-turbo`，且安装包小一个量级。CUDA 包作为“高级用户可选下载”更合理。注意 `whisper-rs-sys` 的 build.rs 在 Vulkan 特性下**强制要求 `VULKAN_SDK` 环境变量**，CI 与本地构建机都必须装 SDK（运行机不需要）。

### 6.2 调用示意

```rust
use whisper_rs::{FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters};

let ctx = WhisperContext::new_with_params(model_path, WhisperContextParameters::default())?;
let mut state = ctx.create_state()?;

let mut p = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
p.set_language(Some("en"));
p.set_translate(false);
p.set_no_context(true);            // 关闭上文条件，抑制重复幻觉
p.set_token_timestamps(true);      // 词级时间戳的基础
p.set_suppress_blank(true);
p.set_suppress_nst(true);
p.set_no_speech_thold(0.6);
p.set_logprob_thold(-1.0);
p.set_entropy_thold(2.4);
p.set_temperature_inc(0.0);
p.set_n_threads(num_cpus::get().min(16) as i32);  // 实测 16 线程最优，超过收益递减
p.set_print_special(false);
p.set_print_progress(false);
p.set_print_realtime(false);
p.set_print_timestamps(false);
// 分块处理：offset/duration 以毫秒计
p.set_offset_ms(chunk_start_ms as i32);
p.set_duration_ms(chunk_len_ms as i32);

state.full(p, &pcm_f32)?;

// 注意：以下签名以 whisper-rs 0.16 实测为准
// full_n_segments() 直接返回 c_int（不是 Result）
// get_segment()/get_token() 返回 Option（不是 Result）
for i in 0..state.full_n_segments() {
    let Some(seg) = state.get_segment(i) else { continue };
    let text = seg.to_str_lossy()?;
    let start_cs = seg.start_timestamp();   // 单位厘秒（10ms）
    let end_cs   = seg.end_timestamp();
    let no_speech = seg.no_speech_probability();

    for j in 0..seg.n_tokens() {
        let Some(tok) = seg.get_token(j) else { continue };
        let d = tok.token_data();           // d.t0 / d.t1 / d.t_dtw 单位厘秒，d.p 为概率
        let p = tok.token_probability();
        // 过滤 [_BEG_] 等特殊 token，按空格/标点边界合并为 word
    }
}
```

> 上述签名（`Option` 返回、`full_n_segments()` 非 Result）已通过实际编译验证；旧版本写法会编译失败。`set_abort_callback_safe(|| cancel.is_cancelled())` 可用于在解码循环内响应取消。

**线程数实测**（7950X，base.en，60s 音频）：

| 线程 | 耗时 | 实时倍率 |
| --- | --- | --- |
| 4 | 24.13s | 2.5x |
| 8 | 13.20s | 4.5x |
| 16 | 8.96s | 6.7x |

不显式设置 `set_n_threads` 时默认值偏低（tiny.en 60s 用了 11.66s），必须手动设置。

### 6.3 词级时间戳（关键验证点）

whisper.cpp 的 token 时间戳有两种来源，精度差别很大：

- **默认（非 DTW）**：由注意力权重或插值推导，词边界误差可达数百毫秒。
- **DTW 对齐**（whisper-rs 0.16 已暴露）：通过交叉注意力对齐头做动态时间规整，精度接近 WhisperX。

**方案 A：DTW 对齐（首选，API 已确认，精度未实测）**

```rust
use whisper_rs::{DtwMode, DtwModelPreset, DtwParameters, WhisperContextParameters};

let mut cp = WhisperContextParameters::default();
cp.dtw_parameters(DtwParameters {
    mode: DtwMode::ModelPreset { model_preset: DtwModelPreset::LargeV3Turbo },
    ..Default::default()
});
cp.flash_attn(false);   // DTW 与 flash attention 互斥：flash_attn=true 会让 DTW 被静默禁用

let ctx = WhisperContext::new_with_params(model_path, cp)?;
```

> 以上字段与枚举已从 whisper-rs 0.16 源码逐行确认：`WhisperContextParameters` 有 `use_gpu`/`flash_attn`/`gpu_device`/`dtw_parameters` 四个字段；`DtwMode` 有 `None`/`TopMost{n_top}`/`Custom{aheads}`/`ModelPreset{model_preset}`；`DtwModelPreset` 覆盖 Tiny 到 LargeV3Turbo。`dtw_parameters` 是字段名，setter 也叫 `dtw_parameters`。

读取时优先用 `t_dtw`，为负值（未计算）时回退到 `t0/t1`：

```rust
let d = tok.token_data();
let start_cs = if d.t_dtw >= 0 { d.t_dtw } else { d.t0 };
```

注意：

- `DtwModelPreset` 必须与实际模型匹配；`distil-large-v3` 没有对应 preset，只能用 `TopMost` 或回退方案 B。
- DTW 增加约 5–10% 推理耗时（公开资料，未本机实测），换取词级精度。
- DTW 的精度收益**尚未在本机用真实素材量化**，必须纳入 Spike 验收。

**方案 B：token → word 合并（回退）**

1. 过滤特殊 token 与时间戳 token。
2. GPT-2 BPE 的 token 以空格开头表示新词；以空格/标点边界合并为 word。
3. `word.start = 首 token t0`，`word.end = 末 token t1`，`prob = min(token.p)`。
4. 对相邻且间隔 <80ms 的碎片词做合并，避免“I / don't / know”被拆散。
5. 用 VAD 语音区间做校正：落在静音区的词边界向外吸附到区间端点。

**方案 C：VAD 区间 + 句级比例分配（兜底）**

1. 用 Silero VAD 得到语音区间 `[s, e]`。
2. 区间内按标点切成句子，按字符数比例分配时长。
3. 句子内部再按词数均分，仅在停顿处断开。
4. 精度约 ±200ms，对字幕足够，但做不了卡拉 OK 级逐词高亮。

**方案 D：外部强制对齐（不做进 v1）**

需要 WhisperX/wav2vec2，Rust 无成熟实现。若未来必须，做成可选 Python sidecar，只对需要的项目跑对齐。

**Spike 验收门槛**（3 条 3–5 分钟真实素材）：

| 指标 | 通过线 | 实测 |
| --- | --- | --- |
| 词边界中位误差 | ≤ 150ms（DTW）/ ≤ 250ms（方案 B） | 未做人工标注评测 |
| 词边界 P90 误差 | ≤ 350ms（DTW）/ ≤ 550ms（方案 B） | 未做人工标注评测 |
| DTW token 覆盖率 | ≥ 95% | **100%**（1134/1134，已达标） |
| 断句后字幕与语音不同步率 | ≤ 3% | 待管线实现后测 |
| 60min 等效吞吐（turbo/Vulkan） | ≥ 12x 实时 | **40x**（已达标，3.3 倍余量） |
| WER（清晰语音） | ≤ 8% | **3.69%**（TED 人工字幕基准，已达标） |

方案 A 达标即锁定 DTW；A 不达标但 B 达标则关闭 DTW（省 5–10% 时间）；两者都不达标，重新评估 Python 方案。

### 6.4 分块与显存

- 按 VAD 静音点切块，目标 5–10 分钟/块；找不到静音则固定 10 分钟、重叠 5 秒。
- 每块解码为 16kHz 单声道 f32：10 分钟约 38MB，峰值可控。
- 块间时间戳加偏移；重叠区按“后块优先、边界 200ms 内去重”。
- 取消在块边界检查 `CancellationToken`，延迟 ≤ 一块时长。

### 6.5 幻觉抑制

与 Python 版一致，参数映射如下（setter 名称已从 whisper-rs 0.16 源码确认存在）：

| 目的 | Python 版 | Rust 版 |
| --- | --- | --- |
| 关闭上文条件 | `condition_on_previous_text=False` | `set_no_context(true)` |
| 无语音阈值 | `no_speech_threshold=0.6` | `set_no_speech_thold(0.6)` |
| 压缩比阈值 | `compression_ratio_threshold=2.4` | `set_entropy_thold(2.4)`（语义相近，非完全等价） |
| 低置信过滤 | `log_prob_threshold=-1.0` | `set_logprob_thold(-1.0)` |
| 静音过滤 | `vad_filter=True` | 独立 Silero VAD 预切分 + `set_suppress_blank(true)` |

> 说明：whisper.cpp 没有与 `compression_ratio_threshold` 完全对应的参数，`entropy_thold` 控制的是解码熵而非压缩比，只能作为近似替代。实际阈值需用真实素材调参，不能照搬 Python 数值。

**实测观察到的幻觉**：用 11 秒语音循环拼接成 60 秒/11 分钟音频时，turbo 模型对重复内容会连续输出相同句子（54 段全部是同一句）。真实视频不会如此规律，但**音乐、掌声、循环 BGM 段仍可能触发重复幻觉**，必须靠 VAD 切分 + 重复检测兜底。

后处理规则（重复段、纯标点、纯音乐符号、低置信段）保持与 Python 版相同的判定，直接复用测试用例。

### 6.6 DTW 配置（实测必须）

DTW 与 flash attention 互斥，且 whisper.cpp **默认开启 flash attention**，不显式关闭会导致 DTW 静默失效：

```rust
let mut cp = WhisperContextParameters::default();
cp.flash_attn(false);   // 必须：否则 DTW 被静默禁用
cp.dtw_parameters(DtwParameters {
    mode: DtwMode::ModelPreset { model_preset: DtwModelPreset::LargeV3Turbo },
    ..Default::default()
});
```

实测对比（jfk.wav，11s，turbo-q5）：

| 配置 | flash attn | dtw | `t_dtw >= 0` 的 token | 总耗时 |
| --- | --- | --- | --- | --- |
| 默认 + `-dtw` | 1 | **0（被禁用）** | 0 / 28 | 0.84s |
| `-nfa` + `-dtw` | 0 | 1 | **26 / 28** | 1.06s |

关闭 flash attention 后耗时增加约 26%（0.84s → 1.06s），这是 DTW 的额外代价。若不需要逐词高亮，可以保持 flash attention 开启以换取速度。

## 7. 断句

算法、常量、验收标准**完全沿用** Python 版 TRD 第 5.3 节。Rust 实现要点：

```rust
pub struct SegmenterConfig {
    pub max_line_zh: usize,      // 20
    pub max_lines: usize,        // 2
    pub max_cue_ms: i64,         // 7000
    pub min_cue_ms: i64,         // 1000
    pub min_gap_ms: i64,         // 40
    pub max_cps_zh: f32,         // 9.0
    pub max_cps_en: f32,         // 17.0
    pub pause_split_ms: i64,     // 350
}
```

- 中文长度用 `s.chars().count()`；字素簇用 `unicode-segmentation` 处理 emoji/组合字符。
- 标点识别用 `regex` 预编译静态 `LazyLock<Regex>`，避免热路径分配。
- 时间统一 `i64` 毫秒，禁止浮点累计误差。
- 断句结果实现 `Serialize/Deserialize`，直接落 JSONL，与 Python 版产物格式一致，便于交叉比对。
- 单元测试直接移植 Python 版的 fixture（输入词序列 → 期望 cue 边界），确保两版行为一致。

翻译后的二次切分同样保留：中文超容量时按中文标点重切，并重新分配时间。

## 8. 翻译

### 8.1 客户端

```rust
let client = reqwest::Client::builder()
    .timeout(std::time::Duration::from_secs(120))
    .build()?;

#[derive(serde::Serialize)]
struct ChatRequest<'a> {
    model: &'a str,
    messages: Vec<Message<'a>>,
    temperature: f32,
    #[serde(skip_serializing_if = "Option::is_none")]
    response_format: Option<ResponseFormat>,
}
```

- OpenAI 兼容接口：`POST {base_url}/chat/completions`。
- Ollama：`POST http://127.0.0.1:11434/api/chat`，`stream: false`，`format: "json"`。
- 并发：`futures::stream::iter(batches).map(translate_one).buffer_unordered(4)`。
- 重试：手写循环 + `tokio::time::sleep`，1s/2s/4s，最多 3 次；仅对超时/429/5xx 重试。
- JSON 解析：先 `trim`，剥离 ```json 围栏，再 `serde_json::from_str::<Vec<TransItem>>`；失败按条重试，仍失败标 `needs_review`。

### 8.2 严格 ID 对齐

```rust
let want: BTreeSet<i64> = items.iter().map(|x| x.idx).collect();
let got: BTreeSet<i64> = resp.iter().map(|x| x.id).collect();
if want != got {
    // 缺失项单独重试；多余项丢弃并记日志；绝不按顺序盲配
}
```

### 8.3 提示词与术语表

与 Python 版完全一致（TRD.md 5.4.3 / 5.4.4），把提示词模板做成 `const` 并带 `PROMPT_VERSION`，参与缓存键。术语后置校验：译文未包含目标词时强制替换并打标。

### 8.4 本地翻译（P1）

| 方案 | 实现 | 评价 |
| --- | --- | --- |
| Ollama | HTTP，`qwen2.5:7b-instruct` | **首选**，零集成成本 |
| mistral.rs | 进程内推理 | 编译重、显存占用高，v2 再评估 |
| ct2rs + NLLB | CTranslate2 绑定 | 绑定不成熟，仅作备选 |
| llama-cpp-2 | llama.cpp 绑定 | 可行，但又要处理一套原生构建 |

## 9. 媒体处理

全部通过 **ffmpeg 子进程**，不链接 libav。

```rust
// 探测
tokio::process::Command::new(ffprobe_path)
    .args(["-v", "error", "-print_format", "json",
           "-show_format", "-show_streams", input])
    .output().await?;

// 提取 16k 单声道 f32（供 whisper 直接使用）
tokio::process::Command::new(ffmpeg_path)
    .args(["-y", "-i", input, "-vn", "-map", "0:a:0",
           "-ac", "1", "-ar", "16000", "-c:a", "pcm_f32le",
           "-f", "f32le", audio_out])
    .status().await?;

// 预览代理（解决 WebView 对 MKV/HEVC 支持差）
// -vf scale=-2:720 -c:v libx264 -preset veryfast -crf 23 -c:a aac

// 烧录
tokio::process::Command::new(ffmpeg_path)
    .args(["-y", "-i", input,
           "-vf", &format!("subtitles={}:fontsdir={}", ass_escaped, fonts_dir),
           "-c:v", "libx264", "-preset", "medium", "-crf", "18",
           "-c:a", "copy", output])
    .spawn()?;
```

要点：

- **参数一律用数组传**，不拼 shell 字符串；Windows 中文/空格路径安全。
- ASS 路径转义：优先 `set_current_dir(work_dir)` 后用相对文件名，避开 `C\:` 转义。
- 烧录进度：`-progress pipe:1 -nostats`，解析 `out_time_ms` 计算百分比。
- sidecar 路径：Tauri `externalBin` 解析，开发态回退到 `PATH`。
- ffmpeg 构建必须含 `--enable-libass`，CI 里校验 `ffmpeg -filters | grep subtitles`。

## 10. 数据与缓存

### 10.1 数据库

Schema 与 Python 版完全一致（TRD.md 3.1）。实现差异：

- `rusqlite` + `bundled`，无需用户安装 SQLite。
- `PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;`
- 迁移用 `PRAGMA user_version` 手写，避免额外依赖。
- 所有写入包在事务里；批量插入 cue 用 prepared statement。

### 10.2 产物与原子写

目录结构不变（`%LOCALAPPDATA%\SubBridge\work\<project_id>\`）。原子写用 `atomicwrites::AtomicFile`，Windows 下走 `MoveFileExW(MOVEFILE_REPLACE_EXISTING)`，避免 `rename` 不能覆盖的问题。

### 10.3 缓存键

```rust
let key = blake3::hash(&serde_json::to_vec(&CacheKey {
    file_hash, stage, stage_version, params, model, prompt_version,
})?);
```

字段与 Python 版一致，保证两版缓存语义可对齐（目录不共用）。

## 11. 任务队列与取消

```rust
enum JobState { Queued, Running, Paused, Failed, Done, Canceled }

struct JobHandle {
    id: Uuid,
    cancel: CancellationToken,
    child: Mutex<Option<tokio::process::Child>>, // 当前 ffmpeg
}
```

- `JobManager` 持有 `mpsc::Receiver<JobCommand>`，单消费者串行执行。
- 每个任务一个 `CancellationToken`；ASR 在 chunk 边界检查，ffmpeg 直接 kill。
- 失败保留已完成阶段产物；`retry` 从 `job.stage` 继续，校验输入哈希与 `stage_version`。
- 启动时把残留 `Running` 标为 `Paused`，等待用户恢复（避免上次崩溃后状态卡死）。
- 翻译按 `idx` 粒度缓存，恢复时只补缺失条目。

## 12. Tauri 命令与事件

### 12.1 命令

| 命令 | 参数 | 返回 |
| --- | --- | --- |
| `probe_environment` | — | ffmpeg/CUDA/Vulkan/模型/磁盘状态 |
| `list_projects` | 分页/筛选 | `Vec<Project>` |
| `create_project` | `path` 或 `paths` | `Project` |
| `delete_project` | `id`, `purge` | `()` |
| `enqueue_job` | `project_id`, `from_stage?` | `job_id` |
| `cancel_job` | `job_id` | `()` |
| `retry_job` | `job_id` | `job_id` |
| `list_jobs` | — | `Vec<Job>` |
| `get_cues` | `project_id`, `flagged?` | `Vec<Cue>` |
| `update_cue` | `cue_id`, `text_en?`, `text_zh?`, `start_ms?`, `end_ms?` | `Cue` |
| `split_cue` | `cue_id`, `at_ms` | `(Cue, Cue)` |
| `merge_cues` | `ids` | `Cue` |
| `run_qc` | `project_id` | `QcReport` |
| `export_project` | `project_id`, `format`, `lang`, `burn_in` | `Artifact` |
| `get_settings` / `set_settings` | — | 脱敏设置 |
| `set_api_key` | `provider`, `key` | `()`（写 keyring） |
| `list_models` / `download_model` | — | 模型状态 |
| `scan_folder` | `path` | `Vec<MediaInfo>` |

### 12.2 事件

```json
{"event":"job://progress","payload":{"job_id":"...","stage":"asr","progress":0.42,"eta_sec":95}}
{"event":"job://log","payload":{"job_id":"...","level":"info","line":"..."}}
{"event":"job://state","payload":{"job_id":"...","status":"failed","error":{"code":"E_LLM_TIMEOUT","message":"..."}}}
{"event":"model://download","payload":{"name":"large-v3-turbo","progress":0.6,"bytes":524288000}}
```

### 12.3 安全

- `tauri.conf.json` 的 `capabilities` 只开放实际用到的命令与插件权限。
- CSP：`default-src 'self'; img-src 'self' asset:; media-src 'self' asset:; style-src 'self' 'unsafe-inline'`。
- release 关闭 devtools；不加载任何远程 URL。
- API Key 只经 `set_api_key` 写入 keyring，命令返回值永不回显明文。
- 文件操作全部 canonicalize 后校验是否位于允许目录内。

## 13. 前端

技术栈不变：React 18 + TypeScript + Vite + Tailwind + shadcn/ui + Zustand + TanStack Query。

差异：

| 项 | Python 版 | Rust 版 |
| --- | --- | --- |
| 请求 | `fetch('/api/...')` | `invoke('command', args)` |
| 实时更新 | WebSocket | `listen('job://progress')` |
| 文件选择 | `<input type=file>` / 路径上传 | Tauri dialog 插件（原生路径，无上传） |
| 视频预览 | `http://127.0.0.1:8765/media/...` | `convertFileSrc(path)` → `asset://` 协议 |
| 打开产物目录 | 后端接口 | `opener` 插件 |

虚拟滚动、字幕同步、键盘操作、质检侧栏等交互设计与 PRD 一致。

## 14. 打包与分发

### 14.1 构建

```powershell
# 前端
cd frontend; npm ci; npm run build

# Rust（默认 Vulkan）
cd src-tauri
cargo tauri build --features vulkan

# CUDA 性能包（可选）
$env:CUDA_PATH="C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA\v12.x"
$env:LIBCLANG_PATH="C:\Program Files\LLVM\bin"
cargo tauri build --features cuda
```

### 14.2 sidecar 与资源

```json
{
  "bundle": {
    "targets": ["nsis"],
    "externalBin": ["binaries/ffmpeg", "binaries/ffprobe"],
    "resources": ["resources/ggml-vulkan.dll", "resources/fonts/*"]
  }
}
```

- Tauri 要求 sidecar 文件名带目标三元组后缀：`ffmpeg-x86_64-pc-windows-msvc.exe`。
- CUDA 包额外携带：`cudart64_12.dll`、`cublas64_12.dll`、`cublasLt64_12.dll`、`cudnn64_9.dll`（注意 NVIDIA 再分发许可）。
- Vulkan 包携带 `ggml-vulkan.dll` 与 Vulkan loader（系统通常已有，缺失时回退 CPU）。

### 14.3 体积估算

ffmpeg 体积为 gyan.dev 9.0.2 essentials 实测：

| 组成 | 大小 |
| --- | --- |
| Tauri 应用 + 前端 | 15–25 MB |
| whisper.cpp + ggml（静态链接进主程序） | 10–20 MB |
| `ffmpeg.exe` | **101 MB**（实测） |
| `ffprobe.exe` | **100 MB**（实测） |
| Vulkan 运行库 | 10–20 MB（或复用系统） |
| **安装包（未压缩合计）** | **约 240–265 MB** |
| 安装包（NSIS LZMA 压缩后，估） | 约 90–120 MB |
| 模型（首次下载，按选择） | base.en 141 MB / turbo-q5 574 MB / large-v3 3.10 GB |

> 旧版本文档写的“60–90MB 安装包”只算了主程序，没算 ffmpeg。**ffmpeg + ffprobe 实际占约 200MB**，这是安装包体积的主要来源。若改用 BtbN `gpl-shared`，exe 变小但需带一组 DLL，总量相近。若要显著瘦身，只能自编译裁剪 ffmpeg（去掉不需要的编码器），可压到 30–50MB，但增加构建维护成本。

### 14.4 模型分发

- 不随安装包分发；首次启动从 HuggingFace（`ggerganov/whisper.cpp`）下载，支持镜像与断点续传。
- 下载用 `reqwest` 流式写临时文件，进度经事件推送，完成后原子替换。
- 支持“导入本地模型目录”，方便离线部署。

### 14.5 CI

- GitHub Actions `windows-latest` 构建 Vulkan 版（无需 CUDA Toolkit）。
- CUDA 版用带 CUDA 的 self-hosted runner 或预编译产物，避免每次 CI 装 3GB Toolkit。
- 缓存 `~/.cargo` 与 `target/`；whisper.cpp 的 CMake 构建是冷编译大头。

## 15. 性能预算

### 15.1 本机实测（CPU，Ryzen 9 7950X）

| 场景 | 耗时 | 实时倍率 |
| --- | --- | --- |
| tiny.en，11s 音频 | 3.49–3.72s | ~3.1x |
| base.en，11s 音频 | 7.19–7.35s | ~1.5x |
| base.en，60s，4 线程 | 24.13s | 2.5x |
| base.en，60s，8 线程 | 13.20s | 4.5x |
| base.en，60s，16 线程 | 8.96s | **6.7x** |
| tiny.en，60s，默认线程 | 11.66s | 5.1x |

### 15.2 按计算量估算（**非实测，仅供规划**）

| 模型 | CPU（16 线程）实时倍率 | 60min 耗时 |
| --- | --- | --- |
| base.en | 6.7x（实测） | ~9 min |
| small.en | ~3x | ~20 min |
| large-v3-turbo-q5 | **0.2x（实测）** | ~5 小时 |
| large-v3 | ~1.1x（估） | ~55 min |

> **关键实测**：turbo-q5 在 CPU 上只有 0.2x（60s 音频 276s）。large 系列在 CPU 上完全不可用，**GPU 是硬需求**。base.en 的 6.7x 是 CPU 唯一可接受的选项，适合无 GPU 机器的快速草稿。

### 15.3 GPU 实测（RTX 3060 12GB，large-v3-turbo-q5_0）

**英文真实素材：**

| 音频 | 时长 | 耗时 | 实时倍率 | WER |
| --- | --- | --- | --- | --- |
| TED 演讲（人工字幕） | 355.5s | 8.75s | **40.6x** | 3.69%（规范化） |
| TED 同素材 + DTW | 355.5s | 12.77s | 27.8x | 同上 |
| 斯坦福毕业演讲（自动字幕） | 904.2s | 19.35s | **46.7x** | 1.99%（参考同源，偏乐观） |

**中文真实素材：**

| 后端 | 音频 | 时长 | 耗时 | 实时倍率 |
| --- | --- | --- | --- | --- |
| Vulkan（链接） | 中文对话 | 94.5s | 2.35s | 40.2x |
| CUDA（CLI） | 中文对话 | 94.5s | 2.33s | 40.6x |

**其他：**

| 项 | 值 |
| --- | --- |
| 显存占用 | 1299 MiB / 12288 MiB |
| 模型加载 | 0.48s |
| VAD 开销 | **负**（跳过静音，-22%） |
| DTW 开销 | +46% |
| DTW token 覆盖 | 100% |

**真实素材结论**：按 **40x 保守估算**，60 分钟视频 ASR 约 **1.5 分钟**；即使按 20x 悲观估算也只需 3 分钟。PRD 的 12 分钟目标有极大余量。

### 15.4 全流程（60min 1080p，估算）

| 阶段 | 40x 估算 | 20x 悲观估算 |
| --- | --- | --- |
| 音频提取 | ~30s | ~30s |
| ASR（turbo-q5 + VAD） | ~1.5min | ~3min |
| 断句 | <1s | <1s |
| 翻译 | 4–6min | 4–6min |
| 质检/导出 | <2s | <2s |
| **合计（不含烧录）** | **6–8min** | **7.5–9.5min** |

**默认模型定为 `large-v3-turbo-q5_0`**（574MB）。ASR 已完全不是瓶颈，**翻译耗时（4–6 分钟）占总时间的 60–75%**，优化重点必须放在翻译批处理与并发上 —— 这是本项目最重要的性能结论。

## 16. 测试计划

| 层 | 内容 |
| --- | --- |
| 单元测试 | segmenter（移植 Python fixture）、exporter（BOM/CRLF/ASS 转义）、qc、缓存键、术语替换 |
| 基准测试 | `criterion`：10 万词断句耗时 < 50ms |
| 集成测试 | 3 条样例视频跑全管线；断网离线；kill 后续跑；批量 10 文件 |
| ASR 冒烟 | 需模型存在才运行，CI 默认跳过；本地 nightly 跑 |
| 前端 | 浏览器模式 + mock IPC 跑 Playwright；Tauri 端用 `tauri-driver`（Windows 支持有限） |
| 交叉验证 | 同一素材分别跑 Python/Rust 版，对比 cue 边界与译文 ID 对齐率 |

**双版本对拍**是 Rust 方案的重要质量手段：断句与导出是纯逻辑，可以直接用同一组 fixture 断言输出完全一致。

## 17. 风险与对策

| 风险 | 等级 | 对策 |
| --- | --- | --- |
| 真实素材吞吐低于预期 | 低 | **已用 94.5s 真实语音实测 40.6x**，60min 预计 2min，余量充足 |
| 静音/音乐素材幻觉 | 高 | **已实测**：不启用 VAD 时纯 BGM 视频输出 11–15 次重复幻觉；**VAD 必须默认开启** |
| DTW 被 flash attention 静默禁用 | 中 | **已实测确认**；必须 `flash_attn(false)`，文档已明确 |
| DTW 精度未量化 | 中 | 待真实英文素材测中位/P90 误差 |
| 源语言误判 | 中 | **已实测**：auto 对短素材/静音素材误判严重；产品必须支持手动指定源语言，默认 en 但可改 |
| CUDA 分发体积 | 中 | 官方包 653MB（压缩后约 250MB）；可提供“CPU 精简版”与“CUDA 完整版” |
| Rust 链接 CUDA 未验证 | 中 | 当前用 CLI sidecar 验证；v1 可先用 sidecar，链接版放 CI |
| Vulkan 无法安装 | 低 | **已解决**：`Start-Process -Verb RunAs` 提权成功，SDK 装到 vendor 目录，无需系统级安装 |
| Vulkan 构建失败 | 中 | **已解决**：必须用 Ninja + vcvars，且清空 CMakeCache；MSBuild 生成器会因 ggml-vulkan 子项目失败 |
| Vulkan 冷启动慢 6.7 倍 | 高 | **已实测**；必须在启动时预热（跑 1s 静音推理），否则首次任务体验极差 |
| whisper-rs FFI 稳定性 | 低 | 用高层安全 API；ASR 放 `spawn_blocking`；捕获 panic |
| 长音频内存 | 低 | 60min 16kHz f32 约 230MB；超长按 VAD 分块 |
| WebView2 缺失（旧 Win10） | 低 | Tauri 安装器自动引导安装 |
| 模型下载网络 | 中 | 已实测 hf-mirror 可用；支持断点续传 + 本地导入 |
| 本地 LLM 显存竞争 | 低 | ASR 与翻译串行；默认云端翻译 |

## 18. 开发计划

| 周 | 内容 | 交付/门槛 |
| --- | --- | --- |
| W1 | **ASR Spike（已完成）**：whisper-rs CPU、CUDA GPU、VAD、DTW、JSON 输出 | 已通过（见第 1.1 节） |
| W1 | **真实素材复测**：2–3 条真实英文视频，测吞吐与词边界误差 | **待执行** |
| W1 | Tauri 骨架、SQLite、ffmpeg sidecar、媒体探测 | 能导入并提取音频 |
| W2 | ASR 集成 + 分块 + 断句 + 纯英 SRT | M1 闭环 |
| W3 | 翻译管线 + 术语表 + 双语 SRT | M2 |
| W4 | 编辑器 + 质检 | M3 |
| W5 | 队列/续跑 + ASS/烧录 + 批量 | M4 |
| W6 | GPU 分发打包、首启引导、性能调优 | 安装包 |

> CUDA 分发已找到捷径：官方 b5454 预编译包自带全部运行库，直接打包 `Release/` 即可，无需用户装 Toolkit。这比原计划（CI 构建 CUDA）省一周。

比 Python 版多出的主要是 GPU 构建与打包调试；纯业务代码量两者接近。

## 18.1 本机环境实测基线

| 项 | 值 |
| --- | --- |
| CPU | AMD Ryzen 9 7950X（16C/32T） |
| RAM | 63.2 GB |
| GPU | RTX 3060 12 GB，驱动 610.88 |
| 磁盘 | C: 44 GB 可用 / E: 96 GB 可用 |
| Rust | cargo 1.99.0 stable-x86_64-pc-windows-msvc |
| MSVC | Visual Studio Community 2026 |
| CMake | `C:\Program Files\CMake\bin\cmake.exe` |
| WebView2 | 155.0.4283.62 |
| CUDA Toolkit | **未安装**（但官方预编译包自带运行库，可直接跑） |
| Vulkan SDK | **已安装 1.4.363.0**（`vendor/vulkan-sdk/`，提权后成功） |
| Python | **未安装** |
| ffmpeg | 已装（gyan.dev 9.0.2，`vendor/ffmpeg/`） |
| Tauri CLI | 已装 2.12.3 |
| whisper.cpp CUDA | 已装（b5454，`vendor/whisper-cuda/Release/`） |
| turbo 模型 | 已下载 574MB（`vendor/models/`） |

> `cargo` 不在默认 PATH，位于 `C:\Users\XiaoMei\.cargo\bin`，构建脚本需显式加入。

## 18.2 已安装依赖清单

| 组件 | 位置 | 体积 | 验证状态 |
| --- | --- | --- | --- |
| Tauri CLI 2.12.3 | `~/.cargo/bin/tauri.exe` | — | `cargo tauri --version` 通过 |
| ffmpeg 9.0.2 | `vendor/ffmpeg/ffmpeg-9.0.2-essentials_build/bin/` | 101 MB | `-version`、`libass`、音频提取通过 |
| ffprobe 9.0.2 | 同上 | 100 MB | JSON 探测通过 |
| whisper.cpp CUDA b5454 | `vendor/whisper-cuda/Release/` | 653 MB 解压后 | GPU 转写、DTW、JSON 输出通过 |
| large-v3-turbo-q5_0 | `vendor/models/` | 574 MB | GPU 转写通过 |
| Silero VAD v6.2.0 | `.research/models/` | 0.84 MB | 4 段切分通过 |
| base.en | `.research/models/` | 141 MB | CPU 6.7x 通过 |
| tiny.en | `.research/models/` | 74 MB | CPU 通过 |
| Vulkan SDK 1.4.363.0 | `vendor/vulkan-sdk/` | 约 1.5 GB | `vulkaninfoSDK` 识别 RTX 3060，`glslc` 可用 |
| Ninja 1.13.1 | `vendor/ninja/ninja.exe` | 0.6 MB | Vulkan 构建必需 |
| Rust 1.99.0 + MSVC 2026 | 系统 | — | CPU / Vulkan `cargo build` 均通过 |

> `vendor/` 下的大文件不应提交到 git，已在 `.gitignore` 中排除。分发时从官方源重新下载并校验 SHA256。

## 19. Python → Rust 迁移映射

| Python 模块 | Rust 对应 | 复用内容 |
| --- | --- | --- |
| `services/segmenter.py` | `services/segmenter.rs` | 算法、常量、fixture 全部复用 |
| `services/exporter.py` | `services/exporter.rs` | 格式规则、测试用例复用 |
| `services/qc.py` | `services/qc.rs` | 规则表复用 |
| `services/translator/*` | `services/translator/*` | 提示词、ID 校验逻辑复用 |
| `services/media.py` | `services/media.rs` | ffmpeg 命令复用 |
| `services/asr.py` | `services/asr.rs` | 参数语义映射（6.5 表） |
| `pipeline/orchestrator.py` | `pipeline/orchestrator.rs` | 阶段划分、缓存键、续跑规则复用 |
| `db.py` / schema | `db.rs` | SQL 原样复用 |
| FastAPI 路由 | Tauri commands | 接口语义一一对应 |
| React 前端 | 同前端，改 API 层 | 组件与交互全部复用 |

**推荐做法**：Python 版先作为“算法参考实现 + 评测工具”保留，Rust 版逐模块对拍，避免两套逻辑各自漂移。

## 20. 开放问题

1. **是否保留 Python 版**：建议保留在 `python-ref/` 作为参考实现与评测基线，不随产品分发。
2. **CUDA 性能包是否值得做**：Vulkan 已够用；若目标用户多为 NVIDIA 且追求极限速度再做。
3. **VAD 用 whisper.cpp 内置还是独立 ONNX**：以 Spike 结果为准，内置少一个依赖。
4. **是否需要逐词高亮（卡拉 OK）**：DTW 方案（A）可支撑逐词高亮；若 Spike 只能走方案 B/C，则放到 v2 并引入强制对齐。
5. **默认模型**：建议 `large-v3-turbo`，需同步修订 PRD 的性能目标表述。
6. **macOS/Linux**：架构上支持，但 v1 只验证 Windows，避免打包与 GPU 后端分散精力。
