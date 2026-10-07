# 现代化 Dockerfile 编写指南

<!-- summary: 现代 Dockerfile 的核心不是“能跑起来”，而是构建速度、攻击面与供应链可追溯性。本文拆解层缓存与缓存挂载的区别、基础镜像选型、多阶段与多 target、非 root 与密钥隔离，以及 OCI 元数据、zstd 压缩和 SBOM。 -->
<!-- tags: Docker, Dockerfile, BuildKit, Distroless, OCI, Container Security, Supply Chain -->

把一个服务容器化，在今天已经没有多少门槛：找一个官方镜像，写几条 `COPY` 和 `RUN`，加一行 `CMD`，镜像就能跑起来。

但“能跑起来”和“能长期维护”是两件完全不同的事。同一个应用，两份 Dockerfile 的体积可能相差十倍，完整构建时间可能相差一个数量级，暴露给攻击者的攻击面也完全不同。真正的差别不在语法，而在几个工程判断：基础镜像选谁、缓存怎么用、产物怎么分层、密钥怎么进、元数据怎么留。

这篇文章按“开发者会踩到什么”来组织，先给结论和对照表，再逐项拆开：

1. 什么算是现代 Dockerfile 的核心特征。
2. 层缓存和缓存挂载到底有什么区别，为什么改了代码也未必会全量重编。
3. 基础镜像应该怎么选，Distroless 的各变体差在哪。
4. 多阶段、多 target、非 root 和构建密钥怎么落地。
5. OCI 元数据、zstd 压缩、provenance / SBOM 在什么场景该开、什么场景该关。
6. Go 项目怎么做到真正的增量构建。

## 一、先看结论

<!-- table-svg: dockerfile-summary-table.svg -->
| 维度         | 传统写法                          | 现代化写法                                      | 需要注意的边界                                   |
| ------------ | --------------------------------- | ----------------------------------------------- | ------------------------------------------------ |
| 基础镜像     | ubuntu / centos / 完整语言镜像    | Distroless、Chainguard、slim、scratch           | 没有 shell 也意味着不能 `docker exec` 进容器排错 |
| 依赖安装     | 每次构建全量下载                  | `--mount=type=cache` 挂载包管理器缓存           | 缓存挂载只在本地有效，CI 需要额外导出            |
| 层结构       | `COPY . .` 之后再统一安装依赖     | 依赖清单先行，构建与运行严格分阶段              | 层缓存失效不等于缓存挂载丢失                     |
| 运行身份     | 默认 root                         | `USER nonroot` 加 `COPY --chown`                | 文件属主不对会在运行时变成权限报错               |
| 构建密钥     | 用 `ENV` 或 `ARG` 传 Token        | `--mount=type=secret` 按次注入                  | secret 不落层，但仍可能被构建日志带出            |
| 镜像元数据   | 基本不写                          | OCI Labels 注入版本、源码坐标和许可证           | 标签应在 CI 动态注入，不要硬编码在 Dockerfile    |
| 分发格式     | 默认 gzip                         | zstd 加 registry 层缓存                         | 压缩级别过高会显著拖慢构建，收益递减             |
| 供应链证明   | 没有                              | provenance / SBOM attestation                   | `--load` 与 attestation 存在兼容问题             |

一句话概括：**现代 Dockerfile 优化的不是某一行的写法，而是构建速度、镜像体积、运行攻击面和供应链可追溯性这四件事。** 它们经常互相拉扯，所以下面每一项都会同时给出代价。

## 二、基础镜像：先决定攻击面，再谈体积

基础镜像的选择决定了三件事：镜像有多大、里面有多少可以被利用的东西、以及你以后能多快地跟进上游安全更新。

