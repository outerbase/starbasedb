import { FC, JSX } from 'hono/jsx'
import { Loader } from '../loader/Loader'
import { cn } from '../../utils/index'

type ButtonProps = {
    as?: string
    children?: any
    className?: string
    disabled?: boolean
    displayContent?: 'items-first' | 'items-last'
    href?: string
    loading?: boolean
    shape?: 'base' | 'square'
    size?: 'sm' | 'base' | 'lg'
    title?: string
    toggled?: boolean
    variant?: 'primary' | 'secondary' | 'ghost' | 'destructive'
    onClick?: () => void
}

export const Button: FC<ButtonProps> = ({
    as,
    children,
    className,
    disabled,
    displayContent = 'items-last',
    href,
    loading,
    shape = 'base',
    size = 'base',
    title,
    toggled,
    variant = 'secondary',
    ...props
}) => {
    const Component = (as ||
        (href ? 'a' : 'button')) as keyof JSX.IntrinsicElements

    return (
        <Component
            class={cn(
                'ob-btn ob-focus interactive flex shrink-0 items-center justify-center font-medium select-none',
                {
                    'btn-primary btn-shadow': variant === 'primary',
                    'btn-secondary btn-shadow': variant === 'secondary',
                    'btn-ghost': variant === 'ghost',
                    'btn-destructive': variant === 'destructive',

                    'ob-size-sm gap-1.5': size === 'sm',
                    'ob-size-base gap-2': size === 'base',
                    'ob-size-lg gap-2.5': size === 'lg',

                    square: shape === 'square',

                    'flex-row-reverse': displayContent === 'items-first',

                    'ob-disable': disabled,

                    toggle: toggled,
                },
                className
            )}
            disabled={disabled}
            href={href}
            {...props}
        >
            {shape !== 'square' && title}

            {loading ? (
                <span
                    className={cn({
                        'w-3': size === 'sm',
                        'w-3.5': size === 'base',
                        'w-4': size === 'lg',
                        'ease-bounce transition-[width] duration-300 starting:w-0':
                            !children,
                    })}
                >
                    <Loader size={size === 'sm' ? 12 : 16} />
                </span>
            ) : (
                children
            )}
        </Component>
    )
}
