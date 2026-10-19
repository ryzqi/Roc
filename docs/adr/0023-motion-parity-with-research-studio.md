# 动效与页面视觉回到 `research-studio` 口径

P10 的切换提交（ADR 0022）删掉了旧前端，但**保留**了它的设计权威地位：`design-system/MASTER.md` v2 的
`source:` 一栏写的就是「research-studio 前端（设计权威）」。落地时有两处是**刻意不照抄**的，都记录在代码
注释里，理由都是预算或契约：

1. **画布 tab 指示器**：参考用 `motion.div layoutId` 弹簧滑动，新壳改成每个 tab 自己 120ms 透明度过渡。
   `WorkspaceCanvas` 的注释给出的实测是 `1,075,296 B`（带 layoutId）对 `690,349 B`（不带），差 ~385 KB，
   而当时自定的 eager 天花板是 900 KB。
2. **视图切换**：`MASTER.md` §11 写「视图切换直接切，不做路由 fade」，参考实际是
   `AnimatePresence mode="wait"` + 120ms 透明度。

除此之外还有一批参考里的动效从未搬过来：`index.css` 的 `fadeIn` / `scaleIn` / `slideInRight` 三个关键帧与
工具类（新壳一个都没有），以及 `AgentChat` 的下拉与折叠动画。

## 决定

- **动效引擎统一用 `motion/react`**（已是依赖，`main.tsx` 早就挂了 `MotionConfig reducedMotion="user"`）。
  预设、时长、缓动集中到 `src/renderer/shared/motion.ts`，照抄参考，不另造第二套刻度。
- **`MASTER.md` §11 的「不做路由 fade」作废。** 视图切换恢复 120ms 淡入淡出；画布 tab 指示器恢复共享
  `layoutId` 弹簧滑动。规范真身随之改为 `shared/motion.ts` + `styles/index.css`，不再是那份文档
  （该文档已在 `1da2e0e9` 清理提交里删除）。
- **三个关键帧与工具类原样搬回**（`fadeIn` 150ms / `scaleIn` 180ms / `slideInRight` 200ms，全部
  `cubic-bezier(0.16, 1, 0.3, 1)`），未加层，与参考的层叠行为一致。
- **浮层补上退出动画**：模态 180ms 缩放、抽屉 200ms 右侧滑入、遮罩淡入淡出。参考只写了进入（Git 抽屉用的
  `animate-in slide-in-from-right` 还需要那个从未安装的 `tailwindcss-animate`，所以实际上是死类）。
  `ModalShell` 原本 `if (!open) return null`，退出动画需要 `AnimatePresence` 留住一帧，改为在
  `open` 分支内渲染。
- **折叠块用原生 `<details>` 动画，不用 `AnimatePresence`。** 见下。
- **页面视觉按参考逐面对齐**，`data-testid` 与七个阶段闸门允许同步修改。
- **图标色相成为 token**：参考行内写的 `text-sky-400` / `-amber-400` / `-emerald-400` / `-purple-400`
  变成 `--icon-*`。深色用 400 档（与参考完全一致），浅色降到 600 档。
- **动效额度由闸门守，不由注释守**：`pnpm check:renderer-chunks` 的 `1,700,000 B` 是唯一的额度真身。

## 理由

1. **原约束已经不成立，是它而不是设计意图在挡。** 让 P1 拒绝动画的是 900 KB 自定天花板；真实预算是
   `check-renderer-chunks.mjs` 里的 `1,700,000 B`，P10 实测 `917,865 B`。加回布局投影后实测
   `1,321,798 B`（+403,933 B），仍有 378 KB 余量。继续用「预算」当理由会把一个过期数字当成规范。
2. **`motion` 不在 deny-list 上。** `scripts/lib/renderer-chunk-attribution.mjs` 的
   `EAGER_FORBIDDEN_PACKAGES` 列的是 `react-diff-view` / `@xterm/*` / `katex` / `highlight.js` /
   `react-markdown` / `streamdown` / `react-virtuoso` / `zod`，`motion` 不在其中 —— 它本来就已经
   eager（`MotionConfig`）。所以「动画的代价」是一次可以量出来的字节，不是一次架构让步。
3. **一个数字出现在注释里就是会过期。** 「22% 的预算」这条注释对了半年，期间预算和三处依赖都变了。
   既然约束能被脚本断言，就该由脚本守。
4. **`AnimatePresence` 不只是好看。** 「滚动到最新」按钮原先用 CSS 淡出，必须保持挂载，于是在转录上留下
   一个 28px 的隐形命中区。`AnimatePresence` 退出后真的把它从 DOM 摘掉。

## 代价

- **eager 体积 +403,933 B**（917,865 → 1,321,798 B）。真实余额从 782 KB 降到 378 KB，后续再加
  Markdown 或编辑器类依赖时要先量。
- **首屏多解析约 0.4 MB JS**，冷启动路径变长。`pnpm smoke:performance` 是这条的守门人。
- **`ModalShell` 的 `if (!open) return null` 被移除**，退出的一帧里子树仍在 DOM 中。为此加了
  `openRef`：退出期间的闭包读到的 `open` 是过期的 `true`，不读实时值会让一次误点关两次。
- **参考里有两处不照抄**，都属于「照着做会破坏功能」而不是省事：
  - **不画假红绿灯**。参考在浏览器里跑，所以自己画了三个圆点；这个窗口是
    `titleBarStyle: 'hiddenInset'` + 真实 `trafficLightPosition`，照抄会出现六个灯。
  - **助手头部不做模型下拉**。`settings.save` 是**整文档**保存而非 patch（`SettingsSaveRequest`），
    设置中心持有那份文档的脏草稿；助手再开一个写入口就会成为整文档资源的第二个写者。参考下拉的最后
    一行本来就是「设置模型与服务」，所以这里直接把 pill 指向设置中心，尾随图标用 `Settings2` 而不是
    会许诺一个不存在的菜单的 `ChevronDown`。
- **折叠块是 CSS 而不是 `motion`**：参考用 `AnimatePresence` + `height: 0 → auto`，但它是 `motion.div`；
  这里的折叠块是**原生 `<details>`**（键盘、读屏、流式期间可用都来自这一点）。要照抄就得把 `<details>`
  换成 button + region，把这些性质丢掉。改用 `::details-content` +
  `interpolate-size: allow-keywords`，两个方向都是真动画，语义不动。本机 Electron 44 的 Chromium 是
  **152**（实测 `process.versions.chrome`，不是假设），两个特性都在；万一将来不在，退化表现是「没有位移
  的瞬时展开」，块仍然可用。
