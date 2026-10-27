import { route } from '@/lib/server';
import { ecusCompanion, ecusRequest } from '@/lib/server-ecus';
export function POST(request: Request) { return route(() => ecusRequest(() => ecusCompanion(request))); }
