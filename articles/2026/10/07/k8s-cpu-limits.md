# K8s 的 CPU limits 到底该不该设：CFS 节流、隔离代价与工程折中

<!-- summary: 平均 CPU 只有 30%，p99 延迟却因 CFS 节流大幅恶化。停止设置 CPU limits 原理成立，却不能一刀切。本文拆解 CFS 节流机制、CPU 与内存的区别、隔离与 QoS 的代价，并给出按负载分级的管理策略。 -->
<!-- tags: Kubernetes, CPU Limits, CFS, SRE, Capacity Planning -->

先讲一个很多 SRE 都遇到过的场景。

半夜告警：结账服务的 p99 延迟涨了 4 倍，请求大面积超时。打开监控，Pod 的平均 CPU 利用率只有 30%，内存正常，错误日志也没有明显的异常。从大盘上看，资源非常充足，但用户就是卡。

最后定位到的“元凶”，是 Deployment YAML 里那行被无数人复制过的 `limits.cpu`。

Medium 上有一篇文章把这类现象总结成一句很有传播力的话：**Stop Setting Kubernetes CPU Limits（是时候停止设置 CPU limits 了）**。它的核心论据是 Linux 的 CFS 带宽控制器：CPU limit 会在 100ms 的周期内强制冻结容器，导致平均利用率很低、长尾延迟却爆炸。

这篇文章值得认真读，因为它的内核原理是对的。但如果你明天就把全公司的 `limits.cpu` 全部删掉，很可能会制造另一场事故。下面把“它说对了什么”“它没说透什么”“生产环境到底怎么做”一次讲清楚。

## 一、先看结论

<!-- table-svg: k8s-cpu-summary-table.svg -->
| 维度          | 传统默认做法               | 爆款文章的主张                 | 更稳妥的工程做法                                 |
| ------------- | -------------------------- | ------------------------------ | ------------------------------------------------ |
| CPU limits    | requests 和 limits 都设    | 删掉，只留 requests            | 按负载分级：在线服务放宽或不设，离线任务严格限制 |
| CPU requests  | 常被当成形式               | 必须保留，且要准确             | 保留，作为调度与保底算力依据                     |
| Memory limits | 与 CPU 对称设置            | 暗示必须保留                   | 必须保留，内存是不可压缩资源                     |
| CFS 节流      | 很少被监控                 | 是延迟恶化的根因               | 把节流比例纳入核心 SLO 监控                      |
| 隔离性        | 靠 limit 兜底              | 基本未讨论                     | 用节点池、QoS、权重和准入来兜底                  |
| 成本          | 看 limit 配额              | 提升集群利用率                 | 兼顾利用率与多租户公平、许可证计费               |

一句话概括：**文章的技术判断成立，工程结论过于绝对。正确的理解不是“停止设置”，而是“重新审视并放宽 CPU limit”。**

## 二、监控看不见的根源：CFS 节流

要理解这个故障，必须先理解 Linux 是怎么“执行” CPU limit 的。

### 1. CFS 带宽控制器与 100ms 周期

Linux 内核用 **CFS 带宽控制器（CFS Bandwidth Controller）** 来限制一个 cgroup 的 CPU 使用量。它把时间切成固定长度的周期（period），默认是 **100ms**，并规定每个周期内该 cgroup 最多能消耗多少 CPU 时间（quota）。

在 cgroup v2 里，这个约束就是 `cpu.max`：

```text
$ cat /sys/fs/cgroup/<cgroup>/cpu.max
50000 100000
```

含义是：每 100000 微秒（100ms）的周期内，最多使用 50000 微秒（50ms）的 CPU。在 cgroup v1 里则对应 `cpu.cfs_quota_us` 和 `cpu.cfs_period_us`。

Kubernetes 的 `limits.cpu: 500m` 翻译过来就是“每 100ms 最多 50ms”。`1000m`（1 核）等于“每 100ms 可以用满 100ms”。

### 2. 配额是怎么在几毫秒内被耗尽的

问题出在“周期内配额”这个语义上。假设一个 Java 或 Go 服务有 8 个工作线程同时处理一波突发请求：

- 每个线程只需要 6~7ms 的 CPU，8 个线程加起来就是约 50ms。
- 50ms 配额在周期刚开始的 **6ms 左右**就被消耗干净。
- 接下来的 **94ms**，内核会把这个 cgroup 里的所有线程**强制冻结（throttle）**，直到下一个周期开始。

```text
一个 100ms 的 CFS 周期（limits.cpu: 500m）
|== 已用 50ms ==|--------------- 被 throttle 的 94ms ---------------|
0ms            6ms                                              100ms
```

