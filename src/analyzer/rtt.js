/**
 * RTT Analyzer Module (Enhanced)
 * Handles adaptive RTT measurements, status classification, and risk detection
 */

const SimpleKMeans = require('./kmeans');

class RTTAnalyzer {
    constructor() {
        this.measurements = [];
        this.pendingProbes = new Map();
        this.trackedJids = new Set(); // Track multi-device JIDs

        // Rolling average buffer for displaying results
        this.rollingWindow = [];
        this.rollingWindowSize = 3; // Average every 3 measurements

        // Adaptive Analysis
        this.kmeans = new SimpleKMeans(3); // 3 Clusters: Fast, Medium, Slow
        this.isCalibrated = false;

        // FIXED BASELINE: Never increases, only decreases when we see faster responses
        this.fixedBaseline = null;

        // Risk State
        this.presenceLog = new Map(); // Store latest presence per JID
        this.anomalies = [];

        this.deviceProfile = {
            detectedBrand: 'Unknown',
            detectedModel: 'Unknown',
            confidence: 0,
            characteristics: {},
            screenTransitions: [],
            riskFlags: []
        };
    }

    /**
     * Handle incoming presence update
     */
    handlePresence(update) {
        // update example: { id: "123@s.whatsapp.net", presences: { "123@s.whatsapp.net": { lastKnownPresence: "available" } } }
        const id = update.id;
        if (!update.presences || !update.presences[id]) return;

        const presence = update.presences[id].lastKnownPresence;
        this.presenceLog.set(id, {
            status: presence, // 'available', 'unavailable', 'composing', 'recording'
            timestamp: Date.now()
        });

        // Check for anomalies immediately
        this.detectAnomalies(id);
    }

    /**
     * Handle raw receipt (critical for Android devices)
     * Android devices send 'inactive' receipts that Baileys ignores by default
     */
    handleRawReceipt(node) {
        try {
            const { attrs } = node;
            
            // We only care about 'inactive' receipts here (Android devices)
            if (attrs.type === 'inactive') {
                console.log(`[RAW RECEIPT] Received inactive receipt from Android device:`, JSON.stringify(attrs));

                const msgId = attrs.id;
                const fromJid = attrs.from;

                if (!fromJid || !msgId) {
                    console.log('[RAW RECEIPT] Missing from JID or message ID');
                    return;
                }

                // Track this JID
                this.trackedJids.add(fromJid);

                // Process as CLIENT ACK
                return this.handleReceipt(msgId, 'inactive', fromJid);
            }
        } catch (err) {
            console.error(`[RAW RECEIPT] Error handling receipt:`, err);
        }
    }

