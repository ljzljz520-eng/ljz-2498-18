# Catalpa 文稿台：位置同步与稳定锚点

本项目基于 **Vue 3 + Vite**，实现编辑区与渲染预览区之间的文稿位置同步。同步不以两个容器的滚动百分比硬换算，而使用“源节点 / 布局节点”的区间映射，并以浏览器真实测量校正服务端布局索引。

## 核心能力

- 编辑与预览可 **锁定联动**，也可解除锁定后各自滚动。
- 渲染服务返回不可变布局版本、布局节点以及布局节点到源节点的区间映射。
- 一个源表格可拆成多个页面片段；续页重复表头也会映射回同一个源表格。
- 一个预览段落可对应多个源行；源定位保存为节点指纹、源行、行内比例、节点比例和标题路径。
- 浏览器实时测量与服务端布局索引比较，按布局节点进行误差校正；无映射或请求失败时自动降级为比例同步。
- 代码折叠、图片 `load/error`、窗口缩放、字体替换和重新渲染后自动重定位。
- 双向滚动事件携带发起端，并用反馈门忽略程序性滚动回声，避免无穷跳动。
- 数据库按用户和文稿保存个人阅读位置；异步回包、保存和会话切换均校验文档身份。
- 恢复旧书签时优先使用节点指纹，行号越界会收敛到节点区间；无法识别时安全回到顶部。

## 快速开始

```bash
corepack prepare pnpm@latest --activate
pnpm install
pnpm dev
pnpm test
pnpm build
```

> 当前环境如果没有 `pnpm`，也可临时使用 `npm install && npm test && npm run build`。

## 目录结构

```text
src/
├── App.vue                         # 双栏、锁定/解锁、状态提示和文稿切换
├── composables/
│   └── useDocumentWorkspace.js     # 滚动联动、重定位、恢复、保存和生命周期
├── core/
│   ├── sourceDocument.js           # 源 Markdown/Catalpa 解析，生成稳定源节点
│   ├── positionMapping.js          # 区间映射、双向定位、实测校正和旧书签修复
│   ├── feedbackGate.js             # 发起端标记与程序性滚动回声抑制
│   └── requestIdentity.js          # 乱序回包、会话和文档身份守卫
├── data/demoDocuments.js           # 长表、图片失败、快速切文稿演示
├── services/
│   ├── layoutServer.js             # 模拟异步渲染后端与分页/映射回包
│   └── readingDatabase.js          # IndexedDB 布局版本与个人位置存储
└── style.css
database/schema.sql                 # 真实后端的布局表和阅读位置表参考
tests/                              # Node 内置 test runner 单元测试
```

## 映射模型

源节点：

```ts
type SourceNode = {
  id: string
  type: 'heading' | 'paragraph' | 'table' | 'code' | 'list' | 'quote' | 'hr'
  lineStart: number
  lineEnd: number
  fingerprint: string
  headingPath: string[]
}
```

布局区间：

```ts
type SourceRange = {
  layoutNodeId: string
  sourceNodeId: string
  sourceNodeFingerprint: string
  sourceLineStart: number
  sourceLineEnd: number
  ratio: number        // 源表格行在整个源节点中的比例
  y: number            // 服务端布局内容坐标
  height: number
  innerY: number       // 该源区间在布局节点内部的起点
  innerHeight: number
}
```

源行是一对多关系：

- 长表格的第一个布局片段覆盖表头、分隔线和首批数据行。
- 续页片段包含两个源区间：重复表头和该页数据行，因此预览表头和正文都能映射回源表格。
- 段落由连续源行组成，保存的是该节点内行比例，而不是“预览高度 / 预览总高度”。

## 浏览器实测与误差校正

1. 渲染服务先给出服务端 `y/height` 和源区间。
2. 前端在滚动、图片完成、折叠、缩放或字体替换后读取真实 DOM 的 `getBoundingClientRect()`。
3. 若布局节点存在真实测量值，就把服务端节点内部坐标仿射映射到实测坐标。
4. 若节点已不存在或测量值不足，使用相邻实测锚点插值；仍无可用锚点时保持服务端索引。
5. 没有映射、映射版本过期或后端请求失败时，状态标记为 `percentage-fallback`，仅做临时比例联动；保存仍优先保留源节点书签。

## 防反馈循环

`feedbackGate` 为每次程序性滚动记录：

- 发起端：`editor`、`preview`、`restore` 或 `relayout`；
- 期望 `scrollTop`；
- 浏览器钳制容差；
- 过期时间和最近一次已应用位置。

对端收到滚动事件后，若事件是程序性写入的回声则忽略；超过 TTL、用户再次拖动或位置显著改变时不会继续吞事件。每次同步只沿一个方向传播，因此不会在两侧反复修正形成无穷跳动。

## 数据库

`database/schema.sql` 提供后端参考：

- `layout_versions`：不可变布局版本。
- `layout_source_ranges`：布局节点与源节点/源行区间的多对多关系。
- `reading_positions`：`(user_id, document_id)` 唯一的个人阅读位置。

前端演示使用 IndexedDB：

- `layout_versions`
- `reading_positions`

IndexedDB 不可用时会退到内存 Map。实际生产中应由渲染服务和用户服务写入 SQL/文档数据库，前端只按布局版本请求映射。

## 已覆盖的测试场景

```bash
pnpm test
```

- 长表拆成多个布局片段，续页重复表头仍映射到源表格。
- 源行定位到正确布局片段；预览位置反向定位到源行。
- 浏览器实测相对服务端索引发生偏移时进行校正。
- 无映射时明确返回 `none`，由 UI 降级而不是伪造精确位置。
- 旧书签按指纹修复，越界行号收敛到节点区间。
- 程序性滚动回声被忽略，TTL 后用户滚动恢复生效。
- AbortController 取消渲染请求。
- 映射回包乱序、文稿切换或用户身份不一致时拒绝采用。