被冻结的线程不是“跑得慢”，而是**完全无法运行**。对于同步等待响应返回的网络请求来说，这几十毫秒的停顿就是用户可感知的卡顿。

### 3. 为什么平均利用率监控不出来

Prometheus 之类的监控通常按 15s 或 1m 的间隔抓取 `counter`，再算成“平均 CPU 使用率”。一个大部分时间被冻结、偶尔突发的容器，平均下来可能只有 30%，看起来非常健康。

而真正该看的指标是**节流**：

```promql
# 每个 Pod 在本周期内被节流的周期占比
sum(rate(container_cpu_cfs_throttled_periods_total[5m])) by (pod)
/
sum(rate(container_cpu_cfs_periods_total[5m])) by (pod)

# 被节流掉的总时长占比
sum(rate(container_cpu_cfs_throttled_seconds_total[5m])) by (pod)
/
sum(rate(container_cpu_usage_seconds_total[5m])) by (pod)
```

如果这个比例显著大于 0（比如 > 1%），说明 CFS 节流正在真实地伤害这个服务。这个比值比“要不要设 limit”这条规则本身更接近问题的本质。很多默认配置能存活多年，只是因为没有人把这个指标放上监控大屏。

## 三、CPU 和内存不是一类资源

传统建议之所以强调“requests 和 limits 都要设”，背后其实有一个对称性的美学错误：既然内存设了 limit，CPU 理所当然也要设。但 CPU 和内存的物理属性完全不同。

<!-- table-svg: k8s-cpu-resource-compare-table.svg -->
| 维度         | CPU                                 | 内存                                 |
| ------------ | ----------------------------------- | ------------------------------------ |
| 资源类型     | 可压缩（compressible）              | 不可压缩（incompressible）           |
| 超限后的行为 | 变慢：被 throttle 或排队            | 崩溃：OOMKilled，严重时拖垮节点      |
| 隔离手段     | CFS 带宽、权重、绑核                | cgroup 内存上限、OOM 优先级          |
| 是否可以借用 | 可以借用节点上空闲的 CPU 周期       | 不能借用，超额会被内核杀掉           |
| limit 的作用 | 限制吞吐上限，也引入尾延迟          | 保护节点不被单个容器的内存失控毁掉   |
| 建议         | 谨慎设置，或设置得比 request 宽很多 | 必须设置，防止内存泄漏和节点雪崩     |

结论很直接：

- **CPU limit 的代价是延迟**：超了就变慢，不会让进程直接崩溃。
- **内存 limit 的代价是安全**：没有它，一个内存泄漏就能把整个 Node 拖死。

把这两个资源当成同一类东西来管，正是爆款文章批评的那种“配置层面的整齐美学”。配置看着对称，运行起来却是两种完全不同的行为。

## 四、这篇文章说对了什么

抛开“停止设置”这个刺眼的口号，它的技术判断基本都站得住：

1. **揭示了“平均 CPU 正常、长尾延迟爆炸”的现象**。这是很多团队排查很久才发现的坑，CFS 的 100ms 微观节流正是最常见的解释之一。
2. **纠正了 CPU 与内存对称管理的误区**。内存是底线，CPU 是可以被压缩的。用同一套模板套两种资源，本身就是偷懒。
3. **指出硬性 CPU limit 会浪费闲置算力**。节点上其他 Pod 空闲时，你的服务本可以突发使用那些空闲核。强制 limit 让这部分算力白白浪费，也降低了整个集群的资源利用率。

所以它值得被认真对待，但它给出的“一刀切”结论，忽略了平台工程视角的几个关键约束。

## 五、文章没说透的代价

### 1. “吵闹的邻居”

假设同一节点上有 A 和 B 两个 Pod：

- **有 CPU limit 时**：A 被压在 1 核，B 可以稳定运行。
- **没有 CPU limit 时**：A 一旦陷入死循环、正则回溯或流量突增，会抢走节点上所有空闲 CPU。B 虽然有自己的 request 保底，但在高负载下仍然会被严重挤压。

在微服务混部环境里，缺乏隔离是极其危险的。**“不设 limit”实际上是把隔离责任从内核转移到了调度层和节点规划层**，如果这两层没有跟上，风险就落到了线上。

### 2. QoS 等级降级

Kubernetes 用 limit 和 request 的关系来定义 QoS：

- `Guaranteed`：所有容器的 requests == limits，保护级别最高。
- `Burstable`：设置了 request，但 limits 不等或缺失。
- `BestEffort`：什么都没设，最先被驱逐。

