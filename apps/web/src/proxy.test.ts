import { describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { classifyRoute, proxy } from './proxy';

describe('Next.js 16 Proxy Route Classifier', () => {
  it('classifies /auth paths as auth routes', () => {
    expect(classifyRoute('/auth/login')).toBe('auth');
    expect(classifyRoute('/auth/callback')).toBe('auth');
    expect(classifyRoute('/api/v1/auth/session')).toBe('auth');
  });

  it('classifies protected application paths as protected routes', () => {
    expect(classifyRoute('/dashboard')).toBe('protected');
    expect(classifyRoute('/dashboard/analytics')).toBe('protected');
    expect(classifyRoute('/settings')).toBe('protected');
    expect(classifyRoute('/crm')).toBe('protected');
    expect(classifyRoute('/organizations')).toBe('protected');
  });

  it('classifies public paths as public routes', () => {
    expect(classifyRoute('/')).toBe('public');
    expect(classifyRoute('/about')).toBe('public');
    expect(classifyRoute('/pricing')).toBe('public');
    expect(classifyRoute('/api/v1/health')).toBe('public');
  });
});

describe('Next.js 16 Proxy Execution', () => {
  it('redirects unauthenticated users from protected routes to login', () => {
    const req = new NextRequest('http://localhost/dashboard');
    const res = proxy(req);

    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toBe('http://localhost/auth/login?redirect=%2Fdashboard');
  });

  it('allows authenticated users with session cookie (tugpt_session) to access protected routes', () => {
    const req = new NextRequest('http://localhost/dashboard', {
      headers: { cookie: 'tugpt_session=test-session-token' },
    });
    const res = proxy(req);

    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toMatch(/^req-/);
  });

  it('allows authenticated users with Supabase access token (sb-access-token) to access protected routes', () => {
    const req = new NextRequest('http://localhost/settings', {
      headers: { cookie: 'sb-access-token=sb-test-token' },
    });
    const res = proxy(req);

    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toMatch(/^req-/);
  });

  it('injects x-request-id and propagates x-tenant-id header when cookie is present', () => {
    const req = new NextRequest('http://localhost/api/v1/health', {
      headers: {
        'x-request-id': 'custom-req-id-123',
        cookie: 'tugpt_tenant_id=org-uuid-456',
      },
    });
    const res = proxy(req);

    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBe('custom-req-id-123');
    expect(res.headers.get('x-tenant-id')).toBe('org-uuid-456');
  });

  it('propagates x-tenant-id header when cookie is absent but header is present', () => {
    const req = new NextRequest('http://localhost/api/v1/health', {
      headers: {
        'x-request-id': 'custom-req-id-789',
        'x-tenant-id': 'org-uuid-789',
      },
    });
    const res = proxy(req);

    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toBe('custom-req-id-789');
    expect(res.headers.get('x-tenant-id')).toBe('org-uuid-789');
  });
});
