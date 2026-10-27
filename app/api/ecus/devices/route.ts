import { route } from '@/lib/server';
import { ecusDevices, ecusRequest } from '@/lib/server-ecus';
export function POST(request: Request) { return route(() => ecusRequest(() => ecusDevices(request))); }
export function DELETE(request: Request) { return route(() => ecusRequest(() => ecusDevices(request))); }
