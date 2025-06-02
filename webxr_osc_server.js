const https = require('https');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const osc = require('osc'); // Ensure you have this installed: npm install osc

// --- Configuration ---
const SSL_KEY_FILE = 'key.pem'; // Your private key file
const SSL_CERT_FILE = 'cert.pem'; // Your certificate file
const SERVER_IP = '192.168.1.104'; // Your server's IP address on the local network
const SERVER_PORT = 8443; // Port for the HTTPS server
const OSC_TARGET_IP = '127.0.0.1'; // IP of the machine running Max/MSP (localhost if same machine)

// OSC Port Configuration
const OSC_PORTS = {
  HMD: 7400,          // HMD data goes to port 7400
  CONTROLLER0: 7401,  // Controller 0 data goes to port 7401
  CONTROLLER1: 7402   // Controller 1 data goes to port 7402
};

// Debug and logging configuration
const DEBUG_MODE = true;
const LOG_OSC_MESSAGES = false; // Set to true to log all OSC messages
const LOG_SAMPLE_RATE = 0.001; // Log 0.1% of messages to avoid spam

// OSC Connection management - now supports multiple ports
let oscUDPPorts = {
  HMD: null,
  CONTROLLER0: null,
  CONTROLLER1: null
};
let oscConnected = {
  HMD: false,
  CONTROLLER0: false,
  CONTROLLER1: false
};
let oscMessageCount = 0;
let oscErrorCount = 0;
let lastOSCError = null;

// Performance tracking
let messageStats = {
  hmd: { count: 0, lastTime: 0 },
  controller0: { count: 0, lastTime: 0 },
  controller1: { count: 0, lastTime: 0 }
};

