// src/index.ts
import { Env } from './types';

export { DatabaseDurableObject } from './durable_object';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Route requests to the Durable Object
    // For simplicity, we'll use a fixed DO ID for the database.
    // In a real application, you might derive the DO ID from the request (e.g., tenant ID).
    const durableObjectId = env.DATABASE_OBJECT.idFromName('starbasedb-main-instance');
    const durableObjectStub = env.DATABASE_OBJECT.get(durableObjectId);

    // Forward the request to the Durable Object
    return durableObjectStub.fetch(request);
  },
};
