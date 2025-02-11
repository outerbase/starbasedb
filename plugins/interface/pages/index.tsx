// SERVER RENDERED:
//
import { createContext, useContext, type FC } from 'hono/jsx'
import Layout from './layout'

// Theme Definitions
const themes = {
    light: {
        color: '#000000',
        background: '#ffffff',
        buttonBackground: '#007bff',
        buttonColor: '#ffffff',
    },
    dark: {
        color: '#ffffff',
        background: '#1e1e1e',
        buttonBackground: '#444444',
        buttonColor: '#ffffff',
    },
}

const ThemeContext = createContext(themes.light)

const ThemedButton: FC<{ onClick: string; label: string }> = ({
    onClick,
    label,
}) => {
    const theme = useContext(ThemeContext)
    return (
        <button
            style={{
                background: theme.buttonBackground,
                color: theme.buttonColor,
                padding: '10px 20px',
                border: 'none',
                borderRadius: '5px',
                cursor: 'pointer',
            }}
            data-action={onClick} // Attach data attribute for JS to pick up
        >
            {label}
        </button>
    )
}

const IndexPage: FC<{ messages: string[] }> = ({ messages }) => {
    return (
        <ThemeContext.Provider value={themes.light}>
            <Layout>
                <div
                    style={{
                        padding: '20px',
                        minHeight: '100vh',
                        transition: 'all 0.3s ease',
                    }}
                >
                    <h1>Welcome to Hono with Dynamic Themes!</h1>
                    <ThemedButton onClick="toggleTheme" label="Toggle Theme" />
                    <div id="counterDisplay">Counter: 0</div>
                    <ThemedButton
                        onClick="incrementCounter"
                        label="Increment"
                    />

                    <section style={{ marginTop: '20px' }}>
                        <h2>Messages</h2>
                        <ul>
                            {messages.length > 0 ? (
                                messages.map((msg, index) => (
                                    <li
                                        key={index}
                                        style={{ padding: '5px 0' }}
                                    >
                                        {msg}
                                    </li>
                                ))
                            ) : (
                                <li>No messages found.</li>
                            )}
                        </ul>
                    </section>
                </div>

                {/* Hydration Script */}
                <script
                    dangerouslySetInnerHTML={{
                        __html: `
              document.addEventListener('DOMContentLoaded', () => {
                let counter = 0;
                let isDarkMode = false;
                let socket;

                // Initialize WebSocket connection
                function initWebSocket() {
                  socket = new WebSocket('wss://starbasedb.brayden-b8b.workers.dev/socket?token=ABC123');

                  socket.onopen = function() {
                    console.log("WebSocket connection opened");
                  };

                  socket.onmessage = function(event) {
                    console.log("Received:", event.data);
                    // You can update the UI here based on received messages
                    const messagesSection = document.querySelector('section ul');
                    if (messagesSection) {
                      const li = document.createElement('li');
                      li.style.padding = '5px 0';
                      li.textContent = event.data;
                      messagesSection.appendChild(li);
                    }
                  };

                  socket.onclose = function(event) {
                    console.log(\`WebSocket closed with code: \${event.code}, reason: \${event.reason}, clean: \${event.wasClean}\`);
                    // Attempt to reconnect after a delay
                    setTimeout(initWebSocket, 5000);
                  };

                  socket.onerror = function(error) {
                    console.error("WebSocket error:", error);
                  };
                }

                // Initialize WebSocket connection
                initWebSocket();

                // Existing theme toggle functionality
                const toggleTheme = () => {
                  isDarkMode = !isDarkMode;
                  document.body.style.backgroundColor = isDarkMode ? '#1e1e1e' : '#ffffff';
                  document.body.style.color = isDarkMode ? '#ffffff' : '#000000';
                };

                // Existing counter functionality
                const incrementCounter = () => {
                  counter++;
                  document.getElementById('counterDisplay').textContent = 'Counter: ' + counter;
                };

                document.querySelectorAll('[data-action="toggleTheme"]').forEach(button => {
                  button.addEventListener('click', toggleTheme);
                });

                document.querySelectorAll('[data-action="incrementCounter"]').forEach(button => {
                  button.addEventListener('click', incrementCounter);
                });
              });
            `,
                    }}
                />
            </Layout>
        </ThemeContext.Provider>
    )
}

