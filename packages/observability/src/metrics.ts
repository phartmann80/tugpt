export interface ProviderMetrics {
  provider: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  success: boolean;
  errorCode?: string;
}

export class MetricsCollector {
  private static instance: MetricsCollector;
  private metrics: ProviderMetrics[] = [];

  public static getInstance(): MetricsCollector {
    if (!MetricsCollector.instance) {
      MetricsCollector.instance = new MetricsCollector();
    }
    return MetricsCollector.instance;
  }

  public recordProviderCall(metric: ProviderMetrics): void {
    this.metrics.push({
      ...metric,
    });

    // Log metric payload in structured format
    console.log(
      JSON.stringify({
        type: 'metric',
        metric_name: 'ai_provider_call',
        timestamp: new Date().toISOString(),
        ...metric,
      })
    );
  }

  public getRecentMetrics(): ProviderMetrics[] {
    return [...this.metrics];
  }

  public clear(): void {
    this.metrics = [];
  }
}

export const metricsCollector = MetricsCollector.getInstance();
