import type { MetricEvent, Telemetry as SdkTelemetry } from '@protontech/drive-sdk';

import type { Logger } from '../util/logger';

/**
 * The SDK's telemetry sink, wired to the plugin's own logger.
 *
 * The SDK defaults to writing straight to the console; routing it here instead
 * puts its diagnostics in the same ring buffer as the plugin's, so the sync log
 * in settings shows the whole story of a failed transfer rather than half of it.
 *
 * Metrics are deliberately dropped rather than forwarded. Proton's own clients
 * report them to Proton; a third-party plugin has no business sending a user's
 * transfer statistics anywhere, and nothing in the SDK requires it.
 */
export class Telemetry implements SdkTelemetry<MetricEvent> {
    constructor(private readonly logger: Logger) {}

    getLogger(name: string): Logger {
        return this.logger.getLogger(`sdk:${name}`);
    }

    recordMetric(_event: MetricEvent): void {
        // Intentionally not reported anywhere.
    }
}
