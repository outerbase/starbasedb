import { StrictMode } from 'hono/jsx'
import { hydrateRoot } from 'hono/jsx/dom/client'
import { cn } from '../../utils/index'

import '../../public/global.css'
import { Button } from '@interface/components/button/Button'
import { Label } from '@interface/components/label/Label'
import { Input } from '@interface/components/input/Input'
import { Avatar } from '@interface/components/avatar'
import { Card } from '@interface/components/card'
import { Select } from '@interface/components/select'
import { Toggle } from '@interface/components/toggle'

const root = document.querySelector(
    '#root[data-client="template"]'
) as HTMLElement

type ServerProps = {}

// Get server props from the data attribute
const serverProps = root
    ? (JSON.parse(root.dataset.serverProps || '{}') as ServerProps)
    : ({} as ServerProps)

if (root) {
    hydrateRoot(
        root,
        <StrictMode>
            <Template {...serverProps} />
        </StrictMode>
    )
}

function Template({}: ServerProps) {
    return (
        <section>
            <h1>Template Page</h1>
        </section>
    )
}