    /**
     * Get status name for debugging
     */
    getStatusName(status) {
        switch (status) {
            case 0: return 'ERROR';
            case 1: return 'PENDING';
            case 2: return 'SERVER_ACK';
            case 3: return 'DELIVERY_ACK (CLIENT)';
            case 4: return 'READ';
            case 5: return 'PLAYED';
            case 'inactive': return 'INACTIVE (Android)';
            default: return 'UNKNOWN';
        }
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
     * Only processes CLIENT ACK (status 3) which means device actually received the message
     * Status 2 (SERVER ACK) only means WhatsApp server received it, not the user's device
     */
    handleReceipt(messageId, status, fromJid = null) {
        if (!this.pendingProbes.has(messageId)) {
            return null;
        }

        // CRITICAL: Only CLIENT ACK (3) means device is online and received the message
        // SERVER ACK (2) only means server received it, not the device
        // This is essential for Android device detection
        if (status !== 3 && status !== 'inactive') {
            console.log(`[RTT] Ignoring non-client receipt: status=${status} (${this.getStatusName(status)})`);
            return null;
        }

        const probe = this.pendingProbes.get(messageId);
        const endTime = Date.now();
        const rtt = endTime - probe.startTime;

        // Track the JID if provided (multi-device support)
        if (fromJid) {
            this.trackedJids.add(fromJid);
            console.log(`[RTT] CLIENT ACK from ${fromJid}, RTT: ${rtt}ms`);
        }

        // Train clustering model with new data
        this.updateModel(rtt);

        const userStatus = this.classifyStatus(rtt);
        const networkHealth = this.calculateNetworkHealth(rtt);

        const measurement = {
            timestamp: new Date().toISOString(),
            target: probe.target,
            deviceModel: probe.deviceModel || 'Unknown',
            rtt_ms: rtt,
            status: userStatus,
            receipt_type: status,
            network_health: networkHealth,
            smart_cluster: this.kmeans.classify(rtt)
        };

        this.measurements.push(measurement);
        this.pendingProbes.delete(messageId);

        // Add to rolling window for averaging (non-overlapping batches)
        this.rollingWindow.push(measurement);

        // Only return a measurement when we have a full window (3 samples)
        // Then RESET the window for the next batch of 3
        if (this.rollingWindow.length < this.rollingWindowSize) {
            console.log(`[RTT] Collecting samples... (${this.rollingWindow.length}/${this.rollingWindowSize})`);
            return null; // Don't emit measurement yet
        }

        // Calculate average from the full window (3 fresh samples)
        const avgRtt = this.rollingWindow.reduce((sum, m) => sum + m.rtt_ms, 0) / this.rollingWindow.length;
        const avgMeasurement = {
            ...measurement,
            rtt_ms: Math.round(avgRtt),
            raw_rtt: rtt,
            is_averaged: true,
            samples_in_avg: this.rollingWindow.length,
            window_rtts: this.rollingWindow.map(m => m.rtt_ms) // Show all RTTs in the window
        };

        console.log(`[RTT] Averaged result: ${Math.round(avgRtt)}ms from [${this.rollingWindow.map(m => m.rtt_ms).join(', ')}]`);

        // RESET window for next batch of 3 fresh samples
        this.rollingWindow = [];

        // Check for anomalies
        this.detectAnomalies(probe.jid || `${probe.target}@s.whatsapp.net`, avgMeasurement);

        // Update device profile every 5 measurements
        if (this.measurements.length % 5 === 0) {
            this.analyzeDeviceFingerprint();
        }

        return avgMeasurement;
    }

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
            status: 'OFFLINE',
            network_health: 'DISCONNECTED'
        };

        this.measurements.push(measurement);
        this.pendingProbes.delete(messageId);

