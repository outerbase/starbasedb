/**
 * R2 utility functions for StarBaseDB export operations
 */

export interface R2PutOptions {
  contentType?: string
  contentDisposition?: string
  customMetadata?: Record<string, string>
}

/**
 * Upload content to R2 bucket
 */
export async function putR2Object(
  bucket: string | null,
  key: string,
  content: string | Uint8Array | ReadableStream,
  options?: R2PutOptions
): Promise<void> {
  if (!bucket) {
    throw new Error('R2 bucket name is required')
  }

  const r2Bucket = globalThis.__r2Buckets ?? {}
  const storage = (globalThis as any).__r2Storage
  
  if (!storage) {
    throw new Error('R2 storage not initialized. Ensure R2 binding is configured.')
  }

  const metadata: R2PutOptions = {
    contentType: 'application/octet-stream',
    ...options,
  }

  await storage.put(bucket, key, content, metadata)
}

/**
 * Download content from R2 bucket
 */
export async function getR2Object(
  bucket: string | null,
  key: string
): Promise<{ content: string; metadata: R2PutOptions }> {
  if (!bucket) {
    throw new Error('R2 bucket name is required')
  }

  const storage = (globalThis as any).__r2Storage
  
  if (!storage) {
    throw new Error('R2 storage not initialized')
  }

  const object = await storage.get(bucket, key)
  
  if (!object) {
    throw new Error(`Object not found: ${key}`)
  }

  const content = await object.text()
  
  return {
    content,
    metadata: {
      contentType: object.httpMetadata?.contentType,
      contentDisposition: object.httpMetadata?.contentDisposition,
      customMetadata: object.customMetadata,
    },
  }
}

/**
 * List objects in R2 bucket (for tracking exports)
 */
export async function listR2Objects(
  bucket: string | null,
  prefix?: string
): Promise<Array<{ key: string; size: number; uploadedAt: string }>> {
  if (!bucket) return []

  const storage = (globalThis as any).__r2Storage
  if (!storage) return []

  const list = await storage.list({ prefix, delimiter: '/' })
  
  return list.objects.map(obj => ({
    key: obj.key,
    size: obj.size,
    uploadedAt: obj.uploadedAt,
  }))
}
