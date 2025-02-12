import { hc } from 'hono/client'
import { css } from 'hono/css'
import { useState } from 'hono/jsx'

// import type { Api } from "../api";

// const client = hc<Api>("/api");

export function Counter() {
    const [count, setCount] = useState(0)
    const [message, setMessage] = useState<string>()

    //   const getScore = async () => {
    //     try {
    //       const res = await client.index.$get();
    //       const { message } = await res.json();
    //       setMessage(message);
    //     } catch (error) {
    //       console.error("Error fetching message", error);
    //     }
    //   };

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
