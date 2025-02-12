import { StrictMode } from 'hono/jsx'
import { createRoot, hydrateRoot } from 'hono/jsx/dom/client'

import { Counter } from './Counter'
import './index.css'

const ssrRoot = document.getElementById('ssr-root')
if (ssrRoot) {
    hydrateRoot(
        ssrRoot,
        <StrictMode>
            <Counter />
        </StrictMode>
    )
}

// const spaRoot = document.getElementById("spa-root");
// if (spaRoot) {
//   const root = createRoot(spaRoot);
//   root.render(
//     <StrictMode>
//       <Counter />
//     </StrictMode>,
//   );
// }
