// MicroPython Studio - WebREPL client
// Based on official MicroPython WebREPL client (MIT License)
// Modifications: auto-connect, auto-auth, VS Code integration

var term;
var ws;
var connected = false;
var binary_state = 0;
var put_file_name = null;
var put_file_data = null;
var get_file_name = null;
var get_file_data = null;

// Set by host page (injected by webReplTerminal.js)
var MPS_WS_URL = window.MPS_WS_URL || '';
var MPS_PASSWORD = window.MPS_PASSWORD || '';

function calculate_size(win) {
    var cols = Math.max(80, Math.min(200, (win.innerWidth - 260) / 7.2)) | 0;
    var rows = Math.max(20, Math.min(80, (win.innerHeight - 120) / 14)) | 0;
    return [cols, rows];
}

(function() {
    window.onload = function() {
        var size = calculate_size(self);
        term = new Terminal({
            cols: size[0],
            rows: size[1],
            useStyle: true,
            screenKeys: true,
            cursorBlink: true
        });
        term.open(document.getElementById("term"));

        // Auto-connect if URL is provided
        if (MPS_WS_URL) {
            setStatus('connecting');
            setTimeout(function() { connect(MPS_WS_URL); }, 300);
        }
    };
    window.addEventListener('resize', function() {
        if (term) {
            var size = calculate_size(self);
            term.resize(size[0], size[1]);
        }
    });
}).call(this);

function setStatus(state) {
    var dot = document.getElementById('status-dot');
    var txt = document.getElementById('status-text');
    if (!dot || !txt) return;
    if (state === 'connected') {
        dot.className = 'connected';
        txt.textContent = 'Connected to ' + MPS_WS_URL;
    } else if (state === 'connecting') {
        dot.className = '';
        dot.style.background = '#fa0';
        txt.textContent = 'Connecting...';
    } else {
        dot.className = '';
        dot.style.background = '#f44';
        txt.textContent = 'Disconnected';
    }
}

function update_file_status(s) {
    var el = document.getElementById('file-status');
    if (el) el.innerHTML = s;
}

function connect(url) {
    ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';

    var _autoAuthDone = false;

    ws.onopen = function() {
        setStatus('connected');
        term.removeAllListeners('data');
        term.on('data', function(data) {
            data = data.replace(/\n/g, "\r");
            ws.send(data);
        });
        term.on('title', function(title) {
            document.title = title;
        });
        term.focus();
        term.write('\x1b[32mMicroPython Studio WebREPL\x1b[m\r\n');
        connected = true;

        ws.onmessage = function(event) {
            if (event.data instanceof ArrayBuffer) {
                var data = new Uint8Array(event.data);
                switch (binary_state) {
                    case 11:
                        if (decode_resp(data) == 0) {
                            for (var offset = 0; offset < put_file_data.length; offset += 1024) {
                                ws.send(put_file_data.slice(offset, offset + 1024));
                            }
                            binary_state = 12;
                        }
                        break;
                    case 12:
                        if (decode_resp(data) == 0) {
                            update_file_status('Sent ' + put_file_name + ', ' + put_file_data.length + ' bytes');
                        } else {
                            update_file_status('Failed sending ' + put_file_name);
                        }
                        binary_state = 0;
                        break;
                    case 21:
                        if (decode_resp(data) == 0) {
                            binary_state = 22;
                            var rec = new Uint8Array(1);
                            rec[0] = 0;
                            ws.send(rec);
                        }
                        break;
                    case 22: {
                        var sz = data[0] | (data[1] << 8);
                        if (data.length == 2 + sz) {
                            if (sz == 0) {
                                binary_state = 23;
                            } else {
                                var new_buf = new Uint8Array(get_file_data.length + sz);
                                new_buf.set(get_file_data);
                                new_buf.set(data.slice(2), get_file_data.length);
                                get_file_data = new_buf;
                                update_file_status('Getting ' + get_file_name + ', ' + get_file_data.length + ' bytes');
                                var rec = new Uint8Array(1);
                                rec[0] = 0;
                                ws.send(rec);
                            }
                        } else {
                            binary_state = 0;
                        }
                        break;
                    }
                    case 23:
                        if (decode_resp(data) == 0) {
                            update_file_status('Got ' + get_file_name + ', ' + get_file_data.length + ' bytes');
                            saveAs(new Blob([get_file_data], {type: "application/octet-stream"}), get_file_name);
                        } else {
                            update_file_status('Failed getting ' + get_file_name);
                        }
                        binary_state = 0;
                        break;
                    case 31:
                        binary_state = 0;
                        break;
                }
            }

            // Auto-authenticate: detect password prompt and send password
            if (!_autoAuthDone && MPS_PASSWORD && typeof event.data === 'string') {
                if (event.data.indexOf('Password') !== -1) {
                    _autoAuthDone = true;
                    setTimeout(function() {
                        ws.send(MPS_PASSWORD + '\r\n');
                    }, 80);
                    return; // Don't echo "Password: " to terminal yet, let the response handle it
                }
            }

            term.write(event.data);
        };
    };

    ws.onclose = function() {
        connected = false;
        setStatus('disconnected');
        if (term) {
            term.write('\x1b[31m\r\nDisconnected\x1b[m\r\n');
        }
        term.off('data');
    };

    ws.onerror = function(e) {
        setStatus('disconnected');
        if (term) {
            term.write('\x1b[31mWebSocket error - check that WebREPL is running on the board\x1b[m\r\n');
        }
    };
}

