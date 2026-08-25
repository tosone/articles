# 阿里开发者生态遭 npm 定向投毒：这次供应链攻击真正危险在哪里

<!-- summary: 这次针对阿里开发者生态的 npm 供应链攻击，不是简单的恶意包投放，而是一次围绕私有包命名、分层依赖、配置执行、跨平台 RAT 和企业协作工具横向移动设计的定向攻击。 -->
<!-- tags: 供应链安全, npm, RAT, 事件分析 -->

最近公开披露的一起 npm 供应链攻击，把目标指向了使用阿里内部开发工具和 `@ali` 私有包生态的开发者。事件最早由 Socket Threat Research 分析，随后被多家安全媒体转载。攻击者发布了一组看起来像阿里内部依赖的 npm 包，把恶意逻辑拆到多层依赖里，最终投递一个跨平台 RAT。

这件事值得单独写，不是因为“又有恶意 npm 包”。

npm 恶意包已经很多了，常见套路包括 typo-squatting、preinstall 脚本偷 token、下载器拉二阶段 payload、维护者账号被盗后发毒版本。但这次更值得关注的地方在于：它不是随机撒网，而是围绕目标组织的内部包命名、研发平台、协作工具和开发者工作站做了细致适配。

换句话说，它攻击的不是一个漏洞，而是一条开发链路：开发者安装依赖、包管理器解析依赖、Node 执行安装逻辑、配置解析器运行规则、企业工具驻留在本机、凭证散落在开发环境里。任何一环被默认信任，都会成为下一阶段的跳板。

## 一、先看结论

| 维度     | 这次攻击怎么做                                                                         | 工程含义                                                                     |
| -------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 初始入口 | 发布未加 scope 的 npm 包，伪装成阿里 `@ali` scope 下的私有包或相关工具。               | 私有包命名不是安全边界，公开 registry 上的同名/近似名仍可能进入依赖树。      |
| 依赖结构 | 把 loader 拆到 top-layer lure、middle-layer bridge、low-layer config/parser 多个包里。 | 单独审一个包可能看不出问题，必须审整棵依赖树和安装期行为。                   |
| 执行方式 | 下载 `.cloud-preferences.json`，再通过 `local-config-parser` 的规则引擎执行隐藏逻辑。  | “配置即代码”一旦能执行表达式，就要按代码执行面管理，而不是按普通 JSON 管理。 |
| 逃逸方式 | 借助 Node.js `vm` 沙箱逃逸思路重新拿到 `process` 和模块加载能力。                      | `vm` 不是强安全沙箱，不能用来运行不可信规则。                                |
| 后续载荷 | 按 Windows、Linux、macOS 选择不同持久化方式，最终落到 `aone-cli` RAT。                 | 开发者工作站已经是高价值资产，不能只按“个人终端”看待。                       |
| 横向移动 | 针对 DingTalk、Wukong、Qoder 等企业协作和开发工具注入或伪装通信。                      | 攻击者理解目标组织工具链，响应时要查业务工具目录和插件目录。                 |
| 归因     | 有中文注释、UTC+08 提交时间等线索，但不能作为强归因证据。                              | 防守重点应放在影响面、凭证轮换和终端取证，而不是过早确定攻击者身份。         |

如果团队只记一个点：**这不是“装了某个包就删掉”的问题，而是开发机被远控之后，源代码、内网凭证、云密钥、IM 会话和二次投毒能力都可能暴露。**

## 二、攻击入口：伪装成目标组织会使用的私有包

这次披露中最核心的入口包之一是 `lib-mtop`。公开报道里提到，它是一个未加 scope 的 npm 包，名称与阿里 `@ali` scope 下的私有包相同或高度相似。该包早在 2023 年 11 月就已经发布过一个没有实际功能的版本，直到 2026 年 3 月和 4 月出现了 `1.0.1`、`1.0.2`、`1.0.3` 等新版本，才加入下载并执行远程 JavaScript 的 loader。

这里的关键不是“名字像不像”，而是企业 npm 使用方式本身容易产生灰区。

