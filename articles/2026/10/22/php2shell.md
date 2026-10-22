# PHP 2026-109618/109619 高分漏洞解析：OOM 如何变成 RCE

<!-- summary: PHP 8.2 至 8.5 的两个 CVSS 9.2 漏洞（CVE-2026-109618/109619），根因是 OOM 路径破坏了内存生命周期契约；OpenAI 随后通过 Patch the Planet 披露了 AI 发现与协调过程。本文拆解攻击链、52 倍放大、补丁缺口与 WAF 绕过。 -->
<!-- tags: PHP, CVE-2026-109618, CVE-2026-109619, Memory Safety, Vulnerability Analysis, WAF, OpenAI, Patch the Planet, AI Security -->

2026 年 10 月 20 日，Hacker News 上一个被迅速删除的帖子提前泄露了两个 PHP 远程代码执行漏洞的存在。第二天 13:34Z，GitHub Security Advisory 发布；13:37Z，PHP 8.5.12 等四个修复版本打上 tag。两个漏洞都评为 CVSS v4.0 9.2，影响面覆盖当时仍在维护的 8.2、8.3、8.4、8.5 四个分支。OpenAI 随后发布的 Patch the Planet 说明，补上了发现与协调的另一半故事。

随后 GitHub 上出现了几十个带 `php2shell`、`CVE-2026-109618`、`CVE-2026-109619` 字样的仓库，大多数是镜像、扫描器、检测规则和蹭热度的 PoC。[`dinosn/php-cve-2026-10961x-lab-poc`](https://github.com/dinosn/php-cve-2026-10961x-lab-poc) 是其中少数值得认真读的：它不只给出一条利用链，还把“证明了什么、没证明什么”写在首页，把负向对照和受控 abort 做成每次必跑的流程。

仓库名里的 `10961x` 是个笼统前缀，实际对应两个编号：**CVE-2026-109618**（RCE via OOM corruption）和 **CVE-2026-109619**（RCE via stale global state）。

这篇文章不复述 payload，而是按工程影响拆三件事：根因是什么、这份 PoC 到底证明了什么、生产环境该做什么。

## 一、先把结论和事实排好

先给判断，再展开细节。

<!-- table-svg: php2shell-summary-table.svg -->
| 项目              | 关键事实                                                 | 实验室结论                                     | 工程动作                     |
| ----------------- | -------------------------------------------------------- | ---------------------------------------------- | ---------------------------- |
| CVE-2026-109618   | OOM bailout 后消费未初始化内存，CVSS 9.2                 | Chain A 可复现，依赖非默认分配器               | 升级到修复版本               |
| CVE-2026-109619   | 跨请求残留全局状态导致 UAF，CVSS 9.2                     | Chain B 在默认 Zend MM 上可达                  | 升级并收紧会话配置           |
| 内存放大          | 6 字节 multipart 头放大到约 314 字节堆内存               | 52 倍，2.57MB 请求可 OOM 128M 限制             | 重算内存与上传上限的比例     |
| 8.5.12 补丁       | 引擎级 fallible allocation 重构                          | 两个 CVE 已死，三条相邻路径仍存活              | 升级后继续排查同攻击面       |
| 公开 WAF 规则     | 多数锚定 `multipart/form-data;`                          | 逗号、空格分隔同样被 PHP 接受                  | 改正文结构检测与行为检测     |

一句话概括：**这不是“一个请求打穿所有 PHP”，而是请求生命周期里的内存契约被打破，并且在特定配置下可以走到命令执行。** 升级是必须的，但升级不等于攻击面清零。

受影响范围对应四个维护分支：`8.2.x < 8.2.35`、`8.3.x < 8.3.36`、`8.4.x < 8.4.27`、`8.5.x < 8.5.12`。这四个修复 tag 与仓库里的事后核对完全一致。需要单独提醒的是 PHP 7.4：它早已 EOL，但仓库在 7.4.33 上同样复现了 52 倍内存放大，这条线不会再有官方补丁。

## 二、根因：OOM bailout 打破了 allocate-then-publish

理解这两个 CVE，不需要先看 exploit，先看 PHP 处理一个请求的顺序。

`php_request_startup` 激活模块 RINIT，然后解析输入。对于 `multipart/form-data`，`rfc1867_post_handler` 会把每个字段注册进 `$_POST`、`$_FILES`，`session.upload_progress` 还会把进度写进会话。这些操作最终都落在 Zend HashTable 上：找 slot、写 key、写 value、更新 `nNumUsed` 和 `nNextFreeElement`。

问题出在“更新计数器”和“初始化 value”的先后顺序。简化后的旧代码大概是这样：

```c
/* 旧路径：先把状态发布出去，再填内容 */
slot = &ht->arData[ht->nNumUsed];
ht->nNumUsed++;
ht->nNextFreeElement = idx + 1;   /* 清理逻辑已经能看到这个 slot */
ZVAL_UNDEF(&slot->val);
if (UNEXPECTED(/* 这里分配失败 */)) {
  /* zend_error 触发 longjmp bailout，不会走正常回滚 */
}
```

OOM 在 PHP 里不是一个可以层层返回的错误码，而是 `zend_error` 触发的 `longjmp`。它会直接跳到请求清理阶段，跳过中间所有函数的正常退出路径。清理代码看到 HashTable 里“已经有一个 bucket”，就按正常 zval 去析构；但 bucket 的 key 和 value 可能还没写完。于是它读到的，是同一块堆内存里上一轮请求留下的字节，或者攻击者精心布置的字节。

这就是 CVE-2026-109618 的核心：**OOM 之后，request shutdown 仍会读取和分支于“临时可达但尚未初始化”的请求内存。** 只要能把这块内存塑造成一个 fake zval，再让它指向 fake array，最终就能走到 array 的 `pDestructor`，把析构调用变成任意函数调用。

8.5.12 的修法不是补一个判断，而是把整条分配路径改成可失败（fallible allocation）：

```c
/* 8.5.12 的思路：先拿到内存，再发布状态 */
p = pemalloc(size, persistent);
if (UNEXPECTED(p == NULL)) {
  return HASH_NOMEM;   /* 由调用方回滚，不进入 longjmp */
}
ht->arData = p;
ht->nNumUsed = 0;
ht->nNextFreeElement = 0;   /* 到这里才对清理逻辑可见 */
```

这次改动横跨 785 个文件：`femalloc` / `fpemalloc` 返回 `NULL` 而不是 bailout；`_zend_hash_add_or_update_i`、resize、packed/mixed 初始化路径在发布计数器之前返回 `HASH_NOMEM`；`php_variables.c` 和 `rfc1867.c` 增加 `ZEND_HAS_OOM()` 守卫；`session.c` 增加 `PS(in_rfc1867_update)` 标志，在 pre-RINIT 的上传进度窗口强制进入 incomplete_classes_only 模式（该窗口不允许用户代码执行），sid 创建失败也会正确中止。

第二个 CVE 是另一条线：**worker 跨请求保留了指向请求内存的全局状态。**

Apache prefork 和 PHP-FPM 的 worker 都是长期进程。请求结束时，请求级内存被释放，但分配器不会把页还给操作系统，下一次请求会复用同一批地址。如果某个全局变量还指着上一轮请求的内存，而新请求在 RINIT 重置它之前就访问了它，这就是一个 UAF。

仓库里的 Chain B 利用的是 `PS(http_session_vars)`：pre-RINIT 的 OOM 让它持有一个悬空的 `zend_reference`，下一请求用一个 31 字节的字段值精确回收那块地址，伪造出的 reference 会依次经过 `zend_reference_destroy → zend_array_destroy → zend_hash_destroy`，最后在 `pDestructor` 处执行目标函数。更早的 `BG(serialize)` / `BG(unserialize)` 变体也是同一类：全局状态在请求之间残留，下一次请求在初始化之前就消费了它。

这里真正值得记住的工程结论是：**“request-scoped” 是约定，不是隔离。** 任何跨请求保留的指针，在新请求开始时都必须被当作不可信数据，而不是“应该还在”的缓存。

## 三、PoC 证明了什么，没证明什么

这份仓库最有价值的地方，不是它打出了 `uid=33`，而是它把证据分了层。

<!-- table-svg: php2shell-proof-table.svg -->
| 层级       | 内容                                                                                     | 对读者的意义                                       |
| ---------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------- |
| 已证明     | 8.5.11 + Apache prefork 单 worker + 指定 ini，4 个普通 HTTP 请求拿到 `uid=33`，12/12 成功，跨 8 组 ASLR | 代码执行可行性成立，不是纯理论推演                 |
| 实验室辅助 | 早期链的地址来自 GDB 或 `/proc/<pid>/maps`；端到端版本改用 cookie 泄露                 | 远程利用仍需信息泄露，不是固定偏移一条路走到黑     |
| 未证明     | 默认加固配置、多 worker、FPM RCE、PHP 5+ 全版本、补丁后复现原链、持久化控制             | 不能把实验室结论外推成“所有 PHP 都沦陷”            |
| 已证伪     | 流传的 cached-zval `session.upload_progress` UAF 理论                                     | 不要在错误方向上做检测规则和应急排查               |

端到端链条是四个请求：两个用于泄露地址，两个用于触发。第一个请求构造 1001 个变量触发 `max_input_vars`，让 `headers_sent=1`，再用空 cookie 让 `reset_id` 失败、`send_cookie` 保持为 1，最后用一个 24MiB 字段在 pre-RINIT 阶段触发 OOM，把 `PS(id)` 留成悬空指针。第二个请求用 257 个元素的数组让 `zend_array` 落在 `PS(id)-0x10`，于是 `ZSTR_LEN` 读到 `nTableSize=512`，响应里的 `PHPSESSID` cookie 就带出了 512 字节的堆内容：其中既有指向 `zval_ptr_dtor` 的 `pDestructor`（可算出 libphp 基址），也有 9 个 `arData` 指针（多数投票可算出 chunk 基址）。

值得注意的是，仓库明确写了 chunk 与 libphp 的差值在不同 ASLR 代际之间并不固定（测到过 `-0x1a00000`、`+0x3600000`、`-0x1c00000`）。这意味着泄露是“真的有用”，不是拿一个固定偏移碰运气。这一点比很多只给一条成功日志的 PoC 更可信。

但前提也写得很直白：

- `display_errors=On`。生产常用的 `php.ini-production` 会让这个泄露路径失效。
- `post_max_size` 要大于触发 OOM 的字段。实验室是 24MiB，默认 8M 不够。
- `memory_limit` 要小于这个字段，否则 OOM 不会发生。
- 单 worker prefork 才能稳定让四个请求落到同一个 worker。多 worker 需要按 worker 配对重试或轮转。
- Chain A 还要求 `USE_ZEND_ALLOC=0`，这本身就不是默认配置。

所以“12/12 成功”是真的，“任何 PHP 站点都能打”是假的。两者之间隔着一组具体的 ini 和部署条件。

更值得学的是它的控制阶梯。每个决定性用例都从新 fork 的 worker 开始，负向对照里 fake 结构存在但不分派，abort 对照把 `pDestructor` 指到 `abort@plt` 并确认 SIGABRT，只有 marker 用例才检查唯一字节的命令输出。仓库写得很清楚：**HTTP 错误、空响应、PHP fatal error、worker 崩溃，都不算命令执行证据。** FPM 那个 stale-state 发现被明确标成 crash primitive，而不是 RCE，就是因为没通过这条线。

这套方法论比漏洞本身更值得抄。一个 PoC 如果只展示“服务器 500 了”“cookie 变了”“进程重启了”，它证明的是扰动，不是利用。

复现也要守边界。仓库的安全约束写得很明确：专用 Docker 容器、内部网络、不发布端口、镜像按 digest 固定，payload 只允许 `id`、`printf` 这类命令写 `/tmp`。这类实验只在自有隔离环境里做，不要拿到生产或第三方资产上验证。

仓库还顺手证伪了一个传播很广的理论：所谓 cached raw `zval *` 在 `session.upload_progress` 里被二次解码释放，形成 UAF。作者在 4 个 stock 版本和 3 个 LiteSpeed 厂商构建上做了 watchpoint 和分配追踪，结论是引用计数从 2 降到 1、从未到 0，所有解引用都发生在 free 之前，公开的 149 元素 groom 甚至在 free 之前就分配了，结构上不可能回收目标 chunk。这个结论和另外两个独立分析一致。对防守方来说，这意味着不必为这个理论单独写规则。

## 四、52 倍内存放大：`post_max_size` 不再是墙

如果说两个 CVE 是内存破坏，那 52 倍放大是另一个更“日常”的问题：它让“请求体很小，所以打不爆内存”这个假设失效。

<!-- table-svg: php2shell-amplification-table.svg -->
| memory_limit | 触发 OOM 的最小请求体 | 放大倍率 |
| ------------ | --------------------- | -------- |
| 8M           | 153 KB                | 54.8x    |
| 32M          | 636 KB                | 52.8x    |
| 128M         | 2.57 MB               | 52.3x    |
| 256M         | 5.14 MB               | 52.2x    |

机制不复杂：重复的 6 字节 multipart 头（例如 `X: a`）会触发 PHP 为每个保存的头分配一个固定 256 字节起始缓冲（`SMART_STR_START_SIZE`），加上结构开销约 314 字节。6 字节的线上数据，变成 314 字节的堆内存，比例稳定在 50 倍上下。

这意味着 `post_max_size=8M` 并不能保护 `memory_limit=128M`：2.57MB 的请求体就足以 OOM。默认组合下两者的比例是 16 倍，正好落在危险区。仓库还在 7.4.33、8.1.34、8.4.26 上测到同样的 51 到 52 倍，说明这不是 8.5 独有的回归。

另外两个细节让问题更麻烦：

- `Transfer-Encoding: chunked` 可以绕过基于 `Content-Length` 的预检查。实验室里 8.85MB 的 chunked 请求被正常解析并 OOM，而同样大小、带 `Content-Length` 的请求会被拒绝。
- 8.5.12 同时修了两条：未知头过滤和流式 `post_max_size` 强制执行。也就是说，这个放大问题被并入同一次安全发布，但没有单独分配 CVE 编号。

由此可以推一个配置上的经验规则：**如果希望“仅靠请求体”无法触发 OOM，`memory_limit` 至少要达到 `post_max_size` 的 60 倍，且还要留出应用自身的内存基线。** 默认的 8M / 128M 只有 16 倍，不满足这个条件。反过来，如果业务只需要 2M 上传，128M 的限制就是 64 倍，安全边界会好很多。

这不是说放大本身等于 RCE。它给的是 DoS，以及内存破坏链所需要的“OOM 前置条件”。但在真实攻防里，前置条件往往就是最难的那一步。

## 五、补丁之后：修好的是两个 CVE，不是整片攻击面

8.5.12 的修复是有效的，这一点有负向对照支撑：仓库用官方 tarball 以 GPG 校验后构建 8.5.12，configure 参数与官方 8.5.11 镜像逐 token 一致，扩展集相同，并在源码里确认了 `femalloc`、`HASH_NOMEM`、`ZEND_HAS_OOM`、`in_rfc1867_update` 等修复标记。结果是：两个链的 OOM 仍然触发，但旧消费点零遍历、`hsv_type=0x0`、零分派、零 marker，worker 存活。同一个 harness 在 8.5.11 上则是正向的。

但仓库在 8.5.12 上确认了三条仍然存活的路径：

1. **`var_destroy` 析构重入 UAF（CWE-416）**。边界仍然是 n=1015，与 8.5.11 一致；故障点从 `var_unserializer.c:849` 移到 `:906`，但仍是同一条语句。补丁的 fallible allocation 重构没有在 `var_destroy()` 的 `__destruct` 分派周围加 `BG(serialize_lock)`，所以这条重入路径的竞态条件没有被覆盖。
2. **序列化 handler 不匹配**。用 `php_serialize` 写出的、带 `|` 前缀键的会话，被 `php` handler 在应用阶段 `session_start()` 时解码，仍然可以实例化攻击者指定的对象。补丁的 `incomplete_classes_only` 守卫只覆盖 pre-RINIT 的上传进度窗口，不覆盖应用阶段的解码。
3. **上传进度键注入**。攻击者控制的键会被原样写进会话文件。补丁无法清洗它，因为这本身就是功能；要形成利用，还需要应用侧存在 include/LFI 之类的 sink。

这三条不是两个 CVE 的“未修版本”，而是同一攻击面上的相邻缺陷。官方 GHSA 只覆盖 OOM corruption 和 stale global state 两类，补丁也只对这些路径负责。对防守方来说，正确的结论是：**升级 8.5.12 是止血，不是终点。**

FPM 的情况还要更细一点。仓库在 `php:8.5.11-fpm` 上验证了 `BG(unserialize)` 的跨请求残留：32M 限制下，24MB 会话在 `php_var_unserialize` 内部 OOM，worker 没有退出。原因是 exit-70 屏障只覆盖启动阶段的 OOM，用户态会话解码的 OOM 不会触发它。残留的 `level=1 data=<stale ptr>` 会进入下一请求的 rfc1867 pre-RINIT 窗口；一个 8191 字节的 multipart 字段会产生 8216 字节的 `_emalloc`，覆盖到悬空指针，最终在 `var_tmp_var` 里 SIGSEGV。

这个发现的定位很克制：**可重复的 worker 崩溃（DoS）加一个内存破坏原语，RCE 尚未证明。** 它需要低 `memory_limit`、大的攻击者可控会话、存在 `session_start()` 的端点、`upload_progress=On`，以及 `pm=static max_children=1` 才能稳定落到同一个 worker。生产环境里这些条件不常见，但“FPM 天然安全”这个判断已经不成立，只能说是“有条件保护”。

同一份核对日志里还有一条生产侧的结果：对一个 WordPress 站点集群做端到端测试，上传进度注入向量确实能远程生效，但 WordPress 在请求结束时重写会话并丢弃注入键；从 24MB 到 128MB 的分层解码 oracle 也没有在任何端点上打出解码失败。结论是“机制真实，但在该集群的前置条件处被挡住”。这比“全网可打”或“完全不受影响”都更接近现实。

## 六、WAF 与检测：一个逗号就能绕过

漏洞公开当天，社区迅速放出了 ModSecurity、Suricata、njs、OpenResty Lua 等一批规则。仓库对其中一部分做了验证，最刺眼的一条是：**PHP 的 SAPI 在解析 `Content-Type` 时，不只接受分号作为分隔符。**

`SAPI.c` 会在 `;`、`,` 和空格处截断参数；`rfc1867.c` 用 `strpbrk(boundary, ",;")` 找 boundary。于是下面四种写法在 PHP 看来是等价的：

```text
Content-Type: multipart/form-data; boundary=X
Content-Type: multipart/form-data, boundary=X
Content-Type: multipart/form-data,boundary=X
Content-Type: multipart/form-data boundary=X
```

公开规则里锚定在 `Content-Type: multipart/form-data; boundary=` 上的签名，改一个字符就能绕过。实验室确认这四种写法产生完全相同的 339 字节上传进度会话行，逗号形式同样能触发已 arm 的 worker UAF。

相对靠谱的写法是把分隔符集合本身纳入匹配，例如 syhunt 后来采用的 Apache 规则：

```apache
RewriteCond %{HTTP:Content-Type} ^[[:space:]]*multipart/form-data([;,[:space:]]|$) [NC]
RewriteRule ^ - [F]
```

这条规则不是“锚定分号”，而是“锚定 PHP 自己接受的分隔符集合”，所以逗号变体不会漏。但它仍然只是止血。真正可靠的检测要往两层走：

- **正文结构**：按 boundary 分隔行判断是不是 multipart，而不是只看头。
- **行为**：PHP worker 派生 shell、解释器、网络工具，是比请求特征更稳的信号。

仓库还点了几个公开规则的实现缺陷：有的 njs 规则把 `.test()` 的布尔值当长度用，条件永远为假；有的 Suricata 规则用 `detection_filter:track by_dst, count 40`，跨流计数而不是单请求内计数；有的 Lua 规则只读 body 前 64KB，把触发字段推到 64KB 之后就能绕过；还有规则依赖引擎自己的 multipart 解析结果，逗号分隔时解析失败，变量为空，规则自然不触发。

一个实用的补充信号是 **`Set-Cookie` 的长度**。端到端链条的泄露会把 `PHPSESSID` 撑到 512 字节的 URL 编码内容；正常会话 ID 是 26 到 32 个字符。监控异常长的会话 cookie，比匹配某个 payload 字节更通用，也更难被绕过。

WAF 的定位要说清楚：它能买时间，不能替代补丁。尤其是这次的问题出在请求解析和内存生命周期，规则层永远在追着实现细节跑。

## 七、处置清单

如果只做三件事：升级、重算配置比例、改检测锚点。

<!-- table-svg: php2shell-checklist-table.svg -->
| 优先级 | 动作                                                                 | 验收标准                                       |
| ------ | -------------------------------------------------------------------- | ---------------------------------------------- |
| P0     | 升级到 8.2.35 / 8.3.36 / 8.4.27 / 8.5.12 或更高                      | `php -v` 与镜像 digest 一致，重新构建而非只改 tag |
| P0     | 生产关闭 `display_errors`，重算 `memory_limit` 与 `post_max_size`     | 大 multipart 不再触发 OOM，比例至少 60 倍       |
| P1     | 不用上传进度就关闭 `session.upload_progress`，开启严格会话模式        | 会话文件里没有攻击者可控键                     |
| P1     | 检测规则改为正文结构加行为检测，覆盖逗号/空格分隔                     | 四种 Content-Type 写法都能命中                 |
| P2     | 为 `var_destroy` 重入和 handler 混用补回归用例                        | 8.5.12 上仍能复现，升级后不误判为已修           |
| P2     | 隔离 7.4 等 EOL 分支                                                  | 无公网暴露，或已排期迁移                       |

具体到命令，先盘点版本和关键 ini：

```bash
php -v
php -i | grep -E '^(memory_limit|post_max_size|upload_max_filesize|display_errors|session.upload_progress.enabled|session.use_strict_mode|session.use_only_cookies)'
```

容器环境不要只看 tag。官方镜像的 digest 才是构建输入，升级时应该改 Dockerfile 里的 digest 并重新构建，而不是在运行中的容器里替换二进制：

```dockerfile
FROM php:8.5.12-apache@sha256:<digest>
```

如果无法立即升级，至少要做的临时收敛：

- 把 `post_max_size` 压到业务真正需要的上限，并确认 `memory_limit` 至少是它的 60 倍。
- 关闭 `display_errors`，这会直接破坏这条端到端链条的地址泄露前提。
- 不用 `session.upload_progress` 就关掉；必须使用时，限制会话端点和 `memory_limit`。
- 在反向代理层拒绝 `multipart/form-data` 后跟逗号或空格分隔的 `Content-Type`。
- 监控异常长的 `PHPSESSID`、PHP worker 的异常重启，以及 worker 派生 shell 的行为。

如果站点在 10 月 21 日之前已经暴露，并且满足 `display_errors=On`、`post_max_size` 较大、`memory_limit` 较低这些条件，且请求能稳定落到同一个 worker，建议按“可能已被执行”做一次排查：看 `/tmp` 下的异常文件、PHP worker 的进程树和子进程、容器出站连接、Apache 错误日志里大 multipart 之后的 worker 替换记录，以及 512 字节级别的会话 cookie。不要只扫 Web 日志里的已知 payload，因为这次的关键请求在语法上是合法的 multipart。

## 八、Patch the Planet：AI 发现漏洞之后

技术链路之外，这次事件还有一条值得单独看的线：漏洞是怎么被发现的，以及披露是怎么协调的。

10 月 21 日，OpenAI 发布了一篇协调披露说明，标题是[《Patch the Planet：协调全球响应，应对智能体发现的严重漏洞》](https://openai.com/zh-Hans-CN/index/coordinated-disclosure-of-critical-vulnerabilities/)。按这篇说明的说法，过去两个月，OpenAI 牵头组建了一个由维护者、研究人员和安全服务商组成的联盟，共同应对 PHP 中的严重漏洞。在 Patch the Planet 计划中，Calif 使用 GPT-5.6 Sol 发现了一个严重漏洞；Wiz 也独立发现并报告了这两个漏洞。PHP 维护者主导了修复和版本发布，OpenAI、Wiz、Cloudflare 等伙伴提供研究、技术支持和协调，目标是在漏洞披露前把防护措施准备好。

这段话里有两个信息值得分开看。

一是“AI 发现漏洞”已经进入真实的安全响应流程，而不只是演示。OpenAI 的判断很直接：考虑到漏洞的严重程度和 PHP 的广泛使用，这是近年来影响最大的安全问题之一；它说明 AI 能发现影响整个互联网的漏洞，但同样的能力也可能帮助攻击者更快地开发攻击工具和漏洞利用程序。按 OpenAI 的说法，这一次前沿 AI 比攻击者更早发现漏洞，给维护者和安全服务商留出了一个“防御者窗口期”。

二是“发现”之后的协调，比发现本身更花时间。OpenAI 提出的五阶段框架是：

1. 验证并修复上游漏洞。维护者、研究人员和技术伙伴确认漏洞、评估影响、开发并测试修复，同时用前沿模型做对抗性测试，寻找绕过补丁的方法和变体。
2. 为受影响组织留出行动时间。由维护者决定提前通知谁；分发方要把修复适配到旧版本，托管服务商要测试缓解措施，安全服务商要准备检测规则和 WAF 规则。
3. 与政府合作伙伴协调，协助保护关键系统。OpenAI 提到他们联络了美国政府的多个部门，包括白宫超级智能工作组、国家网络总监办公室（ONCD）、CISA，以及国际合作伙伴。
4. 为各受影响产品准备更新。随着修复、指导和披露计划稳定，邀请更多分发方、托管商、响应团队和运维人员参与，补齐覆盖缺口。
5. 补丁可用后发布指导并支持部署。公开指导要能让人评估风险、找到权威更新或临时缓解措施，并确认修复生效。

这套框架的核心不是“谁先知道”，而是“谁需要在披露前知道，以及知道多少”。OpenAI 说，每个参与方拿到的信息范围不同，从包含失陷指标的网络日志，到更敏感、可实际运行的概念验证利用程序；即使有限的细节也可能暴露漏洞，所以要在共享风险和防护收益之间做权衡。如果出现漏洞已被实际利用、信息泄露、公开补丁暴露漏洞，或修复停滞导致用户风险上升，时间表会被重新评估。

配套动作也很具体：OpenAI 以 Codex 技能的形式提供了 PHP 版本检查工具 [`openai/php2shell-checker`](https://github.com/openai/php2shell-checker)，帮助运维人员识别可能有漏洞的 PHP 版本；Patch the Planet 网站汇总了维护者的补丁、升级说明、合作伙伴的研究和临时缓解措施；CISA 的 BOD 26-04 给出了按风险排序和修复的指导。OpenAI 还承诺通过 Daybreak 计划提供 10 亿美元的使用补贴，重点支持安全资源有限、承担关键服务防护职责的组织，并通过 Codex for OSS、赞助 Rust 基金会等方式支持维护者。

这些动作解决的是“发现之后怎么办”，而不是“漏洞本身怎么利用”。对本文的技术分析来说，它们不改变前面那条证明边界：PoC 仍然需要特定的 ini、单 worker、地址泄露；AI 发现漏洞，也不等于每个 PHP 站点都自动可打。但它们补上了另一个维度：当漏洞发现的速度开始由 AI 决定，防御方的响应速度、协调能力和版本可见性，会变得和技术细节同样重要。

OpenAI 还把话题推到更长期：从源头保障代码安全、把关键组件迁移到内存安全语言、用形式化验证证明关键安全属性、用更强的隔离机制限制未知漏洞的影响。这些方向不是这次 PHP 漏洞的补丁，但它们决定了下一批漏洞被发现时，防御方是否还有同样的窗口期。

OpenAI 自己也在文末留了几个开放问题：披露窗口期到底需要多长；对于政府或其他运维方拥有、但已经失去管理员访问权限的系统，是否应该利用漏洞为其打补丁；哪些参与方需要提前通知；在上游修复就绪前，如何帮助下层软件包和不再接收安全更新的旧版本。这些问题没有标准答案，但它们决定了“防御者窗口期”是一个真实的窗口，还是只是一句好听的话。

## 九、结论

php2shell 值得写，不是因为它“又一个 RCE”，而是因为它把两类很典型的工程问题暴露得很清楚。

第一类是 **OOM 路径的语义**。在 C 里，`longjmp` 式的错误处理会把“部分完成”的状态留给清理代码；只要清理代码假设“表里的东西都是初始化过的”，OOM 就从资源问题变成了内存安全问题。修复的方向不是加一个 `if`，而是把“先发布、后初始化”改成“先分配、失败就返回”，这是 8.5.12 那 785 个文件在做的事。

第二类是 **长驻进程的请求边界**。PHP 的 request-scoped 内存是分配器层面的复用，不是隔离。任何跨请求保留的指针、缓存、全局状态，都必须在新请求开始时重新验证。`PS(http_session_vars)`、`BG(serialize)`、`BG(unserialize)` 这三个名字背后是同一个错误假设。

对开发者来说，这次事件还有一层方法论价值：读 PoC 时先看它的证明边界，再看它的成功率。四个请求、12/12、8 组 ASLR，这些数字只有在“单 worker、display_errors 开启、post_max_size 提高”的前提下才成立；而“HTTP 500 不算 RCE”“worker 崩溃不算 RCE”这两条，应该成为评估任何 exploit 声称的底线。

对防守方来说，动作顺序也很清楚：先升级到修复版本，再重算 `memory_limit` 与 `post_max_size` 的比例，然后修掉锚定分号的检测规则，最后把 `var_destroy`、handler 混用、上传进度键注入这些相邻路径纳入持续监控。WAF 可以买时间，但不能替代补丁；而补丁能关掉两个 CVE，也关不掉整片攻击面。

把 OpenAI 的披露说明放在一起看，这次事件的意义不只在于两个 CVE。它同时展示了三件事：AI 可以把漏洞发现推进到互联网级组件的深处；一次负责任的披露需要维护者、云厂商、安全厂商和政府机构共同排期；而防御者窗口期不会自动变成安全，它需要版本可见性、补丁能力和可执行的缓解措施来兑现。对普通团队来说，能做的仍然是那些朴素的事：知道自己跑的是哪个版本，知道谁在维护它，知道补丁发布后多久能上线。
