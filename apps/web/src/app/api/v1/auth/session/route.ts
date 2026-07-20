import { NextResponse } from 'next/server';
import { defaultLogger } from '@tugpt/observability';
import { createServerClient } from '@tugpt/database';
import { AuthService } from '@tugpt/auth';

export async function GET(request: Request) {
  const requestId = request.headers.get('x-request-id') || `req-${Date.now()}`;
  const rawTenantId = request.headers.get('x-tenant-id');

  try {
    const supabase = createServerClient();
    const authService = new AuthService(supabase);

    const user = await authService.getCurrentUser();

    if (!user) {
      defaultLogger.info('Session check: unauthenticated', { requestId });
      return NextResponse.json(
        { authenticated: false, user: null, activeTenant: null },
        { status: 401 }
      );
    }

    // Resolve active tenant context server-side (validating user membership)
    const activeTenant = await authService.resolveTenantContext(user.id, rawTenantId);

    defaultLogger.info('Session check: authenticated', {
      requestId,
      userId: user.id,
      tenantId: activeTenant?.organizationId || null,
    });

    return NextResponse.json({
      authenticated: true,
      user: {
        id: user.id,
        email: user.email,
        fullName: user.fullName,
        avatarUrl: user.avatarUrl,
      },
      activeTenant,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    defaultLogger.error('Session check failed', err as Error, { requestId });
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 });
  }
}