过去大家习惯用 `ubuntu`、`centos`，甚至直接用完整的 `node:20`。这类镜像里有 shell、包管理器、`curl`、`wget`、`gcc`，调试很方便，但**攻击者拿到的容器权限也同样是这些工具**：一旦应用被攻破，对方可以 `sh` 进来、下载脚本、横向扫描。Distroless 的思路就是把这条路直接堵死——镜像里只有你的应用和它真正依赖的系统库。

<!-- table-svg: dockerfile-base-image-table.svg -->
| 镜像                              | 包含内容                        | 适用场景                             | 代价与限制                                     |
| --------------------------------- | ------------------------------- | ------------------------------------ | ---------------------------------------------- |
| `scratch`                         | 空镜像，什么都没有              | 完全静态编译的二进制                 | 没有 CA 证书和时区数据，需要自己 `COPY` 进去   |
| `distroless/static`               | CA 证书、时区数据               | 静态二进制，Go / Rust 的常见选择     | 无 shell、无包管理器                           |
| `distroless/base`                 | glibc、ssl 库、CA 证书          | 动态链接应用，且必须使用 glibc       | 排错需要依赖 `debug` 变体                      |
| `distroless/cc`                   | base 加 `libstdc++`             | C++ 应用，或依赖 C++ 运行时          | 体积略大于 base                                |
| `distroless/nodejs` / `java` 等   | base 加对应语言运行时           | Node.js、JVM、Python 应用            | 运行时版本跟随上游节奏，可能滞后               |
| Chainguard Images                 | 按语言持续维护的最小镜像        | 需要快速跟进语言新版本的生产环境     | 强化镜像需要商业订阅（FIPS、SLA）              |
| Debian / Ubuntu `slim`            | 精简发行版，保留包管理器        | 复杂的系统依赖，需要调试工具         | 攻击面仍然明显大于 Distroless                  |
| Alpine                            | musl libc 加 apk                | 体积敏感，且能接受 musl              | musl 兼容性和 DNS 解析行为与 glibc 不同        |

选型时可以按下面的顺序判断：

- **静态编译的语言**（Go 设了 `CGO_ENABLED=0`、Rust 静态链接）：优先 `distroless/static`，需要极致精简就直接 `scratch`。用 `scratch` 时记得补 CA 证书和 `tzdata`，否则 HTTPS 校验和日志时间会出问题。
- **需要 glibc 的动态链接应用**：用 `distroless/base` 或 `distroless/cc`。
- **解释型语言**：用对应的 `distroless/nodejs`、`distroless/java` 等变体，或者 Chainguard 的对应镜像。
- **确实有一堆系统级依赖**：退回 `slim`，但要知道这是在对攻击面做妥协。

这里有一个必须点名的坑：Distroless 每个镜像都提供 `latest` 和 `debug` 两个变体。`debug` 里内置了 busybox，提供了 `sh`、`ls`、`cat` 这些命令。**`debug` 只应该在本地或临时排错时使用，绝不能进生产。** 一旦运行镜像里出现了 shell，Distroless 的安全收益就归零了。

### Chainguard Images：把 Distroless 理念做成可持续维护的产品

Google Distroless 的思路很好，但长期以来有两个现实问题：更新慢、语言版本少，而且一旦线上出问题，没有 shell 就没法排查。**Chainguard Images** 基本可以看作这套理念的现代化、可持续维护版本：底层不再是 Debian，而是专门为容器打造的发行版 **Wolfi OS**。

它主要解决三个矛盾：

1. **既要小，又要 glibc。** Alpine 用 musl libc，体积小，但会让依赖 C 库的语言出现兼容性和 DNS 解析差异；Wolfi 用的是标准 glibc，行为和完整发行版一致，却依然保持极小的体积。
2. **既要安全，又要能更新。** Chainguard 依靠自动化流水线跟随上游重新编译，高危 CVE 通常在小时级别发布修复，而不是等某个发行版的下一个大版本。
3. **既要无 shell，又要能调试。** 每个镜像都提供两个 tag：`latest` 是生产用的无 shell 版本；`latest-dev` 内置了 shell 和包管理器，供本地开发和 CI 构建阶段使用。

