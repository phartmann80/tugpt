import { NextResponse } from 'next/server';
import { defaultLogger } from '@tugpt/observability';
import { APP_CONFIG } from '../../../../config/locales';

export async function GET(request: Request) {
  const requestId = request.headers.get('x-request-id') || `req-${Date.now()}`;
  defaultLogger.info('Healthcheck requested', { requestId, action: 'health_check' });

  return NextResponse.json({
    status: 'ok',
    app: APP_CONFIG.name,
    version: '1.0.0',
    timestamp: new Date().toISOString(),
    locales: {
      primary: APP_CONFIG.primaryLocale,
      secondary: APP_CONFIG.secondaryLocale,
      supported: APP_CONFIG.supportedLocales,
    },
  });
}
