# Replication Plugin

Syncs data from an external source to the StarbaseDB instance at regular intervals.

## Configuration

Enable it in `src/index.ts` by creating a new instance of `ReplicationPlugin`.

```typescript
new ReplicationPlugin(cronPlugin)
```

It uses the `CronPlugin` to schedule the sync task.
