# dsh-rewind

DeepSeek Harness 插件：**把对话就地回退到任意一条自己发过的消息**，可连这一轮改过的文件一起还原，原文自动放回输入框，改完直接重发。

## 它做了什么

| 能力 | 说明 |
| --- | --- |
| 就地回退 | 目标消息及之后的内容从**模型上下文**中撤回，对话仍在原会话里，不新建分支 |
| 日志不删改 | 只追加一条回退标记（`user/message` + `surfaceOp: replace`），历史、轨迹、审计全部保留 |
| 文件快照 | 写入前捕获 `write` / `edit` / `delete` 触及的文件，回退时按轮次还原或删除 |
| 停止并编辑 | 还在生成的回合，按钮变成铅笔：停止当前生成、撤回这条消息、原文回填输入框 |
| 仅还原文件 | 浮层第三个选项：只还原这一轮改过的文件，对话原样保留 |
| 计划失效 | 预览之后文件又被改动，执行会被拒绝并提示重新预览 |
| 未读插话 | 模型还没读到的 steering 消息可单独撤回，不打断正在生成的回复 |
| 忽略规则 | 工作区根目录 `.dsh-rewindignore` 匹配到的路径不记录（`*`、`**`） |
| 子会话保护 | 子代理会话不能单独回退，Host 直接拒绝并提示去主会话操作 |
| 磁盘保护 | 数据盘剩余不足 200 MB 时暂停记录快照；还原目标盘空间不足时直接拒绝 |
| 双击 Esc | 空闲时连按两次 Esc 打开回退历史 |
| 候选面板 | 输入框下方「回退历史」按钮打开全部可回退消息，标题右侧显示该会话已回退次数 |
| 草稿保护 | 回退时输入框已有内容会先存到本机，「回退历史」里可一键恢复 |
| 附件提示 | 目标消息带图片/文件时明确提示「只回填文字」，不静默丢附件 |
| 隔离区 | 还原时被覆盖或删除的内容按会话分组留档；可逐条写回文件、删除或整体清空（写回前会把当前内容再留档） |
| 选择性还原 | 浮层里逐个勾选要还原的文件，默认全选 |
| 差异预览 | 每个文件可展开查看「当前 → 还原后」的行级 diff（− 会被移除，+ 会写回） |
| 冲突提示 | 文件在回退点之后被外部改过，行尾标「之后被改动」，不会悄悄覆盖 |
| 输入框回填 | 撤回的原文写回输入框，改完直接重发 |
| 渲染同步 | 被撤回的轮次在对话里隐藏，重发新消息不会误伤新内容 |
| 确认浮层 | 先列影响范围（原文、受影响文件、将还原还是将删除），再执行 |
| 设置页 | 设置 → 内置插件 → 回退对话：快照状态、容量上限、隔离区、清空 |
| 命令入口 | `/rewind` 列出可回退消息，`/rewind <序号>` 回退，`/rewind <序号> files` 连文件一起还原；`/undo` 一键撤回最近一轮 |
| 命令回填 | 命令执行后原文同样自动回到输入框（Host 排队、客户端消费一次） |
| 自检 | `GET /api/dsh-rewind/selfcheck` 报告接线状态、最近告警，以及 blob/隔离区的完整性（缺失、孤儿、损坏行）；设置页顶行直接显示结果 |

## 安装

本机（开发目录，`link:` 方式，和 `dsh-mcp` / `dsh-session` 一致）：

```sh
dsh plugin --profile web add ~/Documents/code/dsh-plugins/dsh-rewind
```

或已发布版本：

```sh
dsh plugin --profile web add @netcatty/dsh-rewind
```

装完刷新页面即可：你自己每条消息的「复制」按钮旁会多一个 `↶`。

## 使用

