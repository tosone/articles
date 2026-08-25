# Docker v29 与 Moby v2 重构全解读

## 引子：从 Docker 到 Moby，再到今天的 v2

很多人第一次接触 Docker 的 Go SDK，都会从 `github.com/docker/docker` 开始。这个路径很有历史感：它来自 Docker 早期那个“一切都在一个仓库里”的时代。Docker daemon、Engine API、CLI 相关类型、内部工具包，都曾经挤在同一套代码和同一条 import path 下面。

后来 Docker 生态越来越大，containerd、BuildKit、Compose、Registry、CLI、Engine 逐渐拆成更清晰的组件。2017 年，Docker 把底层开源容器引擎项目整理成 Moby Project：Docker 产品继续面向终端用户，Moby 则作为上游项目，承载容器运行时、镜像、网络、存储等底层能力的开发。

但名字拆开了，Go 代码里的历史路径并没有立刻消失。很多项目仍然通过 `github.com/docker/docker/client`、`github.com/docker/docker/api/types` 调用 Docker Engine。直到 Docker Engine v29，这条旧路径才真正进入收尾阶段：`github.com/docker/docker` 被官方宣布 deprecated，不再继续更新，公共 Go API 改由 `github.com/moby/moby/client` 和 `github.com/moby/moby/api` 承担。

这也是 `github.com/moby/moby/v2` 出现的背景。它不是新的业务 SDK，而是 Moby 仓库根模块的新身份，用于构建 Docker Engine 这类容器引擎。v29 之后，Moby 的 Go module 化、Engine 发布 tag、公共 SDK 拆分、containerd image store 默认启用、nftables 实验支持，都在同一条时间线上发生。

换句话说，Docker v29 不是一次普通版本升级。它更像 Docker 到 Moby 这段多年演进的集中落点：产品叫 Docker，开源上游叫 Moby，而 Go 开发者真正要迁移的，是从旧的 `docker/docker` 历史路径，迁到新的 `moby/moby` 公共模块边界。

## 一、先分清三个版本号

这次变化最容易误解的地方，是 Docker Engine 版本、Moby 根模块版本、公共 Go SDK 版本长得太像，但含义完全不同。

| 你看到的版本                                                         | 它是什么                                                                                                               | 应该怎么用                                             |
| -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `docker-v29.x.x`                                                     | Docker Engine 的软件发布 tag。从 v29 起加 `docker-` 前缀，避免 Go 工具链把 `v29.0.0` 当成 Go module 的第 29 个大版本。 | 给 Engine 用户、发行版维护者和构建流程使用。           |
| `github.com/moby/moby/v2` @ `v2.0.0-beta.N`                          | Moby 仓库根模块，用来构建容器引擎二进制。官方明确说它是内部实现细节，不保证 API 稳定。                                 | 不要在业务代码里 `go get`。除非你在构建自定义 Engine。 |
| `github.com/moby/moby/client`、`github.com/moby/moby/api` @ `v1.x.x` | Docker Engine API 的公共 Go SDK，独立打 tag、独立演进。                                                                | Go 项目迁移时应该使用的模块。                          |

所以，看到 `v2.0.0-beta.N` 这样的根模块版本时，不要把它理解成 Docker Engine 的软件状态。`docker-v29.x.x` 是面向用户的软件版本，`v2.0.0-beta.N` 更像根模块随 Engine 发布滚动的内部坐标。它存在的意义，是让 Moby 这个老仓库正式进入 Go Modules 时代，同时和过去十多年积累的 `v1` 到 `v28` 历史 tag 做一次清晰切割。

**一句话：v29 是 Docker Engine 的分水岭，v2 是 Moby 根模块在 Go 世界里的新身份；真正给应用开发者用的是 `client` 和 `api`。**

## 二、Docker v29 到底改了什么

Docker 官方给 v29 的定位是 _Foundational Updates for the Future_。这个说法很准确：它没有把重点放在炫目的命令行新功能上，而是在补过去多年累积的架构债。

### 1. Moby 全面迁移到 Go Modules

历史上，Moby 是在 Go 生态还没有成熟 module 机制时成长起来的项目，长期背着 legacy vendoring、历史 import path 和大量兼容包。v29 开始，`github.com/docker/docker` 这条老 Go module 路径正式停止更新，公共 API 改由两个新模块承担：

