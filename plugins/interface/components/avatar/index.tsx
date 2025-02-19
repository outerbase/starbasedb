import { cn } from '../../utils/index'
import type { Child } from 'hono/jsx'

type AvatarProps = {
    as?: 'button' | 'a'
    image?: string
    size?: 'sm' | 'base' | 'lg'
    toggled?: boolean
    username: string
    href?: string
    class?: string
    children?: Child
}

export function Avatar({
    as = 'button',
    image,
    size = 'base',
    toggled,
    username,
    href,
    class: className,
    ...props
}: AvatarProps) {
    const firstInitial = username.charAt(0).toUpperCase()

    const baseClasses = cn(
        'ob-btn btn-secondary circular relative overflow-hidden',
        {
            'ob-size-sm': size === 'sm',
            'ob-size-base': size === 'base',
            'ob-size-lg': size === 'lg',
            interactive: as === 'button',
            'after:absolute after:top-0 after:left-0 after:z-10 after:size-full after:bg-black/5 after:opacity-0 after:transition-opacity hover:after:opacity-100 dark:after:bg-white/10':
                image,
            'after:opacity-100': image && toggled,
            toggle: !image && toggled,
        }
    )

    const combinedClasses = [baseClasses, className].filter(Boolean).join(' ')

    const imgSize = size === 'sm' ? 28 : size === 'base' ? 32 : 36

    if (as === 'a') {
        return (
            <a href={href} class={combinedClasses} {...props}>
                {image ? (
                    <img
                        class="w-full"
                        height={imgSize}
                        width={imgSize}
                        src={image}
                        alt={username}
                    />
                ) : (
                    <p class="text-ob-base-100 font-bold">{firstInitial}</p>
                )}
            </a>
        )
    }

    return (
        <button class={combinedClasses} {...props}>
            {image ? (
                <img
                    class="w-full"
                    height={imgSize}
                    width={imgSize}
                    src={image}
                    alt={username}
                />
            ) : (
                <p class="text-ob-base-100 font-bold">{firstInitial}</p>
            )}
        </button>
    )
}
