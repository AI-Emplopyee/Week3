import { route } from '@/lib/server';
import { ecusRequest, ecusStatus } from '@/lib/server-ecus';
export const dynamic = 'force-dynamic';
export function GET(request: Request) { return route(() => ecusRequest(() => ecusStatus(request))); }
