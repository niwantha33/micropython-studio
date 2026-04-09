import sys
import json
import subprocess
import os
import shlex

# -------------------------------
# AUTO-INSTALL REQUESTS
# -------------------------------
try:
    import requests
except ImportError:
    try:
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install", "requests"])
        import requests
    except Exception as e:
        print(json.dumps({"error": f"Failed to install requests: {str(e)}"}))
        sys.exit(1)


class OllamaHelper:
    def __init__(self, base_url="http://127.0.0.1:11434"):
        self.base_url = base_url

    # -------------------------------
    # CONNECTION CHECK
    # -------------------------------
    def check_connection(self):
        urls = [self.base_url]

        if "localhost" in self.base_url:
            urls.append(self.base_url.replace("localhost", "127.0.0.1"))
        elif "127.0.0.1" in self.base_url:
            urls.append(self.base_url.replace("127.0.0.1", "localhost"))

        for url in urls:
            try:
                r = requests.get(f"{url}/api/tags", timeout=3)
                if r.status_code == 200:
                    self.base_url = url
                    return True
            except:
                continue
        return False

    # -------------------------------
    # STATUS
    # -------------------------------
    def get_status(self):
        if not self.check_connection():
            return {"connected": False}

        try:
            r = requests.get(f"{self.base_url}/api/tags", timeout=5)
            models = r.json().get("models", [])

            names = [m["name"] for m in models]

            has_mpy = any("mycoder-mpy" in n for n in names)
            has_cpy = any("mycoder-cpy" in n for n in names)
            return {
                "connected": True,
                "installed": has_mpy or has_cpy,
                "mpy": has_mpy,
                "cpy": has_cpy
            }
        except Exception as e:
            return {"connected": False, "error": str(e)}

    # -------------------------------
    # DELETE MODEL
    # -------------------------------
    def delete_model(self, name):
        try:
            proc = subprocess.run(
                ["ollama", "rm", name],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT
            )
            return proc.returncode == 0
        except Exception as e:
            return {"error": str(e)}

    # -------------------------------
    # PULL BASE MODEL
    # -------------------------------
    def pull_model(self, name="gemma4:e2b"):
        try:
            proc = subprocess.Popen(
                ["ollama", "pull", name],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT
            )
            for line in proc.stdout:
                text = line.decode(errors="replace").rstrip()
                if text:
                    print(json.dumps({"status": text}), flush=True)
            proc.wait()
            return proc.returncode == 0
        except Exception as e:
            print(json.dumps({"error": str(e)}))
            return False

    # -------------------------------
    # CREATE MODEL
    # -------------------------------
    def create_model(self, name, modelfile):
        if not os.path.exists(modelfile):
            print(json.dumps({"error": f"Modelfile not found: {modelfile}"}))
            return False

        try:
            proc = subprocess.Popen(
                ["ollama", "create", name, "-f", modelfile],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT
            )
            for line in proc.stdout:
                text = line.decode(errors="replace").rstrip()
                if text:
                    print(json.dumps({"status": text}), flush=True)
            proc.wait()
            return proc.returncode == 0

        except Exception as e:
            print(json.dumps({"error": str(e)}))
            return False

    # -------------------------------
    # CHAT
    # -------------------------------
    # def chat(self, messages, model):
    #     try:
    #         r = requests.post(
    #             f"{self.base_url}/api/chat",
    #             json={
    #                 "model": model,
    #                 "messages": messages,
    #                 "stream": True,
    #                 "options": {
    #                     "temperature": 1,
    #                     "top_p": 0.96,
    #                     "top_k": 60,
    #                     "num_ctx": 8192
    #                 }
    #             },
    #             stream=True,
    #             timeout=120
    #         )

    #         # ✅ Check HTTP status
    #         if r.status_code != 200:
    #             yield f"\n❌ HTTP Error {r.status_code}: {r.text}"
    #             return

    #         # ✅ Stream response safely
    #         for line in r.iter_lines(decode_unicode=True):
    #             if not line:
    #                 continue

    #             try:
    #                 chunk = json.loads(line)
    #             except json.JSONDecodeError:
    #                 continue  # skip bad chunks safely

    #             # ✅ Handle Ollama error
    #             if "error" in chunk:
    #                 yield f"\n❌ Ollama Error: {chunk['error']}"
    #                 return

    #             # ✅ Normal token streaming
    #             if "message" in chunk:
    #                 yield chunk["message"].get("content", "")

    #             # ✅ End of stream
    #             if chunk.get("done"):
    #                 break

    #     except requests.exceptions.ConnectionError:
    #         yield "\n❌ Cannot connect to Ollama (is it running?)"

    #     except requests.exceptions.Timeout:
    #         yield "\n❌ Request timed out"

    #     except Exception as e:
    #         yield f"\n❌ Unexpected Error: {str(e)}"

    def chat(self, messages, model):
        """
        Stream chat response using Ollama CLI (faster than HTTP API)

        Args:
            messages: List of {role, content} dicts
            model: Model name (e.g., "mycoder-cpy-docs")

        Yields:
            str: Tokens as they're generated
        """
        try:
            # ── Format messages into a single prompt ──────────────────
            # Ollama CLI doesn't support multi-turn history natively,
            # so we concatenate messages with clear role markers.
            prompt_parts = []
            for msg in messages:
                role = msg.get("role", "user").upper()
                content = msg.get("content", "").strip()
                if role == "SYSTEM":
                    prompt_parts.append(f"«SYSTEM»\n{content}\n")
                elif role == "USER":
                    prompt_parts.append(f"«USER»\n{content}\n")
                elif role == "ASSISTANT":
                    prompt_parts.append(f"«ASSISTANT»\n{content}\n")

            full_prompt = "\n".join(prompt_parts).strip()

            # ── Build CLI command ─────────────────────────────────────
            # Using --verbose for raw output, --nowordwrap to preserve formatting
            cmd = [
                "ollama", "run", model,
                "--prompt", full_prompt,
                "--verbose",        # Raw output (no extra formatting)
                "--nowordwrap"      # Keep code formatting intact
            ]

            # ── Run with streaming stdout ─────────────────────────────
            proc = subprocess.Popen(
                cmd,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,           # Decode bytes to str automatically
                bufsize=1,           # Line-buffered for real-time streaming
                creationflags=subprocess.CREATE_NO_WINDOW if hasattr(
                    subprocess, 'CREATE_NO_WINDOW') else 0  # Hide console window on Windows
            )

            # Stream tokens as they arrive
            for line in proc.stdout:
                if not line.strip():
                    continue
                # Ollama CLI outputs raw text — yield directly
                yield line.rstrip('\n')

            # Check for errors after completion
            proc.wait(timeout=120)
            if proc.returncode != 0:
                error = proc.stderr.read().strip()
                if "context window full" in error.lower():
                    yield "\n❌ Context too long — try shortening your conversation"
                elif "model not found" in error.lower():
                    yield f"\n❌ Model '{model}' not found. Run: ollama pull {model}"
                else:
                    yield f"\n❌ CLI Error ({proc.returncode}): {error}"

        except FileNotFoundError:
            yield "\n❌ Ollama CLI not found. Install from https://ollama.com"

        except subprocess.TimeoutExpired:
            proc.kill()
            yield "\n❌ Request timed out (120s)"

        except KeyboardInterrupt:
            proc.kill()
            yield "\n⚠️ Interrupted by user"

        except Exception as e:
            yield f"\n❌ Unexpected Error: {type(e).__name__}: {str(e)}"


