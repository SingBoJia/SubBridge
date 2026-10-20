# vendor 目录说明

本目录存放已验证可用的第三方二进制与模型，**不提交到 git**（见根目录 `.gitignore`）。

## 已安装内容

| 组件 | 路径 | 体积 | 用途 |
| --- | --- | --- | --- |
| ffmpeg 9.0.2 | `ffmpeg/ffmpeg-9.0.2-essentials_build/bin/ffmpeg.exe` | 101 MB | 音频提取、字幕烧录 |
| ffprobe 9.0.2 | 同上 | 100 MB | 媒体探测 |
| whisper.cpp CUDA b5454 | `whisper-cuda/Release/` | 1.2 GB | GPU 转写（自带 CUDA 12.4 运行库） |
| large-v3-turbo-q5_0 | `models/ggml-large-v3-turbo-q5_0.bin` | 574 MB | 默认 ASR 模型 |
| 并行下载器 | `pdl.mjs` | 8 KB | 绕过单连接限速 |

## 重新获取

```bash
cd vendor

# ffmpeg（gyan.dev，含 libass）
curl -L "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" -o ff.zip
unzip -oq ff.zip -d ffmpeg/

# whisper.cpp CUDA 12.4（官方预编译，自带运行库，无需 CUDA Toolkit）
node pdl.mjs \
  "https://github.com/ggml-org/whisper.cpp/releases/download/b5454/whisper-bin-win-cuda-12.4.0-x64.zip" \
  "whisper-cuda/cuda.zip" 8 4
unzip -oq whisper-cuda/cuda.zip -d whisper-cuda/

# turbo 模型（574 MB）
curl -L "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin" \
     -o models/ggml-large-v3-turbo-q5_0.bin
```

## 验证

```bash
# ffmpeg
./ffmpeg/ffmpeg-9.0.2-essentials_build/bin/ffmpeg.exe -version
./ffmpeg/ffmpeg-9.0.2-essentials_build/bin/ffmpeg.exe -filters | grep -E "ass|subtitles"

# GPU 转写
cd whisper-cuda/Release
./whisper-cli.exe -m "../../models/ggml-large-v3-turbo-q5_0.bin" \
                  -f "../../../.research/jfk.wav" -l en -t 8
```

预期输出：

```
[00:00:00.000 --> 00:00:10.400]   And so, my fellow Americans, ask not what your country can do for you, ask what you can do for your country.
whisper_print_timings:    total time =   830.95 ms
```

## 关于 Vulkan SDK

本机 Vulkan SDK 下载速度仅 35KB/s（官方源限速），未完成安装。CUDA 路径已验证可用，无需 Vulkan。若后续需要：

```bash
# 最新版本查询
curl https://vulkan.lunarg.com/sdk/latest/windows.json

# 下载（建议用 pdl.mjs 并行分段）
node pdl.mjs "https://sdk.lunarg.com/sdk/download/1.4.363.0/windows/vulkan-sdk-1.4.363.0.exe" \
             "downloads/vulkan-sdk.exe" 6 4
```

## 许可提醒

- ffmpeg essentials 是 GPL 构建，分发需遵守 GPL。
- whisper.cpp 为 MIT。
- Whisper 模型权重为 MIT（OpenAI）。
- CUDA 运行库受 NVIDIA 再分发许可约束，随包分发前需确认条款。

## Vulkan SDK（已下载，未安装）

文件：`downloads/vulkan-sdk.exe`（303 MB，1.4.363.0）

安装失败原因：

```
installationError : Cannot elevate access rights while running from command line.
Please restart the application as administrator.
```

**需要管理员权限**。以管理员身份打开 PowerShell 后执行：

```powershell
cd E:\9_GITHUB_CODE_REPOS\SubBridge\vendor
.\downloads\vulkan-sdk.exe in --root "E:\9_GITHUB_CODE_REPOS\SubBridge\vendor\vulkan-sdk" `
  --accept-licenses --accept-messages --confirm-command
```

装完后设置环境变量再构建：

```powershell
$env:VULKAN_SDK = "E:\9_GITHUB_CODE_REPOS\SubBridge\vendor\vulkan-sdk"
cargo build --release --features vulkan
```

> 注意：`whisper-rs-sys` 的 build.rs 在 Vulkan 特性下强制要求 `VULKAN_SDK` 环境变量。CUDA 路径已完整验证，Vulkan 仅作非 NVIDIA 显卡的备选，不阻塞主线。

## Vulkan SDK（已安装）

路径：`vendor/vulkan-sdk/`，版本 1.4.363.0，安装于 2026-10-20。

验证：

```bash
./vulkan-sdk/Bin/vulkaninfoSDK.exe --summary | grep -i "deviceName\|apiVersion"
# deviceName = NVIDIA GeForce RTX 3060
# apiVersion = 1.4.341
```

### 安装方法（需提权）

headless 模式直接运行会失败：

```
installationError : Cannot elevate access rights while running from command line.
```

用 PowerShell 提权即可成功：

```powershell
$p = Start-Process -FilePath 'E:\9_GITHUB_CODE_REPOS\SubBridge\vendor\downloads\vulkan-sdk.exe' `
  -ArgumentList 'in','--root','E:\9_GITHUB_CODE_REPOS\SubBridge\vendor\vulkan-sdk',
                '--accept-licenses','--accept-messages','--confirm-command' `
  -Verb RunAs -Wait -PassThru
Write-Output ('exit=' + $p.ExitCode)   # exit=0
```

## Ninja（Vulkan 构建必需）

路径：`vendor/ninja/ninja.exe`，版本 1.13.1。

### Vulkan 构建步骤（已验证）

```bat
call "D:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat"
set PATH=C:\Users\XiaoMei\.cargo\bin;E:\9_GITHUB_CODE_REPOS\SubBridge\vendor\ninja;%PATH%
set VULKAN_SDK=E:\9_GITHUB_CODE_REPOS\SubBridge\vendor\vulkan-sdk
set CARGO_TARGET_DIR=E:\sbt
set CMAKE_GENERATOR=Ninja
cd /d E:\9_GITHUB_CODE_REPOS\SubBridge\spike\asr-smoke
cargo build --release --features vulkan
```

**三个必须同时满足的条件**（缺一失败）：

1. **必须用 Ninja 生成器**。默认 MSBuild 生成器会在 `ggml-vulkan` 的 `vulkan-shaders-gen` 子项目上失败：`MSB6003` + `DirectoryNotFoundException`。
2. **必须先清空 target 目录**。残留的 `CMakeCache.txt` 带 `CMAKE_GENERATOR_INSTANCE`，与 Ninja 冲突：`Generator Ninja does not support instance specification`。
3. **必须在 vcvars64 环境里构建**。否则 CMake 找不到 cl.exe。

实测构建耗时 1m20s。

### 运行验证

```bash
cd E:/sbt/release
./asr-smoke.exe vendor/models/ggml-large-v3-turbo-q5_0.bin .research/real_a.wav
```

预期：

```
ggml_vulkan: 0 = NVIDIA GeForce RTX 3060 ... | matrix cores: NV_coopmat2
inference: 2.35s          # 第二次运行（稳态）
```

> **首次运行会是 15.65s**，因为要编译 Vulkan 着色器。产品必须做启动预热。
