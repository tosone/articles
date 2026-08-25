# Linux 大页不是性能开关：什么时候该用，什么时候该关

<!-- tags: Linux, Memory Management, Huge Pages, Performance -->

Linux 大页经常出现在性能优化建议里：减少页表、提高 TLB 命中率、降低地址翻译成本。这个方向本身没有错，但它很容易被简化成一句危险的话：把 4KB 小页换成 2MB 大页，性能就会变好。

真实情况要克制得多。大页优化的对象不是“所有内存访问”，而是“工作集很大、访问相对连续、生命周期较长”的内存区域。它能减少地址翻译开销，也会改变内存分配粒度、回收行为、NUMA 分布、缺页延迟和系统抖动特征。

这篇文章不把大页写成翻车故事，也不把它写成银弹。重点只回答四个问题：

1. Linux 里的大页到底有哪几类。
2. 哪些业务真的适合大页。
3. 大页会带来哪些限制和副作用。
4. 线上应该怎么验证，而不是凭经验开关。

## 一、先看结论

| 机制     | 常见页大小              | 使用方式                        | 适合场景                                          | 主要风险                                          |
| -------- | ----------------------- | ------------------------------- | ------------------------------------------------- | ------------------------------------------------- |
| 普通页   | 4KB                     | 系统默认                        | Web 服务、微服务、短生命周期对象、小块随机分配    | 页表数量更多，超大工作集下 TLB 压力更高           |
| THP      | 常见 2MB，也可能有 mTHP | 内核自动合并，或 `madvise` 提示 | 大块匿名内存、缓存、部分 JVM/Go/Rust 进程、虚拟机 | 内存压缩、页面合并、单次缺页成本可能带来延迟抖动  |
| HugeTLB  | 2MB / 1GB 等            | 预留大页池，应用显式使用        | 数据库共享内存、DPDK、KVM、HPC、低延迟专用服务    | 需要连续物理内存，不可 swap，预留后普通内存不可用 |
| 1GB 大页 | 1GB                     | 通常启动参数预留                | 超大连续内存、虚拟化宿主机、少数数据库/HPC 场景   | 粒度太粗，NUMA 和容量规划要求更高                 |

一句话判断：

> 如果你的进程长期持有大块连续内存，大页可能值得测试；如果你的负载以小对象、短生命周期、碎片化访问为主，默认 4KB 页通常更稳。

这里还有一个关键边界：Linux 并不是把整个系统的最小内存页直接从 4KB 改成 2MB。普通内存管理仍然以基础页为根基。所谓“用大页”，通常指某些虚拟内存区域由更大的页表项映射，或者应用显式从 HugeTLB 池中申请大页。

## 二、为什么大页有性能收益

CPU 访问内存时使用的是虚拟地址。虚拟地址要转换成物理地址，转换结果会缓存在 TLB 里。TLB 很快，但容量有限。

4KB 页的问题是覆盖范围小。一个 64GB 的进程，如果大量内存都处在活跃工作集里，会对应非常多页表项。TLB 放不下这么多映射，访问过程中就会出现更多 TLB miss。一次 TLB miss 不只是少查了一个缓存，它可能触发多级页表遍历，虚拟化场景下还可能叠加 guest page table 和 host page table 的额外成本。

2MB 大页的优势是覆盖范围大。相同 1GB 内存：

| 页大小 | 覆盖 1GB 需要的页数 |  相对 4KB 页 |
| ------ | ------------------: | -----------: |
| 4KB    |              262144 |         1 倍 |
| 2MB    |                 512 |    少 512 倍 |
| 1GB    |                   1 | 少 262144 倍 |

页数减少后，页表更小，TLB 中每个条目能覆盖更大地址范围。对顺序扫描、大数组计算、数据库 buffer pool、虚拟机内存这类负载来说，这个收益可能非常明显。

但这只解释了大页为什么“可能快”。它没有说明大页为什么“总是快”。页变大以后，系统还要付出另外几类成本。

## 三、Linux 里的三种大页路径

讨论大页前，先把几个名字拆开。

### 1. Transparent Huge Pages

