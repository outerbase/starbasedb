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

    const [loading, setLoading] = useState(false)
    const [refreshing, setRefreshing] = useState(false)
    const [toggled, setToggled] = useState(false)

    const dbs = [
        'SQLite',
        'MySQL',
        'Postgres',
        'LibSQL',
        'MongoDB',
        'Clickhouse',
        'BigQuery',
        'Snowflake',
        'MSSql',
        'Redshift',
    ]

    // useEffect(() => {
    //     // Create WebSocket connection using current host
    //     const socket = new WebSocket(
    //         `wss://${window.location.host}/cdc?token=ABC123&source=internal`
    //     )

    //     // Connection opened
    //     socket.onopen = () => {
    //         setWsStatus('Connected')
    //         setWsMessages((prev) => [...prev, 'WebSocket connection opened'])
    //     }

    //     // Listen for messages
    //     socket.onmessage = (event) => {
    //         setWsMessages((prev) => [...prev, `Received: ${event.data}`])
    //     }

    //     // Connection closed
    //     socket.onclose = (event) => {
    //         setWsStatus('Disconnected')
    //         setWsMessages((prev) => [
    //             ...prev,
    //             `WebSocket closed with code: ${event.code}, reason: ${event.reason}, clean: ${event.wasClean}`,
    //         ])
    //     }

    //     // Connection error
    //     socket.onerror = (error: any) => {
    //         setWsStatus('Error')
    //         setWsMessages((prev) => [
    //             ...prev,
    //             `WebSocket error: ${error.message}`,
    //         ])
    //     }

    //     // Cleanup on component unmount
    //     return () => {
    //         socket.close()
    //     }
    // }, [])

    const [isValid, setIsValid] = useState(true)
    const [value, setValue] = useState(dbs[0])
    const [toggle, setToggle] = useState(false)

    const handleToggleClick = () => {
        setToggle(!toggle)
    }

    const checkIfValid = (value: string) => {
        if (value === 'dog' || value === '') {
            setIsValid(true)
        } else setIsValid(false)
    }

    const handleToggle = () => {
        setToggled(!toggled)
    }

    const handleClickLoading = () => {
        setLoading(true)

        setTimeout(() => {
            setLoading(false)
        }, 2000)
    }

    const handleClickRefresh = () => {
        setRefreshing(true)

        setTimeout(() => {
            setRefreshing(false)
        }, 2000)
    }

    return (
        <section>
            <div className="container mx-auto px-4 pt-6">
                <div>
                    <h2>{message}</h2>
                    <button
                        type="button"
                        className="bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded"
                        onClick={() => {
                            console.log('Page 2 Button clicked...')
                            setCount((c) => c + 1)
                        }}
                    >
                        Increase count
                    </button>
                    <span className="ml-4">Count: {count}</span>

                    <div className="mt-8">
                        <Label title="Avatars">
                            <Avatar
                                username={'logan'}
                                image={undefined}
                                size="base"
                            />
                            <Avatar username={'brandon'} image={undefined} />
                        </Label>
                    </div>

                    <div className="mt-8">
                        <Label title="Cards">
                            <Card variant="primary">Content</Card>
                            <Card as="a" href="/" variant="secondary">
                                Link Content
                            </Card>
                        </Label>
                    </div>

                    <div className="mt-8 w-[160px]">
                        <Label
                            title="Name"
                            htmlFor="name"
                            className="flex flex-col gap-2"
                        >
                            <Button
                                title={'Primary'}
                                size="base"
                                variant="primary"
                            />
                            <Button title={'Secondary'} />
                            <Button title={'Ghost'} variant="ghost" />
                            <Button
                                title={'Destructive'}
                                size="base"
                                variant="destructive"
                            />
                            <Button
                                title={'Loading'}
                                size="lg"
                                loading={true}
                            />
                            <Button
                                title={'Click to load'}
                                size="lg"
                                onClick={handleClickLoading}
                                loading={loading}
                            />
                            <Button
                                title={'Click to toggle'}
                                size="base"
                                variant="ghost"
                                onClick={handleToggle}
                                toggled={toggled}
                            />
                        </Label>

                        <Label title="Name" htmlFor="name">
                            <Input
                                onValueChange={() => {}}
                                placeholder="e.g. Joe Smith"
                                id="name"
                                size="sm"
                                disabled
                            />
                        </Label>

                        <Label
                            title="Resource name"
                            htmlFor="resourceName"
                            required
                            requiredDescription="text must be 'dog' "
                            isValid={isValid}
                        >
                            <Input
                                isValid={isValid}
                                preText="outerbase.com/"
                                onValueChange={checkIfValid}
                                placeholder="my-cool-base"
                                id="resourceName"
                                size="base"
                            />
                        </Label>
                        <Label title="Month" htmlFor="month">
                            <Input
                                onValueChange={() => {}}
                                placeholder="e.g. April"
                                id="month"
                                size="lg"
                            />
                        </Label>
                    </div>

                    <div>
                        <Label title="Selects">
                            <Select
                                options={dbs}
                                setValue={(value) => setValue(value)}
                                value={value}
                                size="sm"
                            />
                            <Select
                                options={dbs}
                                setValue={(value) => setValue(value)}
                                value={value}
                                size="base"
                            />
                            <Select
                                options={dbs}
                                setValue={(value) => setValue(value)}
                                value={value}
                                size="lg"
                            />
                        </Label>
                    </div>

                    <div className="mt-8 flex items-center gap-4">
                        <Toggle
                            onClick={handleToggleClick}
                            toggled={toggle}
                            size="sm"
                        />
                        <Toggle
                            onClick={handleToggleClick}
                            toggled={toggle}
                            size="base"
                        />
                        <Toggle
                            onClick={handleToggleClick}
                            toggled={toggle}
                            size="lg"
                        />
                    </div>

                    {/* WebSocket Status and Messages */}
                    <div className="mt-8">
                        <h3 className="text-lg font-semibold">
                            WebSocket Status: {wsStatus}
                        </h3>
                        <div className="max-h-[200px] overflow-y-auto mt-4 border border-gray-200 rounded p-4">
                            {wsMessages.map((msg, index) => (
                                <div key={index} className="py-1">
                                    {msg}
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            </div>
        </section>
    )
}
