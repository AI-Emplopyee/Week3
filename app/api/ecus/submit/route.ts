import { route } from '@/lib/server';
import { ecusRequest, submitEcusExport } from '@/lib/server-ecus';
export function POST(request: Request) { return route(() => ecusRequest(() => submitEcusExport(request))); }