THP 是透明大页。它的目标是让应用不改代码，也能让一部分匿名内存使用大页映射。

常见控制入口：

```bash
cat /sys/kernel/mm/transparent_hugepage/enabled
cat /sys/kernel/mm/transparent_hugepage/defrag
cat /sys/kernel/mm/transparent_hugepage/khugepaged/pages_collapsed
```

常见策略有三种：

```bash
echo always  > /sys/kernel/mm/transparent_hugepage/enabled
echo madvise > /sys/kernel/mm/transparent_hugepage/enabled
echo never   > /sys/kernel/mm/transparent_hugepage/enabled
```

含义大致是：

| 策略      | 含义                           | 适用倾向                               |
| --------- | ------------------------------ | -------------------------------------- |
| `always`  | 内核尽量自动使用 THP           | 吞吐优先、延迟不敏感、已验证收益的机器 |
| `madvise` | 只有应用明确标记的区域使用 THP | 更稳妥的生产默认策略                   |
| `never`   | 普通 THP 路径不主动启用        | 强延迟敏感、曾因 THP 抖动的服务        |

THP 的优点是接入成本低，不需要预留固定大页池。缺点是它可能在缺页、内存压缩、后台合并时引入不可预测延迟。内核里的 `khugepaged` 会扫描可合并区域，把连续小页合并成大页；这个过程对吞吐型负载未必明显，但对 P99/P999 延迟敏感服务就需要谨慎。

### 2. HugeTLB

HugeTLB 是显式大页机制。管理员提前预留一批大页，应用通过 `mmap(MAP_HUGETLB)`、System V shared memory 或 `hugetlbfs` 使用。

查看当前 HugeTLB 池：

```bash
grep -E 'HugePages|Hugepagesize|Hugetlb' /proc/meminfo
ls /sys/kernel/mm/hugepages/
```

临时预留 1024 个默认大小的大页：

```bash
echo 1024 | sudo tee /proc/sys/vm/nr_hugepages
```

如果默认大页大小是 2MB，这表示预留约 2GB 内存给 HugeTLB 池。预留出来的内存不能再被普通页自由使用，也不能在内存紧张时 swap 出去。

生产环境更常用启动参数预留，因为系统启动早期更容易拿到连续物理内存：

```text
default_hugepagesz=2M hugepagesz=2M hugepages=1024
```

对 1GB 大页，则通常需要更严格的启动期规划：

```text
default_hugepagesz=1G hugepagesz=1G hugepages=16
```

HugeTLB 的优点是行为稳定、可预测，适合需要明确控制内存布局的系统。缺点是运维成本高：容量要预留，NUMA 节点要分配，容器权限要配置，预留过多会挤压普通内存。

### 3. mTHP

较新的内核支持 multi-size THP，也就是比 4KB 大、但小于传统 2MB PMD 大页的一组尺寸，例如 16KB、32KB、64KB 等。它试图在两个目标之间折中：

- 比 4KB 减少更多缺页和 TLB 压力。
- 比 2MB 降低单次缺页和内存浪费的幅度。

能否使用 mTHP 取决于内核版本、架构和发行版配置。不要假设所有机器都有同样能力，应该先看实际 sysfs：

```bash
find /sys/kernel/mm/transparent_hugepage -maxdepth 1 -type d -name 'hugepages-*'
```

如果线上内核支持 mTHP，它可能成为比“全开 2MB THP”更温和的选择。

## 四、哪些场景适合大页

### 1. 数据库 buffer pool 或 shared buffer

数据库通常长期持有大块内存，用来缓存数据页、索引页、执行计划或共享状态。这类内存区域生命周期长、大小稳定，访问热点明确，比较容易从大页中获益。

例如 PostgreSQL 支持 `huge_pages` 配置：

```conf
shared_buffers = 16GB
huge_pages = try
```

`try` 的含义比较适合作为初始策略：能用 huge page 就用，不能用也不直接启动失败。等容量、权限、NUMA 和监控都验证稳定后，再考虑是否改成更严格的 `on`。

MySQL/InnoDB、Oracle、ClickHouse、部分列式数据库和分析引擎也有类似需求。它们的共同点不是“数据库”这个标签，而是内存模型：大块、长期、重复访问。

