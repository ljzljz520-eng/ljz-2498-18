<script setup>
import { computed } from 'vue'
import { useDocumentWorkspace } from './composables/useDocumentWorkspace'

const workspace = useDocumentWorkspace()
const {
  documents,
  activeDocumentId,
  source,
  previewHtml,
  editorRef,
  previewRef,
  mirrorRef,
  locked,
  alternateFont,
  loadingLayout,
  layoutError,
  degraded,
  confidence,
  driftPx,
  saveState,
  restoreState,
  lineCount,
  charCount,
} = workspace

const sourceLines = computed(() => source.value.split(/\r?\n/))
const confidenceLabel = computed(() => {
  const labels = {
    exact: '区间精确',
    measured: '浏览器实测',
    'drift-corrected': '已误差校正',
    interpolated: '相邻锚点插值',
    'percentage-fallback': '无映射降级',
    'stale-layout': '等待新版映射',
    loading: '映射加载中',
    editing: '编辑后重算',
    idle: '等待滚动',
  }
  return labels[confidence.value] || confidence.value
})
</script>

<template>
  <div class="page">
    <header class="hero">
      <div>
        <p class="eyebrow">Vue 3 + Vite · 区间锚点同步</p>
        <h1>Catalpa 文稿台</h1>
        <p class="subtitle">编辑与预览可锁定联动，也可各自滚动；位置以源节点指纹和区间映射持久化。</p>
      </div>
      <div class="stats">
        <span>{{ lineCount }} 行</span>
        <span>{{ charCount }} 字符</span>
      </div>
    </header>

    <section class="toolbar" aria-label="文稿与同步控制">
      <label class="document-select">
        当前文稿
        <select :value="activeDocumentId" @change="workspace.selectDocument($event.target.value)">
          <option v-for="doc in documents" :key="doc.id" :value="doc.id">{{ doc.title }}</option>
        </select>
      </label>

      <button class="ghost-btn primary" type="button" @click="workspace.toggleLock()">
        {{ locked ? '解除锁定：保持双方位置' : '锁定：跟随当前位置' }}
      </button>
      <button class="ghost-btn" type="button" @click="workspace.toggleFont()">
        {{ alternateFont ? '恢复默认字体' : '替换阅读字体' }}
      </button>
      <button class="ghost-btn" type="button" @click="workspace.resetToDemo">恢复示例</button>
      <button class="ghost-btn danger" type="button" @click="workspace.clearAll">清空</button>
    </section>

    <section class="statusbar" aria-live="polite">
      <span :class="['status-dot', locked ? 'locked' : 'unlocked']"></span>
      <strong>{{ locked ? '位置锁定' : '独立滚动' }}</strong>
      <span>{{ confidenceLabel }}</span>
      <span v-if="driftPx !== 0">实测校正 {{ driftPx }}px</span>
      <span v-if="degraded" class="warning">自动降级</span>
      <span v-if="loadingLayout">渲染中…</span>
      <span v-if="restoreState">书签：{{ restoreState }}</span>
      <span class="spacer"></span>
      <span>{{ saveState }}</span>
      <span v-if="layoutError" class="warning">{{ layoutError }}</span>
    </section>

    <main class="workspace">
      <section class="panel editor-panel">
        <div class="panel-header">
          <h2>编辑区</h2>
          <span class="hint">行高镜像用于真实测量，不做百分比硬同步</span>
        </div>
        <div class="editor-stack">
          <textarea
            ref="editorRef"
            class="editor"
            :value="source"
            placeholder="在这里输入 Catalpa 内容..."
            spellcheck="false"
            wrap="soft"
            @input="workspace.onSourceInput"
            @scroll="workspace.onScroll('editor')"
          />
          <div ref="mirrorRef" class="source-mirror" aria-hidden="true">
            <span
              v-for="(_, index) in sourceLines"
              :key="index"
              class="source-line"
            >{{ sourceLines[index] || ' ' }}</span>
          </div>
        </div>
      </section>

      <section class="panel preview-panel">
        <div class="panel-header">
          <h2>预览区</h2>
          <span class="hint">图片、折叠、字体或缩放后自动重锚</span>
        </div>
        <article
          ref="previewRef"
          class="preview markdown-body"
          v-html="previewHtml"
          @scroll="workspace.onScroll('preview')"
        ></article>
      </section>
    </main>
  </div>
</template>
