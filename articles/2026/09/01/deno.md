# Deno 没有掉队，它只是押注了更底层的 AI 基建

<!-- summary: Bun 把 JavaScript 运行时竞争推到台前，Deno 的声量却显得安静很多。但从 Deno 2、Deno Deploy、Claw Patrol 到 Deno Desktop 看，它并没有停滞，而是在把自己重新定位成安全、标准化、可部署的 JavaScript 基础设施。 -->
<!-- tags: Deno, JavaScript Runtime, AI Agent, Security Sandbox -->

这两年讨论 JavaScript 运行时时，Bun 很容易成为主角。它快、锋利、发布节奏高，创始人也很会把工程进展转化成社区话题。相比之下，Deno 的存在感弱了不少，尤其在 AI 编程工具、Agent、全栈框架都被放大讨论的时候，Deno 看起来不像那个当年带着“修正 Node.js 遗憾”出场的挑战者。

但“没那么出名”和“掉队”是两件事。

Deno 过去几年的变化，核心不是继续和 Node.js 站在对立面，也不是和 Bun 拼谁的 benchmark 更适合传播，而是逐渐转向一条更基础设施化的路线：兼容 Node/npm，补齐企业迁移路径，继续强化权限模型和安全边界，把 Deno Deploy、JSR、Deno Sandbox、Claw Patrol、Deno Desktop 这些能力连接到一起。

如果把 AI 时代的软件问题拆开看，Deno 押注的不是“帮你生成更多代码”的上层应用，而是“怎样安全地运行不完全可信的代码和 Agent”。这条路线没那么热闹，但非常符合 Deno 一开始的技术基因。

## 一、先看结论

| 问题                       | Deno 的答案                                                                                            | 工程含义                                                                            |
| -------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| 还能不能迁移现有 Node 项目 | Deno 2 开始强调 Node.js 和 npm 兼容，支持 `package.json`、`node_modules`、npm 包和工作区。             | Deno 不再要求团队用“重写生态”的方式试用它，可以从工具链、测试、脚本、服务局部迁移。 |
| AI 时代有什么新动作        | Claw Patrol 把 Agent 到生产系统之间的网络和协议访问放到外部策略层控制。                                | Deno 把安全沙箱思路延伸到 Agent 基建，而不是只做聊天应用或 IDE 插件。               |
| 商业化靠什么               | Deno Deploy、Deno Subhosting、Deno Sandbox、JSR 等产品组成运行和分发基础设施。                         | 它更像面向平台团队和 SaaS 厂商的底座，而不是单纯的本地 runtime。                    |
| 为什么声量不如 Bun         | Bun 的性能叙事、All-in-One 体验和高频传播更适合社交媒体扩散。                                          | 开发者心智被“更快、更爽、更少配置”抓住，Deno 的安全和标准化价值需要更长周期验证。   |
| 应该怎么选                 | Bun 适合追求本地开发速度和一体化工具链的团队；Deno 适合重视权限、安全边界、标准 API 和边缘部署的团队。 | 不要按热度选 runtime，要按项目风险模型、生态依赖和部署形态选。                      |

## 二、Deno 这几年到底在做什么

Deno 早期最鲜明的标签是“反 Node.js”：默认安全权限、原生 TypeScript、URL import、ESM、内置 formatter 和 test runner。这个方向有很强的工程洁癖，也确实指出了 Node.js 生态的一些历史问题。

问题在于，企业项目很少从一张白纸开始。它们已经有 `package.json`，有 npm 包，有 CommonJS，有构建脚本，有 CI，有一堆和 Node 生态绑定的库。一个运行时如果要求团队先迁移生态再获得收益，就很难进入主流程。

Deno 2 的战略调整就在这里：它不再把“脱离 npm”当成身份认同，而是把 Node.js 和 npm 兼容变成规模化前提。官方在 Deno 2 发布中明确强调，它支持运行现有 Node 项目，支持 `package.json` 和 `node_modules`，并允许团队渐进式采用 Deno 的工具链。

这不是一次简单的妥协。它更像 Deno 从“理念型替代品”转向“可落地基础设施”的必要动作。

以前你可能要这样说服团队：

```ts
import { serve } from "https://deno.land/std/http/server.ts";

serve((_req) => {
  return new Response("hello");
});
```

这段代码很干净，但问题也明显：一旦项目依赖大量 npm 包，迁移成本会立刻盖过语法上的清爽。

现在更现实的路径是：

```ts
import express from "npm:express@4";

const app = express();

app.get("/", (_req, res) => {
  res.send("hello from deno");
});

app.listen(8000);
```

这不是说 Express 就是 Deno 的最佳实践，而是说明 Deno 已经承认一个现实：如果不能顺着 npm 生态进入现有项目，运行时再漂亮也很难成为工程默认选项。

## 三、Deno 的主线：从运行时变成基础设施

今天再看 Deno，不能只看 `deno run`。它正在把几条线拼成一个更完整的平台。