删掉 CPU limit 后，Pod 会从 `Guaranteed` 降为 `Burstable`。在节点资源紧张需要驱逐时，它的保护级别会下降。对核心链路来说，这个变化需要被显式评估，而不是顺手删掉。

### 3. 运行时可能误判可用 CPU

如果容器没有 CPU limit，某些运行时在启动探测时可能误以为它拥有**整台物理机**的所有核心。后果是：

- Go 的 `GOMAXPROCS` 可能被设成宿主机核数，导致大量线程争抢、上下文切换飙升。
- JVM 的 GC 线程数、JIT 线程数、ForkJoinPool 并行度同理。

现代 Go 和 Java 已经能通过 cgroup 信息做启发式判断，但不同版本、不同发行版的行为不完全一致。移除 CPU limit 前，必须确认运行时拿到的是一个合理值，而不是宿主机核数。

### 4. 成本与多租户治理

在大型组织里，limit 不只是技术配置，也是治理手段：

- 它是成本分摊和配额审批的依据。
- 它防止某个团队的低效脚本吃掉整个集群的算力。
- 在按 CPU 计费的商业软件场景下，它甚至直接对应预算。

这一点正是评论区里最容易被忽略的现实约束，后面单独说。

## 六、评论区补充的三个视角

原文的评论区比正文更接近工程现场。有三条补充特别值得放进来。

### 1. CPU 数量直接决定许可证成本

一位读者提到：他们依赖的第三方镜像按 CPU 授权（PVU，Processor Value Unit）。如果删掉 CPU limit，容器会“看到”整个 worker node 的所有核心，授权费用就会按整台机器计算，成本可能直接翻倍。

<!-- table-svg: k8s-cpu-comments-table.svg -->
| 评论者        | 核心观点                                                     | 对实践的启示                                         |
| ------------- | ------------------------------------------------------------ | ---------------------------------------------------- |
| Sherlock      | 商业软件按 CPU 授权（PVU），删掉 limit 会按整个 Node 计费    | 合规和成本约束可能比性能约束更硬，不能只看延迟       |
| Jakub Jirak   | 问题是“把两种不同资源当成可互换”，配置整齐的审美代价很高     | 真正该上监控的是节流比例，而不是记住“不要设 limit”   |
| Kövi András   | 稳定内存的应用用 `limit=request` 合理；突发型应用会浪费内存  | 内存策略也要分类，短生命周期任务应拆成独立 Pod       |

### 2. 别把“不设 limit”当成新教条

另一位读者的总结很精辟：故障的根因不是 CFS quota，而是**把两种物理上不同的资源当成可互换的东西**，只因为它们在 YAML 里相邻两行、看起来整齐。配置的整齐是一种非常昂贵的审美。

他还指出一个更普遍的问题：这类默认值能存活多年，往往是因为**暴露问题的指标从来没有出现在任何人的屏幕上**。你无法质疑一个你从没看到过代价的默认值。所以真正的行动项不是“删掉 limit”，而是**把节流比例变成一等监控指标**。

### 3. 内存策略也要分类

第三位读者补充：`limit=request` 对内存稳定可预测的应用是合理猜测，但对“呼吸型”应用会造成大量闲置内存浪费。对这类应用，另一种思路是把短生命周期、突发型的任务拆成独立的短生命 Pod。

换句话说，**用一个全局规则同时管 CPU 和内存，或者管所有应用类型，本身就是错的**。

## 七、务实的落地策略

真正成熟的实践不是“设”或“不设”，而是**按负载特征分级管理**。

### 1. 区分在线与离线

<!-- table-svg: k8s-cpu-decision-table.svg -->
| 负载类型                                     | CPU limit 建议                                  | 原因                                             |
| -------------------------------------------- | ----------------------------------------------- | ------------------------------------------------ |
| 延迟敏感的在线服务（网关、交易、实时推荐）   | 不设，或设置成 request 的 4~8 倍                | 避免 CFS 节流伤害 p99，允许空闲时突发            |
| 普通在线服务（后台 API、内部系统）           | 设置较宽的 limit，request : limit 保持 1:2~1:4  | 兼顾隔离性与突发能力                             |
| 离线批处理、CronJob、数据同步、日志采集      | 严格设置 limit                                  | 对延迟不敏感，重点是不要抢走在线业务的算力       |
| 需要最高保障的核心组件                       | `requests == limits`，配合专用节点池            | 换取 Guaranteed QoS 和更可预测的隔离             |

