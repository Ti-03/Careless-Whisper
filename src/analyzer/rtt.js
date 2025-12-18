/**
 * RTT Analyzer Module
 * Handles RTT measurements, status classification, and device fingerprinting
 */

class RTTAnalyzer {
    constructor() {
        this.measurements = [];
        this.pendingProbes = new Map();
        this.deviceProfile = {
            detectedBrand: 'Unknown',
            detectedModel: 'Unknown',
            confidence: 0,
            characteristics: {},
            screenTransitions: []
        };
    }

    /**
     * Register a new probe
     */
    registerProbe(messageId, probeData) {
        this.pendingProbes.set(messageId, probeData);
        
        // Auto-timeout after 10 seconds
        setTimeout(() => {
            if (this.pendingProbes.has(messageId)) {
                this.handleTimeout(messageId);
            }
        }, 10000);
    }

    /**
     * Handle receipt and calculate RTT
     */
    handleReceipt(messageId, status) {
        if (!this.pendingProbes.has(messageId)) {
            return null;
        }
        
        const probe = this.pendingProbes.get(messageId);
        const endTime = Date.now();
        const rtt = endTime - probe.startTime;
        
        const userStatus = this.classifyStatus(rtt);
        
        const measurement = {
            timestamp: new Date().toISOString(),
            target: probe.target,
            deviceModel: probe.deviceModel || 'Unknown',
            rtt_ms: rtt,
            status: userStatus,
            receipt_type: status
        };
        
        this.measurements.push(measurement);
        this.pendingProbes.delete(messageId);
        
        // Update device profile every 5 measurements
        if (this.measurements.length % 5 === 0) {
            this.analyzeDeviceFingerprint();
        }
        
        return measurement;
    }

    /**
     * Handle probe timeout (offline)
     */
    handleTimeout(messageId) {
        if (!this.pendingProbes.has(messageId)) {
            return null;
        }
        
        const probe = this.pendingProbes.get(messageId);
        const measurement = {
            timestamp: new Date().toISOString(),
            target: probe.target,
            deviceModel: probe.deviceModel || 'Unknown',
            rtt_ms: null,
            status: 'OFFLINE'
        };
        
        this.measurements.push(measurement);
        this.pendingProbes.delete(messageId);
        
        return measurement;
    }

    /**
     * Classify device status based on RTT
     * Thresholds adjusted for Jordan network (+300ms baseline)
     */
    classifyStatus(rtt) {
        if (rtt < 900) return 'APP_FOREGROUND';
        if (rtt < 1600) return 'SCREEN_ON';
        if (rtt < 3800) return 'SCREEN_OFF';
        return 'UNKNOWN';
    }

