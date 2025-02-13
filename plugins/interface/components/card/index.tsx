import { cn } from '../../utils/index'
import type { Child } from 'hono/jsx'

type CardProps = {
    as?: 'div' | 'a'
    children?: Child
    variant?: 'primary' | 'secondary' | 'ghost' | 'destructive'
    href?: string
    class?: string
    [key: string]: any
}

export function Card({
    as = 'div',
    children,
    variant = 'secondary',
    href,
    class: className,
    ...props
}: CardProps) {
    const baseClasses = cn('ob-btn w-full rounded-lg p-3', {
        'btn-primary': variant === 'primary',
        'btn-secondary': variant === 'secondary',
    })

    const combinedClasses = [baseClasses, className].filter(Boolean).join(' ')

    if (as === 'a') {
        return (
            <a href={href} class={combinedClasses} {...props}>
                {children}
            </a>
        )
    }

    return (
        <div class={combinedClasses} {...props}>
            {children}
        </div>
    )
}
