# Rspack SWC loader 性能对比

结论：性能差异取决于模块边界和文件形态，不能只由 SWC 版本推断。在这组 2000 模块、关闭缓存的 TypeScript 全量构建中，`builtin:swc-loader` 比 `swc-loader`：

- 独立进程端到端典型耗时少 **28.5%**（`1.40x`）
- 调用 Rspack API 后的 compiler 生命周期典型耗时少 **34.2%**（`1.52x`）
- 独立进程峰值 RSS 少 **36.8%**（211.5 MiB vs 334.8 MiB）
- 常驻 Node 进程内反复新建 compiler 做全量构建时，典型耗时少 **29.4%**（`1.42x`）

单个大型 TypeScript payload 的结果不同：64 KiB 时 builtin 的 fresh-process 构建快约 10%，256 KiB 的常驻进程构建已基本持平；1–8 MiB 时常驻进程中的 `swc-loader` 反而快约 4–6%。不过 external 路径的峰值 RSS 始终更高，并从 64 KiB 的 `1.10x` 扩大到 8 MiB 的 `1.62x`。

## 严格对齐 SWC 版本

`builtin:swc-loader` 不会使用项目安装的 `@swc/core`，而是使用 Rspack native binding 内嵌的 Rust SWC。因此这里只比较底层 SWC crate 完全对齐的组合：

| 组件 | 固定版本 | 底层版本 |
| --- | --- | --- |
| `@rspack/core` | `1.7.12` | `swc_core 59.0.1` |
| `@swc/core` | `1.15.21` | `swc_core 59.0.1` |
| `swc-loader` | `0.2.7` | 调用上面的 `@swc/core` |