    /**
     * Analyze device fingerprint based on RTT patterns
     */
    analyzeDeviceFingerprint() {
        if (this.measurements.length < 5) {
            return this.deviceProfile;
        }
        
        const validRtts = this.measurements.filter(m => m.rtt_ms !== null && m.rtt_ms < 10000);
        if (validRtts.length < 3) {
            return this.deviceProfile;
        }
        
        // Calculate statistics
        const rtts = validRtts.map(m => m.rtt_ms);
        const avgRtt = rtts.reduce((sum, r) => sum + r, 0) / rtts.length;
        const minRtt = Math.min(...rtts);
        const maxRtt = Math.max(...rtts);
        const stdDev = Math.sqrt(rtts.reduce((sum, r) => sum + Math.pow(r - avgRtt, 2), 0) / rtts.length);
        
        // Count status distribution
        const statusCounts = validRtts.reduce((acc, m) => {
            acc[m.status] = (acc[m.status] || 0) + 1;
            return acc;
        }, {});
        
        // Device detection logic
        let brand = 'Unknown';
        let confidence = 0;
        let characteristics = {};
        
        // iPhone detection (low variance, tight clustering)
        if ((stdDev < 250 && minRtt >= 300 && minRtt < 800 && avgRtt < 1500) || 
            (stdDev < 200 && avgRtt < 1800)) {
            brand = 'Apple iPhone Pro/Max';
            confidence = 88;
            characteristics = {
                'Processor': 'A17/A18 Pro chip',
                'RTT Stability': 'Very High (iOS)',
                'iOS Signature': 'Low variance despite high RTT'
            };
        } else if ((stdDev < 300 && minRtt >= 350 && minRtt < 900 && avgRtt < 1700) ||
                   (stdDev < 250 && avgRtt < 2000)) {
            brand = 'Apple iPhone';
            confidence = 85;
            characteristics = {
                'RTT Stability': 'High (iOS)',
                'iOS Signature': 'Consistent timing'
            };
        } else if (minRtt >= 400 && minRtt <= 750 && avgRtt < 1500 && stdDev >= 200 && stdDev < 350) {
            brand = 'Samsung Galaxy (Flagship)';
            confidence = 75;
            characteristics = {
                'Processor': 'Snapdragon/Exynos',
                'RTT Stability': 'Moderate-High'
            };
        } else if (avgRtt > 1600 || stdDev > 450) {
            brand = 'Android (Budget/Mid-range)';
            confidence = 70;
            characteristics = {
                'RTT Stability': 'Low',
                'Power Management': 'Aggressive'
            };
        } else if ((minRtt > 700 || avgRtt > 1300) && stdDev > 300) {
            brand = 'Android Device';
            confidence = 65;
        }
        
        // Detect transitions
        const transitions = [];
        for (let i = 1; i < validRtts.length; i++) {
            if (validRtts[i].status !== validRtts[i-1].status) {
                transitions.push({
                    time: validRtts[i].timestamp,
                    from: validRtts[i-1].status,
                    to: validRtts[i].status,
                    rttChange: validRtts[i].rtt_ms - validRtts[i-1].rtt_ms
                });
            }
        }
        
        // Add statistics to characteristics
        characteristics['Avg RTT'] = `${avgRtt.toFixed(0)}ms`;
        characteristics['Min RTT'] = `${minRtt.toFixed(0)}ms`;
        characteristics['Max RTT'] = `${maxRtt.toFixed(0)}ms`;
        characteristics['RTT Std Dev'] = `${stdDev.toFixed(0)}ms`;
        characteristics['Foreground %'] = `${((statusCounts.APP_FOREGROUND || 0) / validRtts.length * 100).toFixed(1)}%`;
        characteristics['Screen On %'] = `${((statusCounts.SCREEN_ON || 0) / validRtts.length * 100).toFixed(1)}%`;
        characteristics['Screen Off %'] = `${((statusCounts.SCREEN_OFF || 0) / validRtts.length * 100).toFixed(1)}%`;
        characteristics['Transitions'] = transitions.length;
        
        this.deviceProfile = {
            detectedBrand: brand,
            detectedModel: 'Not specified',
            confidence: confidence,
            characteristics: characteristics,
            screenTransitions: transitions
        };
        
        return this.deviceProfile;
    }

    /**
     * Get current statistics
     */
    getStatistics() {
        const validRtts = this.measurements.filter(m => m.rtt_ms !== null);
        const statusCounts = this.measurements.reduce((acc, m) => {
            acc[m.status] = (acc[m.status] || 0) + 1;
            return acc;
        }, {});
        
        return {
            total: this.measurements.length,
            avgRtt: validRtts.length > 0 ? Math.round(validRtts.reduce((sum, m) => sum + m.rtt_ms, 0) / validRtts.length) : null,
            minRtt: validRtts.length > 0 ? Math.min(...validRtts.map(m => m.rtt_ms)) : null,
            maxRtt: validRtts.length > 0 ? Math.max(...validRtts.map(m => m.rtt_ms)) : null,
            statusCounts: statusCounts
        };
    }

    /**
     * Get device profile
     */
    getDeviceProfile() {
        return this.deviceProfile;
    }

    /**
     * Get all measurements
     */
    getMeasurements() {
        return this.measurements;
    }

    /**
     * Clear all data
     */
    clear() {
        this.measurements = [];
        this.pendingProbes.clear();
        this.deviceProfile = {
            detectedBrand: 'Unknown',
            detectedModel: 'Unknown',
            confidence: 0,
            characteristics: {},
            screenTransitions: []
        };
    }
}

module.exports = RTTAnalyzer;
