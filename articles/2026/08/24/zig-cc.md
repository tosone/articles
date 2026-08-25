# 用一套 Zig 搞定 Rust 与 Go 的 C/C++ 交叉编译

<!-- tags: Zig, Rust, Go, Cross Compilation, C/C++ -->

Rust 和 Go 本身都擅长交叉编译，但一旦项目引入 C/C++ 依赖，编译器、链接器、libc 和目标架构就会让构建迅速复杂化。Zig 可以作为两者共用的 C/C++ 工具链，用一套环境覆盖常见 Linux 架构与 libc 目标。

纯 Rust 项目通常只要安装目标标准库，再指定 `--target`；纯 Go 项目通常只要设置 `GOOS` 和 `GOARCH`。真正让事情复杂起来的，往往不是 Rust 或 Go 本身，而是依赖树里突然出现的 C 和 C++：

- Rust crate 的 `build.rs` 调用了 `cc`、CMake 或 `pkg-config`。
- Go 包通过 cgo 编译 `.c`、`.cc`、`.cpp` 文件。
- SQLite、OpenSSL、zstd、libgit2、FFmpeg 等依赖需要目标平台的头文件和库。
- 最终链接器必须理解目标架构、目标 libc、启动对象和动态加载器。

传统做法是为每个目标安装一套交叉工具链：

```text
x86_64-linux-gnu-gcc
aarch64-linux-gnu-gcc
x86_64-linux-musl-gcc
aarch64-linux-musl-gcc
...
```

目标一多，CI 很快就变成工具链、sysroot、头文件和库版本的组合管理。

Zig 提供了另一条路：把 `zig cc` 和 `zig c++` 当成兼容 Clang 命令行的 C/C++ 驱动，通过 `-target` 在同一套安装中切换架构、操作系统和 libc。Rust 侧有 `cargo-zigbuild` 帮忙接入 Cargo；Go 侧则可以直接把它交给 `CC` 和 `CXX`。

这篇文章不介绍 Rust、Go 的安装，重点只讲一件事：**Zig 如何成为两套语言工具链共用的 C/C++ 交叉编译层。**

## 一、先看结论

| 场景               | 不使用 Zig                                     | 使用 Zig                                        | 仍然需要自己准备什么                                                 |
| ------------------ | ---------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------- |
| 纯 Rust            | `rustup` 目标标准库，部分目标还要外部 linker。 | `cargo zigbuild --target ...`。                 | Rust 目标标准库。                                                    |
| Rust + C/C++ crate | 目标 GCC/Clang、sysroot、C/C++ 运行库。        | `cargo-zigbuild` 注入 Zig linker 和编译器包装。 | 第三方库、非系统头文件，部分场景还要 `bindgen` 的宿主机 `libclang`。 |
| 纯 Go              | `GOOS`、`GOARCH` 通常已经够用。                | 通常没必要使用 Zig。                            | 无。                                                                 |
| Go + cgo           | 目标 C/C++ 编译器、libc、外部 linker。         | `CC="zig cc -target ..."`，必要时再设置 `CXX`。 | 第三方目标库、头文件、正确的 `pkg-config` 配置。                     |
| Linux glibc 兼容   | 在老发行版或对应 sysroot 中构建。              | 目标名可声明 glibc 版本下限。                   | 在真实旧系统上验证。                                                 |
| Linux 静态发布     | 单独安装 musl 工具链。                         | 选择 `*-linux-musl` 并走外部静态链接。          | 确认所有原生依赖都能静态链接。                                       |

最重要的判断是：

> Zig 解决的是“谁来编译和链接目标 C/C++ 代码”，不是“自动变出所有目标平台依赖”。

如果项目只依赖 Zig 自带支持的 libc 和自己仓库里的 C/C++ 源码，体验通常很好；如果项目依赖目标平台预装的动态库、专有 SDK 或复杂 `pkg-config` 环境，仍然要准备对应的头文件和目标库。

