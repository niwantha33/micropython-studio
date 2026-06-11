# mpy_parser.py — Parse MicroPython .mpy v6 files to map instruction pointer offsets to source lines.
import sys

class MPYReader:
    def __init__(self, fileobj):
        self.fileobj = fileobj

    def tell(self):
        return self.fileobj.tell()

    def read_byte(self):
        b = self.fileobj.read(1)
        if not b:
            raise EOFError("Unexpected EOF")
        return b[0]

    def read_bytes(self, n):
        b = self.fileobj.read(n)
        if len(b) < n:
            raise EOFError("Unexpected EOF")
        return b

    def read_uint(self):
        i = 0
        while True:
            b = self.read_byte()
            i = (i << 7) | (b & 0x7f)
            if not (b & 0x80):
                return i

def read_qstr(reader):
    ln = reader.read_uint()
    if ln & 1:  # static qstr
        idx = ln >> 1
        common = {
            1: "",
            2: "__main__",
        }
        return common.get(idx, f"qstr_{idx}")
    ln >>= 1
    data = reader.read_bytes(ln).decode("utf-8", errors="replace")
    reader.read_byte()  # null terminator
    return data

def read_obj(reader):
    obj_type = reader.read_byte()
    if obj_type == 0:  # MP_PERSISTENT_OBJ_FUN_TABLE
        return "MPFunTable"
    elif obj_type == 1:  # MP_PERSISTENT_OBJ_NONE
        return None
    elif obj_type == 2:  # MP_PERSISTENT_OBJ_FALSE
        return False
    elif obj_type == 3:  # MP_PERSISTENT_OBJ_TRUE
        return True
    elif obj_type == 4:  # MP_PERSISTENT_OBJ_ELLIPSIS
        return Ellipsis
    elif obj_type == 10:  # MP_PERSISTENT_OBJ_TUPLE
        ln = reader.read_uint()
        return tuple(read_obj(reader) for _ in range(ln))
    else:
        ln = reader.read_uint()
        buf = reader.read_bytes(ln)
        if obj_type == 5:  # MP_PERSISTENT_OBJ_STR
            return buf.decode("utf-8", errors="replace")
        elif obj_type == 6:  # MP_PERSISTENT_OBJ_BYTES
            return buf
        elif obj_type == 7:  # MP_PERSISTENT_OBJ_INT
            return int(buf.decode("ascii", errors="replace"))
        elif obj_type == 8:  # MP_PERSISTENT_OBJ_FLOAT
            return float(buf.decode("ascii", errors="replace"))
        elif obj_type == 9:  # MP_PERSISTENT_OBJ_COMPLEX
            return complex(buf.decode("ascii", errors="replace"))
        else:
            return buf

