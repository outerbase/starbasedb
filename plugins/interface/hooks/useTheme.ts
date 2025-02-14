import { useEffect } from 'hono/jsx'

const useTheme = (theme?: 'dark' | 'light') => {
    useEffect(() => {
        // Get stored theme from cookie on mount
        const storedTheme = document.cookie
            .split('; ')
            .find((row) => row.startsWith('theme='))
            ?.split('=')[1] as 'dark' | 'light' | undefined

        const themeToApply = theme || storedTheme

        // Store theme preference in cookie
        if (themeToApply) {
            document.cookie = `theme=${themeToApply};path=/;samesite=lax`
        }

        // Apply theme class on client-side only
        if (typeof window !== 'undefined') {
            const html = document.querySelector('html')

            if (themeToApply === 'dark') {
                html?.classList.add('dark')
            } else if (
                themeToApply === 'light' &&
                html?.classList.contains('dark')
            ) {
                html?.classList.remove('dark')
            }
        }
    }, [theme])
}

export default useTheme
