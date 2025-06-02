// Ensure this script is loaded after the DOM is ready, or use DOMContentLoaded
// Alternatively, place the <script> tag at the end of the <body> or use 'defer'

let scene, camera, renderer, xrSession = null;
let hmdMarker, controllerMarkers = []; // Renamed for clarity
let oscEnabled = false;
let lastOSCSendTime = 0;
const OSC_SEND_INTERVAL = 32; // Approx 30 FPS (1000ms / 30fps ~= 33ms)
let socket = null;

// DOM Elements - these will be null until DOMContentLoaded
let hmdPosEl, hmdRotEl, ctrl0PosEl, ctrl0RotEl, ctrl1PosEl, ctrl1RotEl;
let wsStatusEl, oscStatusEl, startXRButton, stopXRButton, oscToggleButton;
let previewCanvas, errorMessageEl, serverAddressEl, messageBoxEl;

// Add new DOM elements for button state
let ctrl0BtnEl, ctrl1BtnEl;

// This will be set in DOMContentLoaded
let SERVER_URL;

let lastHMDPose = null;
let lastControllerPoses = [{}, {}];
let lastXRFramePose = null;
let lastXRControllerPoses = [{}, {}];
let dataSampleInterval = null;

// Add debugging flag
const DEBUG_MODE = true;

// Custom message display
function showMessage(text, duration = 3000) {
    if (!messageBoxEl) messageBoxEl = document.getElementById('messageBox');
    if (messageBoxEl) {
        messageBoxEl.textContent = text;
        messageBoxEl.style.display = 'block';
        setTimeout(() => {
            messageBoxEl.style.display = 'none';
        }, duration);
    } else {
        console.warn("MessageBox element not found. Message:", text);
    }
}

// Enhanced logging for debugging
function debugLog(message, data = null) {
    if (DEBUG_MODE) {
        console.log(`[WebXR Debug] ${message}`, data || '');
    }
}

// Convert quaternion to Euler angles in degrees (-180 to 180)
function quaternionToEulerDegrees(quat) {
    const euler = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(quat.x, quat.y, quat.z, quat.w), 'YXZ');
    return {
        yaw: (euler.y * 180 / Math.PI),     // Y rotation (yaw)
        pitch: (euler.x * 180 / Math.PI),   // X rotation (pitch)  
        roll: (euler.z * 180 / Math.PI)     // Z rotation (roll)
    };
}

// Normalize angle to -180 to 180 range
function normalizeAngle(angle) {
    while (angle > 180) angle -= 360;
    while (angle < -180) angle += 360;
    return angle;
}

// WebSocket setup
function initWebSocket() {
  if (!SERVER_URL) {
    console.error("SERVER_URL is not defined. WebSocket cannot connect.");
    if (wsStatusEl) {
        wsStatusEl.textContent = 'Error: Server URL not set';
        wsStatusEl.style.color = '#F44336';
    }
    return;
  }
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    console.log('WebSocket already open or connecting.');
    return;
  }
  
  debugLog('Attempting WebSocket connection to:', SERVER_URL);
  socket = new WebSocket(SERVER_URL);

  socket.onopen = () => {
    debugLog('WebSocket connected successfully');
    console.log('WebSocket connected to:', SERVER_URL);
    if (wsStatusEl) {
        wsStatusEl.textContent = 'Connected';
        wsStatusEl.style.color = '#4CAF50'; // Green
    }
    if (errorMessageEl) errorMessageEl.textContent = '';
  };

  socket.onclose = (event) => {
    debugLog('WebSocket closed', { code: event.code, reason: event.reason });
    console.log('WebSocket closed. Code:', event.code, 'Reason:', event.reason);
    if (wsStatusEl) {
        wsStatusEl.textContent = 'Disconnected. Retrying...';
        wsStatusEl.style.color = '#FF9800'; // Orange
    }
    // Simple reconnect logic
    setTimeout(initWebSocket, 3000);
  };

  socket.onerror = (err) => {
    debugLog('WebSocket error occurred', err);
    console.error('WebSocket error:', err);
    if (wsStatusEl) {
        wsStatusEl.textContent = 'Error';
        wsStatusEl.style.color = '#F44336'; // Red
    }
    if (errorMessageEl) errorMessageEl.textContent = 'WebSocket connection error. Is the server running?';
  };
}