1. 在你自己那条消息下方（时间与「复制」按钮旁）点 `↶`；这条消息还在生成时，图标是铅笔 `✎`，点它等于「停止并编辑」。
2. 浮层显示这条消息的原文、受影响文件，以及两个选择：
   - **只回退对话**（默认）
   - **对话和文件**（仅在有文件改动时出现；每个文件一个复选框，可只还原一部分）
3. 确认后：消息从上下文与对话中撤回，原文回到输入框。

键盘：`Esc` 或点浮层外关闭。候选面板打开时 `↑`/`↓` 移动、`Enter` 打开确认、`Esc` 收起。

命令：输入 `/rewind` 看候选列表，`/rewind 2` 回退到第 2 条（1 = 最近），`/rewind 2 files` 连文件一起还原；`/undo` 等价于 `/rewind 1`，`/undo files` 连文件一起撤回。命令回执里带原文，复制后即可重发。

## 插件市场索引

包内附带一份 format-1 索引 `index.json`，可在「插件 → 发现 → 索引源」添加：

```
https://cdn.jsdelivr.net/npm/@netcatty/dsh-rewind@0.1.6/index.json
```

之后搜索「回退」或「rewind」即可安装，不需要记包名；也可以继续用 `dsh plugin add @netcatty/dsh-rewind`。

## 数据位置

```
$DSH_HOME/dsh-plugins/dsh-rewind/archive/
  index.json            按 <会话>|<轮次> 记录每个文件的改动前状态
  blobs/<sha256>.bin    改动前的字节
```

单文件上限 2 MiB、每轮最多 200 个文件、全局最多 500 轮；`.git` 目录下的内容永不记录。

三个上限和「捕获文件改动」开关都在「设置 → 内置插件 → 回退对话」里直接改，保存在 `~/.dsh/dsh-plugins/dsh-rewind/settings.json`，保存后立即生效（会重建归档实例）。`cordis.patch.yml` 插件行里的同名值作为默认值；只有 `archiveDir` 仍只能在那里配置。

设置页（设置 → 内置插件 → 回退对话）显示轮次/文件数/占用/隔离区与实际的快照目录，可分别清空快照与隔离区；对应 `GET /api/dsh-rewind/stats`、`POST /api/dsh-rewind/clear`、`POST /api/dsh-rewind/clear-quarantine`（均需 `confirm: true`）。

## 边界与安全

- **只支持打开中的会话**：就地回退要写 live Session 的 surface，冷会话会返回 409 并提示先打开它。
- **停止并编辑会中断生成**：这是按钮的本意；点「取消」不会影响正在生成的回复。
- **附件不回填**：客户端拿不到把 durable attachment 转成草稿附件的公开接口，所以只回填文字并提示数量。
- **仅还原文件**不碰对话，也不取消正在生成的回合（会等它结束后再写文件）。
- **steering 回退是防御性的**：代码在目标消息仍在 `inbox.nextStep` 时跳过 cancel，但 0.2.2-rc.1 的「插话发送」实际会排到下一轮，正常使用中构造不出该状态。
- **压缩兼容**：已实测「回退后手动 `/compact` 正常压缩、压缩后继续对话正常」；目标消息若在最近一次压缩之前，回退会被拒绝（它已不在模型上下文里）。
- **只追加，不重写**：会话日志（JSONL/zstd 工件）一个字节都不改，回退只是多一条标记事件。
- **文件还原只覆盖插件记录过的路径**：路径来自运行时捕获的绝对路径，永不来自请求体；`.git` 内文件跳过；目标变成符号链接时跳过不写。
- **不做无损撤销**：本版没有"撤销回退"。回退后重新发送是推荐路径；日志里被撤回的内容仍可在轨迹视图与导出中查看。
- **HTTP 面**：与 `dsh-session` 相同，`/api/dsh-rewind/*` 走 DSH 自己的 `connection.admit` 鉴权，无该服务时退回 loopback / 同源校验；请求体上限 64 KiB。
- 快照捕获依赖 Harness 的 `fs/*-intent` 瀑布，因此 `bash` 直接写文件、git 操作、外部工具改动不在保证范围内。