很多大公司都有内部 npm registry，也会用 scoped packages 区分私有包，例如：

```text
  @ali/lib-mtop
  @ali/aone-kit
  @ali/aone-sandbox
```

攻击者如果在公开 npm registry 上发布：

```text
  lib-mtop
  aone-kit
  aone-kit-cli
  aone-sandbox
```

它们不一定能直接替代私有包，但足以制造几种现实风险：

1. 开发者搜索包名时误装公开包。
2. 脚手架、示例代码、自动修复工具错误补全依赖。
3. monorepo 或 CI 的 registry 配置存在优先级问题。
4. 某些 wrapper 包同时声明私有依赖和额外公开依赖，让安装结果看起来“部分正常”。

公开资料提到，`ch4ce` 这个 npm 账号发布过 `lib-mtop`、`aone-kit`、`aone-kit-cli`、`aone-sandbox`、`local-config-parser` 等包。现在该账号在 npm 上已不可见。至于是维护者账号被盗，还是发布者主动转恶，目前没有公开证据能定论。

这也是供应链攻击里最麻烦的一类情况：入口看起来不像漏洞利用，更像“包生态里的正常发布行为”。包能被安装、版本号正常递增、依赖树能解析，安全系统如果只看是否来自 npm 官方 registry，很容易错过。

## 三、它不是一个恶意包，而是一棵恶意依赖树

这次攻击比较成熟的地方，是攻击者没有把所有恶意逻辑塞进一个包里。

公开报道里列出的恶意包共 18 个：

| 包名                      | 角色                                      |
| ------------------------- | ----------------------------------------- |
| `lib-mtop`                | 早期入口和 downloader。                   |
| `aone-kit`                | 顶层诱饵包，模仿内部工具命名。            |
| `aone-kit-cli`            | 顶层诱饵包。                              |
| `aone-sandbox`            | 顶层诱饵包。                              |
| `local-config-parser`     | 配置解析器，负责读取并执行规则。          |
| `smart-config-manager`    | 中间层桥接包，把诱饵包连接到低层 loader。 |
| `cloud-config-fetcher`    | 获取远程配置并写入本地隐藏文件。          |
| `fast-transform-pipeline` | 低层或测试性质组件，参与分层投递。        |
| `aone-cloud-cli`          | 顶层诱饵包。                              |
| `colder-cli`              | 顶层诱饵包。                              |
| `def-open-client`         | 顶层诱饵包。                              |
| `feedback-ai-sdk`         | 顶层诱饵包。                              |
| `flight-compare-analyzer` | 顶层诱饵包。                              |
| `lwp-web-client`          | 顶层诱饵包。                              |
| `lzd-unified-station-sdk` | 顶层诱饵包。                              |
| `open-worker-cli`         | 顶层诱饵包。                              |
| `test-skill-zip`          | 顶层诱饵包。                              |
| `uniapi-bridge`           | 顶层诱饵包。                              |

更重要的是它们之间的分工。

第一层是诱饵包。很多包几乎没有真实功能，或者只是声明看起来合理的依赖。它们的任务不是马上暴露恶意代码，而是让目标开发者或自动化环境把整棵依赖树装进来。

第二层是 `smart-config-manager`。公开分析称，多个顶层诱饵包都依赖它，它相当于中间层桥接点，把表面看似空壳的包连接到后续下载和执行组件。

第三层是 `cloud-config-fetcher` 和 `local-config-parser`。前者从攻击者控制的 GitHub 仓库下载规则配置，并保存为 `.cloud-preferences.json`；后者读取这份配置，用 Node.js 的 `vm` 模块执行规则。Socket 原文给出的配置地址是 `hxxps://raw[.]githubusercontent[.]com/smi1e2u/smart-config-manager/main/defaults/preferences.json`。

从单包视角看，这些行为都有伪装空间：

- 一个 config fetcher 下载远程 JSON，看起来像正常配置同步。
- 一个 config parser 解析本地规则，看起来像正常配置处理。
- 一个中间层 manager 组合它们，看起来像正常封装。
- 一个顶层 CLI 依赖 manager，看起来像正常工具链组织。