### 2. 绝对不要设置 `request == limit`（除非有特殊理由）

如果你决定保留 CPU limit，请给应用留出喘息空间。`1:2` 或 `1:4` 的比例通常比 `1:1` 更合理。只有在需要 Guaranteed QoS 或必须避免 CPU 超卖的核心组件上，才考虑让两者相等。

### 3. 用数据决定，而不是靠感觉

在动手之前，先回答三个问题：

1. 当前服务是否真的在被节流？看 `container_cpu_cfs_throttled_periods_total` 的比例。
2. CPU request 是否贴近真实用量？长期显著高于实际用量的 request 只是浪费调度预算。
3. 移除 limit 后，谁来防止“吵闹的邻居”？如果没有答案，先不要删。

### 4. 移除 limit 时同步校准运行时

如果确实决定移除 CPU limit，必须同时确认运行时的并行度设置：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: checkout-api
spec:
  template:
    spec:
      containers:
        - name: app
          resources:
            requests:
              cpu: "1"
              memory: "2Gi"
            limits:
              memory: "2Gi"
          env:
            # 用 GOMAXPROCS 或 automaxprocs 显式约束并行度
            - name: GOMAXPROCS
              value: "2"
```

- Go：使用 `automaxprocs`，或在部署时显式设置 `GOMAXPROCS`，不要假设它会自己算对。
- Java：使用 JDK 10+ 并启用容器支持，确认 GC 线程数按 cgroup 限额而不是宿主核数计算。

### 5. 用节点池和 QoS 补上隔离

移除 limit 的前提，是把隔离责任交给更合适的手段：

- 把延迟敏感的在线服务调度到**专用节点池**。
- 用 `taint` / `toleration` 和 `nodeAffinity` 隔开在线与离线负载。
- 对极致的延迟敏感场景，考虑 CPU Manager 的**静态绑核**策略。
- 在较新内核上了解 `cpu.cfs_burst_us`（CFS burst），它允许容器在空闲时透支一部分配额。

## 八、上线前的检查清单

无论最终选择“放宽”还是“保留” CPU limit，都建议按下面的清单走一遍：

- [ ] 已在监控中接入 CFS 节流比例（`throttled_periods / periods`）。
- [ ] 已确认服务的真实 CPU 用量分布，而不是只看平均值。
- [ ] CPU request 设置合理，能支撑调度与保底算力。
- [ ] 已保留 memory limit，并确认它在最坏情况下能保护节点。
- [ ] 已评估移除 CPU limit 后的 QoS 等级变化。
- [ ] 已确认运行时（Go/JVM）不会误判为宿主机全部核心。
- [ ] 已确认同一节点上没有会被“吵闹邻居”拖垮的关键服务。
- [ ] 已检查商业软件的 CPU 授权方式，避免合规成本失控。
- [ ] 已在灰度节点上对比改动前后的 p95/p99/p999 与吞吐。
- [ ] 已准备回滚方案：保留旧的 limit 值，一键恢复。

## 结语：这是一剂猛药，不是一张默认模板

那篇爆款文章的价值，在于它把一个长期被“最佳实践”掩盖的真相摆到台面上：**CPU limit 的底层机制不是限制上限，而是在毫秒级别反复冻结你的进程**。它揭穿了无脑复制粘贴平台默认配置的懒惰。

但它给出的处方是猛药，不是人人都能吃的默认模板。真正成熟的结论是：

> 对延迟敏感的在线服务，放宽甚至移除 CPU limit，用专用节点池和运行时校准来兜底隔离性；对离线任务和容易失控的负载，继续严格设置 CPU limit。

技术原理完全正确，工程落地必须权衡。与其记住“停止设置”，不如记住更本质的一句话：**CPU 是可压缩的，内存不是；隔离要靠规划，不能只靠一行 YAML。**

## 参考资料

1. [Stop Setting Kubernetes CPU Limits (Yes, Really)](https://medium.com/devops-dev/stop-setting-kubernetes-cpu-limits-yes-really-285dbdf8ff51)，DevOps.dev on Medium，本文核心观点与评论区讨论的来源。
2. [Kubernetes 文档：Resource Management for Pods and Containers](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/)
3. [Kubernetes 文档：Pod Quality of Service Classes](https://kubernetes.io/docs/concepts/workloads/pods/pod-qos/)
4. [Linux 内核文档：CFS Bandwidth Control](https://docs.kernel.org/scheduler/sched-bwc.html)
5. [Linux 内核文档：Control Group v2](https://docs.kernel.org/admin-guide/cgroup-v2.html)