## 二、为什么跨语言构建总会卡在 C/C++

Rust 编译器本身能够为很多 target triple 生成目标机器码，Go 编译器也能够根据 `GOOS/GOARCH` 生成目标代码。但一个完整二进制不只有语言自己的对象文件。

以 `aarch64-unknown-linux-gnu` 为例，构建过程至少涉及：

1. Rust 或 Go 为 AArch64 生成对象文件。
2. 原生依赖中的 C/C++ 源码也要编译成 AArch64 对象文件。
3. 链接器要理解 AArch64 ELF。
4. 链接过程要找到正确的 libc、启动对象和其他目标库。
5. 最终二进制引用的 glibc 符号版本不能高于部署环境。

很多“Rust 交叉编译失败”或“Go 交叉编译失败”，本质上是第二步到第五步失败：

```text
linker `cc` not found
file in wrong format
cannot find -lssl
fatal error: sqlite3.h: No such file or directory
GLIBC_2.38 not found
```

这里需要区分三个概念：

| 概念                   | 负责什么                               | Zig 能否直接提供                         |
| ---------------------- | -------------------------------------- | ---------------------------------------- |
| 编译器与 linker driver | 编译 C/C++，组织链接参数，调用链接器。 | 能，使用 `zig cc` / `zig c++`。          |
| libc 与基础 sysroot    | libc 头文件、ABI 信息、启动对象。      | 对 Zig 支持的常见目标可以提供或生成。    |
| 第三方原生依赖         | OpenSSL、SQLite、CUDA、厂商 SDK 等。   | 通常不能，需要源码交叉编译或准备目标库。 |

Zig 的价值，是把前两项尽量收进一套可移植工具链，并把目标选择压缩为一个参数。

## 三、先认识 `zig cc` 与目标三元组

本文不展开 Rust 和 Go 的安装。Zig 只要确保 `zig` 位于 `PATH` 即可；macOS 可以通过 Homebrew 安装：

```bash
brew install zig
zig version
```

Linux 和 Windows 可以使用 Zig 官网提供的归档包，CI 中建议下载并校验固定版本，而不是始终追踪 master 构建。

`zig cc` 和 `zig c++` 可以像 `clang`、`clang++` 一样使用：

```bash
zig cc hello.c -o hello
zig c++ hello.cpp -o hello-cpp
```

交叉编译时增加 `-target`：

```bash
zig cc -target aarch64-linux-gnu hello.c -o hello-linux-arm64
zig cc -target x86_64-linux-musl hello.c -o hello-linux-amd64-static
zig c++ -target aarch64-linux-musl hello.cpp -o hello-cpp-linux-arm64
```

Zig target 与 Rust target、Go target 的拼写并不完全相同：

| 目标                   | Zig                  | Rust                         | Go                          |
| ---------------------- | -------------------- | ---------------------------- | --------------------------- |
| Linux x86-64 + glibc   | `x86_64-linux-gnu`   | `x86_64-unknown-linux-gnu`   | `GOOS=linux GOARCH=amd64`   |
| Linux ARM64 + glibc    | `aarch64-linux-gnu`  | `aarch64-unknown-linux-gnu`  | `GOOS=linux GOARCH=arm64`   |
| Linux x86-64 + musl    | `x86_64-linux-musl`  | `x86_64-unknown-linux-musl`  | `GOOS=linux GOARCH=amd64`   |
| Linux ARM64 + musl     | `aarch64-linux-musl` | `aarch64-unknown-linux-musl` | `GOOS=linux GOARCH=arm64`   |
| Windows x86-64 GNU ABI | `x86_64-windows-gnu` | `x86_64-pc-windows-gnu`      | `GOOS=windows GOARCH=amd64` |
| macOS ARM64            | `aarch64-macos`      | `aarch64-apple-darwin`       | `GOOS=darwin GOARCH=arm64`  |

这张映射表很重要。Rust 的 vendor 字段、Go 的 `amd64` 命名和 Zig 的目标写法不同，不能把同一个字符串机械复制到三边。

