import useTheme from '../../hooks/useTheme'
import { cn } from '../../utils/index'
// import { Moon, Sun } from '@phosphor-icons/react'
import { useState } from 'hono/jsx'

const ThemeSelector = () => {
    const [theme, setTheme] = useState<'dark' | 'light'>(() => {
        if (typeof window !== 'undefined') {
            const stored = document.cookie
                .split('; ')
                .find((row) => row.startsWith('theme='))
                ?.split('=')[1] as 'light' | 'dark'
            return stored || 'light'
        }
        return 'light'
    })

    useTheme(theme)

    const toggleTheme = () => {
        setTheme((prevTheme) => (prevTheme === 'dark' ? 'light' : 'dark'))
    }

    return (
        <button
            className="flex cursor-pointer items-center justify-center rounded-md hover:bg-neutral-200/60 dark:hover:bg-neutral-900"
            onClick={() => toggleTheme()}
        >
            <div
                className={cn('hidden', {
                    'animate-fade block': theme === 'dark',
                })}
            >
                Dark
            </div>
            <div
                className={cn('animate-fade block', {
                    hidden: theme === 'dark',
                })}
            >
                Light
            </div>
        </button>
    )
}

export default ThemeSelector
