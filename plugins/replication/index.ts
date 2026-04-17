import { Plugin } from '../../src/index'
import { CronPlugin } from '../cron'

export class ReplicationPlugin implements Plugin {
      constructor(private cronPlugin: CronPlugin) {}

    async init() {
              this.cronPlugin.addJob('replication', '*/5 * * * *', async () => {
                            console.log('Running replication task...')
                            // Logic for syncing external data to internal database
                                                 try {
                                                                   const response = await fetch('https://api.example.com/data')
                                                                   const data = await response.json()
                                                                   console.log('Data fetched for replication:', data)
                                                 } catch (error) {
                                                                   console.error('Replication failed:', error)
                                                 }
              })
    }
}