## 版本矩阵

| 项 | 值 |
| --- | --- |
| `engines.dsh` | `>=0.2.2-rc.1`（低于此版本宿主会拒绝加载） |
| 实测环境 | DSH `0.2.2-rc.1`，Web profile，Node 24 |
| 未验证 | `0.2.1` 及更早（`surfaceOp` 契约不同），以及 desktop/其他 profile |

插件依赖的宿主契约，全部按「有则用、无则降级」处理：

| 契约 | 用途 | 缺失时 |
| --- | --- | --- |
| `Session.append(type, data, { surfaceOp, sourceEventSeqs })` | 就地回退的唯一写入 | 返回 503「当前版本不允许就地回退」 |
| `sessionQuery.readSession` / `readSurface` | 读日志与模型上下文 | 回退到 live Session 的 `snapshotEvents()` / `surface.nodes` |
| `fs/write-intent`、`fs/edit-intent`、`fs/delete-intent` | 捕获改动前字节 | 不注入 `fs` 时只做对话回退，文件快照为空 |
| `tools/pre-execute` | 把工具执行映射回会话 | 无法归属写入，快照被跳过 |
| `webServer.register({ kind: 'prefix' })` | 客户端调用面 | 命令仍可用，UI 入口静默缺失 |
| `commands.register` | `/rewind`、`/undo` | 按钮仍可用 |
| Client slots：`conversation.composer.dock`、`settings.plugins.tab` | 按钮注入、浮层、设置页 | 该入口缺失，其余不受影响 |
| `react-dom` 的 `createPortal` | 浮层挂到 `body` | 退回树内渲染（位置可能被 dock 容器带偏） |

## 并发与锁

| 场景 | 行为 |
| --- | --- |
| 同一会话并发两次回退 | Host 用 `inFlight` 串行，第二次返回 409 `busy` |
| 两个窗口同时操作同一会话 | 同上；状态每 4 秒轮询，落后的一方会看到 409 |
| 归档写入 | 单进程内 `serialize` 队列，`index.json` 原子写（临时文件 + rename） |
| 会话日志 | 插件只 append，宿主负责串行与持久化；插件从不改工件 |
| 会话正在生成 | 回退先 `cancel` 并等待 idle（20 秒上限），否则 409 |
| 仅还原文件 | 不取消生成，等回合结束后再写 |
| 外部编辑器同时写同一文件 | 没有文件锁；冲突标记（mtime + 大小）只是提示，最后写入者获胜 |
| 磁盘不足 | 快照侧停记并告警；还原侧返回 507 |

## 开发

```sh
npm run check   # 语法 + 可导入
npm test        # 46 个单测
```

覆盖范围：

| 文件 | 覆盖 |
| --- | --- |
| `surface.test.mjs` | 候选排序、遮蔽范围、marker 载荷、多个 marker 的撤回并集 |
| `surface-extra.test.mjs` | 空会话、最后一个节点、Turn 外消息、Turn 前 marker、limit |
| `store.test.mjs` | 写前快照、`existed:false`、跨 Turn 最早优先、`.git` 跳过、超大文件、重开索引 |
| `store-limits.test.mjs` | `maxTurns` 裁剪、隔离区上限、相同内容共享 blob |
| `restore.test.mjs` | 选择性还原、未变跳过、新建文件删除、跨 Turn 最早快照 |
| `restore-edge.test.mjs` | 符号链接拒绝、二进制逐字节、空文件、目录不记录 |
| `quarantine.test.mjs` | 覆盖留档、删除留档、未变不留档、清空 |
| `integrity.test.mjs` | 健康、缺 blob、孤儿 blob、损坏 manifest 行 |
| `diff.test.mjs` | 相同/单行/上下文压缩/新增文件/超限/行数上限 |

未覆盖：Client 的 DOM 注入与浮层（手工验证）、HTTP 路由鉴权、真实会话的端到端（手工压测）。

## 许可

MIT
