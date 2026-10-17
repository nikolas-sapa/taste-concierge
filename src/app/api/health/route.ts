import { getRuntime } from '@/server/runtime';
import { json } from '@/server/http/guards';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(): Promise<Response> {
  try {
    const app = await getRuntime();
    return json({ status: app.origin && app.bindingConfigurationValid && await app.storageReady() && await app.client.isReady() ? 'ready' : 'unconfigured' });
  } catch { return json({ status: 'unconfigured' }); }
}
