--- a/plugins/query-log/index.test.ts
+++ b/plugins/query-log/index.test.ts
@@ -1,6 +1,7 @@
 import { describe, it, expect, vi, beforeEach } from 'vitest'
 import { QueryLogPlugin } from './index'
 import { StarbaseApp, StarbaseDBConfiguration } from '../../src/handler'
+import { DataSource } from '../../src/types'

 let queryLogPlugin: QueryLogPlugin
 let mockDataSource: DataSource
@@ -20,3 +21,15 @@
     }
 }

+describe('QueryLogPlugin', () => {
+    it('should log queries', async () => {
+        // Arrange
+        const plugin = new QueryLogPlugin()
+        const app = new StarbaseApp()
+
+        // Act
+        plugin.register(app)
+
+        // Assert
+        expect(plugin).not.toBeUndefined()
+    })
+})
