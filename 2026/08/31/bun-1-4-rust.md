# Bun 1.4.0：从 Zig 到 Rust，Bun 真正变快和变稳的地方

<!-- summary: Bun 1.4.0 的重点不只是 Rust 重写，而是内存、兼容、可观测性和一体化工具链的整体推进。 -->
<!-- tags: Bun, Rust, JavaScript Runtime, 工具链 -->

Bun 1.4.0 最容易被传播的标题，是“Bun 从 Zig 重写到了 Rust”。这个标题没错，但如果只停在语言替换，很容易把问题看浅。

Bun 的核心价值一直不是“又一个 JavaScript runtime”，而是把 runtime、package manager、bundler、transpiler、test runner 和若干常用能力打包进一个二进制。它要挑战的也不只是 Node.js 的执行速度，而是 JavaScript/TypeScript 工程里长期存在的工具链碎片化。

这次 1.4.0 的意义在于：Bun 在继续保持一体化工具链路线的同时，开始补运行时稳定性和 Node.js 兼容性的账。Rust 重写解决的是底层生命周期和内存安全压力；新增 Node.js 测试、Playwright/Vitest/Next.js 兼容、profiling 工具、内置 WebView/Image/Markdown/Cron/Terminal，则解决的是“能不能更像一个可靠平台”的问题。

## 一、先看结论

| 方向         | Zig 版本 Bun 的问题或边界                                                             | Bun 1.4.0 的变化                                                                      | 对开发者的意义                                                 |
| ------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| 内存安全     | 手动管理内存，和 JavaScriptCore GC 混用时容易出现 use-after-free、double-free、泄漏。 | Bun 主体从 Zig 迁到 Rust，借助 ownership、borrow checker 和 `Drop` 收紧生命周期。     | 长期运行服务更值得重新评估，崩溃和泄漏类问题有机会系统性减少。 |
| 资源占用     | 部分 HTTP、SSR、工具链场景内存回收不够稳定，空闲 CPU 也偏高。                         | 官方给出空闲 CPU 降 5x、HTTP 服务内存降 13%-48%、Linux 启动约 2x 的数据。             | 对 serverless、CLI、开发服务器和常驻服务都有直接收益。         |
| Node.js 兼容 | “大多数能跑”，但很多工具链仍会撞到 Node 内置模块细节。                                | 新增 1517 个 Node.js 测试通过项，`http`、`fs`、`cluster`、`stream`、`vm` 等继续补齐。 | 迁移现有 Node 项目的风险下降，但仍不能假设 100% 等价。         |
| 生态工具     | Playwright、Vitest、OpenTelemetry、dd-trace 等工具兼容仍有缺口。                      | Playwright、Vitest、Next.js 16、OpenTelemetry、Datadog 等场景获得明确改进。           | Bun 不再只适合小工具和新项目，开始能承接更真实的工程栈。       |
| 内置能力     | 很多常见任务仍要安装 npm 包。                                                         | 新增 `Bun.Image`、`Bun.WebView`、`Bun.markdown`、`Bun.cron()`、`Bun.Terminal`。       | 小型服务、脚本、自动化工具可以少装一批依赖。                   |
| 运维诊断     | CPU/heap profiling、异步栈、生产观测链路还不够顺。                                    | 新增 Markdown profile、V8 兼容 heap snapshot、`node:inspector`、OTel/dd-trace 改进。  | 线上排查更接近 Node.js 生态已有工作流。                        |

这张表可以概括 Bun 1.4.0 的重点：它不是一次单点性能优化，而是一次平台底座重整。

## 二、为什么 Bun 要离开 Zig

Bun 最早选择 Zig，是很自然的决定。Zig 给了 Bun 非常低的系统层控制成本：手动内存管理、清晰的 C ABI、快速写出 transpiler、bundler、HTTP server、package manager 这类偏底层的能力。

问题在于，Bun 的运行时边界很复杂。它不是一个纯 Zig 程序，而是站在 JavaScriptCore、WebKit、uWebSockets、BoringSSL、SQLite 等组件上，同时还要实现 Node.js 的大量行为。JavaScript 值由 JavaScriptCore 的 GC 管，Bun 自己的结构和 native 资源又需要手动释放。两套生命周期一旦交错，就会出现很难靠“认真 review”彻底消灭的问题：

- JS 回调重入导致 native 指针失效。
- 异步写入尚未结束时对象已经释放。
- 错误路径遗漏 `free`。
- 引用计数少减或多减一次。
- GC 可见性和 native 持有关系不一致。