```go
github.com/moby/moby/client
github.com/moby/moby/api
```

这不是简单改名。官方同时把很多“以前能 import、但本质上是内部实现”的包清掉了。过去有些项目会直接拿 `github.com/docker/docker/pkg/...`、`cli/command/...`、`api/pkg/...` 里的工具函数用；到 v29，这类依赖会成片断掉。

### 2. containerd image store 成为新安装默认值

Docker 很早就使用 containerd 运行容器，但镜像层管理长期还保留着 Docker 自己的 graph driver 存储体系。v29 的关键变化是：**新安装的 Docker Engine 默认使用 containerd image store**。

这件事的意义不只是换一个存储目录。containerd 的内容存储和 snapshotter 框架，是 Kubernetes、镜像分发、lazy pulling、远程内容存储、P2P 分发等能力的共同底座。Docker 把镜像存储也迁过去，等于让“容器运行”和“镜像管理”终于回到同一套现代化基础设施上。

但它也带来现实影响：

- 这个默认值只影响新安装；存量 daemon 不会被强制迁移。
- 使用 `userns-remap` 的 daemon 暂时不会默认启用 containerd image store。
- legacy graph driver 仍可用，但已经 deprecated，未来版本会移除。
- 依赖 `/var/lib/docker` 旧目录结构做清理、容量统计、备份或镜像审计的脚本，需要重新验证。
- API 返回也会受影响，例如 `image.InspectResponse.GraphDriver` 在 containerd image backend 下可能被省略。

### 3. 最低 API 版本提升到 1.44

v29 的 daemon 要求客户端 API 版本至少为 `v1.44`，也就是 Docker v25.0+。老客户端连上来会直接报错：

```text
Error response from daemon: client version 1.43 is too old.
Minimum supported API version is 1.44, please upgrade your client to a newer version
```

这条对平台团队影响很大。踩坑对象不一定是人手里的 `docker` 命令，也可能是 Traefik、Portainer、Ansible、CI runner、备份脚本、内部发布系统，或者任何通过 Docker socket 访问 daemon 的老版本工具。

应急手段是放低 daemon 的最小 API 版本，例如启动 `dockerd` 时设置：

```bash
DOCKER_MIN_API_VERSION=1.24 dockerd
```

或者写进 `daemon.json`：

```json
{
  "min-api-version": "1.24"
}
```

但这只能算临时止血。真正应该做的是盘点所有 Docker API 调用方，并升级到理解 API v1.44+ 的版本。

### 4. nftables 进入实验性支持

v29 可以通过 `--firewall-backend=nftables` 启用 nftables 后端。方向很明确：Linux 发行版正在逐步从 iptables 迁移到 nftables，Docker 也在为未来默认切换做准备。

不过它现在仍是实验能力，尤其要注意一个行为差异：使用 nftables 后端时，Docker 不会自动为宿主机打开 IP forwarding。如果 bridge network 需要转发但宿主机没开，daemon 启动或网络创建可能失败。平台侧要自己确认内核参数和防火墙策略，不能照搬 iptables 时代的假设。

### 5. 一批旧能力开始退场

v29 还同时清理了不少历史包袱：

- cgroup v1 deprecated，支持至少延续到 2029 年 5 月，但迁移到 cgroup v2 已经是明确方向。
- Docker Content Trust 从 Docker CLI 中移除，经典 builder 的 DCT 支持也被移除。
- Debian armhf 32 位包改为面向 ARMv7，不再兼容 ARMv6。
- 官方不再提供 Raspbian 32 位包。
- 不再支持加载 Docker 1.10 之前的 legacy image。
- `docker run` / `docker create` 的 `--kernel-memory` 被隐藏并提示不可用。
- `--mount` 的 deprecated `bind-nonrecursive` 选项被移除。
- `docker image ls` 默认展示方式变化，JSON 输出中移除了 `VirtualSize` 字段。

如果你只是本地开发用 Docker，这些变化大概率没什么感觉；如果你维护的是集群节点、CI 基础镜像、镜像扫描系统或自动化运维脚本，就要逐条过一遍。

## 三、不兼容点：升级前应该查什么

可以把 v29 的不兼容分成三类：运行时不兼容、命令行/脚本不兼容、Go SDK 不兼容。

