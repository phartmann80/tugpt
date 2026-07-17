import { NextResponse } from 'next/server';
import { defaultLogger } from '@tugpt/observability';

export async function GET(request: Request) {
  const requestId = request.headers.get('x-request-id') || `req-${Date.now()}`;
  const tenantId = request.headers.get('x-tenant-id');

  defaultLogger.info('Session verification', { requestId, tenantId, action: 'session_check' });

  return NextResponse.json({
    authenticated: false,
    user: null,
    tenantId: tenantId || null,
    timestamp: new Date().toISOString(),
  });
}