版本证据：Rspack 的 [`Cargo.toml`](https://github.com/web-infra-dev/rspack/blob/v1.7.12/Cargo.toml#L139-L141) 和 [`Cargo.lock`](https://github.com/web-infra-dev/rspack/blob/v1.7.12/Cargo.lock#L5908-L5910)，以及 SWC v1.15.21 的 [`swc_core/Cargo.toml`](https://github.com/swc-project/swc/blob/v1.15.21/crates/swc_core/Cargo.toml#L7-L9) 和 [`Cargo.lock`](https://github.com/swc-project/swc/blob/v1.15.21/Cargo.lock#L5828-L5830)。关键转换链也一致，包括 `swc_ecma_codegen 24.0.0`、`swc_ecma_parser 36.0.0`、`swc_ecma_transforms_base 39.0.0` 和 `swc_ecma_transforms_typescript 43.0.0`。

交给 Rspack 的两份配置由同一工厂生成，校验脚本会断言 loader 名是唯一差异，并拒绝 `RSPACK_BINDING` / `SWC_BINARY_PATH` 覆盖锁定的 native binary。每次构建都会深拷贝 SWC options，避免 Rspack 的原地规范化跨轮污染。SWC 配置显式关闭 `.swcrc`、外部配置文件、source map 和 minify，并对齐 `disableAllLints`。

## 正式测试结果

环境：Apple M3 Max（14 logical CPU）、96 GiB、macOS 26.5.2 arm64、Node.js 24.19.0。每组先预热 5 轮，再采集 30 轮；每轮按 AB/BA 顺序交错运行，减少顺序和温度偏差。95% CI 来自保持 15/15 执行顺序配额的 100,000 次 paired bootstrap。

| 场景 | `builtin:swc-loader` median ± MAD | `swc-loader` median ± MAD | 配对加速比（95% CI） |
| --- | ---: | ---: | ---: |
| 独立进程端到端 | 208.72 ± 3.64 ms | 290.89 ± 4.19 ms | `1.399x`（1.387–1.413） |
| API 调用后的 compiler 生命周期 | 143.57 ± 3.31 ms | 218.60 ± 3.16 ms | `1.519x`（1.505–1.548） |
| 常驻进程、新 compiler 全量构建 | 127.18 ± 3.02 ms | 177.84 ± 4.41 ms | `1.416x`（1.388–1.436） |

独立进程的峰值 RSS 中位数分别为 211.52 ± 1.02 MiB 和 334.77 ± 0.72 MiB，配对比率为 `1.583x`（95% CI 1.578–1.589）。冷启动 30/30 轮 builtin 更快；常驻进程为 27/30 轮。两边最终 bundle 均为 10,249,996 bytes，SHA-256 同为：

```text
43dbd7947a1926d0ce101bcfdaf881dab7207528dbd983e06bc4feb84a168402
```

数字 module id 会把 loader 名纳入模块标识的哈希，导致两份 bundle 仅因 module id 不同而无法逐字节比较。因此本基准统一使用 development 模式默认的 named module id；这不会给任一 loader 增加独有配置，并让产物等价性可以直接由 hash 验证。基准还会在计时结束后执行 bundle，并确认运行时 checksum 为独立计算的 `4287433803`。

## 单大文件尺寸曲线

该场景把与多模块 fixture 相同的 TypeScript AST 单元拼接到一个 payload 文件中，另加固定的 145-byte entry；payload 会用 ASCII 空白精确补齐到目标字节数。它控制了 loader 调用次数，但代表的是 generated-code 风格的 `concatenated-standard-units-v1`，不代表所有大型源码形态。

测试机器仍为 Apple M3 Max、96 GiB、macOS 26.5.2 arm64；该轮使用 Node.js 24.16.0。

下面的时间比值和 RSS 比值均为 `external / builtin`：时间比值大于 1 表示 builtin 更快，小于 1 表示 external 更快；RSS 比值大于 1 表示 external 占用更多内存。

| payload | 采样轮数 | fresh process 端到端：builtin / external（配对比值） | 常驻进程 full build：builtin / external（配对比值） | 峰值 RSS：builtin / external（配对比值） |
| ---: | ---: | ---: | ---: | ---: |
| 64 KiB | 40 | 71.64 / 79.49 ms（`1.112x`） | 10.68 / 11.31 ms（`1.049x`） | 100.23 / 110.16 MiB（`1.099x`） |
| 256 KiB | 40 | 87.57 / 92.75 ms（`1.063x`） | 26.79 / 27.18 ms（`1.002x`） | 113.70 / 127.74 MiB（`1.121x`） |
| 1 MiB | 25 | 168.24 / 172.54 ms（`1.032x`） | 106.52 / 101.43 ms（`0.957x`） | 150.30 / 186.50 MiB（`1.251x`） |
| 4 MiB | 12 | 681.78 / 679.78 ms（`0.991x`） | 643.40 / 602.22 ms（`0.943x`） | 295.65 / 439.48 MiB（`1.488x`） |
| 8 MiB | 8 | 1547.42 / 1511.92 ms（`0.979x`） | 1547.38 / 1433.21 ms（`0.948x`） | 461.41 / 743.47 MiB（`1.622x`） |

各档预热轮数依次为 8/8/6/3/2，仍使用 AB/BA 交错顺序。这里的 fresh process 指每个样本启动新 Node 进程，但预热后的 OS page cache 仍然保留。4 MiB 和 8 MiB 是压力测试且样本较少；常驻数据来自同一 Node 进程内反复创建 compiler，适合描述趋势，不应把轮次当成完全独立实验。

每一档的两份最终 bundle 都通过字节 hash 和独立计算的运行时 checksum 校验。生成器还把 shape id、AST 单元数、padding 大小和 payload SHA-256 写入原始结果，避免把相同字节数但不同代码形态的结果误作横向比较。

## 测试负载与方法

默认生成器创建 2000 个确定性的 TypeScript 模块和一个导入全部模块的入口。大文件模式复用同一 AST 单元，但把它们串接在一个 payload 内。两种模式都包含 interface、mapped type、`satisfies`、参数属性、private field、optional chaining、nullish coalescing 和 object spread，并以 ES2018 为目标。

主场景每次启动全新的 Node 进程，排除 Rspack 持久缓存，同时保留已经预热的文件系统 page cache；分别记录父进程 spawn-to-exit 时间、Rspack API 生命周期、Rspack stats 时间和峰值 RSS。`@rspack/core` 在 API 计时前已经加载，而外部 `@swc/core` 由 `swc-loader` 在 `compiler.run()` 中首次加载，所以 API 数字不是“纯 SWC 转换时间”；包含两边完整启动成本的独立进程端到端结果是主要冷启动结论。第二场景在一个 Node 进程中交错创建新的 compiler，仍然执行无缓存全量构建，用来弱化 native 模块首次加载成本。

`swc-loader` 保持默认的异步 `@swc/core.transform()`，没有通过 `sync:true` 改变其 stock 行为。两种 stock loader 还存在一个无法用普通共享配置消除的行为差异：`devtool:false` 时 builtin 会关闭 input source map，`swc-loader@0.2.7` 则会覆盖用户传入的 `inputSourceMap:false`，使 `@swc/core` 按默认行为扫描 `sourceMappingURL`。fixture 不包含 source map，这不影响产物，但该扫描属于真实 `swc-loader` 路径的成本。本测试比较的是两种 stock loader，而不是修改过内部行为的微基准。

[Rspack 官方架构说明](https://www.rspack.dev/api/javascript-api/architecture)指出 builtin loader 在 Rust 侧运行，可减少 JavaScript 排队和跨语言数据转换，并更充分利用并行能力；本次结果与该机制一致。这里测的是合成 TS 图，绝对数字与加速比例仍会随真实项目的模块大小、插件、磁盘、CPU 和其他构建阶段而变化。

## 为什么结果会随文件形态变化

消融实验支持：本负载的主要差距最可能来自集成路径，而不是 SWC 版本差异。builtin 在 Rspack 的 Rust loader runner 内直接调用 Rust SWC；`swc-loader` 则让每个模块经过 Rspack Rust → Node loader runner → `swc-loader` → `@swc/core` N-API → Node → Rspack Rust。后者会增加每模块的 loader context 构造、源码和结果跨边界传递、options JSON 序列化、Promise/callback 调度，并可能增加 GC 压力。相同 crate 版本仍不保证两个 native binary 的 features、allocator 和构建参数完全相同。

大文件曲线把这个解释分成了两部分：

- 64–256 KiB 的 external 冷启动多约 5–8 ms，和首次加载 `@swc/core` / `swc-loader` 的固定成本同量级；文件增大后，这部分被 SWC 转换与代码生成时间摊薄。
- 单个 payload 只跨 loader 边界一次，因此 2000 个小模块中的每模块调度优势不再累计。4–8 MiB 时 external 的小幅时间优势表明，相同 `swc_core` 并不等于两份 native binary 在大 AST 上性能相同；可能涉及 features、allocator、LTO、编译参数或两条 compiler 调用路径，但现有实验不能继续精确拆分。
- external 的 RSS 随文件尺寸增长得更快，与源码、结果和 N-API async task 在 JS/native 边界形成额外 live set，以及第二份 native addon 的 allocator 高水位一致。8 MiB 的额外 RSS 远大于几份源码文本本身，不能简单解释成某一次字符串复制；单文件也排除了“大量 Promise 排队”是这一场景的主要原因。

进一步结果：

- 独立的 20 轮、2000 模块消融中，external 的 API 配对差约 58 ms；直接加载与预加载实验共同估计其中约 5–8 ms（10–13%）是首次 `require` 的固定成本。
- 固定总源码为 875,663 bytes 时，一个 payload 文件加 entry 的常驻耗时几乎相同（81.98 vs 82.00 ms）；拆成 500 个 payload 文件加 entry 后变为 37.36 vs 49.41 ms。高文件数区间的组合增量约为 21–22 µs/payload，说明主要成本随 loader 调用、调度和模块生命周期累计。
- 在同一组独立消融中，空载首次加载完整 external loader 的固定 RSS 增量约 3.8 MiB，而完整构建相差约 125 MiB。直接 SWC 实验里，一次提交 2001 个异步任务比限制 16 并发多约 33 MiB；这支持排队任务及其结果/Promise 的存活集合可能解释部分内存差距，但不能直接等同于 Rspack 中的归因。

完整调用链、源码依据、消融数据及不能精确归因的部分见[性能差距原因分析](docs/performance-gap-analysis.md)。

## 复现

要求 Node.js 20+ 和 pnpm 11.19.0：

```bash
pnpm install
pnpm verify:versions
pnpm bench
pnpm analyze
```

快速检查：

```bash
pnpm bench:quick
pnpm bench:large:quick
```

1 MiB 单大文件正式测试和 4 MiB 压力测试：

```bash
pnpm bench:large
pnpm analyze

pnpm bench:large:stress
pnpm analyze
```

也可通过环境变量调整规模：

```bash
BENCH_MODULES=5000 BENCH_WARMUPS=5 BENCH_RUNS=30 pnpm bench
BENCH_FIXTURE=large-file BENCH_LARGE_FILE_BYTES=8388608 BENCH_WARMUPS=2 BENCH_RUNS=8 pnpm bench
```

生成的源码、bundle 和完整原始样本保存在 `.benchmark-workload/`，不会计入 Git。

GitHub Actions 会在 Node.js 20/24 上分别跑 500 模块和 256 KiB 大文件。共享 runner 上的数字只用于验证版本锁定、两种 loader 可构建、结果 schema、bundle hash 和运行时 checksum，不设置性能阈值；原始结果作为 artifact 保存 14 天。