| 类别       | 变化                                                                              | 典型影响                                                              | 处理建议                                                                                    |
| ---------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| API 版本   | daemon 最低 API 提到 `1.44`，客户端不再兼容 API `< 1.44`。                        | 老 Docker CLI、老 SDK、老运维工具无法连接 daemon。                    | 升级调用方；临时用 `DOCKER_MIN_API_VERSION` 或 `min-api-version` 放行。                     |
| 镜像存储   | 新安装默认 containerd image store，legacy graph driver deprecated。               | 基于旧 graph driver 行为的清理、审计、容量统计脚本失效。              | 在测试机确认 `docker info`、`docker system df`、镜像 inspect 和备份流程。                   |
| API 输出   | Engine API 升到 `1.52`，部分字段省略、改名或移除。                                | 解析 JSON 的自动化程序可能拿不到旧字段。                              | 不要依赖空字段存在；对 `GraphDriver`、`VirtualSize`、镜像 inspect 字段做兼容。              |
| CLI JSON   | `docker version --format '{{json .}}'` 在 v29.0.x 出现过字段大小写/时间格式变化。 | Ansible `community.docker`、CI 版本探测脚本可能报 `ApiVersion` 缺失。 | 优先调用 Engine `/version` API；或同时兼容 `ApiVersion` / `APIVersion`。                    |
| 网络防火墙 | nftables 可实验启用，但不会自动打开 IP forwarding。                               | bridge 网络、端口发布、宿主机转发策略可能和 iptables 后端不同。       | 先灰度；显式配置 `net.ipv4.ip_forward`、`net.ipv6.conf.all.forwarding` 和宿主机防火墙边界。 |
| 平台支持   | cgroup v1、ARMv6/Raspbian 32 位、DCT 等能力退场。                                 | 老系统、老设备、老信任链路需要迁移。                                  | 把 OS、内核、发行版包源、签名方案一起纳入升级计划。                                         |

这张表里最值得提前测的是 API 版本和 Go SDK。前者会让系统“连不上”，后者会让项目“编不过”。

## 四、Go SDK：这次不是改两行 import

很多项目过去这样用 Docker SDK：

```go
import "github.com/docker/docker/client"
import "github.com/docker/docker/api/types"
```

v29 之后，第一步确实是换 import path：

```diff
- import "github.com/docker/docker/client"
+ import "github.com/moby/moby/client"

- import "github.com/docker/docker/api/types"
+ import "github.com/moby/moby/api/types"
```

但真正的工作量在后面。v29 对 Go SDK 做的是一次 API 表面重整，核心方向是把“客户端调用参数”收敛到 `client` 包，把“Engine API 数据结构”留在 `api` 包，减少过去 client/server/internal 类型混杂的问题。

### 重点 breaking changes 清单

