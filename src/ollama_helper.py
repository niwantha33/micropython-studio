import requests
import json
import subprocess
import sys
import os

class OllamaHelper:
    def __init__(self, model="mycoder", base_url="http://localhost:11434"):
        self.base_url = base_url
        self.model = model

    def check_connection(self):
        """Check if Ollama server is running."""
        try:
            response = requests.get(f"{self.base_url}/api/tags", timeout=5)
            return response.status_code == 200
        except:
            return False

    def is_model_installed(self):
        """Check if our custom model exists."""
        try:
            response = requests.get(f"{self.base_url}/api/tags")
            if response.status_code == 200:
                models = response.json().get("models", [])
                return any(m.get("name").startswith(self.model) for m in models)
            return False
        except:
            return False

    def create_model(self, modelfile_path):
        """Create the custom model from a Modelfile."""
        try:
            with open(modelfile_path, 'r') as f:
                modelfile_content = f.read()

            response = requests.post(
                f"{self.base_url}/api/create",
                json={
                    "name": self.model,
                    "modelfile": modelfile_content
                },
                stream=True
            )
            # We can stream progress back if needed, for now just wait
            for line in response.iter_lines():
                if line:
                    status_json = line.decode('utf-8')
                    print(status_json, flush=True) # Stream status to stdout
                    status = json.loads(status_json)
                    if status.get("status") == "success":
                        return True
            return False
        except Exception as e:
            print(f"Error creating model: {e}")
            return False

    def pull_model(self, model_name="qwen2.5-coder:3b"):
        """Pull a base model from Ollama library."""
        try:
            response = requests.post(
                f"{self.base_url}/api/pull",
                json={"name": model_name},
                stream=True
            )
            for line in response.iter_lines():
                if line:
                    status_json = line.decode('utf-8')
                    print(status_json, flush=True) # Stream status to stdout
            return True
        except:
            return False

    def chat_with_history(self, messages):
        """Stream a chat response using the chat endpoint (supports history)."""
        try:
            response = requests.post(
                f"{self.base_url}/api/chat",
                json={
                    "model": self.model,
                    "messages": messages,
                    "stream": True,
                    "options": {
                        "num_ctx": 16384,
                        "num_predict": 4096
                    }
                },
                stream=True
            )
            for line in response.iter_lines():
                if line:
                    chunk = json.loads(line)
                    if "message" in chunk:
                        yield chunk["message"].get("content", "")
                    if chunk.get("done"):
                        break
        except Exception as e:
            yield f"\n❌ Error connecting to Ollama: {str(e)}"

if __name__ == "__main__":
    helper = OllamaHelper()
    
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No command provided"}))
        sys.exit(1)

    cmd = sys.argv[1]
    
    if cmd == "check":
        connected = helper.check_connection()
        installed = helper.is_model_installed() if connected else False
        print(json.dumps({"connected": connected, "installed": installed}))
        sys.stdout.flush()
    
    elif cmd == "setup":
        modelfile = sys.argv[2] if len(sys.argv) > 2 else "resource/Modelfile"
        # First ensure base model is there (quiet pull)
        helper.pull_model("qwen2.5-coder:3b")
        success = helper.create_model(modelfile)
        print(json.dumps({"success": success}))
        
    elif cmd == "chat":
        # Supports both single prompt (old) and JSON messages (new)
        input_data = sys.argv[2] if len(sys.argv) > 2 else ""
        try:
            # Try to parse as JSON messages list
            messages = json.loads(input_data)
            if isinstance(messages, list):
                for chunk in helper.chat_with_history(messages):
                    print(chunk, end="", flush=True)
            else:
                raise ValueError("Not a list")
        except:
            # Fallback to single prompt
            prompt = input_data
            for chunk in helper.chat(prompt):
                print(chunk, end="", flush=True)
