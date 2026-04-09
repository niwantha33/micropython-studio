// src/docSnippets.js - Hardcoded CircuitPython docs for MVP
// ✅ Works immediately — no external dependencies

const snippets = {
    // WiFi on Pico 2W
    wifi: `CIRCUITPYTHON WIFI (Pico 2W + CYW43439):
• Create settings.toml on CIRCUITPY drive:
  CIRCUITPY_WIFI_SSID="YourNetwork"
  CIRCUITPY_WIFI_PASSWORD="YourPassword"
• Connect code:
  import os, wifi, socketpool, ssl
  import adafruit_requests
  wifi.radio.connect(
      os.getenv("CIRCUITPY_WIFI_SSID"),
      os.getenv("CIRCUITPY_WIFI_PASSWORD")
  )
  pool = socketpool.SocketPool(wifi.radio)
  requests = adafruit_requests.Session(pool, ssl.create_default_context())
• Check: wifi.radio.connected, wifi.radio.ipv4_address
• NEVER use: import network, import socket`,

    // I2C communication
    i2c: `CIRCUITPYTHON I2C:
• Import: import board, busio
• Create bus: i2c = busio.I2C(scl=board.GP1, sda=board.GP0)
• Scan devices:
  while not i2c.try_lock(): pass
  print([hex(i) for i in i2c.scan()])
  i2c.unlock()
• Read/write: i2c.writeto(address, buffer), i2c.readfrom_into(address, buffer)
• Pico 2W defaults: I2C0 on GP0/GP1, I2C1 on GP6/GP7
• NEVER use: board.I2C(), board.TX, board.RX`,

    // UART/Serial communication
    uart: `CIRCUITPYTHON UART:
• Import: import board, busio
• Create: uart = busio.UART(tx=board.GP0, rx=board.GP1, baudrate=115200)
• Read: uart.read(10) or uart.readline() (returns bytes)
• Write: uart.write(b"hello\\n")
• Timeout: uart.timeout = 0.1  # seconds
• Pico 2W defaults: UART0 on GP0/GP1, UART1 on GP4/GP5
• NEVER use: board.TX, board.RX, board.UART(), import serial`,

    // Async/asyncio support
    asyncio: `CIRCUITPYTHON ASYNCIO (10.x+):
• Import: import asyncio (native in CP 10+, NOT _asyncio)
• Define coroutine: async def blink(): await asyncio.sleep(0.5)
• Run: asyncio.run(blink())
• Non-blocking: Use await asyncio.sleep() instead of time.sleep()
• Task groups: async with asyncio.TaskGroup() as tg: tg.create_task(coro())
• NEVER use: uasyncio (MicroPython), _asyncio (internal)`,

    // GPIO/digital I/O
    gpio: `CIRCUITPYTHON GPIO:
• Import: import board, digitalio
• Output: led = digitalio.DigitalInOut(board.LED); led.direction = digitalio.Direction.OUTPUT; led.value = True
• Input with pull: btn = digitalio.DigitalInOut(board.GP13); btn.direction = digitalio.Direction.INPUT; btn.pull = digitalio.Pull.UP
• Pico 2W: All GP0-GP28 are 3.3V logic, NOT 5V tolerant
• ⚠️ RP2350-E9 erratum: Internal pull-DOWN unreliable — use external ≤8.2kΩ or Pull.UP
• NEVER use: machine.Pin, Pin.OUT, Pin.IN`,

    // ADC/analog input
    adc: `CIRCUITPYTHON ADC:
• Import: import board, analogio
• Read: adc = analogio.AnalogIn(board.GP26); voltage = adc.value * 3.3 / 65536
• Pico 2W ADC pins: GP26 (ADC0), GP27 (ADC1), GP28 (ADC2), GP29 (VSYS/3, WiFi-shared)
• ⚠️ GP29: Only read when WiFi SPI is idle
• Internal temp: import microcontroller; microcontroller.cpu.temperature
• NEVER use: machine.ADC`,

    // SPI communication
    spi: `CIRCUITPYTHON SPI:
• Import: import board, busio
• Create: spi = busio.SPI(clock=board.GP18, MOSI=board.GP19, MISO=board.GP16)
• Device: from busio import SPI; device = digitalio.DigitalInOut(board.GP17); device.direction = digitalio.Direction.OUTPUT
• Transfer: spi.write(bytes), spi.readinto(buffer), spi.write_readinto(out, in)
• Pico 2W defaults: SPI0 on GP18/19/16, SPI1 on GP10/11/8
• NEVER use: machine.SPI`,

    // PWM output
    pwm: `CIRCUITPYTHON PWM:
• Import: import board, pwmio
• Create: pwm = pwmio.PWMOut(board.GP0, frequency=1000, duty_cycle=32768)
• Duty cycle: 0 = off, 65535 = 100%, 32768 = 50%
• All GP0-GP28 support PWM on Pico 2W
• ⚠️ Same slice pins share frequency (e.g., GP0+GP16 share slice 0)
• NEVER use: machine.PWM`,

    // Display/graphics basics
    display: `CIRCUITPYTHON DISPLAYIO:
• Import: import displayio, board, busio
• SPI display setup:
  spi = busio.SPI(clock=board.GP18, MOSI=board.GP19)
  display_bus = displayio.FourWire(spi, command=board.GP17, chip_select=board.GP16, reset=board.GP15)
  display = adafruit_st7789.ST7789(display_bus, width=240, height=240)
• Draw: group = displayio.Group(); display.root_group = group
• NEVER use: machine.SPI for displays — use displayio bus classes`,

    // Common libraries
    libraries: `CIRCUITPYTHON LIBRARIES (copy .mpy to /lib):
• HTTP: adafruit_requests, adafruit_connection_manager
• MQTT: adafruit_minimqtt
• Sensors: adafruit_bme280, adafruit_ahtx0, adafruit_dht
• Displays: adafruit_ssd1306, adafruit_st7789, adafruit_display_text
• Motors: adafruit_motor, adafruit_neopixel
• Install: Copy <lib>.mpy to CIRCUITPY/lib/ folder
• NEVER use: urequests, umqtt, ujson (MicroPython versions)`
};