| 变化方向                    | 典型例子                                                                                                                                                                              | 迁移含义                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| option 类型迁到 `client` 包 | `api/types/image`、`api/types/container`、`api/types/network`、`api/types/swarm`、`api/types/volume` 中大量 `ListOptions`、`InspectOptions`、`CreateOptions`、`PruneOptions` 被移动。 | 调用 client 方法时，优先从 `github.com/moby/moby/client` 找 options/result 类型，不要继续从 `api/types/...` 里找。 |
| 方法参数改为 option struct  | `ImageBuild`、`ImageList`、`ImageRemove`、`ImageTag`、`ImageSearch`、`ConfigCreate`、`ConfigList`、各类 `Prune` 方法。                                                                | 过去的多个位置参数要改成一个 options struct；默认值、空值语义要重新检查。                                          |
| 返回值改为 result struct    | `ImageInspect`、`ImageHistory`、`ImageLoad`、`ImageSave`、`ConfigInspectWithRaw` 等。                                                                                                 | 过去直接接收多个返回值的代码，需要从 result struct 中取字段。                                                      |
| 方法重命名                  | `ContainerExec...` 系列改为 `Exec...`。                                                                                                                                               | 接口抽象、mock、封装层都要同步改名。                                                                               |
| 镜像拉推流式输出变化        | `ImagePull` / `ImagePush` 返回带 `JSONMessages` 方法的对象，提供消息迭代器。                                                                                                          | 旧的 `io.Reader` / `jsonmessage` 处理逻辑需要重写。                                                                |
| filters 换类型              | 客户端使用新的 `client.Filters`，旧 `api/types/filters` 需要迁移。                                                                                                                    | 构造过滤条件的 helper、测试断言、序列化逻辑都要改。                                                                |
| 网络/IP 类型现代化          | IP 地址和子网改为 `netip.Addr` / `netip.Prefix`；MAC 地址字段使用兼容 `net.HardwareAddr` 的 byte slice。                                                                              | 旧代码里把 IP/MAC 当字符串拼接、比较、JSON 断言的地方要重写。                                                      |
| 类型重命名和搬家            | `container.Port` 改为 `PortSummary`；`ErrorResponse` 移到 `common.ErrorResponse`；`api/types/versions` 移到 client/daemon；`StatsResponseReader` 移到 `client`。                      | 编译错误会集中爆发，建议按模块边界逐批迁移。                                                                       |
| deprecated 字段删除         | `image.InspectResponse.VirtualSize`、`ContainerConfig`、`Parent`、`DockerVersion`；`AuthConfig.Email`；`ServiceSpec.Networks` 等。                                                    | 依赖老字段的展示、缓存、兼容层需要替代实现。                                                                       |
| API 版本协商能力减少        | 移除对 API `< 1.44` 的协商支持。                                                                                                                                                      | 想同时兼容很老 daemon 的客户端库，需要保留旧 SDK 分支或做版本矩阵。                                                |
| 内部包清理                  | `pkg/archive`、`pkg/chrootarchive`、`pkg/atomicwriter`、`pkg/reexec`、`pkg/platform`、`pkg/parsers`、`pkg/system.MkdirAll` 等移除。                                                   | 以前“顺手 import Docker 内部工具包”的项目，要改用 `github.com/moby/go-archive`、`github.com/moby/sys` 或标准库。   |

这背后的设计原则可以概括成一句话：**`client` 负责怎么调用，`api` 负责线上协议长什么样，根模块和内部包不要被业务代码消费。**

### 一个更接近真实迁移的例子

旧代码可能长这样：

```go
images, err := cli.ImageList(ctx, types.ImageListOptions{
  All: true,
  Filters: filters.NewArgs(filters.Arg("reference", "alpine")),
})
```

迁移时不要只机械替换 import。你应该按 v29 的包边界重写调用：

```go
var imageFilters client.Filters
imageFilters = imageFilters.Add("reference", "alpine")

images, err := cli.ImageList(ctx, client.ImageListOptions{
  All:     true,
  Filters: imageFilters,
})
```

不同方法的具体签名要以当前 `client` 模块文档为准，但迁移思路是一样的：**先删掉旧 `docker/docker` 依赖，再围绕 `client` 包重建调用层。**

如果项目里 Docker SDK 用得深，最好不要把这件事排成“依赖升级”。更现实的排期是：

1. 先把所有 Docker SDK 调用集中到一层 adapter。
2. 在 adapter 内完成 import path、options、results、filters、streaming output 的迁移。
3. 用集成测试覆盖容器创建、镜像拉取、镜像构建、网络/卷/日志/exec 等真实路径。
4. 保留旧 SDK 分支给还要连 Docker 24 及更早 daemon 的部署环境。

## 五、v2 正在进行的工作

截至写稿时（2026 年 8 月），Docker Engine 29.x 已经走到 `29.7.x`，Moby v2 相关工作还没有结束。它更像一次分阶段搬家：v29 先把地基换掉，后续版本继续补齐迁移工具、实验能力和兼容性修复。

### 1. embedded-containerd 实验

v29.7.0 引入了 experimental `embedded-containerd`：让 containerd 跑在 daemon 进程内部，而不是作为一个独立受管进程。

这件事值得关注，因为它可能进一步简化 Docker Engine 的进程模型和部署模型。过去 Docker daemon 需要管理外部 containerd 进程；如果 embedded-containerd 成熟，单节点安装、升级、故障恢复、日志采集都有机会变得更直接。当然，它目前仍是实验能力，不适合直接当成生产默认值。

### 2. containerd image store 的收尾

containerd image store 已经成为新安装默认值，但生态迁移还在路上。官方仍在推进迁移指南，围绕 `docker system df`、`docker cp`、镜像拉取、snapshot 统计、并发上传下载限制等场景持续修 bug。

