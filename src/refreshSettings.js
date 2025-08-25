/**
 * runcommand.js
 * run only executable commands 
 * @license MIT
 * @version 1.0
 * @author  Niwantha Meepage 
 */
const vscode = require('vscode');
const path = require('path');
const { getConnectedDevices } = require('./runCommand')
const { getConfigValue, updateCfgComponent } = require('./commonFxn')


async function getValidDevicePort(resource) {

    let gRemoteDevicePort = null;
    let deviceCodeDir = null;

    const projectDir = resource.fsPath

    const configPath = path.join(projectDir, 'device.cfg');

    const port = await getConfigValue(configPath, 'device', 'port');
    const dev_id = await getConfigValue(configPath, 'device', 'deviceId');


    const devices = await getConnectedDevices();
    console.log(devices)
    // Now you can handle the devices array as needed
    if (devices.length > 0) {
        for (const device of devices) {
            const port = device.port;
            const vidpid = device.vidpid;

            if (dev_id === vidpid) {
                gRemoteDevicePort = port;
                vscode.window.showInformationMessage('Updated device id & port!');
                break; // Found matching device, exit loop
            } else if (dev_id === 'undefined') {
                if (vidpid !== '0000:0000') {
                    // Ask user to confirm this device
                    const confirm = await vscode.window.showInformationMessage(
                        `Found device at ${port} (ID: ${vidpid}). Use this device?`,
                        "Yes", "No", "Skip All"
                    );

                    if (confirm === "Yes") {
                        gRemoteDevicePort = port;

                        await updateCfgComponent(configPath, 'device', 'deviceId', vidpid);
                        await updateCfgComponent(configPath, 'device', 'port', port);
                        break; // User confirmed, exit loop
                    } else if (confirm === "Skip All") {
                        break; // User wants to skip all devices
                    }
                    // If "No", continue to next device
                }
            }
        }
        // Check if we found a device
        if (gRemoteDevicePort) {
            console.log(`Selected device: ${gRemoteDevicePort}`);
        } else {
            vscode.window.showWarningMessage('No connected device found!');
        }
    } else {
        console.log('No devices found');
    }
    if (gRemoteDevicePort === null) {
        gRemoteDevicePort = port;
    }
    deviceCodeDir = await getConfigValue(configPath, 'filePath', 'deviceCodeDir');

    return [gRemoteDevicePort, deviceCodeDir];

}

// Export the async function
module.exports = { getValidDevicePort };