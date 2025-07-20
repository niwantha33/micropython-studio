import asyncio
import websockets
import logging

# Setup logging
logging.basicConfig(level=logging.INFO, format="%(asctime)s - %(message)s")


async def echo(websocket):
    async for message in websocket:
        logging.info(f"Received: {message}")
        await websocket.send(f"Echo: {message}")


async def main():
    logging.info("Starting server...")
    async with websockets.serve(echo, "0.0.0.0", 8765):
        logging.info("WebSocket server running on ws://0.0.0.0:8765")
        await asyncio.Future()


asyncio.run(main())
