import { CloudflarePlugin } from './index';
import { StarbaseApp } from '../../src/handler';

describe('CloudflarePlugin', () => {
  it('should register successfully', async () => {
    const app: StarbaseApp = {} as any;
    const plugin = new CloudflarePlugin();
    await plugin.register(app);
  });
});