Bun 官方在 Rust 重写说明里列过一串 1.3.x 修复过的内存问题，包括 `node:zlib`、`node:http2`、`UDPSocket`、`Buffer#copy`、`fs.watch()`、TLS session、CSS parser 等路径。单看每个 bug，都可以继续修；但从工程角度看，这类问题不是“某个人漏看了一行”，而是语言和系统边界没有把生命周期约束表达出来。

Rust 的价值就在这里。它不能让所有 Bug 消失，也不能自动把一个复杂 runtime 变成完美代码，但它能把一大类“释放时机、所有权、析构路径”问题提前到编译期。`Drop` 让资源释放有统一入口，所有权模型让“谁负责释放”更容易写进类型系统，borrow checker 让很多悬垂引用在合并前就变成编译错误。

这也是 Bun 1.4.0 需要区分的第一点：**Rust 不是性能魔法，Rust 在这里首先是稳定性工具。**

## 三、Rust 版本相比 Zig 版本改进了什么

### 1. 内存生命周期从“约定”更多变成“约束”

Zig 的 `defer` 和 `errdefer` 很直接，也符合系统编程里“控制权显式”的设计。但 Bun 的问题不只是某个函数末尾要不要 `defer free()`，而是跨 JS 回调、异步 I/O、native handle、GC root、线程池、网络连接和错误路径之后，资源到底由谁持有。

在 Zig 版本里，这些约束大量依赖局部约定、代码审查、ASAN、fuzzing 和测试。它们都重要，但它们大多是“事后发现”。Rust 版本把一部分约束移到类型和编译器里：

```rust
struct NativeBuffer {
  ptr: NonNull<u8>,
  len: usize,
}

impl Drop for NativeBuffer {
  fn drop(&mut self) {
    unsafe {
      bun_free(self.ptr.as_ptr(), self.len);
    }
  }
}
```

这个例子不是 Bun 源码，只说明模式：资源被对象拥有，离开生命周期时统一释放。对 runtime 来说，这类模式比“每条错误路径都记得释放”更容易维护。

当然，Bun 仍然会有 `unsafe`。它要和 JavaScriptCore、libuv/uWebSockets、BoringSSL、系统 API 打交道，不可能完全停留在 safe Rust。关键变化不是“没有 unsafe”，而是把 unsafe 的范围收缩到更明确的边界内，让外围逻辑更多依赖 Rust 的普通所有权规则。

### 2. 内存分配和回收更统一

Bun 1.4.0 的性能变化并不只是因为语言换了。官方提到一个很具体的点：过去 Bun 同时使用 JavaScriptCore 的 `libpas` allocator 和 `mimalloc`；1.4.0 中 JavaScriptCore 在 Bun 里也改用 `mimalloc`，并扩展了部分 page clearing、scavenger thread、lazy zeroing 相关能力。

这类改动比“Rust 更快”更可信。对一个 runtime 来说，allocator、GC 定时器、futex 调用、root 访问结构，都会影响空闲 CPU、常驻内存和请求高峰下的峰值内存。

官方给出的结果包括：

- 小型 hello world 应用空闲 CPU 下降约 5x。
- HTTP server 类应用内存下降 13%-48%。
- Claude Code 这类长期运行 Bun 应用，生产 CPU p99 从 24% 降到 10%，p50 从 5.8% 降到 2.5%。
- Linux hello.js 启动从 10.9 ms 降到 5.1 ms，峰值内存从 33.0 MB 降到 14.6 MB。
- Windows hello.js 启动从 39.0 ms 降到 15.5 ms。
- Linux/Windows 二进制最多缩小约 17%，macOS 二进制略有增加。

这些数字不应该被直接套到每个业务服务上。你的 ORM、日志、框架、数据库驱动、缓存、SSR 模式都会影响结果。但它们说明 Bun 1.4.0 的改动切中了 runtime 的关键成本，而不是只优化了一个演示 benchmark。

### 3. Node.js 兼容性继续向真实生态靠近

Bun 要成为 Node.js 替代品，最难的不是跑一个 HTTP hello world，而是跑现实世界的 Node.js 生态。生态里的库经常依赖边角行为：`node:http` 的事件顺序、`stream` 的 backpressure、`worker_threads` 参数、`cluster` 共享 socket、`vm` 的上下文隔离、`require-in-the-middle` 的 patch 行为、native addon 的 V8 API。

