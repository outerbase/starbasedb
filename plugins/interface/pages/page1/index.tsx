import { StrictMode, useState } from 'hono/jsx'
import { hydrateRoot } from 'hono/jsx/dom/client'
import { css } from 'hono/css'

import '../../public/global.css'

// Define CSS before any component usage
const sectionClass = css`
    display: grid;
    place-content: center;
    height: 100%;

    [content-grid] {
        display: grid;
        border: 1px solid;
        gap: 0.5rem;
        padding: 0.5rem;
        border-radius: 0.5rem;

        & > div {
            display: grid;
            grid-template-columns: 1fr minmax(400px, 30ch);
            gap: 0.5rem;
            align-items: start;
        }
    }
`

const root = document.querySelector('#root[data-client="page1"]') as HTMLElement
if (root) {
    hydrateRoot(
        root,
        <StrictMode>
            <Page1 />
        </StrictMode>
    )
}

function Page1() {
    const [count, setCount] = useState(0)
    const [message, setMessage] = useState<string>()

    return (
        <section class={sectionClass}>
            <div content-grid>
                <div>
                    <button
                        type="button"
                        onClick={() => {
                            console.log('Button clicked...')
                            setCount((c) => c + 1)
                        }}
                    >
                        Increase count
                    </button>
                    <span>Count: {count}</span>
                </div>

                <div>
                    <button
                        type="button"
                        onClick={() => {
                            console.log('Clicked button...')
                        }}
                        disabled={!!message}
                    >
                        Fetch message
                    </button>
                    <span>{message}</span>
                </div>
            </div>
        </section>
    )
}