/**
 * Find relevant doc snippets for a user query
 * @param {string} query - User's question
 * @param {number} topK - Max snippets to return
 * @returns {string} Formatted doc context for AI prompt
 */
function getRelevantSnippets(query, topK = 3) {
    const q = query.toLowerCase();

    // Score each snippet by keyword matches
    const scored = Object.entries(snippets).map(([key, content]) => {
        let score = 0;
        // Exact key match = high score
        if (q.includes(key)) score += 10;
        // Keyword matches in content
        const words = q.split(/\s+/).filter(w => w.length > 3);
        for (const word of words) {
            if (content.toLowerCase().includes(word)) score += 2;
        }
        return { key, content, score };
    });

    // Get top matches
    const results = scored
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);

    if (results.length === 0) {
        return `📚 No specific CircuitPython docs found for "${query}".
💡 Try searching for: wifi, i2c, uart, asyncio, gpio, adc, spi, pwm, display, libraries`;
    }

    // Format for AI prompt
    return `📚 RELEVANT CIRCUITPYTHON DOCUMENTATION:
${results.map((r, i) => `\n--- [${i + 1}] ${r.key.toUpperCase()} ---\n${r.content}`).join('\n')}

⚠️ INSTRUCTIONS FOR AI:
• Use ONLY information from the sections above
• If the answer isn't covered, respond: "⚠️ Not in docs — check https://docs.circuitpython.org"
• NEVER suggest forbidden modules: machine, network, uasyncio, utime, urequests
• ALWAYS use explicit pins: tx=board.GP0, NOT board.TX`;
}

module.exports = { getRelevantSnippets, snippets };