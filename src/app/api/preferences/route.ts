import { handleOperation } from '@/server/http/operation';
export const runtime = 'nodejs';
export async function POST(request: Request): Promise<Response> {
  return handleOperation(request, 'update');
}