<!-- table-svg: dockerfile-base-image-compare-table.svg -->
| 对比维度     | 完整 Debian / Ubuntu | Alpine    | Google Distroless | Chainguard Images    |
| ------------ | -------------------- | --------- | ----------------- | -------------------- |
| 底层 C 库    | glibc                | musl libc | glibc             | glibc（Wolfi OS）    |
| 包含 Shell   | 是                   | 是        | 否                | 否（生产版）         |
| CVE 数量     | 极多                 | 中等      | 少，但修复慢      | 极少，按小时级修复   |
| 语言版本更新 | 慢                   | 中等      | 极慢              | 快，跟随上游每日构建 |
| 调试难度     | 容易                 | 容易      | 难                | 用 `-dev` 变体调试   |
| 镜像体积     | 大                   | 极小      | 小                | 小                   |

落到 Dockerfile 里，典型用法是**构建阶段用 `-dev`，运行阶段切回无 shell 的生产变体**：

```dockerfile
# 构建阶段：-dev 变体带 shell 和工具链
FROM cgr.dev/chainguard/go:latest-dev AS builder
WORKDIR /app
COPY . .
RUN CGO_ENABLED=0 go build -o /out/server ./cmd/server

# 运行阶段：生产变体没有 shell，也没有 go 命令
FROM cgr.dev/chainguard/static:latest
COPY --from=builder /out/server /usr/local/bin/server
USER nonroot
ENTRYPOINT ["/usr/local/bin/server"]
```

需要区分的是它的两种产品形态：

- **Public Images**（`cgr.dev/chainguard/...`）：公开免费，覆盖常用语言和运行时，适合大多数项目和中小企业。
- **Hardened Images**：商业订阅，提供 FIPS 140-3 合规版本、SLA 漏洞修复承诺，以及 VEX 数据，帮助扫描工具过滤“存在漏洞但实际不可利用”的误报。

对国内团队来说，额外要评估的是镜像拉取源和网络可达性。如果内网无法直连 `cgr.dev`，需要先设计方案把镜像同步到自有仓库，再决定是否把它作为默认基础镜像。

## 三、两套缓存机制：先分清层缓存和缓存挂载

这是 Dockerfile 里被误解最多的一点。很多人看到下面这两行，会直觉认为 `COPY . .` 会让 `RUN go build` 的缓存也一起失效：

```dockerfile
COPY . .
RUN --mount=type=cache,target=/root/.cache/go-build \
    go build -o /app/server ./cmd/server
```

代码确实变了，`COPY` 那一层确实失效了，`RUN` 也**确实会重新执行**。但“重新执行”不等于“从零计算”。原因是**层缓存**和**缓存挂载**是两套完全独立的机制。

<!-- table-svg: dockerfile-cache-mechanism-table.svg -->
| 机制                        | 它决定什么                       | 失效或清除条件                 | 典型收益                             |
| --------------------------- | -------------------------------- | ------------------------------ | ------------------------------------ |
| Docker 层缓存               | 命令要不要重新执行               | 该层或任一前置层的输入发生变化 | 依赖清单没变时跳过下载               |
| `--mount=type=cache`        | 命令重跑时能否复用之前的中间结果 | 只有 `docker builder prune` 才清 | 改了代码后仍能增量编译               |
| `--cache-to` / `--cache-from` | 跨机器携带层缓存和挂载缓存     | 缓存后端被清理或过期           | CI 复用上一台机器构建出的结果        |

可以这样类比：层缓存决定的是“今天要不要重新做这顿饭”，缓存挂载决定的是“重新做的时候，冰箱里上次备好的料还在不在”。命令重新执行了，但 `go build` 在产品目录里读到了上次编译好的 `.o` 文件，于是只重新编译被改动的包。

所以正确的心智模型是：

> **层缓存失效 = 命令重新跑一次。**
> **缓存挂载 = 命令重新跑的时候，之前的计算结果还在。**