### glibc 版本下限

Linux 动态链接最常见的问题不是 CPU 架构，而是 glibc 版本。

在 Ubuntu 24.04 上直接构建的程序，可能引用 `GLIBC_2.39`；复制到旧发行版后，即使架构一致，也会启动失败。Zig 可以在目标中声明最低 glibc 版本：

```bash
zig cc -target x86_64-linux-gnu.2.17 hello.c -o hello
zig cc -target aarch64-linux-gnu.2.28 hello.c -o hello-arm64
```

这表示最终程序依赖相应版本或更高版本的 glibc。它非常适合统一 CI 的 Linux 兼容基线。

但不要把它理解成完整的老发行版容器。Zig 使用的是用于编译和链接的头文件、ABI 数据与 stub library；部署时真正执行代码的仍然是目标机 glibc。构建完成后仍要在最低支持版本上运行测试。

### glibc 与 musl 怎么选

| 选择               | 优点                                                  | 代价                                                    |
| ------------------ | ----------------------------------------------------- | ------------------------------------------------------- |
| `*-linux-gnu.2.17` | 对传统 Linux 软件生态兼容更好，动态库更常见。         | 运行时依赖目标机 glibc，不能把“指定版本”当成完全静态。  |
| `*-linux-musl`     | 容易生成自包含静态二进制，适合 `scratch` 或极简容器。 | DNS、locale、动态加载、部分 C 库兼容行为与 glibc 不同。 |

如果原生依赖复杂，优先考虑 glibc；如果依赖简单、目标是单文件部署，再考虑 musl 静态链接。

## 四、Rust：用 `cargo-zigbuild` 接管链接器

`cargo-zigbuild` 的定位很直接：它是 Cargo 的子命令，负责为目标构建配置 Zig linker，并为常见原生构建过程准备包装器。

安装方式：

```bash
cargo install --locked cargo-zigbuild
```

Rust 目标标准库仍然要存在。例如：

```bash
rustup target add x86_64-unknown-linux-gnu
rustup target add aarch64-unknown-linux-gnu
rustup target add x86_64-unknown-linux-musl
rustup target add aarch64-unknown-linux-musl
```

然后把 `cargo build` 换成 `cargo zigbuild`：

```bash
cargo zigbuild --release --target x86_64-unknown-linux-gnu
cargo zigbuild --release --target aarch64-unknown-linux-gnu
```

如果需要固定 glibc 下限，把版本追加到 target 后面：

```bash
cargo zigbuild --release \
  --target x86_64-unknown-linux-gnu.2.17

cargo zigbuild --release \
  --target aarch64-unknown-linux-gnu.2.17
```

这里有一个容易忽略的细节：`x86_64-unknown-linux-gnu.2.17` 是 `cargo-zigbuild` 扩展出来的构建参数，不是普通 `rustc` target 名。产物目录仍然是：

```text
target/x86_64-unknown-linux-gnu/release/
```

### Rust + C 源码

假设 crate 里有一个简单的 C 文件：

```c
// native/checksum.c
#include <stdint.h>
#include <stddef.h>

uint32_t checksum(const uint8_t *data, size_t len) {
  uint32_t value = 0;
  for (size_t i = 0; i < len; i++) {
    value = value * 33 + data[i];
  }
  return value;
}
```

`build.rs` 使用 `cc` crate：

```rust
fn main() {
  println!("cargo:rerun-if-changed=native/checksum.c");

  cc::Build::new()
    .file("native/checksum.c")
    .compile("checksum");
}
```

普通交叉编译时，`cc` crate 需要找到对应目标的 C 编译器。使用 `cargo-zigbuild` 后，构建过程可以通过它生成的 Zig wrapper 编译目标 C 代码，再由 Zig 完成最终链接：

```bash
cargo zigbuild --release \
  --target aarch64-unknown-linux-gnu.2.17
```

