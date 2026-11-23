# 终端显示与会话生命周期

写作中的终端使用主进程唯一的 `TerminalSessionService` 持有真实 PTY。显示组件负责 xterm、尺寸观察与事件订阅；切换工具、切换画布、隐藏窗口或组件卸载只分离显示，不结束运行中的命令。再次进入同一项目和工作目录时重新连接该会话。

## 身份与权限

- `terminal.attachSession` 按真实 IPC `webContents.id`、项目 ID、当前绑定工作目录和初始 cwd 找到或创建会话。输出及退出事件也只发送给该真实窗口；项目工作目录与归档状态由已有数据库合同校验；cwd 必须位于当前工作区。
- 项目权限由启动层注入的 `ResearchProjectWorkspaceContract` 从科研插件数据库读取；工作区插件只持有自己的数据库，不能直接查询 `research_projects`。首次连接、恢复连接、输入和尺寸更新都核验当前项目，项目被归档、删除或改绑目录后拒绝继续操作；分离与显式结束仍允许清理旧会话。未注入项目校验接口时拒绝项目终端。
- 返回的 `attachmentId` 是主进程生成的一次显示连接令牌。重新连接会更新令牌；旧显示迟到的 `detachSession` 无效，旧令牌不能输入、调整尺寸或结束新显示正在使用的会话。
- 输入与调整尺寸还必须匹配当前工作区。切换项目后，旧显示仅能用自己的身份分离或显式结束旧会话，不能向另一个项目输入。
- 每个窗口最多保留 16 个会话，包括已退出但可回读的会话。达到上限后返回可见错误，用户需回到已有终端结束不再使用的会话。窗口身份不能由 renderer 参数提供；主进程直接调用使用独立的保留身份 0。

## 输出恢复

每个会话在主进程保留最近 262,144 个 UTF-16 单元，约 512 KiB 的字符串载荷。输出事件携带 `startSequence`、`sequence`、`attachmentId`；序号按 JavaScript 字符串单元递增。16ms 批处理只合并同连接的连续区间。

连接回包带有当前会话状态与缓冲快照。显示先订阅，再请求连接，将回包到达前的事件暂存于同样有界的队列中。新 xterm 先写入快照，再依据序号裁掉与实时事件重叠的前缀；旧令牌、旧会话及已显示区间不会重复写入。

缓冲超限时不承诺完整历史：回放舍去首个不完整行，不从 UTF-16 低代理单元开始，并重置新的终端解释器；界面显示“已恢复最近输出；更早内容超出回放容量，终端显示已重置。” 极端连接延迟造成暂存区间缺口时也显示此提示并重置。现有终端日志继续使用原来的磁盘写入及背压合同，不把磁盘日志整体加载回 renderer。

隐藏时没有 xterm DOM、ResizeObserver 或 renderer 输出订阅；PTY 继续记录有界输出。隐藏期间自然退出的会话保留真实退出码和最终输出，再次进入显示已退出，用户可显式重新连接新进程。

## 结束与清理

“清屏”只清除当前 xterm 显示，不清除主进程回放缓冲，也不影响 PTY。“结束会话”先确认终止正在运行的命令，再调用 `closeSession`；自然退出后的“重新连接”先释放旧记录再启动新会话。

主窗口的 `webContents` 真正销毁时，内部 `terminal.owner.closed` 事件释放该窗口所有 PTY 和日志流。普通隐藏不会触发此事件。应用退出时 workspace 插件 `shutdown` 释放全部会话；这些会话不会持久化到下一次应用启动。项目切换保留原窗口拥有的后台会话，重新进入原项目才可恢复其显示；重新绑定目录不能把旧会话当作新目录的会话。

## 验证

```sh
node --test tests/unit/workspace-terminal-project.test.mjs tests/unit/terminal-session-lifecycle.test.mjs tests/unit/terminal-ipc-owner.test.mjs tests/integration/terminal-session-reattach.test.mjs
node --test --test-concurrency=1 tests/renderer/authoring-tools-layout.test.mjs
pnpm check:ipc
pnpm typecheck
```

单元测试覆盖背压、延迟分离、旧令牌拒绝、项目/窗口隔离、容量、缓冲截断、序号交叉去重、批处理和 IPC 窗口绑定；分离的工作区与科研 SQLite 数据库回归验证项目权限来自所属库，并在保留会话期间重查归档、删除与目录变更。真实 node-pty 集成测试验证隐藏期间同一个 shell PID 继续存活、后台输出可恢复、恢复后的输出连续，以及显式结束、窗口销毁对应的 owner 释放和应用 shutdown 后 PID 消失。Electron 回归覆盖隐藏释放 xterm、返回恢复、结束确认和截断提示。应用 smoke 等待真实连接就绪，并要求 shell 生成完整输出行，输入命令的回显不能满足断言。测试临时目录在结束时清理。