### 2. DPDK 与用户态网络栈

DPDK 是 HugeTLB 的典型用户。它需要大块连续物理内存，配合 DMA、网卡队列和用户态 packet buffer 使用。

一个常见的预留方式是：

```bash
echo 2048 | sudo tee /proc/sys/vm/nr_hugepages
sudo mkdir -p /mnt/huge
sudo mount -t hugetlbfs nodev /mnt/huge
```

这里的关键不是“减少 TLB miss”这么单一，而是 DPDK 的内存管理模型本身就假设应用可以拿到稳定的大页内存。对这类系统来说，大页通常是运行前提，不只是优化项。

### 3. KVM 虚拟机

虚拟化场景下，地址翻译可能经历 guest 虚拟地址、guest 物理地址、host 物理地址等多层转换。宿主机和客户机合理使用大页，可以降低嵌套页表带来的 TLB 压力。

典型收益来自：

- VM 内存长期固定。
- 每台虚拟机有明确内存上限。
- 宿主机可以按 NUMA 节点规划大页池。
- 延迟抖动可通过预分配和绑核进一步控制。

但虚拟化环境也更容易因为规划错误出问题。比如大页全部预留在 node0，而虚拟机 vCPU 主要运行在 node1，内存跨 NUMA 访问反而会抵消收益。

### 4. HPC、向量计算与大数组扫描

科学计算、机器学习预处理、图计算、内存数据库、列式扫描等负载，经常有超大数组或矩阵，访问模式相对规律。此时 TLB miss 可能成为可观察瓶颈，大页能减少页表遍历和地址翻译压力。

这类程序更适合按内存区域显式标记，而不是全局打开：

```c
#define _GNU_SOURCE

#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/mman.h>

int main(void) {
  size_t size = 512UL * 1024 * 1024;
  void *buf = aligned_alloc(2 * 1024 * 1024, size);
  if (buf == NULL) {
    return 1;
  }

  if (madvise(buf, size, MADV_HUGEPAGE) != 0) {
    perror("madvise");
  }

  /* 这里放真正的大块连续访问逻辑。 */

  free(buf);
  return 0;
}
```

这个例子只做一件事：告诉内核“这段区域适合大页”。是否真正分配到 THP，还要看内核配置、内存碎片、对齐和当时的系统压力。

## 五、哪些场景不适合默认打开

### 1. 小对象密集型服务

典型 Web 服务、RPC 服务、API 网关、任务调度器，往往有大量短生命周期对象：请求结构体、临时 buffer、JSON 解析结果、日志字段、链路追踪上下文等。

这些对象本身不一定会直接占用独立 2MB 页，但如果运行时、分配器或 THP 策略让大量稀疏区域被提升为大页，就可能造成内存放大。更常见的问题是延迟抖动：请求路径上触发大页分配、清零、内存压缩，P99 会比平均值更早变差。

这类服务更应该先看：

```bash
perf stat -e dTLB-loads,dTLB-load-misses,iTLB-loads,iTLB-load-misses -- sleep 10
cat /proc/vmstat | grep -E 'thp|compact|pgscan|pgsteal'
```

如果 TLB miss 不是瓶颈，打开大页没有意义。

### 2. 内存紧张或超卖环境

HugeTLB 预留的大页不能像普通页那样灵活回收。机器内存本来就紧张时，预留大页会减少 page cache、匿名内存和其他进程可用空间。

容器环境还要额外注意：

- 容器能否挂载 hugetlbfs。
- cgroup 是否限制 hugepage 使用量。
- Kubernetes 是否配置 hugepages resource。
- Pod 调度是否保证目标节点有足够大页。

不要只在宿主机上看到 `HugePages_Free` 足够，就假设容器内应用一定能使用。

### 3. 强长尾延迟敏感服务

交易、广告竞价、实时推荐、音视频控制面这类系统，通常更关心 P99/P999，而不是平均吞吐。

THP 的后台合并和前台分配都可能影响尾延迟。对这类服务，更稳妥的方式是：