function decode_resp(data) {
    if (data[0] == 'W'.charCodeAt(0) && data[1] == 'B'.charCodeAt(0)) {
        var code = data[2] | (data[3] << 8);
        return code;
    } else {
        return -1;
    }
}

function put_file() {
    var dest_fname = put_file_name;
    var dest_fsize = put_file_data.length;

    var rec = new Uint8Array(2 + 1 + 1 + 8 + 4 + 2 + 64);
    rec[0] = 'W'.charCodeAt(0);
    rec[1] = 'A'.charCodeAt(0);
    rec[2] = 1; // put
    rec[3] = 0;
    for (var i = 4; i < 12; i++) rec[i] = 0;
    rec[12] = dest_fsize & 0xff; rec[13] = (dest_fsize >> 8) & 0xff;
    rec[14] = (dest_fsize >> 16) & 0xff; rec[15] = (dest_fsize >> 24) & 0xff;
    rec[16] = dest_fname.length & 0xff; rec[17] = (dest_fname.length >> 8) & 0xff;
    for (var i = 0; i < 64; ++i) {
        rec[18 + i] = i < dest_fname.length ? dest_fname.charCodeAt(i) : 0;
    }

    binary_state = 11;
    update_file_status('Sending ' + put_file_name + '...');
    ws.send(rec);
}

function get_file() {
    var src_fname = document.getElementById('get_filename').value;

    var rec = new Uint8Array(2 + 1 + 1 + 8 + 4 + 2 + 64);
    rec[0] = 'W'.charCodeAt(0);
    rec[1] = 'A'.charCodeAt(0);
    rec[2] = 2; // get
    rec[3] = 0;
    for (var i = 4; i < 16; i++) rec[i] = 0;
    rec[16] = src_fname.length & 0xff; rec[17] = (src_fname.length >> 8) & 0xff;
    for (var i = 0; i < 64; ++i) {
        rec[18 + i] = i < src_fname.length ? src_fname.charCodeAt(i) : 0;
    }

    binary_state = 21;
    get_file_name = src_fname;
    get_file_data = new Uint8Array(0);
    update_file_status('Getting ' + get_file_name + '...');
    ws.send(rec);
}

function handle_put_file_select(evt) {
    var files = evt.target.files;
    var f = files[0];
    put_file_name = f.name;
    var reader = new FileReader();
    reader.onload = function(e) {
        put_file_data = new Uint8Array(e.target.result);
        document.getElementById('put-file-list').innerHTML = '' + escape(put_file_name) + ' - ' + put_file_data.length + ' bytes';
        document.getElementById('put-file-button').disabled = false;
    };
    reader.readAsArrayBuffer(f);
}

document.getElementById('put-file-select').addEventListener('click', function(){
    this.value = null;
}, false);

document.getElementById('put-file-select').addEventListener('change', handle_put_file_select, false);
document.getElementById('put-file-button').disabled = true;