不同生态的缓存目录不一样，挂载对了才有收益。

<!-- table-svg: dockerfile-cache-targets-table.svg -->
| 语言 / 生态   | 缓存挂载目标                          | 构建命令示例                                |
| ------------- | ------------------------------------- | ------------------------------------------- |
| Go            | `/go/pkg/mod`、`/root/.cache/go-build` | `go build -o /app/server ./cmd/server`      |
| Node.js       | `/root/.npm` 或 `/app/node_modules`   | `npm ci --omit=dev`                         |
| Python        | `/root/.cache/pip`                    | `pip install -r requirements.txt`           |
| Rust          | `/usr/local/cargo/registry`           | `cargo build --release`                     |
| Java (Maven)  | `/root/.m2`                           | `mvn package`                               |
| Java (Gradle) | `/root/.gradle`                       | `gradle build`                              |
| PHP (Composer)| `/root/.composer/cache`               | `composer install --no-dev`                 |

一个完整的依赖安装段落通常长这样：

```dockerfile
# 依赖清单先复制，让这一层尽量稳定
COPY package.json package-lock.json ./

# 缓存挂载让包管理器的下载缓存不随层失效而丢失
RUN --mount=type=cache,target=/root/.npm \
    npm ci --omit=dev
```

## 四、多阶段构建与多 target

多阶段构建解决的是“构建环境不该进运行镜像”这个问题。最终镜像里**不应该出现** `gcc`、`make`、`devDependencies`、`.git` 目录这些只在构建期需要的东西。

一个工业级的 Go 多阶段 Dockerfile 大致是这样：

```dockerfile
# syntax=docker/dockerfile:1

# ==================== 构建阶段 ====================
FROM golang:1.24-alpine AS builder

WORKDIR /app

# 依赖清单先行，利用层缓存
COPY go.mod go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download

# 再复制源码
COPY . .

# 同时挂载模块缓存和编译缓存，才能做到增量编译
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build \
      -trimpath \
      -ldflags="-s -w" \
      -buildvcs=false \
      -o /app/server ./cmd/server

# ==================== 运行阶段 ====================
FROM gcr.io/distroless/static-debian12:nonroot

LABEL org.opencontainers.image.title="my-app"
LABEL org.opencontainers.image.description="Production Go service"

COPY --from=builder /app/server /server

EXPOSE 8080

ENTRYPOINT ["/server"]
```

其中两个编译参数和缓存直接相关，值得单独说明：

- `-buildvcs=false`：Go 1.18 之后默认会把 Git commit 信息嵌进二进制。每次 commit 这个值都会变，于是**即使代码逻辑没变，二进制哈希也会变**，破坏下游缓存判定。
- `-trimpath`：移除编译路径里的绝对路径（比如 CI runner 上的 `/home/runner/work/...`），让构建结果可复现，也更利于缓存命中。

当一个仓库里同时要产出多个镜像（服务端、构建器、CLI 等）时，没必要维护多个 Dockerfile。可以在同一个文件里定义多个阶段，再暴露若干个最终 target：

```dockerfile
# 公共基础阶段
FROM alpine:3.24 AS base
RUN apk add --no-cache ca-certificates tini tzdata

# 编译阶段
FROM golang:1.27-alpine AS builder
WORKDIR /src
COPY . .
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    go build -o /out/app ./cmd/app

# 目标一：运行镜像
FROM base AS app
COPY --from=builder /out/app /usr/local/bin/app
USER 1001:1001
ENTRYPOINT ["tini", "--", "app"]

# 目标二：构建器镜像
FROM base AS app-builder
COPY --from=builder /out/app /usr/local/bin/app
USER 1000:1000
```

构建时用 `--target` 指定要产出哪个：