Bun 1.4.0 新增了 1517 个 Node.js 测试通过项，是 1.0 之后最大的一次兼容性推进。官方列出的模块里，`node:http`、`node:fs`、`node:cluster`、`node:timers`、`node:zlib`、`node:vm`、`node:stream` 等都提高了通过率；`node:events`、`node:trace_events`、`node:sqlite` 达到 100% 通过。

更实际的是一批生态工具开始可用或更稳定：

- Playwright 可以在 Bun 上运行，包括 `connectOverCDP()`、`playwright test` 和 UI 模式。
- Vitest 可以在 Bun 下运行，包括 coverage、threads 和 forks pool。
- Next.js 16.3、Turbopack、React Compiler 组合下的 `bun --bun next build` 有明确兼容进展。
- OpenTelemetry 的 HTTP/FS instrumentation 可以工作。
- `dd-trace` 和 `@datadog/pprof` 能持续采集 trace/profile。
- Nuxt、Testcontainers、dockerode、grpc-js、ConnectRPC、AWS SDK、TypeORM、nock、Fastify inject 等场景获得修复。

这部分对迁移判断很重要。很多团队不怕 runtime 快一点或慢一点，怕的是“项目里某个包刚好踩中 Node 内部行为”。Bun 1.4.0 的方向，是减少这种生态惊喜。

### 4. 可观测性更像生产运行时

Bun 早期更像一个极快的开发工具。到了 1.4.0，它开始补生产诊断体验。

新增或增强的能力包括：

- `bun --cpu-prof` 输出 Chrome DevTools / VS Code 可打开的 `.cpuprofile`。
- `bun --heap-prof` 输出 V8 兼容的 `.heapsnapshot`。
- `--cpu-prof-md` 可以把 CPU profile 写成 Markdown，便于 SSH、grep、贴进 issue 或交给 LLM 分析。
- `--heap-prof-md` 可以把 heap profile 写成 Markdown，直接查看类型占用、保留链和 GC root。
- `node:inspector` 支持在运行中启动/停止 CPU profile。
- 异步栈能把 `fs.promises`、`fetch()`、S3、DNS、crypto 等错误指回业务代码里的 `await`。
- `process.on("memoryPressure")` 可以在系统内存压力上来时释放缓存、收缩连接池或停掉 idle worker。

这些能力不一定比 Node.js 生态成熟，但它们说明 Bun 已经在面向线上问题补工具，而不是只追求本地命令速度。

### 5. 一体化工具链继续扩张

Bun 1.4.0 还新增了一批“以前通常要装 npm 包”的能力：

- `Bun.Image`：基础图片处理。
- `Bun.WebView`：浏览器自动化，macOS 可用 WebKit，也可以通过 CDP 控制本地 Chromium。
- `Bun.markdown`：Markdown 到 HTML。
- `Bun.cron()`：进程内定时任务。
- `Bun.Terminal`：终端仿真相关能力。
- JSON5 / JSONL 解析能力。
- `bun run --parallel`、`bun test --parallel`。
- `bun audit fix`、`bun dedupe`、`bun prune`。

这正是 Bun 和 Node.js 最大的产品哲学差异。Node.js 是稳定、长期、极大生态的运行时；Bun 则更像“JavaScript/TypeScript 工程工具箱”。它会把常见任务直接收进核心二进制，减少项目初始化时那串熟悉的依赖：包管理器、transpiler、test runner、bundler、dotenv、markdown parser、cron、图片处理、终端库。

## 四、Bun 相比 Node.js 优秀在哪些方面

先说结论：Bun 不应该被理解成“全面优于 Node.js”。Node.js 的 LTS、生态深度、生产案例、云厂商支持、native addon 兼容性仍然是非常硬的优势。

但在下面这些方面，Bun 的优势是实实在在的。

