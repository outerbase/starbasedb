import { cn } from '../../utils'
import { useState, type FC, type JSX } from 'hono/jsx'
import type { Child } from 'hono/jsx'

export const inputClasses = cn(
    'bg-ob-btn-secondary-bg text-ob-base-300 border-ob-border focus:border-ob-border-active placeholder:text-ob-base-100 ob-disable border border-1 transition-colors focus:outline-none'
)

export type InputProps = Omit<JSX.IntrinsicElements['input'], 'size'> & {
    children?: Child
    className?: string
    displayContent?: 'items-first' | 'items-last'
    initialValue?: string
    isValid?: boolean
    onValueChange: ((value: string, isValid: boolean) => void) | undefined
    preText?: string[] | Child[] | Child
    postText?: string[] | Child[] | Child
    size?: 'sm' | 'base' | 'lg'
}

export const Input: FC<InputProps> = ({
    children,
    className,
    displayContent,
    initialValue,
    isValid = true,
    onValueChange,
    preText,
    postText,
    size = 'base',
    ...props
}) => {
    const [currentValue, setCurrentValue] = useState(initialValue ?? '')

    const updateCurrentValue = (event: Event) => {
        const target = event.target as HTMLInputElement
        const newValue = target.value
        setCurrentValue(newValue)

        if (onValueChange) {
            if (!props.min) {
                onValueChange(newValue, isValid)
            } else if (typeof props.min === 'number') {
                onValueChange(newValue.slice(0, props.min), isValid)
            }
        }
    }

    return preText ? (
        <div
            class={cn(
                'has-[:disabled]:ob-disable has-[:enabled]:active:border-ob-border-active has-[:focus]:border-ob-border-active flex cursor-text',
                inputClasses,
                {
                    'ob-size-sm': size === 'sm',
                    'ob-size-base': size === 'base',
                    'ob-size-lg': size === 'lg',
                },
                className
            )}
        >
            <span class="text-ob-base-200 pointer-events-none mr-0.5 flex items-center gap-2 transition-colors select-none">
                {preText}
            </span>

            <input
                class={cn(
                    'placeholder:text-ob-base-100 w-full bg-transparent focus:outline-none',
                    {
                        'text-ob-destructive': !isValid,
                    }
                )}
                onChange={updateCurrentValue}
                value={currentValue}
                {...props}
            />

            <span class="text-ob-base-200 mr-0.5 flex items-center gap-2 transition-colors select-none">
                {postText}
            </span>
        </div>
    ) : (
        <input
            class={cn(
                inputClasses,
                {
                    'text-ob-destructive transition-colors': !isValid,
                    'ob-size-sm': size === 'sm',
                    'ob-size-base': size === 'base',
                    'ob-size-lg': size === 'lg',
                },
                className
            )}
            onChange={updateCurrentValue}
            value={currentValue}
            {...props}
        />
    )
}