// Enhanced logging function
function debugLog(message, data = null, level = 'INFO') {
  if (DEBUG_MODE) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] [${level}] ${message}`;
    
    if (data) {
      console.log(logMessage, data);
    } else {
      console.log(logMessage);
    }
  }
}

// Initialize persistent OSC connections for each device type
function initOSCConnection() {
  debugLog('Initializing OSC connections for all device types');
  
  Object.keys(OSC_PORTS).forEach(deviceType => {
    const port = OSC_PORTS[deviceType];
    
    if (oscUDPPorts[deviceType]) {
      debugLog(`OSC connection for ${deviceType} already exists, skipping initialization`);
      return;
    }

    debugLog(`Initializing OSC connection for ${deviceType} to ${OSC_TARGET_IP}:${port}`);
    
    oscUDPPorts[deviceType] = new osc.UDPPort({
      localAddress: '0.0.0.0',
      localPort: 0, // Let system assign port
      remoteAddress: OSC_TARGET_IP,
      remotePort: port,
      metadata: true
    });

    oscUDPPorts[deviceType].on('ready', () => {
      oscConnected[deviceType] = true;
      debugLog(`OSC UDP port opened successfully for ${deviceType}`, { 
        localPort: oscUDPPorts[deviceType].options.localPort,
        remoteAddress: `${OSC_TARGET_IP}:${port}`
      });
    });

    oscUDPPorts[deviceType].on('error', (err) => {
      oscConnected[deviceType] = false;
      oscErrorCount++;
      lastOSCError = err.message;
      debugLog(`OSC UDP port error for ${deviceType} (${oscErrorCount} total errors)`, err.message, 'ERROR');
      
      // Attempt to reconnect after a delay
      setTimeout(() => {
        debugLog(`Attempting to reconnect OSC for ${deviceType}...`);
        reconnectOSC(deviceType);
      }, 5000);
    });

    oscUDPPorts[deviceType].on('close', () => {
      oscConnected[deviceType] = false;
      debugLog(`OSC UDP port closed for ${deviceType}`);
    });

    try {
      oscUDPPorts[deviceType].open();
    } catch (err) {
      debugLog(`Failed to open OSC UDP port for ${deviceType}`, err.message, 'ERROR');
      oscConnected[deviceType] = false;
    }
  });
}

// Reconnect OSC with cleanup - now supports individual device types
function reconnectOSC(deviceType = null) {
  const devicesToReconnect = deviceType ? [deviceType] : Object.keys(OSC_PORTS);
  
  devicesToReconnect.forEach(device => {
    if (oscUDPPorts[device]) {
      try {
        oscUDPPorts[device].close();
      } catch (err) {
        debugLog(`Error closing existing OSC port for ${device} during reconnect`, err.message, 'WARN');
      }
      oscUDPPorts[device] = null;
    }
    
    oscConnected[device] = false;
  });
  
  setTimeout(initOSCConnection, 1000);
}

// Determine which device type and port to use based on OSC address
function getDeviceTypeFromAddress(address) {
  if (address.startsWith('/hmd')) {
    return 'HMD';
  } else if (address.startsWith('/controller0')) {
    return 'CONTROLLER0';
  } else if (address.startsWith('/controller1')) {
    return 'CONTROLLER1';
  }
  return 'HMD'; // Default fallback
}

// Enhanced OSC message sending with per-device port routing
function sendOSC(address, args) {
  const deviceType = getDeviceTypeFromAddress(address);
  const targetPort = OSC_PORTS[deviceType];
  const udpPort = oscUDPPorts[deviceType];
  const isConnected = oscConnected[deviceType];
  
  if (!isConnected || !udpPort) {
    if (oscErrorCount < 5) { // Limit error spam
      debugLog(`OSC not connected for ${deviceType}, unable to send message`, { 
        address, 
        deviceType,
        targetPort,
        connected: isConnected 
      }, 'WARN');
    }
    return false;
  }

  try {
    const oscMessage = {
      address: address,
      args: args.map(v => ({ 
        type: 'f', 
        value: isNaN(parseFloat(v)) ? 0.0 : parseFloat(v) 
      }))
    };

    udpPort.send(oscMessage);
    oscMessageCount++;
    
    // Update performance stats
    updateMessageStats(address);
    
    // Periodic logging based on sample rate
    if (LOG_OSC_MESSAGES || Math.random() < LOG_SAMPLE_RATE) {
      debugLog(`OSC sent to ${deviceType}:${targetPort}: ${address}`, {
        args: args.slice(0, 3), // Only log first 3 args to avoid spam
        totalMessages: oscMessageCount
      });
    }
    
    return true;
  } catch (err) {
    oscErrorCount++;
    lastOSCError = err.message;
    debugLog(`Error sending OSC message to ${deviceType}:${targetPort}`, { 
      error: err.message, 
      address, 
      totalErrors: oscErrorCount 
    }, 'ERROR');
    
    // Try to reconnect if we have too many errors
    if (oscErrorCount > 10) {
      debugLog(`Too many OSC errors for ${deviceType}, attempting reconnection`);
      reconnectOSC(deviceType);
    }
    
    return false;
  }
}

// Track message statistics for performance monitoring
function updateMessageStats(address) {
  const now = Date.now();
  let deviceKey = 'hmd';
  
  if (address.includes('controller0')) deviceKey = 'controller0';
  else if (address.includes('controller1')) deviceKey = 'controller1';
  
  if (messageStats[deviceKey]) {
    messageStats[deviceKey].count++;
    messageStats[deviceKey].lastTime = now;
  }
}

// Print periodic statistics
function printOSCStats() {
  if (!DEBUG_MODE) return;
  
  const uptime = process.uptime();
  const connectionStatus = Object.keys(OSC_PORTS).map(device => 
    `${device}:${OSC_PORTS[device]}=${oscConnected[device] ? 'OK' : 'FAIL'}`
  ).join(', ');
  
  debugLog('OSC Performance Stats', {
    uptime: `${Math.floor(uptime)}s`,
    connections: connectionStatus,
    totalMessages: oscMessageCount,
    totalErrors: oscErrorCount,
    lastError: lastOSCError,
    messagesPerSecond: Math.round(oscMessageCount / uptime),
    deviceStats: messageStats,
    portRouting: {
      HMD: `port ${OSC_PORTS.HMD}`,
      Controller0: `port ${OSC_PORTS.CONTROLLER0}`,
      Controller1: `port ${OSC_PORTS.CONTROLLER1}`
    }
  });
}

// Enhanced OSC message handling with validation
function handleOSCMessage(msg) {
  const { address, args } = msg;

  // Validate message structure
  if (!address || typeof address !== 'string') {
    debugLog('Invalid OSC address received', { address }, 'WARN');
    return;
  }

  if (!Array.isArray(args)) {
    debugLog('Invalid OSC args received', { args }, 'WARN');
    return;
  }

  // Validate numeric args
  const validArgs = args.filter(arg => {
    const num = parseFloat(arg);
    return !isNaN(num) && isFinite(num);
  });

  if (validArgs.length !== args.length) {
    debugLog('Some OSC args were invalid and filtered', {
      original: args.length,
      valid: validArgs.length,
      address
    }, 'WARN');
  }

  // Enhanced logging for controller button states
  if (address.startsWith('/controller') && validArgs.length >= 8) {
    const btnState = validArgs[7];
    const controllerNum = address.includes('controller0') ? 0 : 1;
    
    if (LOG_OSC_MESSAGES) {
      debugLog(`Controller ${controllerNum} button state: ${btnState ? 'Pressed' : 'Released'}`, {
        position: validArgs.slice(0, 3),
        orientation: validArgs.slice(3, 7)
      });
    }
  }

  // Send OSC message
  const success = sendOSC(address, validArgs);
  
  if (!success && DEBUG_MODE) {
    debugLog('Failed to send OSC message', { address, argsLength: validArgs.length }, 'WARN');
  }
}

// Load HTTPS certs with better error handling
let options;
try {
  options = {
    key: fs.readFileSync(path.join(__dirname, SSL_KEY_FILE)),
    cert: fs.readFileSync(path.join(__dirname, SSL_CERT_FILE)),
  };
  debugLog('SSL certificates loaded successfully');
} catch (err) {
  console.error('Failed to load SSL certificates:', err.message);
  console.error('Make sure key.pem and cert.pem files exist in the project directory');
  process.exit(1);
}

// Create HTTPS server with enhanced logging
const server = https.createServer(options, (req, res) => {
  let filePath;
  let contentType = 'text/html';
  let statusCode = 200;

  debugLog(`HTTP request received: ${req.method} ${req.url}`, {
    userAgent: req.headers['user-agent'],
    remoteAddress: req.headers['x-forwarded-for'] || req.socket.remoteAddress
  });

  // Basic routing for serving files
  if (req.url === '/' || req.url === '/index.html') {
    filePath = path.join(__dirname, 'index.html');
  } else if (req.url === '/three.min.js') {
    filePath = path.join(__dirname, 'three.min.js');
    contentType = 'application/javascript';
  } else if (req.url === '/app.js') {
    filePath = path.join(__dirname, 'app.js');
    contentType = 'application/javascript';
  } else {
    // Handle 404 Not Found
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 Not Found');
    debugLog(`404 Not Found: ${req.url}`, null, 'WARN');
    return;
  }

  // Read and serve the file
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Error loading ${path.basename(filePath)}`);
      debugLog(`Error loading ${filePath}`, err.message, 'ERROR');
    } else {
      res.writeHead(statusCode, { 'Content-Type': contentType });
      res.end(data);
      debugLog(`Served ${path.basename(filePath)} (${data.length} bytes)`);
    }
  });
});