// 3D scene for preview (non-XR)
function initPreviewScene() {
  if (!previewCanvas) {
      console.error("Preview canvas not found!");
      return;
  }
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x1a1a1a);
  camera = new THREE.PerspectiveCamera(75, previewCanvas.clientWidth / previewCanvas.clientHeight, 0.1, 1000);
  renderer = new THREE.WebGLRenderer({ canvas: previewCanvas, antialias: true });
  renderer.setSize(previewCanvas.clientWidth, previewCanvas.clientHeight);
  renderer.xr.enabled = true;

  const ambientLight = new THREE.AmbientLight(0x606060);
  scene.add(ambientLight);
  const directionalLight = new THREE.DirectionalLight(0xffffff, 0.7);
  directionalLight.position.set(1, 1.5, 1).normalize();
  scene.add(directionalLight);
  
  const gridHelper = new THREE.GridHelper(10, 20, 0x444444, 0x333333);
  scene.add(gridHelper);

  hmdMarker = new THREE.Mesh(
    new THREE.BoxGeometry(0.2, 0.2, 0.2), 
    new THREE.MeshStandardMaterial({ color: 0x00ff00 })
  );
  scene.add(hmdMarker);

  for (let i = 0; i < 2; i++) {
    const ctrlMaterial = new THREE.MeshStandardMaterial({ color: i === 0 ? 0xff0000 : 0x0000ff });
    const ctrlMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.04, 0.15, 16), ctrlMaterial);
    ctrlMesh.visible = false;
    controllerMarkers.push(ctrlMesh);
    scene.add(ctrlMesh);
  }
  camera.position.set(0, 1.6, 2);
  camera.lookAt(0, 1, 0);
  
  debugLog('Preview scene initialized successfully');
  animatePreview();
}

function animatePreview() {
  if (!xrSession) {
    requestAnimationFrame(animatePreview);
    if (renderer && scene && camera) renderer.render(scene, camera);
  }
}

async function startXRSession() {
  if (!navigator.xr) {
    showMessage('WebXR API not available in this browser.');
    console.error('WebXR not supported');
    return;
  }
  if (!renderer) {
    showMessage('Renderer not initialized. Cannot start XR session.');
    console.error('Renderer not initialized.');
    return;
  }
  
  debugLog('Starting XR session...');
  
  try {
    // Check if immersive-vr is supported
    const isSupported = await navigator.xr.isSessionSupported('immersive-vr');
    if (!isSupported) {
      debugLog('immersive-vr not supported, trying inline session');
      showMessage('VR mode not supported, starting inline session');
      xrSession = await navigator.xr.requestSession('inline');
    } else {
      xrSession = await navigator.xr.requestSession('immersive-vr', { 
          requiredFeatures: ['local-floor'],
      });
    }
    
    debugLog('XR session created successfully');
    
    xrSession.addEventListener('end', onXRSessionEnded);
    
    await renderer.xr.setSession(xrSession);
    document.body.classList.add('xr-active');
    if (startXRButton) startXRButton.disabled = true;
    if (stopXRButton) stopXRButton.disabled = false;
    if (oscToggleButton) oscToggleButton.disabled = true;
    
    renderer.setAnimationLoop(renderXRFrame);
    
    // Stop the data sampling interval when entering XR mode
    // The XR frame will handle updates directly
    stopDataSampling();
    
    debugLog('XR session started and animation loop set');

  } catch (err) {
    debugLog('XR session failed', err);
    console.error('Failed to start XR session:', err);
    showMessage('Failed to start XR session: ' + err.message);
    if (errorMessageEl) errorMessageEl.textContent = 'Error starting WebXR: ' + err.message;
  }
}