这说明 v29 的变化不是“开关一拨就完事”。存储后端切换会影响镜像生命周期里的很多边角：拉取、解包、统计、清理、复制、导出、导入，每一个都要靠 29.x 后续小版本继续打磨。

### 3. nftables 转正

nftables 已经能实验启用，后续重点是补齐行为一致性、发行版兼容性、Swarm/overlay 场景，以及性能优化。iptables 不会立刻消失，但方向已经很清楚：未来 Docker 的 Linux 防火墙后端会越来越靠近 nftables。

平台团队现在可以先做两件事：一是把 iptables 规则审计成可复现的声明式配置；二是在测试节点上启用 nftables 后端，验证 bridge network、published ports、overlay network、firewalld reload、IP forwarding 的组合行为。

### 4. 公共 SDK 的边界继续稳定

`client` 和 `api` 两个公共模块会继续沿 `v1.x` 版本线演进。v29 做了大量破坏性清理，但这次清理的目标不是让下游难受，而是把过去长期暧昧的边界重新画清楚：

- 业务代码不该 import 根模块。
- 业务代码不该依赖 Docker CLI 内部命令实现。
- option/result 类型应该跟 client 方法在一起。
- API types 应该描述线上协议，而不是混进调用端便利函数。

这也是为什么迁移时最容易踩坑的地方，不是 import path，而是过去项目对 Docker 内部包的“隐性借用”。

### 5. deprecated API 按节奏清理

v29 已经移除大量 deprecated API、字段、别名和内部工具函数。后续 29.x 继续修安全问题、升级 BuildKit/containerd/runc，也会继续围绕 deprecated 行为做清理。

所以对下游项目来说，最佳策略不是“等 v2 正式版再动”，而是现在就停止新增 `github.com/docker/docker` 依赖，把 Docker 调用层收口。这样下一轮清理来时，影响面会小很多。

## 六、建议的升级动作

如果你是平台或运维同学，升级 v29 前至少做四件事：

1. 列出所有访问 Docker socket 的组件，确认它们支持 API `1.44+`。
2. 在新安装节点验证 containerd image store，包括镜像拉取、构建、导入导出、清理和容量统计。
3. 检查所有解析 `docker version`、`docker image ls`、`docker inspect` JSON 输出的脚本。
4. 如果准备试 nftables，先在非生产节点验证转发、端口发布、firewalld 和 overlay network。

如果你是 Go 开发者，迁移优先级可以这样排：

1. 移除 `github.com/docker/docker`，改用 `github.com/moby/moby/client` 和 `github.com/moby/moby/api`。
2. 不要引入 `github.com/moby/moby/v2`，除非你是在构建 Engine。
3. 把 Docker SDK 调用集中到 adapter，不要让业务代码到处直接拿 client。
4. 重点处理 options/result structs、filters、streaming output、`netip`、类型搬家和 deprecated 字段删除。
5. 用真实 daemon 跑集成测试，单靠编译通过不够。

## 结语：这不是一次改名，而是一次换家

`github.com/docker/docker` 曾经几乎等同于“Docker 的 Go SDK”。但从 v29 开始，这个历史包袱正式卸下来了。

Docker Engine 继续叫 Docker Engine，Moby 继续是它的上游；只是对 Go 世界来说，边界被重新画了一遍：根模块用于构建引擎，`client` / `api` 才是公共入口。与此同时，镜像存储转向 containerd，网络后端准备转向 nftables，cgroup v1、DCT、legacy graph driver 和一批内部包开始退出舞台。

那个看起来“永久 beta”的 `github.com/moby/moby/v2`，其实不是一个等着你 import 的库。它更像一个路标：Docker 生态正在完成一次十年级别的搬家。

---

**参考资料**

1. Moby 项目 README（Go modules 一节）：https://github.com/moby/moby
2. 官方公告《github.com/docker/docker module deprecation》，moby/moby Discussion #52404：https://github.com/moby/moby/discussions/52404
3. Docker 官方博客《Docker Engine v29: Foundational Updates for the Future》：https://www.docker.com/blog/docker-engine-version-29/
4. Docker Engine v29 Release Notes：https://docs.docker.com/engine/release-notes/29/
5. Moby v29.0.0 Release Notes：https://github.com/moby/moby/releases/tag/docker-v29.0.0
6. Docker CLI `docker version` JSON 输出兼容问题：docker/cli#6647、docker/cli#6649、moby/moby#51487