```bash
echo madvise | sudo tee /sys/kernel/mm/transparent_hugepage/enabled
echo never   | sudo tee /sys/kernel/mm/transparent_hugepage/defrag
```

然后只让明确的大块内存区域通过 `madvise(MADV_HUGEPAGE)` 使用 THP。全局 `always` 必须经过压测和灰度验证。

### 4. 频繁 fork 的服务

一些服务会频繁 fork worker、执行外部命令，或者依赖 copy-on-write 行为。大页会改变 COW 的成本形态：写入共享大页中的一小部分数据，可能导致更大的拆分或复制开销。

Redis 社区长期建议关闭 THP，一个重要原因就是后台持久化、fork 和内存延迟容易受到 THP 行为影响。这里的经验不能机械套到所有服务上，但它说明了一点：大页优化必须结合运行时行为，而不是只看常驻内存大小。

## 六、大页的限制要提前算清楚

### 1. 需要连续物理内存

2MB 或 1GB 大页需要对应大小的连续物理内存。系统运行越久，物理内存越碎片化，动态申请大页越容易失败。

所以 HugeTLB 推荐启动期预留：

```text
hugepagesz=2M hugepages=4096
```

运行时再临时调整 `nr_hugepages` 可以用于测试，但不适合作为稳定容量规划的唯一手段。

### 2. 预留内存不可随意借给普通页

HugeTLB 池里的内存是专用资源。预留 8GB 大页，如果应用没有使用，这 8GB 也不会像普通空闲内存那样自然变成 page cache。

因此要监控：

```bash
grep -E 'HugePages_Total|HugePages_Free|HugePages_Rsvd|HugePages_Surp|Hugetlb' /proc/meminfo
```

如果 `HugePages_Free` 长期很高，说明预留过多；如果 `HugePages_Rsvd` 长期接近上限，说明容量可能偏紧。

### 3. NUMA 分布会影响结果

多路服务器上，大页池应该按 NUMA 节点规划。只看全机数量不够，应该看每个 node：

```bash
grep Huge /sys/devices/system/node/node*/meminfo
```

如果应用线程在 node1 上运行，却频繁访问 node0 的大页内存，远端内存访问成本可能抵消 TLB 收益。数据库、DPDK、KVM 这类系统通常要把 CPU 绑定、内存绑定和大页预留一起设计。

### 4. THP 不是完全可预测

THP 的“透明”意味着应用接入简单，也意味着行为不是完全由应用掌控。内核会根据策略、内存状态、对齐情况、碎片程度和后台扫描结果决定是否使用大页。

需要关注的计数包括：

```bash
grep -E 'thp_|compact_' /proc/vmstat
cat /sys/kernel/mm/transparent_hugepage/enabled
cat /sys/kernel/mm/transparent_hugepage/defrag
```

如果压测期间看到 `compact_stall`、`thp_fault_fallback`、`thp_collapse_alloc_failed` 等指标明显上升，要把它们和 P99 延迟放在同一张时间线上看。

### 5. 大页收益需要用业务指标确认

TLB miss 下降不等于业务性能一定提升。正确的验证指标至少包括：

| 维度         | 观察指标                                                     |
| ------------ | ------------------------------------------------------------ |
| CPU 地址翻译 | `dTLB-load-misses`、`iTLB-load-misses`、page walk 相关事件   |
| 内存行为     | RSS、page cache、major/minor fault、swap、NUMA remote access |
| 内核行为     | compaction、khugepaged、direct reclaim、kswapd               |
| 业务效果     | QPS、平均延迟、P95、P99、P999、错误率                        |
| 稳定性       | OOM、分配失败、容器重启、节点不可调度                        |

只拿一个底层指标做结论，很容易把“局部变好”误判成“整体优化”。

## 七、推荐的落地策略

### 1. 默认不要全局 `always`

除非你已经通过压测证明收益明显，否则不要把 THP 全局设置成 `always`。更稳妥的生产起点通常是：

```bash
echo madvise | sudo tee /sys/kernel/mm/transparent_hugepage/enabled
```

让应用或运行时只对关键区域显式申请大页。

### 2. 对专用服务使用 HugeTLB

