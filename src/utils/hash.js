// 稳定字符串哈希（FNV-1a 32bit）。用于内容签名，避免对完整源文本做逐字符比对。
export function fnv1a(input) {
  let hash = 0x811c9dc5
  const text = String(input ?? '')
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  // 转为无符号后以 16 进制输出，固定 8 位
  return (hash >>> 0).toString(16).padStart(8, '0')
}
