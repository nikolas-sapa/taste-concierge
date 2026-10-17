import { handleOperation } from '@/server/http/operation';
export const runtime = 'nodejs';
export const maxDuration = 100;
export async function POST(request: Request): Promise<Response> {
  return handleOperation(request, 'initialize');
}