// Enhanced server startup
server.listen(SERVER_PORT, SERVER_IP, () => {
  console.log('='.repeat(60));
  console.log('WebXR OSC Bridge Server Started');
  console.log('='.repeat(60));
  console.log('🌐 HTTPS Server: https://${SERVER_IP}:${SERVER_PORT}');
  console.log('🎛️  OSC Routing:');
  console.log(`   • HMD data → ${OSC_TARGET_IP}:${OSC_PORTS.HMD}`);
  console.log(`   • Controller 0 → ${OSC_TARGET_IP}:${OSC_PORTS.CONTROLLER0}`);
  console.log(`   • Controller 1 → ${OSC_TARGET_IP}:${OSC_PORTS.CONTROLLER1}`);
  console.log(`🔧 Debug Mode: ${DEBUG_MODE ? 'Enabled' : 'Disabled'}`);
  console.log(`📊 OSC Logging: ${LOG_OSC_MESSAGES ? 'Enabled' : 'Disabled'}`);
  console.log('='.repeat(60));
  console.log('Make sure your Quest headset is on the same Wi-Fi network.');
  console.log('='.repeat(60));
});

// WebSocket server setup with enhanced connection handling
const wss = new WebSocket.Server({ 
  server,
  perMessageDeflate: false, // Disable compression for better performance
  maxPayload: 1024 // Limit payload size
});

