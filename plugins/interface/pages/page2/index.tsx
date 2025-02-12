import { StrictMode, useState } from 'hono/jsx'
import { hydrateRoot } from 'hono/jsx/dom/client'

import '../../public/global.css'

const root = document.querySelector('#root[data-client="page2"]') as HTMLElement

// Add type for server props
type ServerProps = {
    initialCount: number
    message: string
}

// Get server props from the data attribute
const serverProps = root
    ? (JSON.parse(root.dataset.serverProps || '{}') as ServerProps)
    : ({} as ServerProps)

if (root) {
    hydrateRoot(
        root,
        <StrictMode>
            <Page2 {...serverProps} />
        </StrictMode>
    )
}

function Page2({ initialCount = 0, message = '' }: ServerProps) {
    const [count, setCount] = useState(initialCount)

    return (
        <section>
            <div content-grid>
                <div>
                    <h2>{message}</h2>
                    <button
                        type="button"
                        onClick={() => {
                            console.log('Page 2 Button clicked...')
                            setCount((c) => c + 1)
                        }}
                    >
                        Increase count
                    </button>
                    <span>Count: {count}</span>
                </div>
            </div>
        </section>
    )
}
