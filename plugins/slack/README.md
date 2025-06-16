## Usage

````typescript
const slackPlugin = new SlackPlugin({
    webhookUrl: 'https://hooks.slack.com/services/SCRIBBLESCRIBBLESCRIBBLE',
})
const cdcPlugin = new ChangeDataCapturePlugin({
    stub,
    broadcastAllEvents: true,
    events: [],
})

cdcPlugin.onEvent(({ action, schema, table, data }) => {
    ctx.waitUntil(
        slackPlugin.sendMessage({
            blocks: [
                {
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: `${action} detected on ${table}`,
                    },
                },
                {
                    type: 'section',
                    text: {
                        type: 'mrkdwn',
                        text: 'The following data was associated with this action:',
                    },
                },
                {
                    type: 'section',
                    block_id: 'section_1',
                    text: {
                        type: 'mrkdwn',
                        text: '```' + `${JSON.stringify(data)}` + '```',
                    },
                },
            ],
        })
    )
})
````
