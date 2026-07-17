import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const response = NextResponse.next();

  // Inject Request ID for distributed tracing
  const requestId = request.headers.get('x-request-id') || `req-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
  response.headers.set('x-request-id', requestId);

  // Protected route check
  const isAuthRoute = pathname.startsWith('/auth');
  const isProtectedAppRoute = pathname.startsWith('/dashboard') || pathname.startsWith('/settings');

  // Tenant header propagation
  const activeTenantId = request.cookies.get('tugpt_tenant_id')?.value;
  if (activeTenantId) {
    response.headers.set('x-tenant-id', activeTenantId);
  }

  return response;
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
