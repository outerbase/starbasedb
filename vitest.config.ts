--- a/plugins/query-log/index.ts
+++ b/plugins/query-log/index.ts
@@ -16,14 +16,24 @@
 export class QueryLogPlugin extends StarbasePlugin {
     private sqlQueryLogsDB: DurableObjectNamespace<QueryLogDB>
+    private exportQueryLogTimeout: number = 30 * 1000; // 30 seconds

     constructor() {
         super()
         this.requiresAuth = true
+        this.database = env.DATABASE_DURABLE_OBJECT
+        this.databaseQuery()
     }

     override async register(app: StarbaseApp) {
         app.all('/export/dump', async (c: ExecutionContext) => {
             const authorization = c.getHeaders().Authorization || ''
             const exportQueryLog = async () => {
-                const startTime = Date.now()
                 const startTime = Date.now()
                 const queryLogDB = await this.databaseQuery()
                 const queryLogs: QueryLog[] = await queryLogDB.findAll()
                 const dump = queryLogs.reduce((acc: string, log: QueryLog) => {
                     acc += `${log.sql_statement};${'\n'}`
                     return acc
                 }, '')
                 return { dump, startTime }
             }
             this.exportQueryLogTimeout = setTimeout(async () => {
                 const exportQueryLogResponse = await exportQueryLog()
                 c.json({
                     dump: exportQueryLogResponse.dump,
                 })
             }, this.exportQueryLogTimeout)
+            await exportQueryLog()
+            clearTimeout(this.exportQueryLogTimeout)
+            return
         })
+        app.all('/export/dump/:size', async (c: ExecutionContext, d: { size: number }) => {
+            const size = parseInt(d.size)
+            const exportQueryLog = async () => {
+                const startTime = Date.now()
+                const queryLogDB = await this.databaseQuery()
+                const queryLogs: QueryLog[] = []
+                let offset = 0
+                while (queryLogs.length < size) {
+                    const queryLogsBatch = await queryLogDB.findAll({ offset })
+                    queryLogs.push(...queryLogsBatch)
+                    offset += queryLogsBatch.length
+                }
+                const dump = queryLogs.reduce((acc: string, log: QueryLog) => {
+                    acc += `${log.sql_statement};${'\n'}`
+                    return acc
+                }, '')
+                return { dump, startTime }
+            }
+            this.exportQueryLogTimeout = setTimeout(async () => {
+                const exportQueryLogResponse = await exportQueryLog()
+                c.json({
+                    dump: exportQueryLogResponse.dump,
+                })
+            }, this.exportQueryLogTimeout)
+            await exportQueryLog()
+            clearTimeout(this.exportQueryLogTimeout)
+            return
+        })
     }
 }