class RawCode:
    def __init__(self, parent_name, fun_data, children, qstr_table, obj_table):
        self.fun_data = fun_data
        self.children = children
        self.qstr_table = qstr_table
        self.obj_table = obj_table
        
        (
            self.offset_prelude_size,
            self.offset_source_info,
            self.offset_line_info,
            self.offset_closure_info,
            self.offset_opcodes,
            self.n_info,
            self.n_cell,
            args
        ) = self.extract_prelude(fun_data, 0)
        
        if args:
            simple_name_idx = args[0]
            if simple_name_idx < len(qstr_table):
                self.name = qstr_table[simple_name_idx]
            else:
                self.name = f"func_{simple_name_idx}"
        else:
            self.name = parent_name

    def read_prelude_sig(self, read_byte):
        z = read_byte()
        S = (z >> 3) & 0xF
        E = (z >> 2) & 0x1
        F = 0
        A = z & 0x3
        K = 0
        D = 0
        n = 0
        while z & 0x80:
            z = read_byte()
            S |= (z & 0x30) << (2 * n)
            E |= (z & 0x02) << n
            F |= ((z & 0x40) >> 6) << n
            A |= (z & 0x4) << n
            K |= ((z & 0x08) >> 3) << n
            D |= (z & 0x1) << n
            n += 1
        S += 1
        return S, E, F, A, K, D

    def read_prelude_size(self, read_byte):
        I = 0
        C = 0
        n = 0
        while True:
            z = read_byte()
            I |= ((z & 0x7E) >> 1) << (6 * n)
            C |= (z & 1) << n
            if not (z & 0x80):
                break
            n += 1
        return I, C

    def extract_prelude(self, bytecode, ip):
        ip_ref = [ip]
        def local_read_byte():
            b = bytecode[ip_ref[0]]
            ip_ref[0] += 1
            return b

        (
            n_state,
            n_exc_stack,
            scope_flags,
            n_pos_args,
            n_kwonly_args,
            n_def_pos_args,
        ) = self.read_prelude_sig(local_read_byte)

        offset_prelude_size = ip_ref[0]
        n_info, n_cell = self.read_prelude_size(local_read_byte)
        offset_source_info = ip_ref[0]

        args = []
        for arg_num in range(1 + n_pos_args + n_kwonly_args):
            value = 0
            while True:
                b = local_read_byte()
                value = (value << 7) | (b & 0x7F)
                if b & 0x80 == 0:
                    break
                # Yes, standard vuint
            args.append(value)

        offset_line_info = ip_ref[0]
        offset_closure_info = offset_source_info + n_info
        offset_opcodes = offset_source_info + n_info + n_cell

        return (
            offset_prelude_size,
            offset_source_info,
            offset_line_info,
            offset_closure_info,
            offset_opcodes,
            n_info,
            n_cell,
            args
        )

    @staticmethod
    def decode_lineinfo(line_info):
        c = line_info[0]
        if (c & 0x80) == 0:  # 0b0LLBBBBB encoding
            return (c & 0x1F), (c >> 5), line_info[1:]
        else:  # 0b1LLLBBBB 0bLLLLLLLL encoding
            return (c & 0xF), (((c << 4) & 0x700) | line_info[1]), line_info[2:]

    def get_source_line(self, ip_offset: int) -> int:
        bc_offset = ip_offset
        try:
            line_info = memoryview(self.fun_data)[self.offset_line_info : self.offset_opcodes]
        except Exception:
            return 1
        source_line = 1
        while line_info:
            bc_increment, line_increment, line_info = self.decode_lineinfo(line_info)
            if bc_offset >= bc_increment:
                bc_offset -= bc_increment
                source_line += line_increment
            else:
                break
        return source_line

def read_raw_code_with_tables(reader, qstr_table, obj_table, parent_name):
    kind_len = reader.read_uint()
    kind = (kind_len & 3) + 2
    has_children = (kind_len >> 2) & 1
    fun_data_len = kind_len >> 3
    
    fun_data = reader.read_bytes(fun_data_len)
    children = []
    
    rc = RawCode(parent_name, fun_data, children, qstr_table, obj_table)
    
    if has_children:
        n_children = reader.read_uint()
        for _ in range(n_children):
            children.append(read_raw_code_with_tables(reader, qstr_table, obj_table, rc.name))
            
    return rc

def parse_mpy(filename):
    with open(filename, "rb") as fileobj:
        reader = MPYReader(fileobj)
        header = reader.read_bytes(4)
        if header[0] != ord("M"):
            raise ValueError("Not a valid .mpy file")
        # Read QSTR and Object counts
        n_qstr = reader.read_uint()
        n_obj = reader.read_uint()
        
        qstr_table = []
        for _ in range(n_qstr):
            qstr_table.append(read_qstr(reader))
            
        obj_table = []
        for _ in range(n_obj):
            obj_table.append(read_obj(reader))
            
        # Read the outer scope raw code
        raw_code = read_raw_code_with_tables(reader, qstr_table, obj_table, "outer")
        return raw_code, qstr_table, obj_table

def build_line_map(raw_code, line_map=None, path_prefix=""):
    if line_map is None:
        line_map = {}
    
    current_path = f"{path_prefix}.{raw_code.name}" if path_prefix else raw_code.name
    line_map[current_path] = raw_code
    
    for child in raw_code.children:
        build_line_map(child, line_map, current_path)
        
    return line_map

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python mpy_parser.py <file.mpy>")
        sys.exit(1)
    try:
        rc, qstrs, objs = parse_mpy(sys.argv[1])
        print("Successfully parsed .mpy file.")
        print("QSTRs:", qstrs)
        print("Objects:", objs)
        line_map = build_line_map(rc)
        for name, code in line_map.items():
            print(f"Function: {name}")
            # Try mapping some offsets
            for offset in [0, 2, 4, 6, 8, 10]:
                print(f"  offset {offset} -> line {code.get_source_line(offset)}")
    except Exception as e:
        print("Error:", e)
        sys.exit(1)