function onXRSessionEnded() {
  debugLog('XR session ended');
  if(xrSession) xrSession.removeEventListener('end', onXRSessionEnded);
  xrSession = null;
  if (renderer && renderer.xr) renderer.xr.setSession(null);
  document.body.classList.remove('xr-active');
  
  if (startXRButton) startXRButton.disabled = false;
  if (stopXRButton) stopXRButton.disabled = true;
  if (oscToggleButton) oscToggleButton.disabled = false;
  
  renderer.setAnimationLoop(null);
  animatePreview();
  
  // Clear display
  if (hmdPosEl) hmdPosEl.textContent = 'N/A'; 
  if (hmdRotEl) hmdRotEl.textContent = 'N/A';
  if (ctrl0PosEl) ctrl0PosEl.textContent = 'N/A'; 
  if (ctrl0RotEl) ctrl0RotEl.textContent = 'N/A';
  if (ctrl1PosEl) ctrl1PosEl.textContent = 'N/A'; 
  if (ctrl1RotEl) ctrl1RotEl.textContent = 'N/A';
  if (ctrl0BtnEl) ctrl0BtnEl.textContent = 'N/A';
  if (ctrl1BtnEl) ctrl1BtnEl.textContent = 'N/A';
  
  showMessage('WebXR session ended.');
  
  // Restart data sampling for non-XR mode
  startDataSampling();
}

function stopXRSession() {
  debugLog('Stopping XR session...');
  if (xrSession) {
    xrSession.end().catch(err => console.error("Error ending XR session:", err));
  }
}

function renderXRFrame(timestamp, frame) {
  if (!xrSession || !frame || !renderer || !renderer.xr) return;

  const referenceSpace = renderer.xr.getReferenceSpace();
  if (!referenceSpace) {
    debugLog('No reference space available');
    return;
  }
  
  const pose = frame.getViewerPose(referenceSpace);
  const currentTime = Date.now();
  const shouldSendOSC = oscEnabled && socket && socket.readyState === WebSocket.OPEN && 
                       (currentTime - lastOSCSendTime >= OSC_SEND_INTERVAL);

  // --- HMD ---
  if (pose) {
    const position = pose.transform.position;
    const orientation = pose.transform.orientation;
    const pos = { x: position.x, y: position.y, z: position.z };
    const quat = { x: orientation.x, y: orientation.y, z: orientation.z, w: orientation.w };
    
    // Update the visual marker
    if (hmdMarker) {
      hmdMarker.position.set(pos.x, pos.y, pos.z);
      hmdMarker.quaternion.set(quat.x, quat.y, quat.z, quat.w);
    }

    // Update display immediately
    const euler = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(quat.x, quat.y, quat.z, quat.w), 'YXZ');
    updateDisplay('hmd', pos, euler);

    // Send OSC data if enabled and throttling allows
    if (shouldSendOSC) {
      sendOSCData('/hmd/pose', pos, quat);
      debugLog('Sent HMD OSC data', pos);
    }
  } else {
    debugLog('No HMD pose available in this frame');
  }

  // --- Controllers ---
  for (let i = 0; i < xrSession.inputSources.length && i < 2; i++) {
    const source = xrSession.inputSources[i];
    if (i >= controllerMarkers.length) continue;

    const controllerMarker = controllerMarkers[i];
    let btnPressed = false;
    
    // Check for button presses - check multiple common button indices
    if (source.gamepad && source.gamepad.buttons) {
      // Check trigger (index 0), grip (index 1), and other common buttons
      for (let btnIdx = 0; btnIdx < Math.min(source.gamepad.buttons.length, 6); btnIdx++) {
        if (source.gamepad.buttons[btnIdx] && source.gamepad.buttons[btnIdx].pressed) {
          btnPressed = true;
          break;
        }
      }
    }

    if (source.gripSpace) {
      const gripPose = frame.getPose(source.gripSpace, referenceSpace);
      if (gripPose) {
        const position = gripPose.transform.position;
        const orientation = gripPose.transform.orientation;
        const pos = { x: position.x, y: position.y, z: position.z };
        const quat = { x: orientation.x, y: orientation.y, z: orientation.z, w: orientation.w };

        // Update visual marker
        controllerMarker.position.set(pos.x, pos.y, pos.z);
        controllerMarker.quaternion.set(quat.x, quat.y, quat.z, quat.w);
        controllerMarker.visible = true;

        // Update display immediately
        const euler = new THREE.Euler().setFromQuaternion(new THREE.Quaternion(quat.x, quat.y, quat.z, quat.w), 'YXZ');
        updateDisplay(`ctrl${i}`, pos, euler, btnPressed);

        // Send OSC data if enabled and throttling allows - FIXED: Send for each controller
        if (shouldSendOSC) {
          sendOSCData(`/controller${i}/pose`, pos, quat, btnPressed);
          debugLog(`Sent Controller ${i} OSC data`, { pos, btnPressed });
        }
      } else {
        controllerMarker.visible = false;
        updateDisplay(`ctrl${i}`, {x:0,y:0,z:0}, new THREE.Euler(), false);
      }
    } else {
      controllerMarker.visible = false;
      updateDisplay(`ctrl${i}`, {x:0,y:0,z:0}, new THREE.Euler(), false);
    }
  }

  // Hide controllers that aren't connected
  for (let i = xrSession.inputSources.length; i < controllerMarkers.length; i++) {
    if (controllerMarkers[i]) {
      controllerMarkers[i].visible = false;
      updateDisplay(`ctrl${i}`, {x:0,y:0,z:0}, new THREE.Euler(), false);
    }
  }

  // Update the throttling timestamp AFTER processing all devices
  if (shouldSendOSC) {
    lastOSCSendTime = currentTime;
  }

  renderer.render(scene, camera);
}