# -------------------------------
# CLI ENTRY
# -------------------------------
if __name__ == "__main__":
    helper = OllamaHelper()

    if len(sys.argv) < 2:
        print(json.dumps({"error": "No command"}))
        sys.exit(1)

    cmd = sys.argv[1]

    # -------------------------------
    # CHECK
    # -------------------------------
    if cmd == "check":
        print(json.dumps(helper.get_status()))
        sys.exit(0)

    # -------------------------------
    # SETUP BOTH MODELS
    # -------------------------------
    elif cmd == "setup":
        base = "gemma4:e2b"

        modelfile_arg = sys.argv[2] if len(sys.argv) > 2 else None
        if modelfile_arg:
            resource_dir = os.path.dirname(modelfile_arg)
            mpy_modelfile = os.path.join(resource_dir, "Modelfile-mpy")
            cpy_modelfile = os.path.join(resource_dir, "Modelfile-cpy")
        else:
            script_dir = os.path.dirname(os.path.abspath(__file__))
            resource_dir = os.path.join(script_dir, "..", "resource")
            mpy_modelfile = os.path.join(resource_dir, "Modelfile-mpy")
            cpy_modelfile = os.path.join(resource_dir, "Modelfile-cpy")

        helper.pull_model(base)

        helper.create_model("mycoder-mpy", mpy_modelfile)
        helper.create_model("mycoder-cpy", cpy_modelfile)

        print(json.dumps({"success": True}))

    # -------------------------------
    # DELETE
    # -------------------------------
    elif cmd == "delete":
        name = sys.argv[2]
        print(json.dumps({"success": helper.delete_model(name)}))

    # -------------------------------
    # CHAT
    # -------------------------------
    elif cmd == "chat":
        model = sys.argv[2] if len(sys.argv) > 2 else "mycoder-mpy"

        data = sys.stdin.read()
        if not data.strip():
            sys.exit(0)

        messages = json.loads(data)

        for chunk in helper.chat(messages, model):
            print(chunk, end="", flush=True)
