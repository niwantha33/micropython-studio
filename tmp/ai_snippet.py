# Import the os module
import os

# Define the path to the board directory
board_dir = os.path.join(os.getcwd(), 'lib', 'stubs', 'circuitpython-stubs', 'boards', 'rp2350')

# Check if the board directory exists
if os.path.exists(board_dir):
    # List all files and directories in the board directory
    items = os.listdir(board_dir)
    
    # Print each item in the directory
    for item in items:
        print(item)
else:
    print(f"The board directory at {board_dir} does not exist.")