这正是 `cargo-zigbuild` 比手写一组 Cargo linker 配置更有价值的地方：它处理的不只是最后一次链接，还要让常见的 `build.rs` 原生编译步骤看到正确工具。

### Rust + bindgen

`bindgen` 比 `cc` 多一层：它在构建机上运行 `libclang` 解析头文件，但解析的内容属于目标平台。

典型做法是在 `build.rs` 中把 Cargo 提供的 `TARGET` 传给 bindgen：

```rust
use std::{env, path::PathBuf};

fn main() {
  let target = env::var("TARGET").unwrap();
  let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());

  println!("cargo:rerun-if-changed=native/checksum.h");

  let bindings = bindgen::Builder::default()
    .header("native/checksum.h")
    .clang_arg(format!("--target={target}"))
    .generate()
    .expect("generate bindings");

  bindings
    .write_to_file(out_dir.join("bindings.rs"))
    .expect("write bindings");
}
```

这里 Zig 并不会替代宿主机上的 `libclang`。特别是较新的 Zig 携带较新的 libc++ 头文件时，旧版 `libclang` 可能无法解析；遇到 bindgen 报 C++ 头文件语法错误时，应先检查 `libclang` 版本，而不是只检查 linker。

### Rust 静态 musl 构建

对于依赖可静态链接的项目，可以直接选择 musl target：

```bash
cargo zigbuild --release \
  --target x86_64-unknown-linux-musl

cargo zigbuild --release \
  --target aarch64-unknown-linux-musl
```

不要对 glibc target 强行设置：

```text
-C target-feature=+crt-static
```

`cargo-zigbuild` 官方明确提示，Zig 上游目前不支持以这种方式静态链接指定 glibc 版本。需要单文件静态产物时，应优先使用 musl target。

### Rust 最容易踩的三个坑

第一，忘记传 `--target`。没有 target 时，`cargo zigbuild` 实际上会退化成普通 `cargo build`，Zig 不会参与。

第二，在 `RUSTFLAGS` 里再次设置 `-C linker=...`。这会覆盖 `cargo-zigbuild` 注入的 linker，让 Zig 失效。

第三，把宿主机 `/usr/include`、`/usr/lib64` 不加区分地塞给目标构建。这样很容易混入宿主机 glibc 头文件或错误架构的库。额外头文件和库必须确认属于目标平台：

```bash
CFLAGS="-isystem /opt/sysroots/aarch64/include" \
RUSTFLAGS="-L /opt/sysroots/aarch64/lib" \
cargo zigbuild --release \
  --target aarch64-unknown-linux-gnu.2.17
```

## 五、Go：把 Zig 交给 cgo

纯 Go 项目不需要 Zig：

```bash
CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build ./cmd/app
```

只有依赖 cgo 时，Go 才需要目标 C 工具链。Go 官方提供了三个关键入口：

- `CGO_ENABLED=1`：交叉编译时显式开启 cgo。
- `CC`：编译 C 文件并参与外部链接。
- `CXX`：编译 `.cc`、`.cpp`、`.cxx` 文件。

`CC` 和 `CXX` 的值可以包含命令行参数，因此可以直接写 Zig target。

### Linux amd64 + glibc 2.17

```bash
CGO_ENABLED=1 \
GOOS=linux \
GOARCH=amd64 \
CC="zig cc -target x86_64-linux-gnu.2.17" \
CXX="zig c++ -target x86_64-linux-gnu.2.17" \
go build -trimpath -o dist/app-linux-amd64 ./cmd/app
```

### Linux arm64 + glibc 2.17

```bash
CGO_ENABLED=1 \
GOOS=linux \
GOARCH=arm64 \
CC="zig cc -target aarch64-linux-gnu.2.17" \
CXX="zig c++ -target aarch64-linux-gnu.2.17" \
go build -trimpath -o dist/app-linux-arm64 ./cmd/app
```

这时 Go 编译器生成目标 Go 对象，cgo 生成桥接代码，Zig 负责编译其中的 C/C++ 部分并完成目标链接。

