# Installation Guide

Follow the below steps to deploy the user authentication template into your existing
StarbaseDB instance. These steps will alter your StarbaseDB application logic so that
it includes capabilities for handling the routing of `/auth` routes to a new Cloudflare
Worker instance that will be deployed – which will handle all application logic for
user authentication.

## Step-by-step Instructions

### Execute SQL statements in `migration.sql` to create required tables

This will create the tables and constraints for user signup/login, and sessions. You can do this in the Studio user interface or by hitting your query endpoint in your StarbaseDB instance.

```sql
CREATE TABLE IF NOT EXISTS auth_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT COLLATE NOCASE,
    password TEXT NOT NULL,
    email TEXT COLLATE NOCASE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP DEFAULT NULL,
    email_confirmed_at TIMESTAMP DEFAULT NULL,
    UNIQUE(username),
    UNIQUE(email),
    CHECK ((username IS NOT NULL AND email IS NULL) OR (username IS NULL AND email IS NOT NULL) OR (username IS NOT NULL AND email IS NOT NULL))
);

CREATE TRIGGER IF NOT EXISTS prevent_username_email_overlap
BEFORE INSERT ON auth_users
BEGIN
    SELECT CASE
        WHEN EXISTS (
            SELECT 1 FROM auth_users
            WHERE (NEW.username IS NOT NULL AND (NEW.username = username OR NEW.username = email))
               OR (NEW.email IS NOT NULL AND (NEW.email = username OR NEW.email = email))
        )
    THEN RAISE(ABORT, 'Username or email already exists')
    END;
END;

CREATE TABLE IF NOT EXISTS auth_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    session_token TEXT NOT NULL UNIQUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMP DEFAULT NULL,
    FOREIGN KEY (user_id) REFERENCES auth_users (id)
);
```

### Add service bindings to your StarbaseDB wrangler.toml

This will let your StarbaseDB instance know that we are deploying another Worker
and it should use that for our authentication application routing logic.

```
[[services]]
binding = "AUTH"
service = "starbasedb_auth"
entrypoint = "AuthEntrypoint"
```

### Add AUTH to Env interface in `./src/index.ts`

Updates your `./src/index.ts` inside your StarbaseDB project so that your project
can now have a proper type-safe way of calling functionality that exists in this
new Cloudflare Worker that handles authentication.

```
AUTH: {
    handleAuth(pathname: string, verb: string, body: any): Promise<Response>;
}
```

### Add routing logic in default export in `./src/index.ts`

We will add the below block of code in our `export default` section of our
StarbaseDB so that we can pick up on any `/auth` routes and immediately redirect
them to the new Cloudflare Worker.

```
if (pathname.startsWith('/auth')) {
    const body = await request.json();
    return await env.AUTH.handleAuth(pathname, request.method, body);
}
```

### Deploy template project to Cloudflare

Next, we will deploy our new authentication logic to a new Cloudflare Worker instance.

```
cd ./templates/auth
npm i && npm run deploy
```

### Deploy updates in our main StarbaseDB

With all of the changes we have made to our StarbaseDB instance we can now deploy
the updates so that all of the new authentication application logic can exist and
be accessible.

```
cd ../..
npm run cf-typegen && npm run deploy
```

**NOTE:** You will want to deploy your new service worker for authentication before deploying updates to your StarbaseDB instance, because the StarbaseDB instance will rely on the authentication worker being available (see the service bindings we added in the wrangler.toml file for reference).
