const DB_NAME = 'catalpa-reading'
const DB_VERSION = 1
const POSITION_STORE = 'reading_positions'
const LAYOUT_STORE = 'layout_versions'
const memoryFallback = new Map()

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'))
      return
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains(LAYOUT_STORE)) {
        db.createObjectStore(LAYOUT_STORE, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(POSITION_STORE)) {
        const store = db.createObjectStore(POSITION_STORE, { keyPath: 'id' })
        store.createIndex('documentId', 'documentId', { unique: false })
        store.createIndex('userDocument', ['userId', 'documentId'], { unique: false })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

async function withStore(storeName, mode, callback) {
  try {
    const db = await openDatabase()
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(storeName, mode)
      const store = transaction.objectStore(storeName)
      const request = callback(store)
      transaction.oncomplete = () => {
        db.close()
        resolve(request?.result ?? null)
      }
      transaction.onerror = () => {
        db.close()
        reject(transaction.error)
      }
    })
  } catch (error) {
    return { fallback: true, error }
  }
}

export async function saveLayoutVersion(bundle) {
  if (!bundle?.documentId || !bundle?.layoutVersion) return false
  const record = {
    id: `${bundle.userId || 'local-user'}:${bundle.documentId}:${bundle.layoutVersion}`,
    documentId: bundle.documentId,
    ...bundle,
    savedAt: Date.now(),
  }
  const result = await withStore(LAYOUT_STORE, 'readwrite', (store) => store.put(record))
  if (result?.fallback) memoryFallback.set(record.id, record)
  return true
}

export async function getLayoutVersion(documentId, layoutVersion, userId = 'local-user') {
  const id = `${userId}:${documentId}:${layoutVersion}`
  const result = await withStore(LAYOUT_STORE, 'readonly', (store) => store.get(id))
  return result?.fallback ? (memoryFallback.get(id) ?? null) : (result ?? null)
}

export async function saveReadingPosition(position) {
  if (!position?.documentId) return false
  const record = {
    id: `${position.userId || 'local-user'}:${position.documentId}`,
    documentId: position.documentId,
    updatedAt: Date.now(),
    ...position,
  }
  const result = await withStore(POSITION_STORE, 'readwrite', (store) => store.put(record))
  if (result?.fallback) memoryFallback.set(record.id, record)
  return true
}

export async function getReadingPosition(documentId, userId = 'local-user') {
  const id = `${userId}:${documentId}`
  const result = await withStore(POSITION_STORE, 'readonly', (store) => store.get(id))
  return result?.fallback ? (memoryFallback.get(id) ?? null) : (result ?? null)
}
