import { retryWordDocument } from '@/lib/server-word-retry';
import { route } from '@/lib/server';
export const dynamic = 'force-dynamic';
export function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return route(async () => retryWordDocument(request, (await context.params).id));
}