| 维度               | Bun 1.4.0 的优势                                                        | Node.js 的现状                                        | 适合采用 Bun 的场景                            |
| ------------------ | ----------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------- |
| 启动速度           | 单二进制、JSC 和 runtime 路径更轻，Linux hello.js 官方数据 5.1 ms。     | Node.js 26 官方对比数据为 27.2 ms。                   | CLI、serverless、短生命周期脚本、开发工具。    |
| TypeScript 体验    | 直接运行 `.ts` / `.tsx`，很多脚本不需要额外 loader。                    | 通常仍依赖 `tsx`、`ts-node`、构建步骤或实验能力。     | 内部工具、脚本、轻量服务、原型开发。           |
| 包安装             | `bun install` 是核心能力，锁文件和安装器一起优化。                      | npm 稳定但相对慢；团队常额外引入 pnpm/yarn。          | 依赖频繁安装的 CI、monorepo、本地开发。        |
| Bundler/transpiler | `bun build`、TS/JSX transpiler 内置。                                   | 通常组合 esbuild、Vite、Webpack、SWC 等。             | CLI、库、服务端 bundle、简单前端构建。         |
| 测试               | `bun test` 内置，Jest 风格 API，1.4 支持并行。                          | Node 自带 test runner 已进步，但 Jest/Vitest 仍常见。 | 小中型项目、工具库、追求低配置测试。           |
| HTTP/IO            | 官方 benchmark 中 HTTP 和内存占用更有优势。                             | 稳定、生态成熟，性能也在持续改进。                    | 高并发 API、边缘服务、资源敏感容器。           |
| 内置能力           | Image、WebView、Markdown、Cron、Terminal、SQLite、S3 等能力可减少依赖。 | 大多依赖 npm 包或外部工具。                           | 自动化平台、脚本服务、内部工具、轻量数据处理。 |
| 开发心智           | 一个 `bun` 命令覆盖 install/run/test/build。                            | 工具链可组合性强，但配置面更宽。                      | 希望降低项目模板复杂度的新项目。               |

### 1. Bun 的优势首先是“少装东西”

Node.js 的生态非常强，但很多项目刚初始化就会出现一组工具：

```bash
npm install -D typescript tsx vitest vite dotenv eslint prettier
npm install marked node-cron sharp
```

这套组合不是错，它代表 Node.js 生态的灵活性。但灵活性的代价是版本组合、配置文件、启动命令、CI 缓存和升级路径。

Bun 的做法是把高频能力放进同一个二进制：

```bash
bun install
bun test --parallel
bun build ./src/index.ts --outdir ./dist
bun run ./scripts/sync.ts
```

这对内部平台、脚本仓库、工具库、轻量服务尤其有吸引力。很多团队的 JavaScript 工程问题不在业务代码，而在“跑起来之前那一层工具链”。Bun 把这一层压扁了。

### 2. TypeScript 和 JSX 的本地执行体验更直接

Node.js 近几年也在补 TypeScript 相关能力，但现实里大量项目仍然需要 loader、transpiler 或先构建再运行。Bun 默认把 TypeScript/JSX 当作一等输入。

这意味着下面这种开发工具脚本可以很自然：

```ts
// scripts/check-release.ts
import { readFile } from "node:fs/promises";

type PackageJson = {
  name: string;
  version: string;
};

const pkg = JSON.parse(await readFile("package.json", "utf8")) as PackageJson;

if (!pkg.version.includes(".")) {
  throw new Error(`invalid version: ${pkg.version}`);
}

console.log(`${pkg.name}@${pkg.version}`);
```

运行时不需要先配置 `ts-node`：

```bash
bun scripts/check-release.ts
```

对大型生产服务来说，这不是决定性因素；对日常工程效率来说，它很直接。

### 3. 冷启动和资源占用更适合短生命周期任务

Node.js 最大的优势是稳定，但它不是最轻的 runtime。CLI、Git hook、CI 小脚本、serverless handler、代码生成器这类任务，经常被启动时间和安装时间支配。

Bun 在这些场景的优势通常更明显：

- 启动快，短脚本体感更好。
- 安装依赖快，CI 更容易省时间。
- 单二进制工具链，环境准备更少。
- TypeScript 可直接运行，脚本不用先编译。

这也是很多团队最适合先试 Bun 的入口：不要一开始就替换核心 Node.js 服务，先替换开发工具、CI 脚本、内部 CLI、独立 worker。

### 4. 内置 API 能降低供应链面积

每少一个依赖，就少一个升级、审计、漏洞、维护者变更和 transitive dependency 的风险。Bun 把 Markdown、cron、图片、SQLite、S3、WebView、测试、构建等能力往核心里收，某些项目可以因此删掉一批包。

这不是说“内置一定更好”。核心 API 也可能有 Bug，也需要跟着 Bun 升级。但对小型工具和内部系统来说，少维护一堆胶水依赖，本身就是工程收益。

### 5. Bun 的 HTTP 和 framework 场景仍然有性能吸引力

Bun 基于 JavaScriptCore，同时在 HTTP server、I/O、transpiler、package install 等路径做了大量 native 优化。1.4.0 又进一步降低 CPU 和内存。对下列场景，值得实测：