let connectedClients = 0;

wss.on('connection', (ws, req) => {
  const clientIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  const userAgent = req.headers['user-agent'] || 'Unknown';
  connectedClients++;
  
  debugLog(`WebSocket client connected (#${connectedClients})`, {
    ip: clientIp,
    userAgent: userAgent.substring(0, 100), // Truncate long user agents
    totalClients: connectedClients
  });

  // Send connection confirmation
  try {
    const allConnected = Object.values(oscConnected).every(connected => connected);
    ws.send(JSON.stringify({
      type: 'connection',
      status: 'connected',
      oscStatus: allConnected ? 'ready' : 'connecting',
      oscPorts: OSC_PORTS
    }));
  } catch (err) {
    debugLog('Failed to send connection confirmation', err.message, 'WARN');
  }

  ws.on('message', (message) => {
    try {
      const msgString = message.toString();
      
      // Validate message size
      if (msgString.length > 512) {
        debugLog('Received oversized WebSocket message', { size: msgString.length }, 'WARN');
        return;
      }
      
      const msg = JSON.parse(msgString);
      handleOSCMessage(msg);
    } catch (err) {
      debugLog('WebSocket message processing error', {
        error: err.message,
        messagePreview: message.toString().substring(0, 100)
      }, 'ERROR');
    }
  });

  ws.on('close', (code, reason) => {
    connectedClients = Math.max(0, connectedClients - 1);
    debugLog(`WebSocket client disconnected`, {
      ip: clientIp,
      code,
      reason: reason.toString(),
      remainingClients: connectedClients
    });
  });

  ws.on('error', (error) => {
    debugLog(`WebSocket error for client ${clientIp}`, error.message, 'ERROR');
  });

  ws.on('pong', () => {
    debugLog(`Received pong from ${clientIp}`);
  });
});

// WebSocket health monitoring
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.ping();
      } catch (err) {
        debugLog('Failed to ping WebSocket client', err.message, 'WARN');
      }
    }
  });
}, 30000); // Ping every 30 seconds

// Initialize OSC connection
initOSCConnection();

// Print statistics every 30 seconds
if (DEBUG_MODE) {
  setInterval(printOSCStats, 30000);
}

// Graceful shutdown handling
process.on('SIGINT', () => {
  console.log('\n' + '='.repeat(40));
  console.log('Shutting down WebXR OSC Bridge...');
  console.log('='.repeat(40));
  
  // Close all OSC ports
  Object.keys(oscUDPPorts).forEach(deviceType => {
    if (oscUDPPorts[deviceType]) {
      try {
        oscUDPPorts[deviceType].close();
        debugLog(`OSC UDP port closed gracefully for ${deviceType}`);
      } catch (err) {
        debugLog(`Error closing OSC port for ${deviceType} during shutdown`, err.message, 'WARN');
      }
    }
  });
  
  server.close(() => {
    debugLog('HTTPS server closed gracefully');
    process.exit(0);
  });
});

// Error handling for uncaught exceptions
process.on('uncaughtException', (err) => {
  debugLog('Uncaught Exception', err.message, 'ERROR');
  console.error('Stack trace:', err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  debugLog('Unhandled Rejection', { reason, promise }, 'ERROR');
});

debugLog('WebXR OSC Bridge Server initialization complete');