但组合起来之后，它就是完整的下载执行链路。

这类分层设计会削弱传统审查方式。很多团队的依赖审计是“看 package.json 里新增了什么包”，最多打开顶层包看一下源码。问题是，这次的恶意逻辑不在顶层包里完整出现，而是分散在安装后的 transitive dependencies 和远程配置里。

Socket 还提到，攻击者在 4 月 27 日到 28 日之间分阶段铺设包和账号，其中 `node-data-utils` 与 `fast-transform-pipeline` 看起来像是测试多包投递机制的组件，随后才发布 `smart-config-manager`、`cloud-config-fetcher` 和一批顶层诱饵包。这个时间相关性也说明，攻击者不是临时拼了一个 downloader，而是在验证依赖树投递能否稳定工作。

## 四、关键链路：配置文件变成了代码执行入口

这次攻击链可以概括成这样：

```text
  install lure package
  -> smart-config-manager
  -> cloud-config-fetcher
  -> .cloud-preferences.json
  -> local-config-parser
  -> Node.js vm rule execution
  -> sandbox escape
  -> setting.js
  -> platform-specific aone-cli RAT
```

这里最值得警惕的是 `.cloud-preferences.json` 这一步。

很多安全系统会重点盯安装脚本、二进制文件、混淆 JavaScript、可疑网络请求。但如果一个包的公开代码只是“下载配置”和“执行规则”，它可能显得没那么危险。攻击者把真正的逻辑藏在远程配置中，就把恶意载荷从 npm 包本体挪到了外部基础设施。

`local-config-parser` 使用 Node.js `vm` 模块执行规则。`vm` 常被误解成“沙箱”。它确实可以创建一个独立上下文，但 Node 官方长期强调过，它不是运行不可信代码的安全隔离机制。只要暴露对象、原型链、构造器或宿主能力设计不当，规则代码就可能重新拿到宿主环境里的 `process`、模块加载器或其他敏感能力。

公开分析里提到，攻击者使用了典型的 `Function` 构造器逃逸思路，从传入对象一路拿到宿主 `process`，再尝试通过 `process.getBuiltinModule`、`process.mainModule` 或宿主全局对象等多种路径寻找 `require` 或 `_load`，加载 `http` 模块，下载下一阶段 `setting.js`。

文章里不展开可直接复用的逃逸代码。对工程团队来说，需要记住的是这个结论：**不要把 Node.js `vm` 当成安全边界。如果规则来自网络、用户、插件市场或第三方包，它就必须按不可信代码处理。**

## 五、为什么它能藏得比较久

这次攻击有几个有利于隐蔽的设计。

第一，入口包和目标组织强相关。它不是发布一个流行库的拼写错误版本，等全球开发者撞上来；而是选择阿里内部工具命名附近的包。下载量可能不高，但命中目标环境的价值更高。

第二，恶意逻辑被拆分。单个包可能只有普通依赖声明、配置读取、JSON 解析、规则执行。只有把包之间的依赖关系、安装时行为和远程配置串起来，才会看到完整意图。

第三，基础设施有伪装。后续 payload 被报道称来自形似阿里云 OSS 的域名，例如 `aone-cli-next.oss-cn-beijing.aliyuncs[.]com`。这类域名在中国企业网络环境里不一定显眼，尤其是目标本来就使用阿里相关服务。

第四，平台行为分支清晰。攻击者没有粗暴地只投一个脚本，而是根据操作系统选择不同策略：

| 平台    | 公开报道中的行为                                                              | 防守关注点                                                        |
| ------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Windows | 尝试终止或替换 Alilang 相关企业安全、VPN、办公应用核心文件，例如 `app.asar`。 | 检查企业工具安装目录、asar 文件哈希、异常进程终止记录。           |
| Linux   | 下载二进制到 `/tmp`，后台运行后删除磁盘文件。                                 | 检查 `/tmp` 执行痕迹、进程树、bash/zsh 历史、EDR 进程事件。       |
| macOS   | 修改 `~/.zshrc` 并创建 10 分钟周期的 Launch Agent。                           | 检查 shell 启动文件、`~/Library/LaunchAgents`、定时任务和登录项。 |