### Linux + musl 静态链接

amd64：

```bash
CGO_ENABLED=1 \
GOOS=linux \
GOARCH=amd64 \
CC="zig cc -target x86_64-linux-musl" \
CXX="zig c++ -target x86_64-linux-musl" \
go build \
  -trimpath \
  -ldflags="-linkmode external -extldflags -static" \
  -o dist/app-linux-amd64 \
  ./cmd/app
```

arm64：

```bash
CGO_ENABLED=1 \
GOOS=linux \
GOARCH=arm64 \
CC="zig cc -target aarch64-linux-musl" \
CXX="zig c++ -target aarch64-linux-musl" \
go build \
  -trimpath \
  -ldflags="-linkmode external -extldflags -static" \
  -o dist/app-linux-arm64 \
  ./cmd/app
```

这里显式指定 `-linkmode external`，因为最终链接必须交给 Zig；`-extldflags -static` 则要求外部 linker 生成静态产物。

### 一个最小 cgo 例子

Go 文件可以直接在 cgo preamble 中声明 C 函数：

```go
package checksum

/*
#include <stdint.h>
#include <stddef.h>

static uint32_t checksum(const uint8_t *data, size_t len) {
  uint32_t value = 0;
  for (size_t i = 0; i < len; i++) {
    value = value * 33 + data[i];
  }
  return value;
}
*/
import "C"

import "unsafe"

func Sum(data []byte) uint32 {
  if len(data) == 0 {
    return 0
  }

  return uint32(C.checksum(
    (*C.uint8_t)(unsafe.Pointer(&data[0])),
    C.size_t(len(data)),
  ))
}
```

也可以把 C 文件放在同一个 package 目录。Go 工具会自动处理该目录中的 `.c` 文件；如果出现 `.cc`、`.cpp` 或 `.cxx`，则会使用 `CXX`。

### Go 调用 C++ 时别直接暴露 C++ ABI

cgo 面向 C ABI，不能直接把模板、重载、类、异常等 C++ 接口映射给 Go。更稳妥的方式是写一层窄的 `extern "C"` 包装：

```cpp
// engine.cpp
#include "engine.hpp"

extern "C" int engine_score(const char *input) {
  try {
    return Engine{}.score(input);
  } catch (...) {
    return -1;
  }
}
```

对应头文件只暴露 C ABI：

```c
// engine.h
#pragma once

#ifdef __cplusplus
extern "C" {
#endif

int engine_score(const char *input);

#ifdef __cplusplus
}
#endif
```

Go 侧只 include `engine.h`。异常、对象生命周期和 C++ 标准库类型都留在包装层内部。

项目还需要链接 C++ runtime。具体参数取决于目标和依赖使用的 ABI；Zig 默认更接近 LLVM/libc++ 体系时，常见做法是通过 cgo linker flags 加入 `-lc++`，但已有预编译库如果使用 libstdc++，就必须保持 ABI 一致，不能盲目替换。

## 六、把命令收敛成可维护的构建矩阵

手敲命令适合验证，发布流程应该把“语言目标”和“Zig 目标”显式映射起来。

一个简单的 shell 函数可以这样写：

```bash
build_go() {
  goarch="$1"

  case "$goarch" in
  amd64) zig_target="x86_64-linux-musl" ;;
  arm64) zig_target="aarch64-linux-musl" ;;
  *) echo "unsupported GOARCH: $goarch" >&2; return 1 ;;
  esac

  CGO_ENABLED=1 \
  GOOS=linux \
  GOARCH="$goarch" \
  CC="zig cc -target $zig_target" \
  CXX="zig c++ -target $zig_target" \
  go build \
  -trimpath \
  -ldflags="-s -w -linkmode external -extldflags -static" \
  -o "dist/app-linux-$goarch" \
  ./cmd/app
}

build_go amd64
build_go arm64
```

Rust 也可以固定成相同的发布矩阵：

