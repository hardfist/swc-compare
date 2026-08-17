# `builtin:swc-loader` 与 `swc-loader` 性能差距原因分析

## 结论

两边使用相同的 `swc_core 59.0.1`，输出也通过了字节 hash 与运行时 checksum 校验。消融实验支持：当前 2000 模块基准中的主要差距最可能来自 `swc-loader` 每个模块额外经过 JavaScript loader runner、N-API async task 和 libuv worker pool，而不是 SWC 版本差异。相同 crate 版本仍不保证两个 native binary 的 features、allocator、LTO 和构建参数完全相同。

按证据强度排序：

1. 证据最强的解释是随模块数量累计的 Rust/JS/N-API 边界、loader context、Promise/callback 和数据转换成本。
2. 异步任务大量排队会增加中间对象存活和峰值 RSS，并可能增加 GC 与调度压力。
3. `@swc/core` 的首次加载和第二份 native addon 是可测量的固定成本；空载首次加载的即时增量只相当于约一成时间差和约 3% 完整构建 RSS 差，不能代表 addon 在转换期间的全部内存。
4. 当前关闭 source map 的 fixture 中，input source map 扫描不是主要因素。

不能把剩余时间精确拆成“多少属于 N-API、复制、GC 或 native allocator”：这些工作会重叠运行，V8 profiler 也看不到 native worker 的 CPU。下面的数据用于确定主次关系和量级，而不是宣称一个精确的成本账单。

## 两条执行路径

`builtin:swc-loader`：

```text
Rspack Rust module build
  → Rust loader runner
  → builtin SwcLoader::run
  → JavaScriptCompiler::transform
  → swc_core
  → Rust loader result
```

在纯 builtin 链中，Rust loader runner 会识别并直接执行 builtin，不会 yield 到 Node。只有混合 loader 链已经进入 JS runner 时，JS runner 才会在遇到 `builtin:` 边界后停止，并把控制权交回 Rust。builtin 在 Rust 内取得源码、调用 `JavaScriptCompiler::transform`，再把 code、source map 和 diagnostics 放回 loader context。其 options 在首次 resolve loader 时解析为 typed Rust options，随后按 request/options 缓存 loader 实例。

源码依据：

