import uasyncio
import time

async def task_one():
    """Simulates the work of the first task."""
    print("Task One: Starting work.")
    await uasyncio.sleep(2)
    print("Task One: Finished work.")
    return "Result from Task 1"

async def task_two():
    """Simulates the work of the second task."""
    print("Task Two: Starting work.")
    await uasyncio.sleep(3)
    print("Task Two: Finished work.")
    return "Result from Task 2"

async def main():
    """Main function to run tasks concurrently and handle the callback."""
    print("Main: Scheduling tasks.")

    # Create tasks and gather them to wait for both to complete
    results = await uasyncio.gather(task_one(), task_two())

    # Callback on completion
    print("\n--- Callback Notification ---")
    print("All tasks have completed.")
    print(f"Received results: {results}")

if __name__ == "__main__":
    try:
        uasyncio.run(main())
    except KeyboardInterrupt:
        print("Program interrupted.")