```bash
cargo zigbuild --release \
  --target x86_64-unknown-linux-gnu.2.17

cargo zigbuild --release \
  --target aarch64-unknown-linux-gnu.2.17
```

建议同时固定以下版本：

```text
Zig version
cargo-zigbuild version
Rust toolchain
Go toolchain
target libc baseline
```

Zig 仍在 1.0 之前，版本间可能调整 target 支持、libc 数据、Clang 参数和 linker 行为。CI 中不要只写“安装最新版”，而应把 Zig 与 `cargo-zigbuild` 版本作为构建输入管理。

## 七、Zig 不能替你解决什么

### 1. 第三方动态库不会凭空出现

如果代码写了：

```text
-lsqlite3
-lssl
-lavcodec
```

Zig 仍然需要找到目标架构、目标 ABI 对应的库。宿主机上的 `/usr/lib/libssl.so` 不能拿去链接 ARM64 产物。

处理方式通常有三种：

1. 尽量从源码随项目一起交叉编译。
2. 准备按 target 隔离的 sysroot。
3. 在对应目标容器或 runner 中完成最后构建。

### 2. `pkg-config` 默认看到的是宿主机

很多 `-sys` crate 或 cgo 包会调用 `pkg-config`。默认 `pkg-config` 查询宿主机目录，交叉编译时很容易返回错误架构的 `-I` 和 `-L`。

要么让依赖 vendored 构建，要么为目标设置：

```bash
PKG_CONFIG_SYSROOT_DIR=/opt/sysroots/aarch64 \
PKG_CONFIG_LIBDIR=/opt/sysroots/aarch64/usr/lib/pkgconfig \
...
```

关键不是让 `pkg-config` “能找到库”，而是让它只能找到目标库。

### 3. macOS 仍然需要合法 SDK

Zig 可以生成 Mach-O、调用 linker，但 macOS 系统头文件和 framework 来自 Apple SDK。跨主机编译 macOS 目标时，仍然需要设置 `SDKROOT`，并遵守 Apple SDK 的许可边界。

`cargo-zigbuild` 对 Apple target 提供了支持和专用镜像，但这不意味着任意 Zig 安装都内置完整 macOS SDK。

### 4. Windows 要区分 GNU 与 MSVC ABI

`x86_64-windows-gnu` 不等于 `x86_64-pc-windows-msvc`。如果依赖只提供 MSVC `.lib`、使用特定 MSVC C++ ABI，切到 Zig 的 GNU target 并不能自动兼容。

跨 Windows 构建前要先确认依赖是 C ABI、GNU ABI，还是 MSVC ABI。

### 5. 交叉编译成功不等于目标运行正确

编译阶段无法替代目标环境测试。DNS、证书路径、动态加载器、CPU 特性、线程、locale、文件系统和系统调用都可能只在运行时暴露问题。

## 八、构建完成后怎么验证

第一步，检查文件格式和架构：

```bash
file dist/app-linux-amd64
file dist/app-linux-arm64
```

第二步，检查动态依赖：

```bash
readelf -l dist/app-linux-amd64
readelf -d dist/app-linux-amd64
```

静态 musl 产物通常不应再依赖目标机动态加载器。glibc 动态产物则要确认 interpreter 和 `NEEDED` 条目符合预期。

第三步，检查 glibc 符号版本：

```bash
readelf --version-info dist/app-linux-amd64 |
  grep -o 'GLIBC_[0-9.]*' |
  sort -Vu |
  tail -n 1
```

第四步，在目标架构和最低系统版本上运行：

```bash
docker run --rm \
  --platform linux/amd64 \
  -v "$PWD/dist:/dist:ro" \
  debian:bookworm-slim \
  /dist/app-linux-amd64
```

如果支持基线是更老的 glibc，就应该使用相应发行版镜像或真实环境验证。只在最新 Ubuntu 上执行一次，无法证明 `gnu.2.17` 的兼容承诺。

第五步，检查依赖功能，而不只是 `--version`：