- [builtin SWC loader 实现](https://github.com/web-infra-dev/rspack/blob/v1.7.12/crates/rspack_loader_swc/src/lib.rs#L53-L208)
- [options 解析](https://github.com/web-infra-dev/rspack/blob/v1.7.12/crates/rspack_loader_swc/src/options.rs#L120-L197)
- [loader 实例缓存](https://github.com/web-infra-dev/rspack/blob/v1.7.12/crates/rspack_loader_swc/src/plugin.rs#L46-L81)

`swc-loader`：

```text
Rspack Rust module build
  → N-API ThreadsafeFunction
  → Node.js loader runner
  → swc-loader JavaScript
  → @swc/core.transform()
  → N-API AsyncTask / libuv worker
  → native swc_core
  → Promise + loader callback
  → Node.js loader result
  → Rspack Rust
```

普通 JS loader 会把 `JsLoaderContext` 发给 Node，源码在 loader runner 中转换为 JavaScript string。`swc-loader` 每模块读取并扩展 options、加入 filename/source map 字段，然后调用异步 `@swc/core.transform()`。`@swc/core` 又会把 options `JSON.stringify` 成 Buffer；native binding 每次反序列化为 Rust `Options`，创建 `AsyncTask<TransformTask>` 执行转换。

源码依据：

- [Rspack JS loader scheduler](https://github.com/web-infra-dev/rspack/blob/v1.7.12/crates/rspack_binding_api/src/plugins/js_loader/scheduler.rs#L21-L80)
- [跨边界的 loader context](https://github.com/web-infra-dev/rspack/blob/v1.7.12/crates/rspack_binding_api/src/plugins/js_loader/context.rs#L90-L185)
- [`swc-loader@0.2.7` 的 options 与异步 transform](https://github.com/swc-project/pkgs/blob/c91699dcb40eb01ecac9d131a1ec0d4a108fd6e5/packages/swc-loader/src/index.js#L1-L118)
- [`@swc/core@1.15.21` 的 native transform 调用](https://github.com/swc-project/swc/blob/v1.15.21/packages/core/src/index.ts#L212-L249)及 [`toBuffer`](https://github.com/swc-project/swc/blob/v1.15.21/packages/core/src/index.ts#L558-L560)
- [`@swc/core` native transform task](https://github.com/swc-project/swc/blob/v1.15.21/bindings/binding_core_node/src/transform.rs#L22-L112)
- [NAPI-RS `Task::compute` 在 libuv thread 中运行](https://github.com/napi-rs/napi-rs/blob/napi-v3.3.0/crates/napi/src/task.rs#L5-L12)

## 消融实验

以下诊断与主 benchmark 使用相同机器和依赖：Apple M3 Max、14 logical CPU、96 GiB、macOS 26.5.2 arm64、Node.js 24.19.0。共享机器未做 CPU 隔离，测量时 1-minute load average 约为 5–14，部分档位还与其他短实验重叠；个别 cell 的 IQR 达到 25–51%。因此回归只描述本机观测趋势，不能把高 R² 当成误差很小；正式 headline 仍以 README 中独立的 30 轮配对 benchmark 为准。

### 固定成本与每模块成本

标准 fixture 从 1 扩展到 2000 个 TS payload 文件，并始终另有一个 entry 模块。payload 平均约 1.55 KiB；包含 entry 后，总源码按 payload 数摊销约为 1.61 KiB。冷进程中位数如下：

| payload 文件数 `N` | builtin | `swc-loader` | builtin 加速 |
| ---: | ---: | ---: | ---: |
| 1 | 67.70 ms | 74.64 ms | `1.10x` |
| 20 | 69.49 ms | 77.79 ms | `1.12x` |
| 100 | 83.60 ms | 97.46 ms | `1.17x` |
| 500 | 102.87 ms | 130.33 ms | `1.27x` |
| 2000 | 228.36 ms | 283.62 ms | `1.24x` |

对五个中位数点拟合 `T = a + bN`：

```text
builtin:    68.89 ms + 0.07920 ms × N    R² = 0.9955
swc-loader: 79.05 ms + 0.10248 ms × N    R² = 0.9968
```

external 路径表现为约 10.16 ms 额外固定项和 23.28 µs/新增 payload 额外斜率。用每轮配对差值直接拟合得到约 8.75 ms + 28.00 µs/新增 payload，可把 23–28 µs/新增 payload 视为该负载的合理范围。

各档均先预热 10 轮；`N=1/20/100/500/2000` 的测量轮数分别为 80/80/60/50/40。`N` 不包含始终存在的 entry，因此总模块数为 `N + 1`；恒定的 `+1` 不改变斜率。

为了尽量把“代码计算量”与“文件数量”分开，第二个实验把 500 份相同 AST 单元及总源码严格固定为 875,663 bytes，只改变它们分布到多少个 payload 文件中。import 语句、模块 wrapper、模块图和最终 bundle 仍随文件数变化；bundle 从 1,496,518 bytes 增至 2,621,093 bytes，因此它不是只改变一次 N-API 调用次数的纯微基准。

| payload 文件数 `N` | 冷进程 builtin / external | 常驻进程 builtin / external |
| ---: | ---: | ---: |
| 1 | 162.05 / 172.13 ms | 81.98 / 82.00 ms |
| 20 | 93.04 / 100.91 ms | 20.94 / 22.67 ms |
| 100 | 83.52 / 92.20 ms | 20.62 / 23.23 ms |
| 500 | 145.87 / 168.10 ms | 37.36 / 49.41 ms |

常驻绝对耗时呈 U 型，这与单个大 payload 缺少模块级并行、文件数较高后模块图和每模块成本上升相符，但实验没有单独证明并行饱和点。因此不能跨整个区间做简单线性解释。仅把 20/100/500 三个高文件数档位作局部描述，并对每轮配对差值的中位数拟合，得到：

```text
external - builtin = 0.455 ms + 0.02106 ms × N    R² = 0.9979
```

`N=1` 时总 fixture 为 855.14 KiB，由一个 777.01 KiB payload 和一个 78.13 KiB entry 组成，常驻耗时只差 0.01 ms；`N=500` 时相差 12.05 ms。这是“主要差距随文件数量累计”最强的实验依据。不过拟合只有三个点、一个残差自由度，且文件数同时改变 loader 调用、Rspack 调度、模块生命周期、wrapper 和代码生成工作；因此 21–22 µs/payload 只能视为本机组合增量的量级，不能全部标成纯 N-API 调用时间。

固定总量实验中 `N=1/20/100` 各预热 10 轮、测量 50 轮，`N=500` 预热 8 轮、测量 40 轮。

### 首次加载只占约一成

全新子进程中交错采样 30 轮，5 轮预热：

| 加载动作 | median ± MAD | RSS 增量 |
| --- | ---: | ---: |
| `require("@rspack/core")` | 17.13 ± 0.48 ms | 17.99 ± 0.12 MiB |
| 已加载 Rspack 后再加载 `@swc/core` | 5.59 ± 0.30 ms | 3.69 ± 0.05 MiB |
| 已加载 Rspack 后再加载完整 `swc-loader` | 6.16 ± 0.39 ms | 3.77 ± 0.04 MiB |

在独立的 2000 模块、20 轮冷进程消融中：

- builtin API 中位数为 145.49 ms，external 为 204.11 ms；配对差为 57.88 ± 5.58 ms。
- 预加载 `@swc/core` 后 external 为 196.44 ms；配对节省 7.70 ± 2.22 ms。

所以 native addon 和首次 `require` 约占 5–8 ms，即总时间差的 10–13%。剩余约九成发生在实际逐模块编译阶段。

### 异步排队可能解释部分内存差距

同一组 2000 模块冷编译的进程 RSS 为 210.30 MiB 与 335.32 MiB，配对差 125.20 ± 1.38 MiB。空载进程首次 `require` 完整 external loader 后的即时固定增量只比 Rspack 高约 3.77 MiB；这说明文件映射与初始化本身不是完整差距，但没有测量 addon 在转换期间创建的 compiler、任务和 allocator 状态。

直接向 `@swc/core` 提交 2001 个相同小模块转换，10 轮结果如下：

| 调度方式 | 转换耗时 | 转换阶段 RSS 增量 |
| --- | ---: | ---: |
| 异步并发限制 4 | 80.44 ± 4.11 ms | 14.91 ± 0.09 MiB |
| 异步并发限制 16 | 69.07 ± 1.21 ms | 15.27 ± 0.10 MiB |
| 一次提交全部 2001 个 Promise | 68.71 ± 1.95 ms | 48.16 ± 0.09 MiB |
| 同步串行 | 227.49 ± 2.13 ms | 8.43 ± 0.04 MiB |

一次提交全部任务并没有比限制 16 并发更快，却多占约 33 MiB RSS。该差值包含排队任务及其结果/Promise 的整个存活集合，实验没有继续拆分内部组成；它支持这种存活集合可能解释正式 benchmark 内存差距的一部分，但 direct SWC 实验不等同于完整 Rspack 生命周期，不能把这 33 MiB 直接从 125 MiB 中相减。

一次辅助 V8 CPU profile 也观察到 external 主线程 idle 比例显著下降，并在 `runLoaders`、loader callback 与 GC 中出现额外样本。profile 看不到 libuv/Rspack native worker CPU，因而只作为机制线索，不用于精确分摊。

### 当前不是主要因素的项目

- **SWC crate 版本**：两边均为 `swc_core 59.0.1`，不是旧版 SWC 与新版 SWC 的比较。
- **输出差异**：bundle 字节与运行结果一致，排除了产物不等价对性能比较的干扰；它不能证明两条内部路径执行了完全相同的 pass、扫描或 diagnostics 工作。
- **input source map 扫描**：`swc-loader@0.2.7` 会把显式 `inputSourceMap:false` 覆盖成 `undefined`，而 builtin 在 `devtool:false` 时直接关闭它。对当前无 source-map 注释的 500 模块 fixture 强制恢复 `false`，中位仅节省 0.43 ms，50 轮中 27 轮获胜，处于噪声量级。启用 source map 时应重新测试，不能外推这一结论。
- **options JSON 本身**：当前 options 约数百 bytes，单独序列化 2001 次约 1 ms。它是每模块边界的一部分，但不是数十毫秒差距的单一解释。

## 适用边界

- 模块越碎、loader 链越依赖 JS、source map 越重，builtin 的架构优势通常越容易显现；单个大文件且 SWC 计算占绝对主导时，两者可能接近。
- 相对收益会被其他构建阶段稀释。若项目瓶颈是解析依赖、CSS、压缩、磁盘或插件，本基准的 `1.4–1.5x` 不能直接套用到总构建时间。
- 相同 `swc_core` crate 版本不代表两个 native binary 的 features、allocator、LTO 和构建参数完全相同。等价输出与消融让集成边界成为当前证据最强的主要解释，但没有证明两个 binary 的纯 native 性能在所有配置下都相同。
