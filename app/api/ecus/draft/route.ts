import { route } from '@/lib/server';
import { ecusDraft, ecusRequest } from '@/lib/server-ecus';
export const dynamic = 'force-dynamic';
export function GET(request: Request) { return route(() => ecusRequest(() => ecusDraft(request))); }
export function POST(request: Request) { return route(() => ecusRequest(() => ecusDraft(request))); }
