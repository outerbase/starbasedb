# Data Sync Plugin Demo

This demo shows how to use the StarbaseDB Data Sync Plugin to synchronize data between an external PostgreSQL database and StarbaseDB.

## Setup

1. Install dependencies:

```bash
pnpm install
```

2. Set up environment variables:

```bash
# Create a .dev.vars file in the demo directory
cat > plugins/data-sync/demo/.dev.vars << EOL
# Replace these with your own secure tokens - these are just examples
ADMIN_TOKEN=your_admin_token_here  # e.g., a random string like "ABC123"
CLIENT_TOKEN=your_client_token_here # e.g., a random string like "DEF456"
DB_USER=postgres
DB_PASSWORD=postgres
EOL
```

3. Use the existing PostgreSQL Docker container:

```bash
# The container should already be running with:
docker run --name starbasedb-postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=demo -p 5432:5432 -d postgres:15
```

4. Load test data into the Docker container:

```bash
# Copy the setup file into the container
docker cp setup.sql starbasedb-postgres:/setup.sql

# Execute the setup file in the container
docker exec -i starbasedb-postgres psql -U postgres -d demo -f /setup.sql
```

## Running the Demo

1. Start the development server:

```bash
pnpm wrangler dev --config plugins/data-sync/demo/wrangler.toml
```

2. Test the available endpoints:

### Basic Status and Data

```bash
# Check sync status
curl http://localhost:8787/sync-status

# View synced data
curl http://localhost:8787/sync-data
```

### Testing Query Hooks

```bash
# Test query interception
curl -X POST http://localhost:8787/test-query \
  -H "Content-Type: application/json" \
  -d '{"sql": "SELECT * FROM users", "params": []}'
```

### Force Sync

```bash
# Trigger manual sync
curl -X POST http://localhost:8787/force-sync
```

### Debug Information

```bash
# View plugin debug information
curl http://localhost:8787/debug
```

## How it Works

The demo plugin showcases these key aspects of the StarbaseDB plugin system:

1. **Plugin Registration**: The plugin registers itself and the data sync plugin with StarbaseDB.

2. **HTTP Endpoints**:

    - `/sync-status`: Shows the current sync status and configured tables
    - `/sync-data`: Shows the synchronized data
    - `/test-query`: Tests query interception hooks
    - `/force-sync`: Triggers manual synchronization
    - `/debug`: Shows plugin configuration and state

3. **Query Hooks**:
    - `beforeQuery`: Logs and intercepts queries before execution
    - `afterQuery`: Processes results after query execution

## Configuration

The demo uses the following configuration in `wrangler.toml`:

- PostgreSQL connection details:
    - Host: localhost
    - Port: 5432
    - User: postgres
    - Password: postgres
    - Database: demo
    - Schema: public
- Sync interval: 30 seconds
- Tables to sync: users and posts

## Testing

1. The demo automatically syncs data from the PostgreSQL database
2. You can monitor the sync process through the `/sync-status` endpoint
3. View the synced data through the `/sync-data` endpoint
4. Test query hooks using the `/test-query` endpoint
5. Trigger manual syncs using the `/force-sync` endpoint
6. Monitor plugin state using the `/debug` endpoint

## Notes

- This is a demo setup with authentication disabled for simplicity
- In production, you should enable authentication and use secure database credentials
- The sync interval is set to 30 seconds for demo purposes; adjust as needed
- The demo includes mock data for testing without a real database connection
- Query hooks are demonstrated with simulated queries
