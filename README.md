# WEBXR_To_OSC
### A complete system for streaming 6DOF position and rotation data from standalone VR headsets (Meta Quest) to creative applications via OSC protocol.
![webxr](https://github.com/user-attachments/assets/47879d63-7c3b-4990-b4e2-5e88739778f7)

## What This Does

This system captures real-time position, rotation, and button data from:
- **HMD (Head-Mounted Display)**: X, Y, Z position + Yaw, Pitch, Roll rotation
- **Controller 0 & 1**: Position, rotation, and button state. (*currently one button press only*)

Data is streamed via OSC to separate ports for maximum flexibility in your creative applications.

## Creative Applications

- **Audio**: Sonification and creative performances (Max/MSP, Pure Data)
- **Visuals**: Performative visuals (TouchDesigner, Resolume, MadMapper)
- **3D Animation**: Virtual camera control (Blender, Cinema 4D)
- **Game Engines**: Real-time motion capture (Unreal Engine, Unity)
- **Interactive Art**: Installations and responsive environments

## System Architecture

```
Standalone VR Headset ──[WebXR]─► HTTPS Server ──[WebSocket]─► OSC Router ──[UDP]─► Your App
                         (Node.js)                    Port 7400: HMD
                                                     Port 7401: Controller 0  
                                                     Port 7402: Controller 1
```

## Prerequisites

- **Node.js** (v14 or higher)
- **Standalone VR Headset** (***Meta Quest 1 TESTED***)
- **Same Wi-Fi network** for headset and server
- **Package manager**: npm (comes with Node.js)

## Quick Start Guide

### Step 1: Download and Extract

Download all project files and extract them to a folder (e.g., `WEBXR_To_OSC`)

### Step 2: Install Dependencies

```bash
cd WEBXR_To_OSC
npm install ws osc
```

### Step 3: Download Three.js

Download `three.min.js` from [three.js releases](https://github.com/mrdoob/three.js/releases) and place it in your project folder, or use this direct link:

```bash
# Download three.js (version r128 recommended)
curl -o three.min.js https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js
```

### Step 4: Generate SSL Certificates

**⚠️ HTTPS is required for WebXR to work on devices.⚠️**

Self-Signed Certificates (Recommended for local development)

```bash
# Generate private key
openssl genrsa -out key.pem 2048

# Generate certificate signing request
openssl req -new -key key.pem -out csr.pem

# Generate self-signed certificate (valid for 365 days)
openssl x509 -req -days 365 -in csr.pem -signkey key.pem -out cert.pem

# Clean up
rm csr.pem
```

When prompted for certificate details, you can use these example values:
- Country: `US`
- State: ``
- City: ``
- Organization: ``
- Organizational Unit: `Development`
- Common Name: **`YOUR_LOCAL_IP_ADDRESS`** (e.g., `192.168.1.104`)
- Email: `bogus@email.com`

### Step 5: Configure Your IP Address

1. Find your computer's local IP address:
   ```bash
   # macOS/Linux
   ifconfig | grep "inet " | grep -v 127.0.0.1

2. Open `webxr_osc_server.js` and update the `SERVER_IP`:
   ```javascript
   const SERVER_IP = 'YOUR_IP_HERE'; // Replace with YOUR IP address
   ```

3. Open `index.html` and update the server address:
   ```html
   <code id="serverAddress">YOUR_IP_HERE:8443</code>
   ```

### Step 6: Configure OSC Destinations

Edit the OSC target settings, if needed, in `webxr_osc_server.js`:

```javascript
const OSC_TARGET_IP = '127.0.0.1'; // IP of machine running your creative app (IF ITS THE SAME AS THE NODE.JS SERVER KEEP IT AT 127.0.0.1)
const OSC_PORTS = {
  HMD: 7400,          // HMD data destination port
  CONTROLLER0: 7401,  // Controller 0 destination port  
  CONTROLLER1: 7402   // Controller 1 destination port
};
```

### Step 7: Start the Server

```bash
node webxr_osc_server.js
```

You should see:
```
============================================================
WebXR OSC Bridge Server Started
============================================================
 HTTPS Server: https://YOUR_IP_ADRESS:8443
  OSC Routing:
   • HMD data → 127.0.0.1:7400
   • Controller 0 → 127.0.0.1:7401
   • Controller 1 → 127.0.0.1:7402
============================================================
```

### Step 8: Connect Your Standalone Headset

1. Put on your Standalone headset
2. Open the browser
3. Navigate to: `https://YOUR_IP_ADDRESS:8443`
4. **Accept the security warning** (required for self-signed certificates)
5. Click "Enable OSC Streaming"
6. Click "Start WebXR Session"

## OSC Message Format

### HMD Data (Port 7400)
```
Address: /hmd/pose
Arguments: [x, y, z, yaw°, pitch°, roll°]
```

### Controller Data (Port 7401 & 7402)
```
Address: /controller0/pose or /controller1/pose  
Arguments: [x, y, z, yaw°, pitch°, roll°, button_state]
```

- **Position**: Meters from origin (positive Y is up)
- **Rotation**: Degrees (-180° to +180°)
- **Button State**: 1 = pressed, 0 = released

## Creative Application Setup

### Max/MSP
```pd
[udpreceive -u -b 7400]
|
[unpack f f f f f f]
```

### TouchDesigner
1. Add **OSC In CHOP**
2. Set **Network Port** to `7400` (or 7401/7402)
3. Set **OSC Address** to `/hmd/pose`
4. Connect to your visual parameters

### Pure Data
```pd
[netreceive -u -b 7400]
|
[unpack f f f f f f]
```

## Troubleshooting

### "WebXR not supported" Error
- Ensure you're using HTTPS (not HTTP)
- Try the latest version of a browser
- Make sure Developer Mode is enabled on your Headset. (*it might work without it tho*)

### Certificate Warnings
- This is normal with self-signed certificates
- Click "Advanced" → "Proceed to site" in the browser
- The warning only appears once per session

### Connection Issues
- Verify both devices are on the same Wi-Fi network
- Check firewall settings on your computer
- Ensure ports 8443, 7400-7402 are not blocked

### No OSC Data Received
- Verify OSC target IP and ports in `webxr_osc_server.js`
- Check that your creative application is listening on the correct ports
- Enable debug mode by setting `DEBUG_MODE = true` in the server file

## Advanced Configuration

### Custom OSC Ports
Modify the `OSC_PORTS` object in `webxr_osc_server.js`:

```javascript
const OSC_PORTS = {
  HMD: 9000,          // Your custom HMD port
  CONTROLLER0: 9001,  // Your custom controller ports
  CONTROLLER1: 9002
};
```

### Performance Tuning
- Adjust `OSC_SEND_INTERVAL` in `app.js` (default: 32ms ≈ 30fps)
- Enable/disable debug logging in `webxr_osc_server.js`

### Remote OSC Destinations
Send OSC to different machines by changing `OSC_TARGET_IP`:

```javascript
const OSC_TARGET_IP = '192.168.1.200'; // Remote machine IP
```

## Folder Structure

```
webxr-osc-bridge/
├── app.js                 # Client-side WebXR logic
├── index.html            # Web interface
├── webxr_osc_server.js   # Node.js server & OSC router
├── three.min.js          # Three.js library (download separately)
├── cert.pem              # SSL certificate (generate)
├── key.pem               # SSL private key (generate)
└── README.md             # This file
```

## 🤝 Contributing 🤝

This project is open for contributions! Areas for improvement:
- Additional creative application examples
- Performance optimizations
- Extended controller button mapping
- Multi-user support

## License
*This project is provided as-is for creative and educational use.*
