<script setup>
import { computed, onMounted, ref } from 'vue'
import { useManuscriptSync } from './sync/useManuscriptSync.js'

const docs = ref([
  {
    id: 'doc-demo',
    title: '入门示例',
    source: `# Catalpa 编辑器

欢迎使用 **Catalpa 实时预览**。

## 基础语法
- 支持标题、列表、引用
- 支持 *斜体* 与 **粗体**
- 支持 [链接](https://vuejs.org/)

> 右侧预览会跟随左侧编辑器实时更新。

### 代码块（超过 8 行可折叠）
\`\`\`js
function fib(n) {
  if (n < 2) return n
  return fib(n - 1) + fib(n - 2)
}
for (let i = 0; i < 12; i += 1) {
  console.log(i, fib(i))
}
\`\`\`

图片（懒加载成功）：![ok](/ok.svg)
图片（懒加载失败也会重定位）：![broken](/does-not-exist.png)
`,
  },
  {
    id: 'doc-long',
    title: '长表拆页稿',
    source: buildLongDoc(),
  },
])

function buildLongDoc() {
  const lines = []
  lines.push('# 季度数据长表（排版服务会拆成多页）')
  lines.push('')
  lines.push('下表的一个**源表格节点**在渲染后端会被拆到多个页面分片，用于验证“一个源表格跨多页”的区间映射。')
  lines.push('')
  lines.push('| 序号 | 项目 | 数值 | 状态 |')
  lines.push('| --- | :--- | ---: | :--: |')
  for (let i = 1; i <= 60; i += 1) {
    lines.push(`| ${i} | 条目 ${i} | ${(i * 137) % 1000} | ${i % 3 === 0 ? '完成' : '进行中'} |`)
  }
  lines.push('')
  lines.push('## 表后说明')
  lines.push('这一段普通段落由多个源行组成，它们在渲染端合并为**同一个预览段落节点**，')
  lines.push('因此不能按两个容器的滚动百分比做硬同步，必须落到源行区间上。')
  lines.push('区间锚点会在代码折叠、图片加载与字体替换后重新定位，并对服务端布局索引做误差校正。')
  lines.push('')
  lines.push('```js')
  for (let i = 1; i <= 14; i += 1) lines.push(`const line${i} = ${i};`)
  lines.push('```')
  lines.push('')
  lines.push('![缺失图片](/missing.png)')
  lines.push('')
  lines.push('## 结尾')
  lines.push('旧书签会在布局版本变化后按分片签名迁移；乱序回包会被请求序号丢弃。')
  return lines.join('\n')
}

const {
  currentDocId,
  previewHtml,
  locked,
  mode,
  status,
  syncStats,
  editorEl,
  previewEl,
  mount,
  toggleLock,
  switchDoc,
  setServiceMode,
  failNextMapping,
} = useManuscriptSync(docs)

const sourceModel = computed({
  get: () => docs.value.find((d) => d.id === currentDocId.value)?.source ?? '',
  set: (v) => {
    const doc = docs.value.find((d) => d.id === currentDocId.value)
    if (doc) doc.source = v
  },
})

onMounted(mount)

const serviceMode = ref('normal')
function changeMode(e) {
  serviceMode.value = e.target.value
  setServiceMode(serviceMode.value)
}
</script>

<template>
  <div class="page">
    <header class="hero">
      <div>
        <p class="eyebrow">Catalpa 文稿台 · 位置同步</p>
        <h1>编辑与预览</h1>
        <p class="subtitle">区间映射 + 稳定锚点：支持锁定跟随、各自滚动、长表拆页与旧书签迁移。</p>
      </div>
      <div class="stats">
        <span :class="{ 'mode-pill': true, degraded: mode === 'ratio' }">
          {{ mode === 'mapping' ? '映射同步' : '比例降级' }}
        </span>
        <span :class="{ locked: locked }">{{ locked ? '🔒 已锁定' : '🔓 各自滚动' }}</span>
      </div>
    </header>

    <div class="doc-tabs" role="tablist">
      <button
        v-for="doc in docs"
        :key="doc.id"
        type="button"
        class="doc-tab"
        :class="{ active: doc.id === currentDocId }"
        @click="switchDoc(doc.id)"
      >
        {{ doc.title }}
      </button>
    </div>

    <main class="workspace">
      <section class="panel editor-panel">
        <div class="panel-header">
          <h2>编辑区</h2>
          <div class="actions">
            <button class="ghost-btn" type="button" @click="toggleLock">
              {{ locked ? '解锁（各自滚动）' : '锁定（双向跟随）' }}
            </button>
          </div>
        </div>
        <textarea
          ref="editorEl"
          v-model="sourceModel"
          class="editor"
          placeholder="在这里输入 Catalpa 内容..."
          spellcheck="false"
        />
      </section>

      <section class="panel preview-panel">
        <div class="panel-header">
          <h2>预览区</h2>
        </div>
        <article ref="previewEl" class="preview markdown-body" v-html="previewHtml"></article>
      </section>
    </main>

    <footer class="statusbar">
      <span class="status-text">{{ status }}</span>
      <div class="debug">
        <label>排版服务：
          <select :value="serviceMode" @change="changeMode">
            <option value="normal">正常</option>
            <option value="out-of-order">乱序回包</option>
          </select>
        </label>
        <button class="ghost-btn" type="button" @click="failNextMapping">注入一次映射失败</button>
        <span class="stat">请求 {{ syncStats.requests }}</span>
        <span class="stat">丢弃 {{ syncStats.stale }}</span>
        <span class="stat">失败 {{ syncStats.errors }}</span>
      </div>
    </footer>
  </div>
</template>
