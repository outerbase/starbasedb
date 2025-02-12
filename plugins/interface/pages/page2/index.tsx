import { StrictMode, useState, useEffect } from 'hono/jsx'
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
    const [wsMessages, setWsMessages] = useState<string[]>([])
    const [wsStatus, setWsStatus] = useState('Disconnected')

    useEffect(() => {
        // Create WebSocket connection using current host
        const socket = new WebSocket(
            `wss://${window.location.host}/cdc?token=ABC123&source=internal`
        )

        // Connection opened
        socket.onopen = () => {
            setWsStatus('Connected')
            setWsMessages((prev) => [...prev, 'WebSocket connection opened'])
        }

        // Listen for messages
        socket.onmessage = (event) => {
            setWsMessages((prev) => [...prev, `Received: ${event.data}`])
        }

        // Connection closed
        socket.onclose = (event) => {
            setWsStatus('Disconnected')
            setWsMessages((prev) => [
                ...prev,
                `WebSocket closed with code: ${event.code}, reason: ${event.reason}, clean: ${event.wasClean}`,
            ])
        }

        // Connection error
        socket.onerror = (error: any) => {
            setWsStatus('Error')
            setWsMessages((prev) => [
                ...prev,
                `WebSocket error: ${error.message}`,
            ])
        }

        // Cleanup on component unmount
        return () => {
            socket.close()
        }
    }, [])

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

                    {/* WebSocket Status and Messages */}
                    <div style={{ marginTop: '20px' }}>
                        <h3>WebSocket Status: {wsStatus}</h3>
                        <div style={{ maxHeight: '200px', overflowY: 'auto' }}>
                            {wsMessages.map((msg, index) => (
                                <div key={index}>{msg}</div>
                            ))}
                        </div>
                    </div>
                </div>
            </div>
        </section>
    )
}
