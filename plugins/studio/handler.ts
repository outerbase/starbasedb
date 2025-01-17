interface HandleStudioRequestOption {
    username: string
    password: string
    apiKey: string
}

function createStudioHTML(apiKey: string): string {
    return `<!doctype>
<html>
<head>
<style>
  html, body {
    padding: 0;
    margin: 0;
    width: 100vw;
    height: 100vh;
  }

  iframe {
    width: 100vw;
    height: 100vh;
    overflow: hidden;
    border: 0;
  }
</style>
<title>Your Starbase - Outerbase Studio</title>
<link rel="icon" type="image/x-icon" href="https://studio.outerbase.com/icons/outerbase.ico">
</head>
<body>
<script>
  function handler(e) {
    if (e.data.type !== "query" && e.data.type !== "transaction") return;
      let requestBody = e.data.type === 'transaction' ? 
          { transaction: e.data.statements.map(t => ({sql: t})) } :
          { sql: e.data.statement };

      fetch("/query/raw", {
          method: "post",
          headers: {
              "Content-Type": "application/json",
              "Authorization": "Bearer ${apiKey}"
          },
          body: JSON.stringify(requestBody)
      }).then(r => {
          if (!r.ok) {
              document.getElementById('editor').contentWindow.postMessage({
                  id: e.data.id,
                  type: e.data.type,
                  error: "Something went wrong",
              }, "*");
              throw new Error("Something went wrong");
          }
          return r.json()
      }).then(r => {
          const response = {
              id: e.data.id,
              type: e.data.type,
              data: Array.isArray(r.result) ? r.result.map(transformRawResult) : transformRawResult(r.result),
          };

          document.getElementById('editor').contentWindow.postMessage(response, "*");
      }).catch(console.error)
  }

  function transformRawResult(raw) {
      const columns = raw.columns ?? [];
      const values = raw.rows;
      const headerSet = new Set();

      const headers = columns.map((colName) => {
          let renameColName = colName;

          for (let i = 0; i < 20; i++) {
          if (!headerSet.has(renameColName)) break;
              renameColName = \`__\${colName}_\${i}\`;
          }

          return {
              name: renameColName,
              displayName: colName,
              originalType: "text",
              type: undefined,
          };
      });

      const rows = values
          ? values.map((r) =>
              headers.reduce((a, b, idx) => {
                  a[b.name] = r[idx];
                  return a;
              }, {})
          )
          : [];

      return {
          rows,
          stat: {
              queryDurationMs: 0,
              rowsAffected: 0,
              rowsRead: raw.meta.rows_read,
              rowsWritten: raw.meta.rows_written,
          },
          headers,
      };
  }

  window.addEventListener("message", handler);
</script>

<iframe
  id="editor"
  allow="clipboard-read; clipboard-write"
  src="https://studio.outerbase.com/embed/starbase"
/>
</body>
</html>`
}

export async function handleStudioRequest(
    request: Request,
    options: HandleStudioRequestOption
): Promise<Response> {
    // Check for basic authorization
    const auth = request.headers.get('Authorization')

    if (!auth || !auth.startsWith('Basic ')) {
        return new Response('Unauthorized', {
            status: 401,
            headers: {
                'WWW-Authenticate': 'Basic realm="Access to the studio"',
            },
        })
    }

    // base64 auth
    const base64Auth = auth.split('Basic ')[1]
    const decodedAuth = atob(base64Auth)
    const [username, password] = decodedAuth.split(':')

    if (username !== options.username || password !== options.password) {
        return new Response('Unauthorized', {
            status: 401,
            headers: {
                'WWW-Authenticate': 'Basic realm="Access to the studio"',
            },
        })
    }

    // Proceed with the request
    return new Response(createStudioHTML(options.apiKey), {
        headers: { 'Content-Type': 'text/html' },
    })
}
