/**
 * Main Server File
 * Coordinates between WhatsApp connector, RTT analyzer, and web interface
 */

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const qrcode = require('qrcode');

// Import modules
const WhatsAppConnector = require('./src/connectors/whatsapp');
const RTTAnalyzer = require('./src/analyzer/rtt');
const MonitoringController = require('./src/controller/monitoring');

// Initialize Express
const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Initialize modules
const whatsappConnector = new WhatsAppConnector();
const rttAnalyzer = new RTTAnalyzer();
const monitoringController = new MonitoringController(whatsappConnector, rttAnalyzer);

// Middleware
app.use(express.static('public'));
app.use(express.json());

// Serve main HTML file
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Set up WhatsApp connector callbacks
whatsappConnector.onQR((qrData) => {
    io.emit('qr', qrData);
});

whatsappConnector.onConnected((user) => {
    io.emit('connected', user);
});

whatsappConnector.onDisconnected(() => {
    io.emit('disconnected');
});

whatsappConnector.onMessageUpdate((updates) => {
    for (const update of updates) {
        if (update.update.status) {
            const measurement = rttAnalyzer.handleReceipt(update.key.id, update.update.status);
            if (measurement) {
                io.emit('measurement', measurement);
                
                // Send device profile every 5 measurements
                if (rttAnalyzer.getMeasurements().length % 5 === 0) {
                    io.emit('device-profile', rttAnalyzer.getDeviceProfile());
                }
            }
        }
    }
});

// Socket.io event handlers
io.on('connection', (socket) => {
    console.log('Client connected');
    
    // Send current connection status
    socket.on('get-status', () => {
        if (whatsappConnector.isConnected()) {
            socket.emit('connected', whatsappConnector.getUserInfo());
        }
    });
    
    // Start monitoring
    socket.on('start-monitoring', async (config) => {
        try {
            await monitoringController.start(config, {
                onProbe: (probe) => {
                    // Probe sent
                },
                onComplete: () => {
                    io.emit('log', 'Monitoring completed');
                    const filename = monitoringController.exportResults();
                    io.emit('log', `Results exported to: ${filename}`);
                },
                onLog: (message) => {
                    io.emit('log', message);
                }
            });
        } catch (error) {
            socket.emit('log', `Error: ${error.message}`);
        }
    });
    
    // Stop monitoring
    socket.on('stop-monitoring', () => {
        monitoringController.stop();
        io.emit('log', 'Monitoring stopped by user');
        const filename = monitoringController.exportResults();
        io.emit('log', `Results exported to: ${filename}`);
    });
    
    // Get statistics
    socket.on('get-stats', () => {
        const stats = rttAnalyzer.getStatistics();
        socket.emit('stats', stats);
    });
    
    // Clear results
    socket.on('clear-results', () => {
        rttAnalyzer.clear();
        io.emit('log', 'All results cleared');
    });
    
    // Logout
    socket.on('logout', async () => {
        try {
            await whatsappConnector.logout();
            io.emit('log', 'Logged out successfully');
            io.emit('disconnected');
        } catch (error) {
            socket.emit('log', `Logout error: ${error.message}`);
        }
    });
});

// Start server
const PORT = process.env.PORT || 3000;

server.listen(PORT, async () => {
    console.log(`\n🌐 Web Interface running at: http://localhost:${PORT}`);
    console.log('\n📱 Connecting to WhatsApp...\n');
    
    try {
        await whatsappConnector.connect();
    } catch (error) {
        console.error('Error connecting to WhatsApp:', error);
    }
});
