import { StrictMode, useState, useEffect } from 'hono/jsx'
import { hydrateRoot } from 'hono/jsx/dom/client'

// import '../../public/global.css'

import { Button } from '../../components/button/Button'
import { Label } from '../../components/label/Label'
import { Input } from '../../components/input/Input'
import { Avatar } from '../../components/avatar'
import { Card } from '../../components/card'
import { Select } from '../../components/select'
import { Toggle } from '../../components/toggle'

const root = document.querySelector('#root[data-client="chat"]') as HTMLElement

// Get server props from the data attribute
const serverProps = root
    ? (JSON.parse(root.dataset.serverProps || '{}') as ServerProps)
    : ({} as ServerProps)

if (root) {
    hydrateRoot(
        root,
        <StrictMode>
            <Chat {...serverProps} />
        </StrictMode>
    )
}

type Message = {
    id: string
    username: string
    content: string
    timestamp: Date
}

type ServerProps = {
    id: string
    initialCount?: number
    message?: string
}

function Chat({ id }: ServerProps) {
    const [messages, setMessages] = useState<Message[]>([])
    const [inputMessage, setInputMessage] = useState('')
    const [socket, setSocket] = useState<WebSocket | null>(null)
    const [status, setStatus] = useState('Disconnected')

    useEffect(() => {
        // Fetch recent messages
        const fetchMessages = async () => {
            try {
                const response = await fetch(
                    `/rest/main/chat_message?id=${id}`,
                    {
                        headers: {
                            Authorization: 'ABC123',
                        },
                    }
                )
                const data: Record<string, any> = await response.json()
                const chatMessages: Message[] = data.result.map((msg: any) => ({
                    id: msg.id,
                    username: msg.user_id, // Note: You might want to fetch/map usernames separately
                    content: msg.message,
                    timestamp: new Date(msg.created_at),
                }))
                setMessages(chatMessages)
            } catch (error) {
                console.error('Failed to fetch messages:', error)
            }
        }

        // Fetch messages before setting up WebSocket
        fetchMessages()

        // Create WebSocket connection
        const ws = new WebSocket(
            `wss://${window.location.host}/socket?token=ABC123`
        )

        ws.onopen = () => {
            setStatus('Connected')
            setMessages((prev) => [
                ...prev,
                {
                    id: crypto.randomUUID(),
                    username: 'system',
                    content: 'Connected to chat room',
                    timestamp: new Date(),
                },
            ])
        }

        ws.onmessage = (event) => {
            const data = JSON.parse(event.data)
            setMessages((prev) => [
                ...prev,
                {
                    id: crypto.randomUUID(),
                    username: data.username,
                    content: data.content,
                    timestamp: new Date(data.timestamp),
                },
            ])
        }

        ws.onclose = () => {
            setStatus('Disconnected')
        }

        setSocket(ws)

        return () => {
            ws.close()
        }
    }, [id])

    const sendMessage = async () => {
        // if (socket && inputMessage.trim()) {
        //     socket.send(JSON.stringify({
        //         action: 'message',
        //         content: inputMessage,
        //         roomId: id
        //     }))
        //     setInputMessage('')
        // }
        if (inputMessage.trim()) {
            try {
                // Send message to API
                const response = await fetch('/rest/main/chat_message', {
                    method: 'POST',
                    headers: {
                        Authorization: 'ABC123',
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({
                        message: inputMessage,
                        chat_room_id: id,
                        user_id: '1',
                    }),
                })

                if (!response.ok) {
                    throw new Error('Failed to send message')
                }

                // If successful, send through WebSocket for real-time updates
                if (socket) {
                    socket.send(
                        JSON.stringify({
                            action: 'message',
                            content: inputMessage,
                            roomId: id,
                        })
                    )
                }

                setInputMessage('')
            } catch (error) {
                console.error('Failed to send message:', error)
                // Optionally add error handling UI here
            }
        }
    }

    return (
        <div className="flex h-screen flex-col">
            {/* Header */}
            <div className="flex border-b border-black py-3 px-8 justify-between items-center">
                <div className="flex items-center gap-4">
                    <div
                        onClick={() => {
                            window.location.href = '/home'
                        }}
                    >
                        Back
                    </div>
                    <span>Chat Room {id}</span>
                </div>
                <div className="flex items-center gap-4">
                    <div className="flex items-center -space-x-2">
                        <Avatar username="user1" />
                        <Avatar username="user2" />
                        <Avatar username="user3" />
                    </div>
                    <span
                        className={
                            status === 'Connected'
                                ? 'text-green-500'
                                : 'text-red-500'
                        }
                    >
                        {status}
                    </span>
                </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {messages.map((message) => (
                    <Card
                        key={message.id}
                        variant={
                            message.username === 'system'
                                ? 'secondary'
                                : 'primary'
                        }
                        className="max-w-[80%] w-fit"
                    >
                        <div className="flex items-start gap-3">
                            <Avatar username={message.username} size="sm" />
                            <div>
                                <div className="flex items-baseline gap-2">
                                    <span className="font-semibold">
                                        {message.username}
                                    </span>
                                    <span className="text-xs text-gray-500">
                                        {new Date(
                                            message.timestamp
                                        ).toLocaleTimeString()}
                                    </span>
                                </div>
                                <p>{message.content}</p>
                            </div>
                        </div>
                    </Card>
                ))}
            </div>

            {/* Input */}
            <div className="border-t border-black p-4 flex gap-4">
                <Input
                    value={inputMessage}
                    onValueChange={(value) => setInputMessage(value)}
                    placeholder="Type a message..."
                    size="lg"
                    className="flex-1"
                />
                <Button onClick={sendMessage} variant="primary" size="lg">
                    Send
                </Button>
            </div>
        </div>
    )
}