第一条线是运行时和工具链。Deno 仍然坚持开箱即用：TypeScript、formatter、linter、test runner、task runner、dependency management、compile 都在一个命令体系里。这和 Bun 的 All-in-One 有相似之处，但 Deno 更强调 Web 标准、权限模型和稳定性。

第二条线是部署。Deno Deploy 面向 serverless 和边缘计算，配合 `Deno.serve`、KV、队列、Cron、OpenTelemetry 等能力，试图把“写脚本”和“上线服务”之间的距离压短。它不是只提供一个本地 runtime，而是在争夺 JavaScript 应用的运行位置。

第三条线是分发。JSR 是 Deno 对 JavaScript 包管理长期问题的回应：面向 TypeScript、跨运行时、强调文档和类型信息。它很难短期替代 npm，但可以服务那些希望摆脱历史包袱的新库。

第四条线是桌面。Deno 2.9 引入实验性的 `deno desktop`，让开发者用 Web 技术构建本地桌面应用，并输出自包含的分发产物。它不一定会替代 Electron 或 Tauri，但方向很清楚：Deno 希望成为 TypeScript 应用从脚本、服务、边缘到桌面的统一执行层。

一个极简桌面入口大概是这样：

```ts
Deno.serve(() => {
  return new Response("<!doctype html><h1>Hello from Deno Desktop</h1>", {
    headers: {
      "content-type": "text/html",
    },
  });
});
```

这类能力的价值不在于“又多了一个桌面框架”，而在于 Deno 想把运行、打包、权限和分发都收进同一套模型里。

## 四、AI 时代，Deno 为什么没有去抢最热闹的位置

AI 浪潮里最容易出圈的是三类产品：

- 直接面向用户的 AI 应用。
- 能显著提升个人效率的编码助手。
- 能制造强烈性能对比或工程戏剧性的工具。

Deno 都不是。

Deno 的 AI 相关动作更底层。Claw Patrol 是一个很典型的例子：它不是让 Agent 更会写代码，而是把 Agent 到生产系统之间的访问路径外置出来，用规则控制哪些网络请求、SQL、Kubernetes 操作可以通过，哪些必须拒绝或进入审批链。

一个策略可以长这样：

```hcl
rule "deny-dangerous-sql" {
  endpoints = [postgres.prod]
  condition = "sql.verb in ['DROP', 'DELETE', 'TRUNCATE']"
  verdict   = "deny"
  reason    = "Agents must not run destructive SQL in production"
}
```

这背后的判断很朴素：Agent 不能靠自觉约束自己。

当一个 AI Agent 能调用 `kubectl`、`psql`、`gh`、`curl`，并且手里拿着真实凭证时，提示词安全、系统 prompt 和工具描述都不是最后防线。真正的边界应该在 Agent 进程之外，由你控制的网络、协议和凭证层来执行。

这正好是 Deno 最擅长的叙事：默认不信任代码，权限必须显式授予，执行环境要能被约束。

早期 Deno 的权限模型主要保护本地脚本：

```bash
deno run --allow-net=api.example.com --allow-env=API_TOKEN main.ts
```

到 Agent 场景里，这个问题被放大了。过去你担心的是一个脚本偷读环境变量；现在你担心的是一个 Agent 在生产数据库里执行了错误 SQL，或者把 Kubernetes Secret 读出来发给外部服务。

所以 Deno 没有在 AI 应用层拼热度，而是在补一个更难传播但更实际的问题：不可信代码和半自主 Agent 如何进入真实生产环境。

## 五、那为什么 Bun 显得更活跃

Bun 的活跃感并不只是营销造成的，它确实抓住了开发者每天能感受到的痛点。

安装依赖慢、测试慢、启动慢、打包配置复杂，这些问题不需要解释。Bun 把 package manager、runtime、bundler、test runner 放进一个工具里，再用非常直接的性能对比告诉开发者：你现在就能少等几秒。

这种价值很容易传播。截图里一个 `bun install` 比 `npm install` 快很多，大家马上能理解。一个 benchmark 里 HTTP 吞吐量更高，社区马上会讨论。一个创始人在社交媒体上持续发布进展，也会让项目显得始终站在舞台中央。

更重要的是，Bun 很会制造技术话题。无论是 Zig、Rust、Node 兼容、前端工具链，还是用 AI 辅助大规模重写，它的叙事都很适合社交媒体：短、快、有冲突、容易转发。

Deno 的路线刚好相反。它更喜欢发布一组完整的工程能力：兼容性、权限、标准库、部署、观测、安全、企业场景。这些东西对真实项目重要，但不容易变成一句话的传播点。

所以 Bun 显得更火，不代表 Deno 停了；只是二者解决的是不同层级的问题。

## 六、Deno 的认知包袱

Deno 现在的一个现实困难，是早期形象太鲜明。

很多开发者对 Deno 的记忆还停留在：

- 不用 npm。
- 只能 URL import。
- 和 Node 生态不兼容。
- 权限模型很严格，跑脚本要一直加 flag。
- 很适合写 demo，但迁移大型项目不现实。

这些印象并不全是错的，它们来自 Deno 早期真实的产品取舍。只是 Deno 2 之后，很多前提已经改变。

