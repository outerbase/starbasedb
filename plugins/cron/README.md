## Example Usage

Each task should have an entry in the `tmp_cron_tasks` table of your StarbaseDB instance. An example row might look like:

```json
{
    "name": "Even minutes",
    "cron_tab": "*/2 * * * *",
    "payload": "",
    "callback_host": "https://starbasedb-{MY-IDENTIFIER}.workers.dev"
}
```

Then your code in your `/src/index.ts` would implement the plugin setup like below:

```ts
import { CronPlugin } from '../plugins/cron'

// ....
// ....

const cronPlugin = new CronPlugin()
cronPlugin.onEvent(({ name, cron_tab, payload }) => {
    console.log('CRON EVENT: ', name, cron_tab, payload)

    if (name === 'Even minutes') {
        console.log('Payload: ', JSON.stringify(payload))
    }
}, ctx)

const plugins = [
    // ...
    cronPlugin,
] satisfies StarbasePlugin[]
```
