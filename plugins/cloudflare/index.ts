import { StarbasePlugin } from '../../src/plugin';

export class CloudflarePlugin extends StarbasePlugin {
  constructor() {
    super('cloudflare', { requiresAuth: true });
  }

  public async register(app: any): Promise<void> {
    // TO DO: implement register method
  }

  public async beforeQuery(opts: any): Promise<any> {
    // TO DO: implement beforeQuery method
    return opts;
  }

  public async afterQuery(opts: any): Promise<any> {
    // TO DO: implement afterQuery method
    return opts.result;
  }
}