// Update display to show button state
function updateDisplay(id, pos, euler, btnPressed = false) {
  let currentPosEl, currentRotEl, currentBtnEl;
  if (id === 'hmd') { 
    currentPosEl = hmdPosEl; 
    currentRotEl = hmdRotEl; 
  }
  else if (id === 'ctrl0') { 
    currentPosEl = ctrl0PosEl; 
    currentRotEl = ctrl0RotEl; 
    currentBtnEl = ctrl0BtnEl; 
  }
  else if (id === 'ctrl1') { 
    currentPosEl = ctrl1PosEl; 
    currentRotEl = ctrl1RotEl; 
    currentBtnEl = ctrl1BtnEl; 
  }

  if (currentPosEl && currentRotEl) {
    // Only update if we have valid position data
    if (pos.x !== undefined && pos.y !== undefined && pos.z !== undefined) {
      currentPosEl.textContent = `${pos.x.toFixed(2)}, ${pos.y.toFixed(2)}, ${pos.z.toFixed(2)}`;
      currentRotEl.textContent = `${(euler.y * 180 / Math.PI).toFixed(1)}°, ${(euler.x * 180 / Math.PI).toFixed(1)}°, ${(euler.z * 180 / Math.PI).toFixed(1)}°`;
    }
  }
  
  if (currentBtnEl !== undefined) {
    currentBtnEl.textContent = btnPressed ? "Pressed" : "Released";
    currentBtnEl.style.color = btnPressed ? "#4CAF50" : "#F44336";
  }
}

// Send OSC data with rotation in degrees, now includes button state for controllers
function sendOSCData(address, position, orientation, btnPressed) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    debugLog('Cannot send OSC data - WebSocket not connected');
    return;
  }

  // Convert quaternion to Euler degrees
  const eulerDegrees = quaternionToEulerDegrees(orientation);
  
  // Normalize angles to -180 to 180 range
  const yaw = normalizeAngle(eulerDegrees.yaw);
  const pitch = normalizeAngle(eulerDegrees.pitch);  
  const roll = normalizeAngle(eulerDegrees.roll);

  const args = [
    Number(position.x) || 0,    // X position
    Number(position.y) || 0,    // Y position  
    Number(position.z) || 0,    // Z position
    Number(yaw) || 0,           // Yaw rotation in degrees
    Number(pitch) || 0,         // Pitch rotation in degrees
    Number(roll) || 0           // Roll rotation in degrees
  ];
  
  // If controller, append button state (0 or 1)
  if (address.startsWith('/controller')) {
    args.push(btnPressed ? 1 : 0);
  }

  const payload = { address, args };
  
  try {
    const jsonPayload = JSON.stringify(payload);
    socket.send(jsonPayload);
    debugLog(`OSC data sent: ${address}`, args);
  } catch (err) {
    console.error('Error sending OSC data:', err);
    debugLog('Failed to send OSC data', err);
  }
}