第五，它理解开发者环境。最终 payload 被称为 `aone-cli` RAT，具备命令执行、文件上传下载、主机信息收集、payload staging、加密反向 TCP proxy 等能力。Socket 原文列出的命令包括 `info`、`whoami`、`screenshot`、`download`、`upload`、`execute`、`run_python`、`proxy`、`install_python_module`、`install_node_module`、`aipoison`、`aipoison_inject`、`aipoison_deploy`、`dws_lateral` 等，未识别命令还会转给本地 shell 执行。

更危险的是，它还被报道称会针对 DingTalk、Wukong、Qoder 等协作或开发工具做持久化注入，修改 `.skills` 目录下的 Python 脚本，让后续工具调用时再次执行隐藏逻辑。Socket 原文给出的注入标记是 `# __INJECT_MARKER__`，注入代码会尝试从 `~/.real/.bin/` 下寻找 `bun` 或 `bun.exe`，再执行同目录里的 `script.js`。

这说明攻击者的目标不是“一次性偷 npm token”。它更像是在拿开发者工作站做长期落点，再沿着企业工具、IM、代码仓库和内部系统横向移动。

## 六、这不是普通 dependency confusion

很多人会把这类事件归到 dependency confusion。这个判断大体没错，但还不够。

传统 dependency confusion 的核心是：内部包名泄露后，攻击者在公开 registry 发布同名高版本包，利用包管理器解析优先级或版本选择，把公开恶意包装进内部构建环境。

这次更像 dependency confusion、brand impersonation 和 staged malware delivery 的组合。

| 类型                                | 传统风险                           | 这次体现                                                  |
| ----------------------------------- | ---------------------------------- | --------------------------------------------------------- |
| dependency confusion                | 公开包和私有包同名，解析策略错误。 | 未加 scope 的包模仿 `@ali` 私有包命名，诱导目标环境安装。 |
| typosquatting / brand impersonation | 名字相近，靠人工误装。             | `aone-*`、`lzd-*`、`uniapi-*` 等命名贴近目标组织语境。    |
| staged loader                       | 包安装后下载二阶段。               | 远程配置、`setting.js`、平台专属 payload 分层执行。       |
| living off trusted infra            | 借用可信服务降低告警。             | GitHub 获取配置，阿里云形态域名承载后续载荷。             |
| toolchain persistence               | 在开发工具或协作工具里驻留。       | 针对 DingTalk、Wukong、Qoder、`.skills` 目录做后续执行。  |

这也是为什么只靠 lockfile 不够。lockfile 能固定版本，但如果锁定的是恶意版本，或者恶意逻辑来自安装期远程配置，固定版本并不会自动保护你。

同样，只靠 npm registry 下架也不够。包下架之后，已经安装过的机器、缓存里的 tarball、CI 镜像、开发者本地 `node_modules`、全局安装目录和被注入的企业应用仍然需要逐一处理。

## 七、如果你怀疑中招，应该按“开发机失陷”处理

如果环境里出现过上述包名，不建议只执行 `npm uninstall`。

最低限度应该按下面顺序处理：

1. 立刻隔离可疑开发机，保留磁盘和进程证据。不要在原机器上继续登录代码仓库、云控制台或内部系统。
2. 在干净机器上轮换开发者相关凭证，包括 npm token、Git token、SSH key、云 AK/SK、Vault、Kubernetes、Docker、CI/CD、PyPI、RubyGems、Slack、Twilio、内部平台 token 和 IM bot token。
3. 检查项目和全局 npm 依赖，包含 `package.json`、lockfile、`node_modules`、全局安装目录和 CI 缓存。
4. 检查 `.cloud-preferences.json`、可疑 Launch Agent、shell 启动文件、`/tmp` 执行痕迹、Windows 企业应用目录、macOS 用户级后台项。
5. 检查 DingTalk、Wukong、Qoder 等企业工具目录，尤其是被修改的脚本、插件、`.skills` 目录和出现 `# __INJECT_MARKER__` 标记的文件。
6. 回溯网络日志，重点关注到 GitHub 原始内容、可疑 OSS 域名、伪造 DingTalk `Origin` / `Referer` 的请求，以及 `ROBOT_UID=3201d407b7899a12d6d439950511c6a5` 这类环境变量线索。
7. 审计代码仓库近期提交、CI 配置、发布凭证、依赖版本变化和构建产物，确认是否发生二次投毒。