```bash
docker buildx build --file ./build/Dockerfile --target app \
  --platform linux/amd64,linux/arm64 \
  --load -t registry.example.com/app:latest .

docker buildx build --file ./build/Dockerfile --target app-builder \
  --platform linux/amd64,linux/arm64 \
  --load -t registry.example.com/app-builder:latest .
```

这样做的好处是所有 target 共享同一份基础阶段和编译缓存，改动一次源码，两个镜像都能命中同一份 `GOCACHE`，而不是各编译一遍。

## 五、安全边界：用户、密钥与构建上下文

多阶段解决了“镜像里有什么”，接下来要解决“以什么身份运行”和“密钥怎么进”。

### 1. 非 root 运行

必须显式声明非 root 用户，否则容器默认以 root 启动，一旦逃逸就是宿主机 root。两个细节容易漏：

- 复制文件时用 `--chown` 指定属主，否则运行用户可能没有读写权限。
- 用数字 UID（如 `1001:1001`）而不是用户名，避免不同基础镜像里用户名不一致。

```dockerfile
COPY --from=builder --chown=1001:1001 /app/dist ./dist

USER 1001:1001
```

### 2. 构建期密钥

把 Token 写进 `ENV` 或 `ARG` 是很常见的错误。`ARG` 的值会出现在构建历史里，`ENV` 更是会被永久写进镜像层，任何能拉到镜像的人都能读出来。

正确做法是 secret 挂载，密钥只在当前 `RUN` 指令执行期间以文件形式存在，构建完成即销毁：

```dockerfile
RUN --mount=type=secret,id=npm_token \
    NPM_TOKEN=$(cat /run/secrets/npm_token) npm ci
```

CI 里这样传入：

```bash
docker buildx build --secret id=npm_token,env=NPM_TOKEN -t app:latest .
```

### 3. `.dockerignore`

没有 `.dockerignore` 的 Dockerfile 是不及格的。它同时影响两件事：构建上下文体积，以及哪些文件会被 `COPY . .` 带进镜像。

```text
.git
.gitignore
node_modules
dist
__pycache__
*.pyc
.env
.env.*
*.pem
*.key
.vscode
.idea
.DS_Store
```

其中 `.git` 尤其关键。如果它被 `COPY . .` 带进去，那么**每一次 commit 都会让 COPY 层失效**，之前精心设计的层结构全部白费。

## 六、元数据与分发：标签、压缩与供应链证明

镜像构建完之后，还有三件事决定它在生产环境里好不好管理：元数据、压缩算法和供应链证明。

### 1. OCI Labels

OCI 定义了一套标准的镜像注解。它们的价值不在于好看，而在于当镜像推送到 Harbor、ECR 或 GHCR 之后，平台能直接读出镜像的来源、版本和许可证；出了漏洞时，安全团队可以靠这些标签快速定位受影响的镜像。

<!-- table-svg: dockerfile-oci-labels-table.svg -->
| Label                                       | 含义                    | 建议来源             |
| ------------------------------------------- | ----------------------- | -------------------- |
| `org.opencontainers.image.created`          | 构建时间，RFC 3339 格式 | CI 构建时钟          |
| `org.opencontainers.image.revision`         | 源码 commit SHA         | `git rev-parse HEAD` |
| `org.opencontainers.image.version`          | 业务版本号              | 发布 tag             |
| `org.opencontainers.image.source`           | 源码仓库地址            | 仓库配置             |
| `org.opencontainers.image.url`              | 项目主页或文档          | 仓库配置             |
| `org.opencontainers.image.title`            | 镜像简短名称            | Dockerfile 常量      |
| `org.opencontainers.image.description`      | 镜像详细描述            | Dockerfile 常量      |
| `org.opencontainers.image.licenses`         | 开源许可证，SPDX 标识符 | 仓库配置             |
| `org.opencontainers.image.vendor`           | 构建方或团队名称        | 仓库配置             |
| `org.opencontainers.image.base.name`        | 基础镜像名称            | 构建参数             |
| `org.opencontainers.image.base.digest`      | 基础镜像 digest         | 构建参数             |