- Hono、Elysia、Fastify 等轻量 API 服务。
- SSR 或 BFF 层，尤其是内存压力明显的服务。
- WebSocket、代理、边缘网关、短连接密集服务。
- Serverless 冷启动敏感函数。
- monorepo 里的测试、构建和代码生成任务。

但这里一定要强调“实测”。runtime benchmark 只能说明方向，不能替代你自己的请求模型、依赖树和部署环境。

## 五、Node.js 仍然更适合哪些场景

Bun 1.4.0 很强，但 Node.js 并没有因此失去价值。恰恰相反，Node.js 的优势大多来自时间积累，很难被一个版本抹平。

### 1. 生态确定性要求高

如果你的系统依赖大量成熟 npm 包、老框架、复杂构建插件、native addon、APM agent、企业安全扫描、云厂商 SDK，Node.js 仍然是风险最低的默认选项。

Bun 已经兼容很多 Node.js API，但它自己也明确说还不是 100%。如果你的依赖刚好用到未实现的 Node 内部行为，问题可能很难快速定位。

### 2. 长期维护和合规要求高

Node.js 有成熟的 LTS 节奏、发行策略、安全公告、企业支持和运行经验。很多公司的平台标准、镜像基线、监控探针、漏洞扫描和应急流程都围绕 Node.js 建立。

Bun 正在成熟，但它还没有 Node.js 那种十多年沉淀下来的组织惯性。

### 3. 原生扩展深度依赖 V8 或 Node 内部

Bun 1.4.0 对 V8 C++ API、N-API、profiling、Datadog、OpenTelemetry 都有改善，但“能跑”不等于“所有版本、所有平台、所有边界都稳定”。如果项目依赖 native addon，尤其是直接碰 V8、libuv 或 Node 内部结构的库，迁移前必须做完整测试。

### 4. 团队已经有稳定 Node 工具链

如果团队的 pnpm/Vite/Vitest/tsx/ESLint/Prettier/CI 缓存已经稳定，构建时间也不是瓶颈，那么为了“更快”切 Bun 未必划算。Bun 的收益越大，通常越发生在新项目、脚本密集项目、工具链痛点明显的项目里。

## 六、Rust 重写也带来了新的风险

这次迁移值得关注的另一个原因，是它不是传统重写。官方说明里提到，Bun 使用 Claude Code 的动态工作流完成了大规模机械迁移：准备 porting guide 和 lifetime map，让多个 agent 分批迁移、编译、修错、对 diff 做 adversarial review，再用语言无关的 TypeScript 测试套件兜底。

这很有启发，也有风险。

启发在于：测试套件成为大规模迁移最重要的资产。Bun 能在短时间内完成迁移，一个关键原因是 runtime 测试是用 TypeScript 写的，不关心底层实现语言。只要行为契约被测试覆盖，底层可以从 Zig 换到 Rust。

风险在于：一个百万行级别的迁移，即使测试通过，也不代表每条路径都被人类仔细读过。Rust 代码里仍然有 unsafe 边界，和 C/C++/JavaScriptCore 交互时仍然可能出错。对使用者来说，这意味着 Bun 1.4.0 虽然值得试，但核心生产系统最好等几个 patch release 或至少做充分灰度。

这不是保守口号，而是正常工程判断：runtime 底座换语言，哪怕公开 benchmark 很好，也应该用自己的测试和流量验证。

## 七、迁移建议：从工具链开始，而不是从核心服务开始

如果你现在跑的是 Node.js，不建议看到 Bun 1.4.0 就全仓切换。更现实的路径是分层迁移。

### 第一层：本地脚本和 CI

优先尝试：

- 代码生成脚本。
- 发布检查脚本。
- Markdown/JSON/CSV 处理脚本。
- monorepo 中独立的构建辅助命令。
- `bun install` 在 CI 中的缓存收益。

这些路径风险低，收益容易测量。如果出问题，回滚也简单。

### 第二层：测试和构建

可以尝试把部分 Jest/Vitest 测试迁到 `bun test`，或者用 `bun build` 处理简单库和 CLI 的打包。

注意不要一口气替换所有工具。先挑没有复杂 mock、没有 Node 内部依赖、没有 native addon 的测试集。

### 第三层：新服务或边缘 worker

新服务最适合评估 Bun，因为没有历史兼容包袱。可以重点看：

- 冷启动。
- p95/p99 延迟。
- RSS / working set。
- CPU 使用率。
- APM、日志、trace 是否完整。
- 容器镜像大小和启动探针。

