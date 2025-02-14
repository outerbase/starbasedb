import { StrictMode, useState, useEffect } from 'hono/jsx'
import { hydrateRoot } from 'hono/jsx/dom/client'

import '../../public/global.css'

import { Button } from '../../components/button/Button'
import { Label } from '../../components/label/Label'
import { Input } from '../../components/input/Input'
import { Avatar } from '../../components/avatar'
import { Card } from '../../components/card'
import { Select } from '../../components/select'
import { Toggle } from '../../components/toggle'
import ThemeSelector from '../../components/theme/ThemeSelector'

const root = document.querySelector('#root[data-client="home"]') as HTMLElement

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
            <Home {...serverProps} />
        </StrictMode>
    )
}

function Home({ initialCount = 0, message = '' }: ServerProps) {
    type ChatRoom = {
        id: number
        name: string
    }

    const [chatRooms, setChatRooms] = useState<ChatRoom[]>([])

    useEffect(() => {
        const fetchChatRooms = async () => {
            try {
                const response = await fetch('/rest/main/chat_room', {
                    headers: {
                        Authorization: 'ABC123',
                    },
                })
                const data: Record<string, any> = await response.json()
                const rooms: ChatRoom[] = data.result
                setChatRooms(rooms)
            } catch (error) {
                console.error('Failed to fetch chat rooms:', error)
            }
        }

        fetchChatRooms()
    }, [])

    return (
        <section className="flex flex-col gap-4 h-screen">
            <div className="flex border-b border-black py-3 px-8 justify-between items-center">
                <span>FriendChat+</span>
                <div className="items-center flex gap-4">
                    <div className="flex items-center -space-x-2">
                        <Avatar username="user1" />
                        <Avatar username="user2" />
                        <Avatar username="user3" />
                    </div>

                    <Button shape="square">+</Button>

                    <ThemeSelector />
                </div>
            </div>

            <div className="m-auto w-full max-w-4xl flex-1 flex flex-col gap-2">
                {chatRooms.map((room, index) => (
                    <Card
                        key={index}
                        as="a"
                        href={`/chat/${room.id}`}
                        variant="secondary"
                        className="flex items-center justify-between"
                    >
                        <span>{room.name}</span>
                        <div>→</div>
                    </Card>
                ))}
            </div>
        </section>
    )
}
