import { useEffect } from 'hono/jsx'
import { getCookie, setCookie } from 'hono/cookie'
import type { Context } from 'hono'

const useTheme = (theme?: 'dark' | 'light') => {
    useEffect(() => {
        // Store theme preference in cookie
        if (theme) {
            document.cookie = `theme=${theme};path=/;samesite=lax`
        }

        // Apply theme class on client-side only
        if (typeof window !== 'undefined') {
            const html = document.querySelector('html')

            if (theme === 'dark') {
                html?.classList.add('dark')
            } else if (theme === 'light' && html?.classList.contains('dark')) {
                html?.classList.remove('dark')
            }
        }
    }, [theme])
}

export default useTheme