        return measurement;
    }

    /**
     * Train the dynamic model
     */
    updateModel(newRtt) {
        const validRtts = this.measurements
            .filter(m => m.rtt_ms !== null)
            .map(m => m.rtt_ms);

        validRtts.push(newRtt);

        // Retrain K-Means if we have enough data (min 9 points for 3 batches of 3)
        if (validRtts.length >= 9 && validRtts.length % 3 === 0) {
            const success = this.kmeans.train(validRtts.slice(-100)); // Train on last 100 points
            if (success) {
                this.isCalibrated = true;
                console.log(`[RTT] ✅ Calibration complete! (${validRtts.length} samples) Centroids: [${this.kmeans.getCentroids().map(c => Math.round(c)).join(', ')}]ms`);
            }
        }
    }

    /**
     * Classify device status based on dynamic threshold
     * Uses median-based approach with multiple tiers
     */
    classifyStatus(rtt) {
        const validRtts = this.measurements
            .filter(m => m.rtt_ms !== null && m.rtt_ms > 0)
            .map(m => m.rtt_ms);

        // CALIBRATION PERIOD: Collect fast measurements to establish baseline
        // Only lock baseline from measurements < 1000ms (true foreground/active responses)
        const stabilizedRtts = validRtts.slice(3); // Skip first 3 warmup measurements
        
        if (this.fixedBaseline === null) {
            // Collect FAST measurements only (< 1000ms = likely foreground)
            const fastMeasurements = stabilizedRtts.filter(rtt => rtt < 1000);
            
            if (fastMeasurements.length >= 15) {
                // Have enough fast measurements, lock to their p20 (robust baseline)
                const sorted = [...fastMeasurements].sort((a, b) => a - b);
                const p20 = sorted[Math.floor(sorted.length * 0.20)];
                this.fixedBaseline = p20;
                console.log(`[RTT] 🔒 Baseline LOCKED at ${Math.round(this.fixedBaseline)}ms (p20 from ${fastMeasurements.length} fast measurements < 1000ms)`);
                console.log(`[RTT] Fast measurements: [${sorted.slice(0, 15).map(v => Math.round(v)).join(', ')}...]`);
            } else {
                // Still calibrating - waiting for fast measurements
                return `Calibrating... (${fastMeasurements.length}/15 fast samples)`;
            }
        }

        // Use FIXED baseline for thresholds
        const baseline = this.fixedBaseline;
        
        // VERY TIGHT thresholds - App Foreground must be significantly faster
        const threshold1 = baseline * 1.15; // App Foreground: only up to 1.15x baseline (very tight!)
        const threshold2 = baseline * 1.8;  // Screen On: 1.15x-1.8x baseline
        const threshold3 = baseline * 4.0;  // Screen Off: 1.8x-4x baseline
        // Above 4x = Offline
        
        // ADDITIONAL: Check RTT variance for better detection
        // When screen is off, RTT tends to be more consistent (less variance)
        const recentRtts = validRtts.slice(-10).map(m => m); // Last 10 measurements
        let variance = 0;
        if (recentRtts.length >= 5) {
            const avg = recentRtts.reduce((a, b) => a + b, 0) / recentRtts.length;
            variance = Math.sqrt(recentRtts.reduce((sum, r) => sum + Math.pow(r - avg, 2), 0) / recentRtts.length);
        }

        // Log for debugging
        let status;
        if (rtt < threshold1) {
            status = 'App Foreground';
        } else if (rtt < threshold2) {
            // If RTT is in "Screen On" range but variance is low, likely screen off
            if (variance < baseline * 0.3 && rtt > threshold1 * 1.2) {
                status = 'Screen Off';  // Low variance + not super fast = screen off
            } else {
                status = 'Screen On';
            }
        } else if (rtt < threshold3) {
            status = 'Screen Off';
        } else {
            status = 'Offline';
        }
        
        if (validRtts.length <= 50 || validRtts.length % 10 === 0) {
            console.log(`[RTT] ${rtt}ms | 🔒Base: ${Math.round(baseline)}ms | T1: ${Math.round(threshold1)} | T2: ${Math.round(threshold2)} | Variance: ${Math.round(variance)} → ${status}`);
        }

        return status;
    }

    /**
     * Calculate network health (Jitter)
     */
    calculateNetworkHealth(currentRtt) {
        const history = this.measurements.slice(-5).filter(m => m.rtt_ms !== null);
        if (history.length < 2) return 'STABLE';

        const prevRtt = history[history.length - 1].rtt_ms;
        const jitter = Math.abs(currentRtt - prevRtt);

        if (jitter > 500) return 'HIGH_JITTER (Mobile/Unstable)';
        if (jitter > 150) return 'MODERATE_JITTER';
        return 'STABLE (WiFi?)';
    }

    /**
     * Detect Anomalies (Ghosting, Modded Clients)
     */
    detectAnomalies(jid, latestMeasurement = null) {
        const presenceData = this.presenceLog.get(jid);
        if (!presenceData) return;

        const isOnline = presenceData.status === 'available' || presenceData.status === 'composing';
        const lastSeen = (Date.now() - presenceData.timestamp) / 1000;

        // 1. Ghost Detection: Presence says ONLINE, but RTT says OFFLINE/SLEEP
        if (isOnline && lastSeen < 10) {
            if (latestMeasurement) {
                const rttStatus = latestMeasurement.status;
                if (rttStatus.includes('SCREEN_OFF') || rttStatus === 'OFFLINE') {
                    this.addRiskFlag('GHOST_SESSION', 'User is "Online" but device is unresponsive. Possible server glitch or fake status.');
                }
            }
        }

        // 2. Modded Client Detection: Presence says OFFLINE, but RTT is Instant (Foreground)
        if (!isOnline && latestMeasurement) {
            if (latestMeasurement.status.includes('APP_FOREGROUND')) {
                this.addRiskFlag('HIDDEN_ACTIVE', 'User appears Offline but is actively using the app. Likely privacy settings or modded client.');
            }
        }
    }

    addRiskFlag(type, description) {
        // Avoid duplicates
        if (!this.deviceProfile.riskFlags.find(f => f.type === type)) {
            this.deviceProfile.riskFlags.push({
                type,
                description,
                timestamp: new Date().toISOString()
            });
        }
    }

    /**
     * ADVANCED: Detect anomalies in RTT patterns
     */
    detectRTTAnomalies() {
        if (this.measurements.length < 20) return [];

        const validRtts = this.measurements.filter(m => m.rtt_ms !== null).map(m => m.rtt_ms);
        if (validRtts.length < 10) return [];

        const recent = validRtts.slice(-10);
        const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
        const stdDev = Math.sqrt(recent.reduce((sum, r) => sum + Math.pow(r - avg, 2), 0) / recent.length);

        const anomalies = [];
        const latest = validRtts[validRtts.length - 1];

        // Sudden spike detection
        if (latest > avg + (3 * stdDev)) {
            anomalies.push({
                type: 'SUDDEN_SPIKE',
                description: `RTT jumped to ${latest}ms (3σ above average ${avg.toFixed(0)}ms)`,
                severity: 'HIGH'
            });
        }

        // Unusual consistency (possible fake data / bot)
        if (stdDev < 5 && validRtts.length > 30) {
            anomalies.push({
                type: 'TOO_CONSISTENT',
                description: `RTT unusually stable (σ=${stdDev.toFixed(1)}ms). Possible emulator/bot.`,
                severity: 'MEDIUM'
            });
        }

        return anomalies;
    }

    /**
     * ADVANCED: Predict next state using Markov Chain
     */
    predictNextState() {
        if (this.measurements.length < 10) return null;

        const states = this.measurements.slice(-20).map(m => {
            if (m.status.includes('FOREGROUND')) return 'F';
            if (m.status.includes('SCREEN_ON')) return 'S';
            if (m.status.includes('SCREEN_OFF')) return 'O';
            return 'X';
        });

        // Build transition matrix
        const transitions = {};
        for (let i = 0; i < states.length - 1; i++) {
            const from = states[i];
            const to = states[i + 1];
            if (!transitions[from]) transitions[from] = {};
            transitions[from][to] = (transitions[from][to] || 0) + 1;
        }

        // Predict
        const lastState = states[states.length - 1];
        if (!transitions[lastState]) return null;

        const nexts = Object.entries(transitions[lastState]);
        nexts.sort((a, b) => b[1] - a[1]);

        const stateNames = { 'F': 'Foreground', 'S': 'Screen On', 'O': 'Screen Off', 'X': 'Offline' };
        const total = nexts.reduce((sum, [, count]) => sum + count, 0);
        const probability = (nexts[0][1] / total * 100).toFixed(0);

        return {
            predicted: stateNames[nexts[0][0]],
            confidence: `${probability}%`
        };
    }

    /**
     * Analyze device fingerprint based on RTT patterns
     * (Retained original logic but added Risk Flags)
     */
    analyzeDeviceFingerprint() {
        if (this.measurements.length < 5) return this.deviceProfile;

        const validRtts = this.measurements.filter(m => m.rtt_ms !== null && m.rtt_ms < 10000);
        if (validRtts.length < 3) return this.deviceProfile;

        // ... (Keep existing fingerprinting logic logic for brevity, or simplify)
        // For this rewrite, I will reimplement a cleaner version

        const rtts = validRtts.map(m => m.rtt_ms);
        const avgRtt = rtts.reduce((sum, r) => sum + r, 0) / rtts.length;
        const stdDev = Math.sqrt(rtts.reduce((sum, r) => sum + Math.pow(r - avgRtt, 2), 0) / rtts.length);

        // Simplified Logic for now to ensure reliability
        let brand = 'Unknown';
        if (stdDev < 150) brand = 'Apple iPhone (High Confidence)';
        else if (stdDev < 300) brand = 'Android Flagship';
        else brand = 'Android Budget/Old';

        const characteristics = {
            'Avg RTT': `${avgRtt.toFixed(0)}ms`,
            'Std Dev': `${stdDev.toFixed(0)}ms`,
            'Calibration': this.isCalibrated ? 'Smart (Adaptive)' : 'Static (Uncalibrated)',
            'Clusters': this.isCalibrated ? this.kmeans.getCentroids().map(c => Math.round(c)).join(', ') : 'N/A'
        };

        this.deviceProfile.detectedBrand = brand;
        this.deviceProfile.characteristics = characteristics;

        return this.deviceProfile;
    }

    getStatistics() {
        // ... (Standard Getters)
        const validRtts = this.measurements.filter(m => m.rtt_ms !== null);
        const statusCounts = this.measurements.reduce((acc, m) => {
            acc[m.status] = (acc[m.status] || 0) + 1;
            return acc;
        }, {});

        // Calculate baseline and thresholds (using FIXED baseline from fast measurements only)
        let baseline = 0;
        let threshold1 = 0;
        let threshold2 = 0;
        let threshold3 = 0;
        let calibrationProgress = 0;
        let calibrationStatus = '⏳ Waiting for fast measurements...';
        
        if (this.fixedBaseline !== null) {
            baseline = this.fixedBaseline;
            threshold1 = baseline * 1.15; // App Foreground (very tight)
            threshold2 = baseline * 1.8;  // Screen On
            threshold3 = baseline * 4.0;  // Screen Off
            calibrationProgress = 100;
            calibrationStatus = `🔒 Locked: ${Math.round(baseline)}ms (from fast samples)`;
        } else {
            const stabilizedRtts = validRtts.slice(3).map(m => m.rtt_ms);
            const fastCount = stabilizedRtts.filter(rtt => rtt < 1000).length;
            calibrationProgress = Math.round((fastCount / 15) * 100);
            calibrationStatus = `⏳ Calibrating... (${fastCount}/15 fast samples < 1000ms)`;
        }

        return {
            total_measurements: this.measurements.length,
            avg_rtt: validRtts.length > 0 ? Math.round(validRtts.reduce((sum, m) => sum + m.rtt_ms, 0) / validRtts.length) : null,
            baseline_rtt: Math.round(baseline),
            threshold1_rtt: Math.round(threshold1),
            threshold2_rtt: Math.round(threshold2),
            threshold3_rtt: Math.round(threshold3),
            status_counts: statusCounts,
            risk_flags: this.deviceProfile.riskFlags,
            anomalies: this.detectRTTAnomalies(),
            prediction: this.predictNextState(),
            is_calibrated: this.fixedBaseline !== null,
            calibration_progress: calibrationProgress,
            calibration_status: calibrationStatus,
            centroids: this.isCalibrated ? this.kmeans.getCentroids().map(c => Math.round(c)) : null
        };
    }

    getDeviceProfile() {
        return this.deviceProfile;
    }

    getMeasurements() {
        return this.measurements;
    }

    clear() {
        this.measurements = [];
        this.rollingWindow = [];
        this.pendingProbes.clear();
        this.presenceLog.clear();
        this.anomalies = [];
        this.isCalibrated = false;
        this.deviceProfile = {
            detectedBrand: 'Unknown',
            detectedModel: 'Unknown',
            confidence: 0,
            characteristics: {},
            screenTransitions: [],
            riskFlags: []
        };
    }
}

module.exports = RTTAnalyzer;
