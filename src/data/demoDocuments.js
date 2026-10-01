const tableRows = Array.from({ length: 38 }, (_, index) =>
  `| ${index + 1} | 长表行 ${index + 1} | ${index % 3 === 0 ? '跨页后仍可定位' : index % 3 === 1 ? '懒加载图片可能改变高度' : '缩放后需要重测'} | ${20 + index} |`)

const longTable = `# 长表拆页与稳定锚点

下面的源表格会被渲染后端拆到多个页面片段。每一行仍保留自己的源行号，每个片段都有独立布局节点，映射是多对多区间，而不是两个滚动容器的百分比。

![可用图片](/demo-image.svg)

| 序号 | 源节点 | 验证点 | 值 |
| --- | --- | --- | --- |
${tableRows.join('\n')}

![懒加载失败的图片](/missing-image.svg)

表格后面的段落用于验证图片失败占位和跨页之后恢复位置。

## 折叠代码
\`\`\`js
function relocateAfterMutation() {
  const anchor = captureStableAnchor()
  await nextFrame()
  const measured = measureDom(anchor)
  applyCorrection(measured)
}
\`\`\`

最后一个标题用于旧书签恢复。
## 表格后的锚点
这里记录的是源节点指纹、源行号、行内比例和标题路径，不记录裸百分比。
`

const normal = `# Catalpa 编辑器

欢迎使用 **Catalpa 实时预览**。

## 基础语法
- 支持标题、列表、引用
- 支持 *斜体* 与 **粗体**
- 支持 [链接](https://vuejs.org/)

> 右侧预览可以和左侧锁定，也可以各自滚动。

### 代码块
\`\`\`js
const message = "Hello Catalpa"
console.log(message)
console.log('fold changes height')
\`\`\`

切换字体、缩放窗口或折叠代码后，系统会重新测量真实 DOM，而不是沿用旧偏移。
`

const second = `# 第二篇文稿

快速切换文稿时，未完成的映射响应和保存请求都必须带文档身份。

## 不应串写位置
- 在第一篇滚动
- 立即切换到第二篇
- 第一篇的迟到保存不能覆盖第二篇记录

![第二篇图片](/demo-image.svg)

结尾段落。
`

export const demoDocuments = [
  { id: 'doc-long-table', title: '长表拆页', source: longTable },
  { id: 'doc-normal', title: '基础文稿', source: normal },
  { id: 'doc-switch', title: '切换验证', source: second },
]
