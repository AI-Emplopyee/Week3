import { route } from '@/lib/server';
import { ecusReconcile, ecusRequest } from '@/lib/server-ecus';
export const dynamic = 'force-dynamic';
export function POST(request: Request) { return route(() => ecusRequest(() => ecusReconcile(request))); }