export default IndexPage

// CLIENT RENDERED
//
// import { type FC } from 'hono/jsx/dom';

// const IndexPage: FC<{ messages: string[] }> = ({ messages }) => {
//     console.log('Test...')
//     return (
//         <button onClick={() => { console.log('Client?') }}>Test</button>
//     );
// };

// export default IndexPage;

// import { createContext, startViewTransition, useContext, useState, type FC } from 'hono/jsx/dom';
// import Layout from './layout';
// import { css, Style } from 'hono/css'

// Theme Definitions
// const themes = {
//     light: {
//         color: '#000000',
//         background: '#ffffff',
//         buttonBackground: '#007bff',
//         buttonColor: '#ffffff',
//     },
//     dark: {
//         color: '#ffffff',
//         background: '#1e1e1e',
//         buttonBackground: '#444444',
//         buttonColor: '#ffffff',
//     },
// };

// const ThemeContext = createContext(themes.light);

// const ThemedButton: FC<{ onClick: () => void; label: string }> = ({ onClick, label }) => {
//     const theme = useContext(ThemeContext);
//     return (
//         <button
//             style={{
//                 background: theme.buttonBackground,
//                 color: theme.buttonColor,
//                 padding: '10px 20px',
//                 border: 'none',
//                 borderRadius: '5px',
//                 cursor: 'pointer',
//             }}
//             onClick={onClick}
//         >
//             {label}
//         </button>
//     );
// };

// const IndexPage: FC<{ messages: string[] }> = ({ messages }) => {
//     const [isDarkMode, setIsDarkMode] = useState(false);
//     const [counter, setCounter] = useState(0);

//     const toggleTheme = () => setIsDarkMode(!isDarkMode);
//     const incrementCounter = () => setCounter(counter + 1);

//     const currentTheme = isDarkMode ? themes.dark : themes.light;

//     return (
//         <button onClick={() => { console.log('Client?') }}>Test</button>
//         // <ThemeContext.Provider value={currentTheme}>
//         //     <Layout>
//         //         <div style={{ padding: '20px', minHeight: '100vh', transition: 'all 0.3s ease', background: currentTheme.background, color: currentTheme.color }}>
//         //             <h1>Welcome to Hono with Dynamic Themes!</h1>
//         //             <ThemedButton onClick={toggleTheme} label="Toggle Theme" />
//         //             <div>Counter: {counter}</div>
//         //             <ThemedButton onClick={incrementCounter} label="Increment" />

//         //             <section style={{ marginTop: '20px' }}>
//         //                 <h2>Messages</h2>
//         //                 <ul>
//         //                     {messages.length > 0 ? (
//         //                         messages.map((msg, index) => (
//         //                             <li key={index} style={{ padding: '5px 0' }}>
//         //                                 {msg}
//         //                             </li>
//         //                         ))
//         //                     ) : (
//         //                         <li>No messages found.</li>
//         //                     )}
//         //                 </ul>
//         //             </section>
//         //         </div>
//         //     </Layout>
//         // </ThemeContext.Provider>
//     );
// };

// export default IndexPage;

// export default function App({ messages }: { messages: string[] }) {
//     const [showLargeImage, setShowLargeImage] = useState(false)
//     const [count, setCount] = useState<number>(0)

//     return (
//       <>
//         <Style />
//         <button
//           onClick={() => {
//             console.log('Count: ', count)
//             setCount(count + 1)
//             // startViewTransition(() =>
//             //   setShowLargeImage((state) => !state)
//             // )
//           }}
//         >
//           Click!
//         </button>
//         <div>{count}</div>
//         <div>
//           {!showLargeImage ? (
//             <img src='https://hono.dev/images/logo.png' />
//           ) : (
//             <div
//               class={css`
//                 background: url('https://hono.dev/images/logo-large.png');
//                 background-size: contain;
//                 background-repeat: no-repeat;
//                 background-position: center;
//                 width: 600px;
//                 height: 600px;
//               `}
//             ></div>
//           )}
//         </div>
//       </>
//     )
//   }