现在的问题变成：当 Deno 终于兼容 Node/npm，一部分人又会反过来质疑，既然都兼容了，为什么不直接用 Node 或 Bun？

这个问题不能靠口号回答。Deno 的差异点必须回到具体场景：

- 你是否需要默认拒绝文件、网络、环境变量访问。
- 你是否希望 TypeScript、lint、fmt、test、task、compile 尽量由官方工具链统一提供。
- 你是否把 Web 标准 API 当成长期接口，而不是运行时私有 API。
- 你是否需要边缘部署、沙箱执行、租户隔离或 Agent 安全控制。
- 你是否愿意为更清晰的权限和平台边界，接受一部分生态兼容成本。

如果答案都是否定的，Deno 未必是最合适的选择。它现在的价值不在“我也能跑 npm 包”，而在“我能在兼容 npm 的同时，把执行边界管得更严”。

## 七、选型建议：不要按热度选 runtime

如果团队正在做新项目，可以用一个更现实的方式比较 Node、Bun 和 Deno。

| 场景                                         | 更自然的选择          | 原因                                                            |
| -------------------------------------------- | --------------------- | --------------------------------------------------------------- |
| 大量既有 Node 服务，依赖复杂，稳定性优先     | Node.js               | 生态最成熟，线上行为最可预测，招聘和排障成本最低。              |
| 本地开发、测试、脚本、前端工具链追求速度     | Bun                   | 安装、运行、测试、打包体验激进，反馈快，社区声量强。            |
| 边缘函数、脚本自动化、内部平台、受限执行环境 | Deno                  | 权限模型、标准 API、内置工具链和 Deploy/Sandbox 路线更匹配。    |
| AI Agent 需要访问生产系统                    | Deno 生态值得重点观察 | Claw Patrol 这类外部策略层，比只在 prompt 里约束 Agent 更可靠。 |
| 桌面应用但团队只熟 TypeScript                | Deno Desktop 可试点   | 仍处实验期，但对内部工具和轻量桌面应用有吸引力。                |

对已有项目，我不建议为了运行时热度做大迁移。更稳的路径是从边缘场景切入：

1. 先用 Deno 跑独立脚本、内部工具或 CI 辅助任务。
2. 再试用 `deno fmt`、`deno lint`、`deno test` 这类低侵入工具。
3. 对需要权限收敛的脚本，明确写出 `--allow-*` 边界。
4. 对边缘服务或轻量 API，评估 Deno Deploy 的部署模型。
5. 对 Agent 生产访问，单独验证 Claw Patrol 或同类网关的策略表达能力。
6. 保留 Node/Bun 的现实优势，不把 runtime 选择做成信仰问题。

## 八、Deno 真正的风险

Deno 的路线并不是没有风险。

第一，兼容 Node/npm 是必要条件，但不是充分条件。很多项目依赖的不是 API 本身，而是生态里的隐含行为：安装脚本、native addon、调试工具、框架插件、CI 缓存、监控探针。这些边界需要时间打磨。

第二，Deno 的商业化重心偏平台和企业基础设施，这会让个人开发者感知没那么强。一个运行时如果缺少足够多的日常使用入口，社区声量就容易被 Bun 抢走。

第三，安全价值很难被证明。只有当团队真的遇到供应链攻击、Agent 越权、租户隔离、生产访问控制这些问题时，Deno 的设计才会显得非常直接。对还没遇到这些问题的团队，它看起来就像“更麻烦的 Node”。

第四，Deno Desktop、Agent 防火墙、沙箱执行等方向还需要生态验证。基础设施产品不是发布就成功，关键是能不能长期稳定、能不能被平台团队集成、能不能在复杂组织里形成操作手册。

这些风险决定了 Deno 不会靠一两个版本突然反超舆论。但也正因为如此，它的判断周期应该拉长。

## 结语：Deno 从挑战者变成了边界工程

Deno 早期的问题，是把正确的工程理念放在了一个太陡的迁移坡度上。Deno 2 之后，它开始承认 npm 和 Node 生态的现实，把兼容性当成入口，再继续保留权限、安全、标准和部署这些底层主张。

Bun 更像一把锋利的本地开发工具，它用速度和传播抓住开发者心智。Deno 更像一套边界工程：代码能访问什么，包从哪里来，服务跑在哪里，Agent 到生产系统之间有什么硬限制。

所以，Deno 并没有掉队。它只是没有站在 AI 浪潮最吵的位置。

如果你的问题是“怎么更快安装依赖、跑测试、启动项目”，Bun 很可能更直接。如果你的问题是“怎么让 TypeScript 代码在更受控的环境里运行，怎么让 Agent 安全接触真实系统，怎么把脚本、服务、边缘和桌面纳入同一套运行模型”，Deno 依然值得认真看。

参考资料：

- [Announcing Deno 2](https://deno.com/blog/v2.0)
- [Claw Patrol: an open-source security firewall for agents](https://deno.com/blog/clawpatrol)
- [Deno 2.9](https://deno.com/blog/v2.9)