function toggleOSC() {
  oscEnabled = !oscEnabled;
  if (oscToggleButton) oscToggleButton.textContent = oscEnabled ? 'Disable OSC Streaming' : 'Enable OSC Streaming';
  if (oscStatusEl) {
    oscStatusEl.textContent = oscEnabled ? 'Enabled' : 'Disabled';
    oscStatusEl.style.color = oscEnabled ? '#4CAF50' : '#F44336';
  }
  showMessage(oscEnabled ? "OSC Streaming Enabled." : "OSC Streaming Disabled.");
  debugLog(`OSC streaming ${oscEnabled ? 'enabled' : 'disabled'}`);
}

// Initialize everything after the DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
    debugLog('DOM Content Loaded - Initializing app');
    
    // Assign DOM elements
    hmdPosEl = document.getElementById('hmdPos');
    hmdRotEl = document.getElementById('hmdRot');
    ctrl0PosEl = document.getElementById('ctrl0Pos');
    ctrl0RotEl = document.getElementById('ctrl0Rot');
    ctrl1PosEl = document.getElementById('ctrl1Pos');
    ctrl1RotEl = document.getElementById('ctrl1Rot');
    wsStatusEl = document.getElementById('wsStatus');
    oscStatusEl = document.getElementById('oscStatus');
    startXRButton = document.getElementById('startXR');
    stopXRButton = document.getElementById('stopXR');
    oscToggleButton = document.getElementById('oscToggle');
    previewCanvas = document.getElementById('previewCanvas');
    errorMessageEl = document.getElementById('errorMessage');
    serverAddressEl = document.getElementById('serverAddress');
    messageBoxEl = document.getElementById('messageBox');
    ctrl0BtnEl = document.getElementById('ctrl0Btn');
    ctrl1BtnEl = document.getElementById('ctrl1Btn');

    if (serverAddressEl) {
        const hostAndPort = serverAddressEl.textContent.trim();
        if (hostAndPort && hostAndPort.includes(':')) {
            SERVER_URL = `wss://${hostAndPort}`;
            debugLog(`WebSocket SERVER_URL configured to: ${SERVER_URL}`);
        } else {
            console.error("Server address element content is invalid or empty:", hostAndPort);
            SERVER_URL = null;
            if (wsStatusEl) {
                wsStatusEl.textContent = 'Error: Invalid server address in HTML';
                wsStatusEl.style.color = '#F44336';
            }
            showMessage("Error: Server address in HTML is invalid.", 5000);
        }
    } else {
        console.error("Server address element with ID 'serverAddress' not found!");
        SERVER_URL = null;
        if (wsStatusEl) {
            wsStatusEl.textContent = 'Error: Server address HTML element missing';
            wsStatusEl.style.color = '#F44336';
        }
        showMessage("Error: Server address configuration missing in HTML.", 5000);
    }
    
    // Event Listeners
    if (startXRButton) startXRButton.addEventListener('click', startXRSession);
    if (stopXRButton) stopXRButton.addEventListener('click', stopXRSession);
    if (oscToggleButton) oscToggleButton.addEventListener('click', toggleOSC);

    // Initialize WebSocket and 3D scene
    if (SERVER_URL) {
        initWebSocket();
        debugLog('WebSocket initialization started');
    }
    
    if (typeof THREE !== 'undefined') {
        initPreviewScene();
        debugLog('Three.js preview scene initialized');
    } else {
        console.error("THREE.js is not loaded. Cannot initialize preview scene.");
        if(errorMessageEl) errorMessageEl.textContent = "THREE.js failed to load. Check server and script paths.";
    }
    
    // Start data sampling for non-XR mode
    startDataSampling();
    debugLog('Data sampling started for non-XR mode');
});