### 第四层：已有核心服务

核心服务迁移要更谨慎。建议先做一层适配检查：

```bash
bun install
bun test
bun run typecheck
bun --bun ./node_modules/.bin/your-framework build
```

然后逐项验证：

- native addon 是否加载正常。
- `node:http` / `stream` / `worker_threads` / `cluster` 行为是否符合预期。
- APM、OpenTelemetry、日志 patch 是否生效。
- 性能压测是否真的优于 Node.js。
- 内存曲线是否稳定，而不是只看峰值。
- Docker 镜像、Kubernetes 探针、信号处理、graceful shutdown 是否一致。

如果服务必须同时兼容 Node.js 和 Bun，可以先保持 runtime-neutral 的代码风格，避免过早绑定大量 `Bun.*` 私有 API。

## 八、一个简单的选择框架

可以用下面这张表做初步判断。

| 项目类型                | 更适合 Bun                                   | 更适合 Node.js                                            |
| ----------------------- | -------------------------------------------- | --------------------------------------------------------- |
| 新 TypeScript 服务      | 想要低配置、快速启动、少工具链，且依赖较新。 | 公司运行基线必须统一 Node LTS。                           |
| 旧 Express/Fastify 服务 | 依赖简单，测试完整，性能或内存有明确痛点。   | 依赖老插件、native addon、APM agent 或复杂 monkey patch。 |
| CLI / 内部工具          | 启动速度、单二进制体验、直接跑 TS 很重要。   | 分发环境只保证 Node，或依赖 Node 专属调试工具。           |
| Serverless / Edge       | 冷启动敏感，依赖轻，能接受 runtime 灰度。    | 平台只支持 Node LTS，或合规要求保守。                     |
| 大型前端 monorepo       | install/test/build 时间是主要瓶颈。          | 现有 pnpm/Vite/Vitest 缓存和插件链已经稳定。              |
| 企业核心系统            | 适合作为灰度或新模块试点。                   | 默认仍应选择 Node LTS，除非收益被实测证明。               |

这里的重点不是“Bun 或 Node 二选一”。更合理的方式是按工作负载选择 runtime：核心长期服务继续用 Node.js，工具链和新服务先试 Bun，等兼容性和运维经验足够后再扩大范围。

## 九、升级检查清单

如果你准备评估 Bun 1.4.0，可以按这个顺序做：

1. 固定 Bun 版本，不要在 CI 和生产里漂移到不同 patch。
2. 跑完整单元测试、集成测试和端到端测试，不只跑 typecheck。
3. 单独验证 native addon、APM agent、OpenTelemetry、日志库、mock 工具和测试 runner。
4. 对核心 HTTP 路径做压测，记录 p50/p95/p99、RSS、CPU、GC、连接数和错误率。
5. 对启动敏感场景做冷启动测试，不要只看常驻进程吞吐。
6. 检查 Docker 镜像、信号处理、graceful shutdown、健康检查和环境变量加载。
7. 如果使用 `Bun.*` API，明确这些代码不再是纯 Node.js 可移植代码。
8. 先在低风险服务或内部工具灰度，再迁核心路径。
9. 保留回滚到 Node.js 或 Bun 1.3 的方案，至少覆盖一个发布周期。

## 结语：Bun 1.4.0 的价值不是“Rust 赢了 Zig”

Bun 1.4.0 最值得看的地方，不是语言社区之间的胜负叙事。Zig 让早期 Bun 能以很低成本快速铺开一个巨大工具链；Rust 则在 Bun 进入更大规模使用后，提供了更适合长期运行时维护的生命周期约束。

对开发者来说，真正重要的是三件事。

第一，Bun 1.4.0 比过去的 Zig 版本更像一个能长期跑在线上的平台：内存、CPU、启动、诊断、Node.js 兼容都有实质进展。

第二，Bun 相比 Node.js 的优势主要在一体化工具链和低摩擦开发体验，而不是简单一句“更快”。少配置、少依赖、直接跑 TypeScript、内置 install/test/build，这些才是很多团队能马上感知的收益。

第三，Node.js 仍然是生态确定性最强的默认选择。Bun 1.4.0 值得认真评估，但迁移应该基于自己的测试、流量和运维约束，而不是基于发布说明里的最好数字。

如果说 Bun 1.4.0 改变了什么，它改变的不是 JavaScript runtime 的终局，而是 Bun 从“很快的新工具”向“可作为工程平台评估的 runtime”迈了一大步。