如果是数据库、DPDK、KVM 这类明确依赖大页的服务，优先用 HugeTLB 做可预期的容量规划：

```bash
grep Hugepagesize /proc/meminfo
echo 4096 | sudo tee /proc/sys/vm/nr_hugepages
```

然后再根据应用要求配置挂载点、权限、NUMA 和容器资源。不要把 HugeTLB 当成“给所有进程自动加速”的系统开关。

### 3. 用灰度验证，而不是一次性改全集群

建议按这个顺序推进：

1. 在单机压测环境采集基线：业务指标、TLB miss、RSS、P99、compaction。
2. 只对一类服务、一组节点修改 THP 或 HugeTLB 策略。
3. 使用同样流量模型跑长时间压测，至少覆盖 GC、fork、持久化、定时任务和峰值流量。
4. 灰度到少量线上节点，观察 P99/P999 与内存水位。
5. 保留一键回滚参数和启动配置。

大页的收益经常不是线性的。小流量压测可能看不出问题，流量上来后才出现内存放大、压缩抖动或 NUMA 远端访问。

### 4. 给不同语言运行时分别判断

| 运行时/系统      | 建议                                                                 |
| ---------------- | -------------------------------------------------------------------- |
| PostgreSQL/MySQL | 优先看官方 huge page 配置，配合 shared buffer/buffer pool 大小规划。 |
| Redis            | 通常谨慎对待 THP，重点观察 fork、持久化和延迟。                      |
| JVM              | 不要只看堆大小，结合 GC、region size、启动参数和容器限制测试。       |
| Go 服务          | 默认先保守，除非 pprof/perf 证明 TLB 或 page walk 是瓶颈。           |
| DPDK             | HugeTLB 通常是基础要求，需要按 NUMA 和网卡拓扑规划。                 |
| KVM              | 大页可能有明显收益，但要和 vCPU 绑核、内存绑定、迁移策略一起看。     |

不同运行时的内存分配器、GC、fork 行为、mmap 策略都不同。不要因为某个数据库收益明显，就把同样参数复制到 API 服务上。

## 八、上线前检查清单

上线大页配置前，至少确认这些问题：

- 业务瓶颈是否真的和 TLB miss 或 page walk 有关。
- 使用的是 THP、HugeTLB、mTHP，还是 1GB huge page。
- 是否需要应用显式 `madvise` 或配置文件支持。
- HugeTLB 预留容量是否会挤压普通内存和 page cache。
- NUMA 节点上的大页数量是否符合进程 CPU 绑定策略。
- 容器、systemd、权限和 cgroup 是否允许使用大页。
- 压测是否覆盖 P99/P999、GC、fork、持久化、冷启动和峰值流量。
- 是否准备了回滚命令、启动参数回滚和监控告警。

可以用一个简单规则收尾：

| 业务特征                         | 建议                          |
| -------------------------------- | ----------------------------- |
| 大块连续内存、长期持有、重复访问 | 测试 THP `madvise` 或 HugeTLB |
| 专用数据库、DPDK、KVM、HPC       | 可以认真规划 HugeTLB          |
| 小对象密集、短请求、延迟敏感     | 默认 4KB 页，谨慎使用 THP     |
| 内存紧张、容器混部、资源超卖     | 不要预留过多 HugeTLB          |
| 只听说“能减少 TLB miss”          | 先测，不要上线改全局          |

## 结论

Linux 大页的价值是真实存在的，但它优化的是一个非常具体的成本：大工作集下的地址翻译和页表管理。它不是替代 4KB 页的通用方案，也不是所有后端服务都应该打开的性能开关。

更准确的理解是：4KB 页提供细粒度、低浪费、好回收的默认平衡；THP 提供低成本试探和按区域优化；HugeTLB 提供可预测的大页池；1GB 大页只适合容量和拓扑都能被严格控制的少数系统。

真正可靠的做法不是问“大页快不快”，而是问：我的工作集是否足够大，访问是否足够集中，生命周期是否足够长，延迟是否能接受，内存是否预留得起。只有这些答案都成立，大页才是优化；否则，它只是把一个局部指标变好，再把系统复杂度转嫁给线上稳定性。