- SQLite 是否真的能创建和查询数据库。
- OpenSSL/TLS 是否能加载证书并建立连接。
- C++ 异常是否被包装层截获。
- DNS、时区、locale 是否符合部署环境。
- 多线程和信号处理是否正常。

## 九、什么时候应该用 Zig，什么时候不该用

适合 Zig 的场景：

- macOS 或 Linux CI 要同时产出 Linux amd64、arm64。
- Rust 依赖少量通过 `cc` crate 编译的 C/C++ 源码。
- Go 项目启用了 cgo，但原生代码可以随源码编译。
- 需要明确控制 Linux glibc 最低版本。
- 希望用 musl 生成静态命令行工具或容器入口。
- 不想维护多套 `gcc-<target>` 包和 sysroot。

不适合只靠 Zig 的场景：

- 强依赖 CUDA、复杂图形栈或厂商专有 SDK。
- 依赖大量仅提供预编译二进制的 C++ 库。
- 需要严格匹配 MSVC C++ ABI。
- 需要 Apple framework，但构建环境没有合规 SDK。
- 发布前没有任何目标环境运行测试。

这时更稳妥的方案可能是目标原生 runner、Docker/QEMU、`cross`、Nix、crosstool-ng，或者针对平台维护专用构建镜像。Zig 是很强的工具链整合器，但不是所有平台 SDK 的替代品。

## 十、落地清单

准备把 Zig 接进现有 Rust 或 Go 项目时，可以按下面的顺序推进：

1. 先确认项目是否真的依赖 C/C++；纯 Go 和纯 Rust 不要为了统一而增加 Zig。
2. 明确目标矩阵：OS、架构、libc、最低 glibc 版本。
3. 固定 Zig 与 `cargo-zigbuild` 版本。
4. Rust 先用 `cargo zigbuild --target ...` 跑通最小目标。
5. Go 显式设置 `CGO_ENABLED=1`、`CC`，有 C++ 时再设置 `CXX`。
6. 优先让第三方 C/C++ 依赖从源码构建，避免混入宿主机库。
7. 审计 `pkg-config`、`-I`、`-L` 和 `RUSTFLAGS`，确认每条路径都属于目标。
8. 静态发布优先选 musl，不要强求静态 glibc。
9. 用 `file`、`readelf` 检查产物，再在目标架构与最低系统版本上运行。
10. 把构建命令固化进 CI，不依赖开发机里“刚好存在”的环境。

## 结语：Zig 最有价值的身份，是跨语言工具链

很多人认识 Zig，是因为它是一门新的系统编程语言。但在 Rust 和 Go 的构建链里，Zig 更实用的身份往往是另一种：**一套可携带、可切换目标、懂 libc 的 C/C++ 工具链。**

Rust 的 `cargo-zigbuild` 把这套能力接入 Cargo，让 linker、`cc` crate 和常见原生依赖共享同一个目标；Go 则通过 `CC`、`CXX` 和外部链接模式，把 cgo 生成的 C/C++ 代码交给 Zig。

它没有消灭 ABI、sysroot、第三方库和平台 SDK，但它把最重复、最容易污染 CI 的那一层收敛了：不再为每个 CPU 和 libc 单独安装一套 GCC。

对同时维护 Rust 与 Go 的团队来说，这才是 Zig 最值得关注的地方。不是把两门语言的构建系统替换掉，而是在它们共同依赖 C/C++ 的边界上，放置同一套清晰、可复现的交叉编译工具链。

## 参考资料

- [Zig Language Overview: Cross-compiling is a first-class use case](https://ziglang.org/learn/overview/)
- [Zig GNU C Library Support](https://github.com/ziglang/zig/blob/master/lib/libc/glibc/README.md)
- [cargo-zigbuild](https://github.com/rust-cross/cargo-zigbuild)
- [Go cgo documentation](https://pkg.go.dev/cmd/cgo)
- [GoReleaser Zig cgo example](https://github.com/goreleaser/example-zig-cgo)