可以先用一些低成本命令做快速排查，但不要把它当成完整取证。

```bash
  npm ls lib-mtop aone-kit aone-kit-cli aone-sandbox local-config-parser smart-config-manager cloud-config-fetcher fast-transform-pipeline node-data-utils
  npm ls aone-cloud-cli colder-cli def-open-client feedback-ai-sdk flight-compare-analyzer lwp-web-client lzd-unified-station-sdk open-worker-cli test-skill-zip uniapi-bridge
```

在 macOS 和 Linux 上，可以补充查隐藏配置和启动项：

```bash
  find "$HOME" -name ".cloud-preferences.json" -print
  grep -R "# __INJECT_MARKER__" "$HOME" 2>/dev/null
  ls -la "$HOME/Library/LaunchAgents" 2>/dev/null
  grep -n "aone-cli\\|cloud-preferences\\|setting.js" "$HOME/.zshrc" "$HOME/.bashrc" 2>/dev/null
  env | grep "ROBOT_UID=3201d407b7899a12d6d439950511c6a5"
```

如果命令命中，不要急着清理。先保存证据，再在隔离环境里分析。供应链攻击的难点不是删文件，而是确认它有没有拿到凭证、改过代码、污染过构建产物。

## 八、长期防护：把 npm 安装当成代码执行面

这类事件对工程团队的提醒很直接：npm 安装不是“下载文本文件”，它本质上就是一个代码执行面。

几个实践比事后查包更重要。

第一，明确私有包解析策略。内部 registry 和公开 registry 的优先级、scope 映射、fallback 行为必须写死并可审计。不要让 `@scope` 之外的相似包名有机会进入内部项目。

第二，限制安装期脚本。对 CI、生产构建和高敏项目，优先使用：

```bash
  npm ci --ignore-scripts
```

这不是所有项目都能无痛启用，因为一些 native addon 或工具链确实依赖 install scripts。但越是敏感环境，越应该把例外列出来，而不是默认允许所有依赖执行脚本。

第三，审 transitive dependencies。PR 里新增一个看似无害的顶层包，可能带来几十个间接依赖。依赖审查不应该只看 `dependencies` 一行，而要看 lockfile diff、发布者、发布时间、install scripts、包体内容和异常网络行为。

第四，对开发者终端做分层信任。开发机通常有 SSH key、云凭证、代码仓库权限、内部 IM、生产排障工具。它的失陷价值不比一台普通服务器低。企业如果只在服务端做 EDR、网络监控和凭证审计，开发者链路会成为薄弱点。

第五，减少长寿命凭证。开发机上的永久 AK/SK、长期 Git token、可直接访问生产的 kubeconfig，都会让一次 npm 投毒升级成组织级事件。短期凭证、设备绑定、最小权限和敏感操作二次确认，才是供应链攻击后的缓冲层。

第六，给内部工具和插件目录做完整性检查。这次攻击之所以危险，是因为它不只停留在 npm 包里，还尝试进入企业协作工具和 AI 工具脚本目录。未来类似攻击会越来越多地盯上 IDE 插件、Agent skills、CLI 扩展和本地自动化脚本。

## 九、归因要克制，响应要果断

公开报道里提到，样本中存在中文注释，GitHub commit 时间也带有 UTC+08:00 特征，因此研究人员推测攻击者可能是中文环境的威胁行为者，并认为目标可能偏向工业间谍活动。

这些判断可以作为情报线索，但不能当成强归因证据。注释语言和时区都可以伪造，也可能来自协作者、模板、测试环境或刻意误导。

