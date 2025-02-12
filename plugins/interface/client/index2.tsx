import { StrictMode } from 'hono/jsx'
import { createRoot, hydrateRoot } from 'hono/jsx/dom/client'

import { Counter } from './Counter'
import './index.css'

const ssrRoot = document.getElementById('ssr-root')
if (ssrRoot) {
    hydrateRoot(
        ssrRoot,
        <StrictMode>
            <h2>Index 2 bb</h2>
            <Counter />
        </StrictMode>
    )
}
