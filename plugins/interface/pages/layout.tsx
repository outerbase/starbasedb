import { type FC } from 'hono/jsx/dom'

const Layout: FC = (props) => {
    return (
        <html>
            <head>
                <title>Starbase + Hono = Cool</title>
            </head>
            <body id="root">{props.children}</body>
        </html>
    )
}

export default Layout