对企业响应来说，归因不是第一优先级。真正应该马上回答的是：

- 哪些项目安装过这些包？
- 哪些开发机执行过安装脚本或相关 payload？
- 哪些凭证可能被读取？
- 哪些仓库、CI、发布流水线和内部工具可能被二次污染？
- 哪些网络连接能证明 payload 已经连过 C2？
- 哪些企业应用目录、插件目录或脚本目录被修改？

供应链攻击的响应窗口很短。等到攻击者从开发机拿到内部仓库权限，再去改 CI、发包、替换脚手架或注入企业工具，事件就不再是“某个恶意 npm 包”，而是软件交付链路失去可信起点。

## 十、IoC：把线索整理成可查对象

Socket 原文给出的 IoC 很具体。下面这些不应该直接在日常浏览器里打开，尤其是 defanged URL 和域名，应该放进 SIEM、EDR、代理日志、DNS 日志或威胁情报平台里查询。

| 类型                  | 指标                                                                                                |
| --------------------- | --------------------------------------------------------------------------------------------------- |
| GitHub 账号           | `smi1e2u`                                                                                           |
| GitHub 仓库           | `fast-transform-pipeline`、`smart-config-manager`                                                   |
| 主 C2                 | `xemzqli2vu[.]ai-app[.]pub`                                                                         |
| 反向代理 WebSocket C2 | `diamond-cli-znsxphqell[.]cn-shanghai[.]fcapp[.]run`                                                |
| 配置投递              | `hxxps://raw[.]githubusercontent[.]com/smi1e2u/smart-config-manager/main/defaults/preferences.json` |
| 三阶段 loader         | `hxxps://aone-cli-next[.]oss-cn-beijing[.]aliyuncs[.]com/config/setting.js`                         |
| payload 投递          | `hxxps://aone-ai-cli[.]oss-cn-beijing[.]aliyuncs[.]com/app/release/aone-cli.js`                     |
| payload 投递          | `hxxps://aone-ai-cli[.]oss-cn-beijing[.]aliyuncs[.]com/app/release/aone-cli-deps.tar.gz`            |
| payload 投递          | `hxxps://aone-ai-cli[.]oss-cn-beijing[.]aliyuncs[.]com/app/release/aone-cli`                        |
| payload 投递          | `hxxps://aone-ai-cli[.]oss-cn-beijing[.]aliyuncs[.]com/app/release/aone-cli.zip`                    |
| lib-mtop 后续载荷     | `hxxps://aone-kit[.]oss-cn-beijing[.]aliyuncs[.]com/plugins/crypto.js`                              |
| lib-mtop 后续载荷     | `hxxps://aone-kit[.]oss-cn-beijing[.]aliyuncs[.]com/aone-kit-update/aone-kit.js`                    |
| lib-mtop 后续载荷     | `hxxps://aone-kit[.]oss-cn-beijing[.]aliyuncs[.]com/aone-kit-update/app.asar`                       |
| lib-mtop 后续载荷     | `hxxps://aone-kit[.]oss-cn-beijing[.]aliyuncs[.]com/aone-kit-update/aone-kit-update`                |
| 代码标记              | `# __INJECT_MARKER__`                                                                               |
| 环境变量              | `ROBOT_UID=3201d407b7899a12d6d439950511c6a5`                                                        |

Socket 同时给出了 payload hash：