时间戳、commit SHA 这类会变的值不要硬编码在 Dockerfile 里，应该在 CI 中动态注入，否则它们会让层缓存失效：

```bash
docker buildx build \
  --label "org.opencontainers.image.created=$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --label "org.opencontainers.image.revision=$(git rev-parse HEAD)" \
  --label "org.opencontainers.image.source=https://github.com/myorg/myapp" \
  -t registry.example.com/myapp:"$TAG" .
```

### 2. 压缩算法与级别

镜像层默认使用 gzip。在拉取带宽和节点冷启动敏感的场景里，换用 zstd 往往更划算：压缩率与 gzip 相当甚至更好，解压速度快得多，节点拉取和启动的耗时随之下降。

```bash
docker buildx build \
  --output type=image,name=registry.example.com/myapp:v1,push=true,compression=zstd,compression-level=9,force-compression=true \
  .
```

几个参数的取舍：

- `compression=zstd`：可选值还有 `gzip`（默认）和 `estargz`（配合 stargz-snapshotter 做按需拉取）。
- `compression-level`：zstd 范围通常是 1 到 22。级别 1 到 3 速度极快但体积偏大；**级别 9 到 12 是工程上最常用的区间**，压缩率和构建 CPU 消耗比较平衡；19 以上体积最小，但构建时间会成倍增加，除非对分发带宽有极苛刻的要求，否则不建议在 CI 里使用。
- `force-compression=true`：强制重新压缩所有层，切换压缩算法时必须加上，否则已缓存的层会沿用旧格式。

### 3. provenance 与 SBOM

从 BuildKit v0.11 起，`buildx` 默认会为镜像附加两类 OCI 证明：

- **provenance（SLSA 溯源证明）**：记录镜像怎么被构建出来的，包括 Git 地址、commit SHA、构建参数、Dockerfile 内容甚至构建机信息，用来防篡改。
- **SBOM（软件物料清单）**：列出镜像里装了哪些依赖和系统组件，用于漏洞爆发时秒级定位受影响范围。

它们在生产发布时非常有价值，但有三种情况应该显式关闭（`--provenance false --sbom false`）：

1. **使用 `--load` 导入本地 Docker daemon 时**。本地 daemon 对带 attestation 的 OCI Image Index 支持很弱，经常直接报 `unexpected media type`，或者只加载多架构里的某一个架构。
2. **流水线里已经有自己的 SBOM 和签名方案时**。如果项目里已经内置了 syft、grype、cosign，再让 BuildKit 自动附加一份，会让 Manifest 结构变复杂，可能干扰自定义签名和扫描逻辑。
3. **镜像仓库或集群比较老旧时**。附加物会把 Manifest 从传统的 `manifest.v2+json` 变成 `oci.image.index.v1+json`，老版本 Harbor、Nexus 或 kubelet 可能解析不了。

一句话原则：**本地调试和中间测试关掉，生产发布打开。**

### 4. 跨机器缓存

`--mount=type=cache` 只在单机有效。CI 每次可能落在不同机器上，需要把缓存也一起带着走：

```bash
docker buildx build \
  --cache-from type=registry,ref=registry.example.com/myapp:buildcache \
  --cache-to   type=registry,ref=registry.example.com/myapp:buildcache,mode=max \
  --output type=image,name=registry.example.com/myapp:latest,push=true,compression=zstd,compression-level=9 \
  .
```

`mode=max` 会缓存**所有中间层**，而不只是最终层。对多阶段构建和增量编译来说，这个参数很关键；只用默认的 `mode=min`，很多编译缓存不会被导出。用 GitHub Actions 时也可以直接把 `type=gha` 当作缓存后端，不必自建 registry 缓存。

## 七、Go 项目的增量构建

把前面几节的结论落到 Go 项目上，增量构建依赖的是**两个缓存目录同时被挂载**：