// Handle window resize for preview canvas
window.addEventListener('resize', () => {
    if (!xrSession && renderer && camera && previewCanvas) {
        const newWidth = previewCanvas.clientWidth;
        const newHeight = previewCanvas.clientHeight;
        if (newWidth > 0 && newHeight > 0) {
            camera.aspect = newWidth / newHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(newWidth, newHeight);
        }
    }
});

function getCurrentHMDPose() {
  // In XR mode, we don't use this function - data comes directly from renderXRFrame
  if (hmdMarker) {
    return {
      pos: { x: hmdMarker.position.x, y: hmdMarker.position.y, z: hmdMarker.position.z },
      quat: { x: hmdMarker.quaternion.x, y: hmdMarker.quaternion.y, z: hmdMarker.quaternion.z, w: hmdMarker.quaternion.w }
    };
  }
  return null;
}

function getCurrentControllerPose(idx) {
  // In XR mode, we don't use this function - data comes directly from renderXRFrame
  if (controllerMarkers[idx]) {
    return {
      pos: { x: controllerMarkers[idx].position.x, y: controllerMarkers[idx].position.y, z: controllerMarkers[idx].position.z },
      quat: { x: controllerMarkers[idx].quaternion.x, y: controllerMarkers[idx].quaternion.y, z: controllerMarkers[idx].quaternion.z, w: controllerMarkers[idx].quaternion.w },
      btn: false
    };
  }
  return null;
}

// Sample and send data at 60fps - only used in non-XR mode
function startDataSampling() {
  if (dataSampleInterval) clearInterval(dataSampleInterval);
  
  debugLog('Starting data sampling for non-XR mode');
  
  // Only run data sampling when NOT in XR mode
  dataSampleInterval = setInterval(() => {
    // Skip if we're in an XR session - data comes from renderXRFrame instead
    if (xrSession && renderer && renderer.xr && renderer.xr.isPresenting) {
      return;
    }
    
    // HMD - only for non-XR mode (preview mode)
    let hmdPose = getCurrentHMDPose();
    if (hmdPose) {
      lastHMDPose = hmdPose;
      const euler = new THREE.Euler().setFromQuaternion(
        new THREE.Quaternion(lastHMDPose.quat.x, lastHMDPose.quat.y, lastHMDPose.quat.z, lastHMDPose.quat.w), 'YXZ'
      );
      updateDisplay('hmd', lastHMDPose.pos, euler);
      if (oscEnabled && socket && socket.readyState === WebSocket.OPEN) {
        sendOSCData('/hmd/pose', lastHMDPose.pos, lastHMDPose.quat);
      }
    }

    // Controllers - only for non-XR mode
    for (let i = 0; i < 2; i++) {
      let ctrlPose = getCurrentControllerPose(i);
      if (ctrlPose) {
        lastControllerPoses[i] = ctrlPose;
        const euler = new THREE.Euler().setFromQuaternion(
          new THREE.Quaternion(lastControllerPoses[i].quat.x, lastControllerPoses[i].quat.y, lastControllerPoses[i].quat.z, lastControllerPoses[i].quat.w), 'YXZ'
        );
        updateDisplay(`ctrl${i}`, lastControllerPoses[i].pos, euler, lastControllerPoses[i].btn);
        if (oscEnabled && socket && socket.readyState === WebSocket.OPEN) {
          sendOSCData(`/controller${i}/pose`, lastControllerPoses[i].pos, lastControllerPoses[i].quat, lastControllerPoses[i].btn);
        }
      }
    }
  }, 1000 / 60);
}

function stopDataSampling() {
  debugLog('Stopping data sampling');
  if (dataSampleInterval) clearInterval(dataSampleInterval);
  dataSampleInterval = null;
}