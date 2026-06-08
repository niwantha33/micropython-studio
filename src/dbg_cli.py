# dbg_cli.py — Readline-enabled command line interface debugger for MicroPython.
import sys
import os
import json
import threading
import time
import subprocess
import cmd
import ast
import mpy_parser

# Color codes for premium aesthetics
COLOR_GREEN = "\033[92m"
COLOR_YELLOW = "\033[93m"
COLOR_RED = "\033[91m"
COLOR_BLUE = "\033[94m"
COLOR_CYAN = "\033[96m"
COLOR_BOLD = "\033[1m"
COLOR_RESET = "\033[0m"

# Try importing readline for history/autocompletion
try:
    import readline
except ImportError:
    # Windows fallback
    try:
        from pyreadline3 import Readline
        readline = Readline()
    except ImportError:
        readline = None

def get_function_info_at_line(filepath, target_line):
    """Scan file to find the enclosing function and relative line."""
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            source = f.read()
        tree = ast.parse(source, filename=filepath)
    except Exception:
        return None

    best_func = None
    best_def_line = -1

    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef):
            if hasattr(node, "lineno"):
                # Find the function def line closest to target_line but <= target_line
                if node.lineno <= target_line:
                    if node.lineno > best_def_line:
                        best_def_line = node.lineno
                        best_func = node
    
    if best_func:
        return {
            "func": best_func.name,
            "def_line": best_def_line,
            "rel_line": target_line - best_def_line
        }
    return None

def extract_all_locals(filepath):
    """Map function name -> local names using AST."""
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            source = f.read()
        tree = ast.parse(source, filename=filepath)
    except Exception:
        return {}

    func_locals = {}
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef):
            args = [arg.arg for arg in node.args.args]
            if node.args.vararg:
                args.append(node.args.vararg.arg)
            if node.args.kwarg:
                args.append(node.args.kwarg.arg)
            args.extend([arg.arg for arg in node.args.kwonlyargs])
            
            local_vars = []
            for child in ast.walk(node):
                if isinstance(child, ast.Assign):
                    for target in child.targets:
                        if isinstance(target, ast.Name):
                            if target.id not in args and target.id not in local_vars:
                                local_vars.append(target.id)
            func_locals[node.name] = args + local_vars
    return func_locals