- `GOMODCACHE`（`/go/pkg/mod`）：第三方依赖的源码。
- `GOCACHE`（`/root/.cache/go-build`）：**编译中间产物**，也就是决定能否增量编译的关键。

很多人只挂载了 `/go/pkg/mod`，于是依赖不用重新下载了，但代码一改仍然全量重编。原因是 `GOCACHE` 没被保留，编译器和在一台全新机器上工作没有区别。

<!-- table-svg: dockerfile-incremental-table.svg -->
| 场景             | 无缓存挂载                  | 有缓存挂载                          |
| ---------------- | --------------------------- | ----------------------------------- |
| 首次构建         | 全量编译，约 120s           | 全量编译，约 120s                   |
| 改一行业务代码   | 全量重编，约 120s           | 增量编译，约 8 到 15s               |
| 只新增一个依赖   | 重新下载加全量重编          | 只下载新依赖，其余增量编译          |
| 源码完全未变     | 全量重编                    | 全部命中，通常数秒内完成            |

可以用 `go build -v` 直接观察命中情况：第一次构建会列出所有包，第二次只改一个文件时，输出里只会出现那个包和入口包的重新编译记录。

把这几条串起来，Go 增量构建的公式是：

```text
正确的层顺序（go.mod / go.sum 先行）
  + 挂载 GOMODCACHE（/go/pkg/mod）
  + 挂载 GOCACHE（/root/.cache/go-build）   ← 最关键
  + -buildvcs=false（避免 VCS 信息破坏缓存）
  + CI 中 --cache-to / --cache-from（跨机器持久化）
```

## 八、迁移与落地清单

如果你手上已经有一批 Dockerfile，不需要一次性重写。建议按下面的顺序逐项检查，每改一项都记录构建时间和镜像体积的变化：

- [ ] 基础镜像已从完整发行版换成 Distroless / Chainguard / slim。
- [ ] 使用 Chainguard 时，构建阶段用 `-dev` 变体，运行阶段切回无 shell 的生产变体。
- [ ] 运行镜像里没有 shell，没有 `debug` 变体。
- [ ] 依赖清单在源码之前复制，层结构稳定。
- [ ] 依赖安装和编译都挂载了对应的缓存目录。
- [ ] Go 项目同时挂载了 `/go/pkg/mod` 和 `/root/.cache/go-build`。
- [ ] 编译参数包含 `-trimpath` 和 `-buildvcs=false`。
- [ ] `COPY --chown` 与 `USER` 的 UID 一致，运行用户是非 root。
- [ ] 构建密钥走 `--mount=type=secret`，没有出现在 `ENV` 或 `ARG`。
- [ ] `.dockerignore` 至少排除了 `.git`、`node_modules`、`.env`。
- [ ] 镜像带有 OCI Labels，且时间戳和 commit SHA 由 CI 注入。
- [ ] 镜像分发启用了 zstd，压缩级别在 9 到 12 之间。
- [ ] 生产发布保留 provenance 和 SBOM；本地 `--load` 时显式关闭。
- [ ] CI 配置了 `--cache-to type=registry,mode=max` 并验证过二次构建加速。
- [ ] 多镜像仓库已合并到单个 Dockerfile 的多 target，没有重复维护基础层。

## 结语：Dockerfile 是一份构建契约

Dockerfile 看起来只是一串指令，实际上它是一份**构建契约**：它对构建速度、镜像体积、运行权限和供应链信息做出了承诺。传统写法把这份契约写得含糊，于是每次构建都在重来一遍，每个镜像都带着一堆用不到的工具，每个发布产物都无法追溯到源码。

现代化不是在语法上加了什么，而是把四个问题回答清楚：

> 镜像里有什么？以什么身份运行？构建一次要多久？出了漏洞时，我怎么定位到它？

用这四个问题去审一份 Dockerfile，比记住任何一条“最佳实践”都更有用。
