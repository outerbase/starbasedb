interface LoaderProps {
    class?: string
    size?: number
}

export function Loader({ class: className, size = 24 }: LoaderProps) {
    return (
        <svg
            width="24"
            height="24"
            viewBox="0 0 24 24"
            xmlns="http://www.w3.org/2000/svg"
            stroke="currentColor"
            class={className}
            style={`height: ${size}px; width: ${size}px`}
        >
            <circle
                cx="12"
                cy="12"
                r="9.5"
                fill="none"
                stroke-width="2"
                stroke-linecap="round"
            >
                <animateTransform
                    attributeName="transform"
                    type="rotate"
                    from="0 12 12"
                    to="360 12 12"
                    dur="2s"
                    repeatCount="indefinite"
                />
                <animate
                    attributeName="stroke-dasharray"
                    values="0 150;42 150;42 150"
                    keyTimes="0;0.5;1"
                    dur="1.5s"
                    repeatCount="indefinite"
                />
                <animate
                    attributeName="stroke-dashoffset"
                    values="0;-16;-59"
                    keyTimes="0;0.5;1"
                    dur="1.5s"
                    repeatCount="indefinite"
                />
            </circle>
            <circle
                cx="12"
                cy="12"
                r="9.5"
                fill="none"
                opacity="0.1"
                stroke-width="2"
                stroke-linecap="round"
            />
        </svg>
    )
}