| SHA-256                                                            | 含义                                                 |
| ------------------------------------------------------------------ | ---------------------------------------------------- |
| `84a6ccaaab1596139d28e822f40cc99c68d337d4c81d1c6d9692c1d6bb22e4af` | 带二阶段 loader 的 `preferences.json`。              |
| `6044974c633b3a319c31bb32110411520c425e89722a64806528553227e7a50a` | 三阶段 `setting.js` loader。                         |
| `0910ecfa049738ef3f2540855341a380df89224ff71da94b4c21689fd66f62e3` | macOS 上部署的 `aone-cli.js`。                       |
| `b8b81af76163bdcc5b4f7d8fe6795f164991f8a62678c971db031b9e90a27813` | Linux 上部署的 `aone-cli`。                          |
| `ef9a1896eeaae929800eade768276e2240ef252d26d0d96c1950a1a5e1aadb34` | Windows 上部署的 `aone-cli.zip`。                    |
| `e5d8350f1540fe91145dc262c455bca7748ad97dafb2d9facd5adebed9f66d2d` | 包含旧版 `aone-cli.js` 的 `aone-cli-deps.tar.gz`。   |
| `41957bd0ba2d9c07af2e069f10780fdf6b2102c065bebe0db2136dfe07d67a28` | `lib-mtop` 链路中的 `crypto.js` 三阶段 loader。      |
| `33b58598eb317553942e27545982d4c25ce6120eae10e42393746eb0e02ecae9` | `lib-mtop` 链路在 Linux 上投递的 `aone-kit-update`。 |

这些 IoC 的价值不是“命中才算中招”。如果攻击者已经更换基础设施，hash 和域名可能失效。但它们仍然能帮助团队回溯历史代理日志、DNS 解析、EDR 文件事件、终端缓存和 CI 构建日志，判断某台机器是否进入过攻击链。

## 十一、给团队的检查清单

可以把这次事件沉淀成一份更通用的 npm 供应链检查清单。

| 检查项        | 具体动作                                                                           |
| ------------- | ---------------------------------------------------------------------------------- |
| registry 策略 | 固定 `@scope` 到内部 registry，禁止未授权 fallback 到公开 npm。                    |
| 包名保护      | 为内部常用包名建立公开 registry 监控，发现同名、近似名、品牌相关包及时告警。       |
| lockfile 审查 | PR 中强制展示 lockfile diff，标出新增发布者、新包、install scripts、近期低下载包。 |
| 安装期执行    | CI 默认禁用 scripts，对必须启用的包建立 allowlist。                                |
| 终端监控      | 覆盖开发者工作站的进程、网络、启动项、脚本目录和敏感文件访问。                     |
| 凭证治理      | 使用短期凭证和最小权限，避免开发机保存可长期访问生产的密钥。                       |
| 工具完整性    | 对 IDE 插件、企业 IM、AI skills、本地 CLI 扩展做哈希或签名校验。                   |
| 事件演练      | 预先准备“恶意包已安装”的响应流程：隔离、取证、轮换、回溯、重建。                   |

这份清单看起来不如“装一个安全扫描器”简单，但更接近真实防线。扫描器能发现一部分已知恶意包，挡不住所有利用企业命名习惯、远程配置和本地工具链的定向攻击。

## 结语：攻击者开始认真研究开发者工作流

这次针对阿里开发者生态的 npm 投毒，真正值得警惕的不是某一个包名，而是攻击者对开发者工作流的理解。

它知道企业有私有包和内部 scope，知道开发者会安装 CLI 和 SDK，知道 Node.js 工具链在安装期可以执行代码，知道 `vm` 容易被误当成沙箱，知道开发机上有协作工具、AI 工具、云凭证和代码仓库权限。

这说明软件供应链攻击正在从“污染开源包”走向“贴着组织研发流程设计投递链”。防守也必须从包名黑名单升级到工程系统治理：registry 边界、依赖审查、安装期限制、开发机安全、凭证最小化、工具完整性和事件响应流程缺一不可。

对开发团队来说，最实际的一句话是：**不要把依赖安装看成构建前的准备动作，它本身就是生产系统安全的一部分。**

参考资料：

- [A new wave of malicious npm packages targeting Alibaba tools](https://ghost-protocol.app/news/npm-targeting-rat-2433)
- [Socket: npm RAT targets Alibaba](https://socket.dev/blog/npm-rat-targets-alibaba)
- [Malicious npm Packages Deploy Cross-Platform RAT Targeting Alibaba Developers](https://cybersecuritynews.com/npm-packages-cross-platform-rat/)
- [18 Malicious npm Packages Deploy Cross-Platform RAT Against Alibaba Developers](https://gbhackers.com/18-malicious-npm-packages/)
