import asyncio

import digitalio


async def blink_led():
    # Assuming LED pin number 13 for CircuitPython on RP2350
    led = digitalio.DigitalInOut(board.LED)

    led.direction = digitalio.Direction.OUTPUT

    while True:
        led.value = False
        await asyncio.sleep(0.5)
        led.value = True
        print("LED is ON")  # Print message when LED turns on
        await asyncio.sleep(0.5)


if __name__ == "__main__":
    asyncio.run(blink_led())