class MicroDebuggerCLI(cmd.Cmd):
    prompt = f"{COLOR_BLUE}(dbg){COLOR_RESET} "

    def __init__(self, port, target_file=None):
        super().__init__()
        self.port = port
        self.target_file = target_file
        self.bridge_proc = None
        self.running = True
        self.paused = False
        self.current_ip = None
        self.bp_slots = {}  # slot -> info dict
        self.ip_to_loc = {}  # ip -> info dict
        self.pending_bp = []  # list of pending breakpoint registrations
        self.fun_to_name = {}  # fun_address -> function name (str)
        self.local_names_by_fn = {}
        
        # Load local functions/locals if file provided
        if target_file and os.path.exists(target_file):
            self.local_names_by_fn = extract_all_locals(target_file)
            
        self.start_bridge()

    def start_bridge(self):
        bridge_script = os.path.join(os.path.dirname(__file__), "dbg_bridge.py")
        py_cmd = sys.executable
        
        # Start dbg_bridge.py as a subprocess
        self.bridge_proc = subprocess.Popen(
            [py_cmd, bridge_script, self.port],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1
        )
        
        # Start background thread to read bridge stdout
        self.reader_thread = threading.Thread(target=self.read_bridge_output, daemon=True)
        self.reader_thread.start()

    def send_op(self, op, **kwargs):
        if self.bridge_proc and self.bridge_proc.stdin:
            payload = {"op": op}
            payload.update(kwargs)
            try:
                self.bridge_proc.stdin.write(json.dumps(payload) + "\n")
                self.bridge_proc.stdin.flush()
            except Exception as e:
                print(f"{COLOR_RED}Failed to send to bridge: {e}{COLOR_RESET}")

    def read_bridge_output(self):
        while self.running:
            line = self.bridge_proc.stdout.readline()
            if not line:
                break
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
                self.handle_bridge_message(msg)
            except Exception as e:
                print(f"\n{COLOR_YELLOW}[Raw] {line}{COLOR_RESET}")

    def handle_bridge_message(self, msg):
        evt = msg.get("evt")
        if evt == "open":
            print(f"\n{COLOR_GREEN}Connected to device on {msg.get('port')}{COLOR_RESET}")
        elif evt == "bp_hit":
            self.paused = True
            ip = msg.get("ip")
            self.current_ip = ip
            print(f"\n{COLOR_YELLOW}{COLOR_BOLD}Breakpoint hit at ip=0x{ip:04x}{COLOR_RESET}")
            # Try to show source line
            loc = self.ip_to_loc.get(ip)
            if loc:
                print(f"Location: {loc['fsPath']}:{loc['line1']} ({loc['fnKey']})")
                self.show_source_line(loc['fsPath'], loc['line1'])
            else:
                print("No source mapping available for this instruction pointer.")
            # Request locals automatically
            self.send_op("locals")
        elif evt == "exception":
            self.paused = True
            ip = msg.get("ip")
            self.current_ip = ip
            msg_text = msg.get("msg", "Unknown error")
            print(f"\n{COLOR_RED}{COLOR_BOLD}Exception raised: {msg_text} at ip=0x{ip:04x}{COLOR_RESET}")
            loc = self.ip_to_loc.get(ip)
            if loc:
                print(f"Location: {loc['fsPath']}:{loc['line1']} ({loc['fnKey']})")
                self.show_source_line(loc['fsPath'], loc['line1'])
            else:
                print("No source mapping available for this exception location.")
            self.send_op("locals")
        elif evt == "trace":
            ip = msg.get("ip")
            op = msg.get("op")
        elif evt == "reply":
            text = msg.get("text", "")
            if text.startswith("bp "):
                parts = text.split()
                try:
                    slot = int(parts[1])
                    # Parse module, func, line, ip
                    details = parts[3]  # "test.f:8"
                    mod_func, line_str = details.split(":")
                    rel_line = int(line_str)
                    
                    if "." in mod_func:
                        mod_name, func_name = mod_func.split(".", 1)
                    else:
                        mod_name = mod_func
                        func_name = ""
                        
                    ip_part = [p for p in parts if p.startswith("ip=")][0]
                    bp_ip = int(ip_part.split("=")[1])
                    
                    # Find matching pending BP
                    match_info = None
                    for bp in self.pending_bp:
                        if bp["module"] == mod_name and bp["func"] == func_name and bp["rel_line"] == rel_line:
                            match_info = bp
                            self.pending_bp.remove(bp)
                            break
                    if not match_info and self.pending_bp:
                        match_info = self.pending_bp.pop(0)
                        
                    if match_info:
                        self.ip_to_loc[bp_ip] = {
                            "fsPath": match_info["fsPath"],
                            "line1": match_info["line1"],
                            "fnKey": match_info["fnKey"]
                        }
                    
                    # Store info
                    self.bp_slots[slot] = {"ip": bp_ip, "details": details}
                    fun_part = [p for p in parts if p.startswith("fun=")]
                    if fun_part:
                        fun_val = int(fun_part[0].split("=")[1])
                        self.fun_to_name[fun_val] = f"{mod_name}:{func_name}"
                    print(f"\n{COLOR_GREEN}Breakpoint registered: Slot {slot} at ip=0x{bp_ip:04x} ({details}){COLOR_RESET}")
                except Exception as e:
                    pass
            elif text.startswith("stack="):
                print(f"\n{COLOR_CYAN}Call Stack:{COLOR_RESET}")
                print(text)
            elif "state=" in text:
                self.pretty_print_locals(text)
            else:
                print(f"\n{COLOR_GREEN}{text}{COLOR_RESET}")
        elif evt == "sent":
            pass
        elif evt == "error":
            print(f"\n{COLOR_RED}Error: {msg.get('msg')}{COLOR_RESET}")
        elif evt == "closed":
            print(f"\n{COLOR_RED}Connection closed.{COLOR_RESET}")
            self.running = False

    def show_source_line(self, filepath, line_num):
        if not os.path.exists(filepath):
            return
        try:
            with open(filepath, "r", encoding="utf-8") as f:
                lines = f.readlines()
            if 1 <= line_num <= len(lines):
                # Print 3 lines of context
                start = max(1, line_num - 1)
                end = min(len(lines), line_num + 1)
                for l in range(start, end + 1):
                    prefix = "-> " if l == line_num else "   "
                    color = COLOR_YELLOW if l == line_num else ""
                    print(f"{color}{prefix}{l:4d} | {lines[l-1].rstrip()}{COLOR_RESET}")
        except Exception:
            pass

    def pretty_print_locals(self, text):
        # Format: depth=0 state=[val1, val2, ...]
        # Or frame=(...) state=[...]
        try:
            # Simple parsing of state=[...]
            state_idx = text.find("state=[")
            if state_idx == -1:
                print(text)
                return
            state_str = text[state_idx + len("state=["):-1]
            
            # Simple comma split that respects string brackets
            parts = []
            current = []
            bracket_depth = 0
            in_quote = None
            for char in state_str:
                if in_quote:
                    if char == in_quote:
                        in_quote = None
                    current.append(char)
                elif char in ("'", '"'):
                    in_quote = char
                    current.append(char)
                elif char in ("[", "("):
                    bracket_depth += 1
                    current.append(char)
                elif char in ("]", ")"):
                    bracket_depth -= 1
                    current.append(char)
                elif char == "," and bracket_depth == 0:
                    parts.append("".join(current).strip())
                    current = []
                else:
                    current.append(char)
            if current:
                parts.append("".join(current).strip())
            
            # Match with local names if we have them
            names = []
            func_name = None
            
            # Extract fun address from frame=(state_len, depth, ip, fun)
            import re
            frame_match = re.search(r"frame=\((\d+),\s*(\d+),\s*(\d+),\s*(\d+)\)", text)
            if frame_match:
                fun_address = int(frame_match.group(4))
                ip_val = int(frame_match.group(3))
                self.current_ip = ip_val
                if fun_address in self.fun_to_name:
                    fn_key = self.fun_to_name[fun_address]
                    func_name = fn_key.split(":")[-1] if ":" in fn_key else fn_key

            if not func_name:
                loc = self.ip_to_loc.get(self.current_ip)
                if loc:
                    fn_key = loc.get("fnKey", "")
                    func_name = fn_key.split(":")[-1] if ":" in fn_key else fn_key
                    
            if func_name and func_name in self.local_names_by_fn:
                names = self.local_names_by_fn[func_name]
            # Try to resolve and print source line if it wasn't printed yet (e.g. during stepping/exception)
            loc = self.ip_to_loc.get(self.current_ip)
            if not loc and func_name and self.target_file:
                mpy_file = self.target_file.replace(".py", ".mpy")
                if os.path.exists(mpy_file):
                    try:
                        rc, qstrs, objs = mpy_parser.parse_mpy(mpy_file)
                        line_map = mpy_parser.build_line_map(rc)
                        func_code = None
                        for name, code in line_map.items():
                            if name.endswith(func_name):
                                func_code = code
                                break
                        if func_code:
                            line1 = func_code.get_source_line(self.current_ip)
                            print(f"\nLocation: {self.target_file}:{line1} ({func_name})")
                            self.show_source_line(self.target_file, line1)
                    except Exception:
                        pass
                
            print(f"\n{COLOR_CYAN}Local variables (Active Frame):{COLOR_RESET}")
            print(f"{'Name':<20} | {'Value':<30}")
            print("-" * 55)
            
            n_vals = len(parts)
            # locals are usually stored at the end of the state array
            for i, val in enumerate(parts):
                # If we have names, try to align them
                name = f"slot_{i}"
                if names and i < len(names):
                    name = names[i]
                print(f"{COLOR_BOLD}{name:<20}{COLOR_RESET} | {COLOR_GREEN}{val:<30}{COLOR_RESET}")
            print("")
        except Exception as e:
            print(text)

    # CLI Debugger Commands
    def do_continue(self, arg):
        """Continue execution (c)"""
        self.paused = False
        self.send_op("continue")

    def do_c(self, arg):
        return self.do_continue(arg)

    def do_step(self, arg):
        """Step over (s)"""
        self.paused = False
        self.send_op("step")

    def do_s(self, arg):
        return self.do_step(arg)

    def do_step_in(self, arg):
        """Step in (i)"""
        self.paused = False
        self.send_op("step_in")

    def do_i(self, arg):
        return self.do_step_in(arg)

    def do_step_out(self, arg):
        """Step out (o)"""
        self.paused = False
        self.send_op("step_out")

    def do_o(self, arg):
        return self.do_step_out(arg)

    def do_locals(self, arg):
        """Show local variables (l)"""
        self.send_op("locals")

    def do_l(self, arg):
        return self.do_locals(arg)

    def do_stack(self, arg):
        """Show call stack (k)"""
        self.send_op("call_stack")

    def do_k(self, arg):
        return self.do_stack(arg)

    def do_break(self, arg):
        """Set a breakpoint: break [line] OR break [func] OR break [file:line]"""
        if not arg:
            print("Usage: break <line> OR break <func> OR break <file:line>")
            return

        filename = self.target_file
        func = ""
        line = None

        if ":" in arg:
            parts = arg.split(":")
            filename = parts[0]
            try:
                line = int(parts[1])
            except ValueError:
                func = parts[1]
        else:
            try:
                line = int(arg)
            except ValueError:
                func = arg

        if not filename:
            print("Error: No target file specified. Use break <file:line>")
            return

        if not os.path.exists(filename):
            # Check current directory
            if os.path.exists(os.path.join(os.getcwd(), filename)):
                filename = os.path.join(os.getcwd(), filename)
            else:
                print(f"Error: File '{filename}' not found.")
                return

        mod_name = os.path.splitext(os.path.basename(filename))[0]

        if line is not None:
            # Find enclosing function and relative line
            info = get_function_info_at_line(filename, line)
            if not info:
                # Fallback to module level / main
                print(f"Could not find enclosing function for line {line}. Setting at module level.")
                func = "outer"
                rel_line = line
            else:
                func = info["func"]
                rel_line = info["rel_line"]
        else:
            rel_line = 0

        # Register local names for this function
        func_locals = extract_all_locals(filename)
        if func in func_locals:
            self.local_names_by_fn[func] = func_locals[func]

        # We need to compute/guess the IP offset to map it later on bp_hit
        # Let's save the pending breakpoint context
        key = f"{mod_name}:{func}:{line}"
        
        # Parse the corresponding .mpy if we have it or can generate it
        mpy_file = filename.replace(".py", ".mpy")
        if not os.path.exists(mpy_file):
            # Try to compile using mpy-cross
            try:
                import mpy_cross
                subprocess.run([sys.executable, "-m", "mpy_cross", filename], check=True)
            except Exception:
                pass
        
        expected_ip = 0
        if os.path.exists(mpy_file):
            try:
                rc, qstrs, objs = mpy_parser.parse_mpy(mpy_file)
                line_map = mpy_parser.build_line_map(rc)
                # Find matching function raw code block
                func_code = None
                for name, code in line_map.items():
                    if name.endswith(func):
                        func_code = code
                        break
                if func_code:
                    # Find IP corresponding to rel_line
                    # We look for first IP where get_source_line(ip) == rel_line + 1 (or close)
                    # Let's search IP offsets
                    for offset in range(len(func_code.fun_data)):
                        if func_code.get_source_line(offset) == rel_line:
                            expected_ip = offset
                            break
            except Exception:
                pass

        print(f"Setting breakpoint in {mod_name}.{func} at line {line} (rel_line={rel_line})...")
        self.pending_bp.append({
            "module": mod_name,
            "func": func,
            "rel_line": rel_line,
            "fsPath": filename,
            "line1": line if line is not None else rel_line,
            "fnKey": f"{mod_name}:{func}"
        })
        self.send_op("set_bp", module=mod_name, func=func, line=rel_line)

    def do_b(self, arg):
        return self.do_break(arg)

    def do_clear(self, arg):
        """Clear a breakpoint by slot number: clear [slot]"""
        if not arg:
            print("Usage: clear <slot>")
            return
        try:
            slot = int(arg)
            self.send_op("clear_bp", slot=slot)
            if slot in self.bp_slots:
                # Try to clean up ip mapping
                ip = self.bp_slots[slot]["ip"]
                self.ip_to_loc.pop(ip, None)
                self.bp_slots.pop(slot)
        except ValueError:
            print("Error: Slot must be an integer.")

    def do_poke(self, arg):
        """Poke a variable value: poke [local/global] [name] [expr]"""
        if not arg:
            print("Usage: poke local <slot> <expr> OR poke global <name> <expr>")
            return
        parts = arg.split(None, 2)
        if len(parts) < 3:
            print("Usage: poke local <slot> <expr> OR poke global <name> <expr>")
            return
        scope, name, expr = parts
        if scope == "local":
            try:
                slot = int(name)
                self.send_op("poke_local", slot=slot, expr=expr)
            except ValueError:
                print("Error: Local variable reference must be a slot index.")
        elif scope == "global":
            self.send_op("poke_global", name=name, expr=expr, depth=0)
        else:
            print("Error: Scope must be 'local' or 'global'.")

    def do_quit(self, arg):
        """Quit the debugger CLI (q)"""
        self.running = False
        self.send_op("quit")
        time.sleep(0.2)
        if self.bridge_proc:
            self.bridge_proc.terminate()
        return True

    def do_q(self, arg):
        return self.do_quit(arg)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(f"{COLOR_RED}Usage: python dbg_cli.py <PORT> [target_file.py]{COLOR_RESET}")
        sys.exit(1)
        
    port = sys.argv[1]
    target_file = sys.argv[2] if len(sys.argv) > 2 else None
    
    print(f"{COLOR_CYAN}{COLOR_BOLD}=== MicroPython CLI Debugger ==={COLOR_RESET}")
    print(f"Starting connection on port {port}...")
    
    cli = MicroDebuggerCLI(port, target_file)
    try:
        cli.cmdloop()
    except KeyboardInterrupt:
        print("\nExiting...")
        cli.do_quit(None)
