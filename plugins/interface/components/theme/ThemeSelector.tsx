import useTheme from '../../hooks/useTheme'
import { cn } from '../../utils/index'
// import { Moon, Sun } from '@phosphor-icons/react'
import { useState } from 'hono/jsx'

// type ThemeSelectorProps = {
//   onClick: () => void
//   theme: 'light' | 'dark'
// }

const ThemeSelector = () =>
    // { onClick, theme }: ThemeSelectorProps
    {
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
                className="flex size-8 cursor-pointer items-center justify-center rounded-md hover:bg-neutral-200/60 dark:hover:bg-neutral-900"
                onClick={() => toggleTheme()}
            >
                <div
                    className={cn('hidden', {
                        'animate-fade block': theme === 'dark',
                    })}
                >
                    Moon
                </div>
                <div
                    className={cn('animate-fade block', {
                        hidden: theme === 'dark',
                    })}
                >
                    Sun
                </div>
                {/* <Moon
          weight="bold"
          className={cn('hidden', {
            'animate-fade block': theme === 'dark',
          })}
        />
        <Sun
          weight="bold"
          className={cn('animate-fade block', {
            hidden: theme === 'dark',
          })}
        /> */}
            </button>
        )
    }

export default ThemeSelector
