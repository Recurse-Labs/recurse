import os
import sys
import json
import socket
import traceback

import ida_auto
import ida_ida
import ida_idaapi
import ida_funcs
import ida_name
import ida_hexrays
import ida_nalt
import ida_loader
import ida_bytes
import ida_strlist
import ida_xref
import ida_entry
import ida_pro
import ida_gdl
import idc
import idautils

def handle_request(req):
    method = req.get("method")
    params = req.get("params", {})
    
    if method == "ping":
        return {"status": "ok", "hexrays": bool(ida_hexrays.init_hexrays_plugin())}
        
    elif method == "info":
        procname = ida_ida.inf_get_procname()
        is_64 = ida_ida.inf_is_64bit()
        is_be = ida_ida.inf_is_be()
        try:
            filetype = ida_loader.get_file_type_name()
        except Exception:
            try:
                filetype = ida_nalt.get_file_type_name()
            except Exception:
                filetype = "ELF"
        min_ea = ida_ida.inf_get_min_ea()
        max_ea = ida_ida.inf_get_max_ea()
        entry_ea = ida_entry.get_entry(0) if ida_entry.get_entry_qty() > 0 else min_ea
        
        return {
            "arch": procname,
            "bits": 64 if is_64 else 32,
            "endian": "big" if is_be else "little",
            "file_type": filetype,
            "min_ea": min_ea,
            "max_ea": max_ea,
            "entry": entry_ea
        }
        
    elif method == "functions":
        limit = params.get("limit", 10000)
        offset = params.get("offset", 0)
        funcs = []
        pfn = ida_funcs.get_next_func(0)
        idx = 0
        while pfn:
            if idx >= offset and len(funcs) < limit:
                ea = pfn.start_ea
                name = ida_name.get_name(ea) or f"sub_{ea:x}"
                funcs.append({
                    "addr": ea,
                    "name": name,
                    "size": pfn.size(),
                    "returns": not bool(pfn.flags & ida_funcs.FUNC_NORET)
                })
            idx += 1
            pfn = ida_funcs.get_next_func(pfn.start_ea)
        return {"functions": funcs, "total": idx}
        
    elif method == "function_at":
        addr = params.get("addr", 0)
        pfn = ida_funcs.get_func(addr)
        if not pfn:
            return None
        return {
            "addr": pfn.start_ea,
            "name": ida_name.get_name(pfn.start_ea) or f"sub_{pfn.start_ea:x}",
            "size": pfn.size(),
            "returns": not bool(pfn.flags & ida_funcs.FUNC_NORET)
        }

    elif method == "disasm":
        addr = params.get("addr", 0)
        pfn = ida_funcs.get_func(addr)
        ops = []
        if pfn:
            name = ida_name.get_name(pfn.start_ea) or f"sub_{pfn.start_ea:x}"
            size = pfn.size()
            start_ea = pfn.start_ea
            for head in idautils.FuncItems(start_ea):
                disasm_line = idc.GetDisasm(head)
                sz = ida_bytes.get_item_size(head)
                raw = ida_bytes.get_bytes(head, sz)
                hex_bytes = raw.hex() if raw else ""
                ops.append({
                    "addr": head,
                    "disasm": disasm_line,
                    "bytes": hex_bytes,
                    "len": sz
                })
        else:
            name = ida_name.get_name(addr) or f"sub_{addr:x}"
            start_ea = addr
            curr = addr
            for _ in range(64):
                if not ida_bytes.is_code(ida_bytes.get_flags(curr)):
                    break
                disasm_line = idc.GetDisasm(curr)
                sz = ida_bytes.get_item_size(curr) or 1
                raw = ida_bytes.get_bytes(curr, sz)
                hex_bytes = raw.hex() if raw else ""
                ops.append({
                    "addr": curr,
                    "disasm": disasm_line,
                    "bytes": hex_bytes,
                    "len": sz
                })
                curr = idc.next_head(curr)
            size = curr - addr if curr > addr else 0

        return {
            "addr": start_ea,
            "name": name,
            "size": size,
            "ops": ops
        }

    elif method == "graph":
        addr = params.get("addr", 0)
        pfn = ida_funcs.get_func(addr)
        if not pfn:
            return {"addr": addr, "name": f"sub_{addr:x}", "blocks": []}
        name = ida_name.get_name(pfn.start_ea) or f"sub_{pfn.start_ea:x}"
        fc = ida_gdl.FlowChart(pfn)
        blocks = []
        for bb in fc:
            curr = bb.start_ea
            bb_ops = []
            while curr < bb.end_ea:
                dis = idc.GetDisasm(curr)
                sz = ida_bytes.get_item_size(curr) or 1
                raw = ida_bytes.get_bytes(curr, sz)
                bb_ops.append({
                    "addr": curr,
                    "disasm": dis,
                    "bytes": raw.hex() if raw else "",
                    "len": sz
                })
                nxt = idc.next_head(curr, bb.end_ea)
                if nxt <= curr:
                    break
                curr = nxt
            succs = [s.start_ea for s in bb.succs()]
            jump = succs[0] if len(succs) > 0 else None
            fail = succs[1] if len(succs) > 1 else None
            targets = succs if len(succs) > 2 else []
            blocks.append({
                "addr": bb.start_ea,
                "ninstr": len(bb_ops),
                "jump": jump,
                "fail": fail,
                "targets": targets,
                "ops": bb_ops
            })
        return {
            "addr": pfn.start_ea,
            "name": name,
            "blocks": blocks
        }

    elif method == "xrefs":
        addr = params.get("addr", 0)
        direction = params.get("direction", "to")
        limit = params.get("limit", 200)
        xrefs = []
        if direction == "to":
            for xr in idautils.XrefsTo(addr):
                if len(xrefs) >= limit:
                    break
                fcn_name = ida_name.get_name(xr.frm) or ""
                xrefs.append({
                    "from": xr.frm,
                    "to": xr.to,
                    "type": "code" if xr.iscode else "data",
                    "fcn_name": fcn_name,
                    "opcode": idc.GetDisasm(xr.frm)
                })
        else:
            for xr in idautils.XrefsFrom(addr):
                if len(xrefs) >= limit:
                    break
                fcn_name = ida_name.get_name(xr.to) or ""
                xrefs.append({
                    "from": xr.frm,
                    "to": xr.to,
                    "type": "code" if xr.iscode else "data",
                    "fcn_name": fcn_name,
                    "opcode": idc.GetDisasm(xr.frm)
                })
        return {"xrefs": xrefs}

    elif method == "read_bytes":
        addr = params.get("addr", 0)
        length = params.get("len", 0)
        if length > 16 * 1024 * 1024:
            return {"error": "read exceeds the 16 MiB safety limit"}
        raw = ida_bytes.get_bytes(addr, length, 0)
        if raw is None:
            res_bytes = bytearray()
            for i in range(length):
                b = ida_bytes.get_byte(addr + i)
                if b is None or b < 0:
                    break
                res_bytes.append(b)
            raw = bytes(res_bytes)
        return {"bytes": raw.hex() if raw else ""}

    elif method == "imports":
        limit = params.get("limit", 5000)
        imports = []
        qty = ida_nalt.get_import_module_qty()
        for i in range(qty):
            mod_name = ida_nalt.get_import_module_name(i) or ""
            def cb(ea, name, ord):
                if len(imports) >= limit:
                    return 0
                imports.append({
                    "name": name or f"ord_{ord}",
                    "plt": ea if ea != ida_idaapi.BADADDR else None,
                    "bind": mod_name,
                    "kind": "FUNC"
                })
                return 1
            ida_nalt.enum_import_names(i, cb)
            if len(imports) >= limit:
                break
        return {"imports": imports, "total": len(imports)}
        
    elif method == "decompile":
        addr = params.get("addr", 0)
        if not ida_hexrays.init_hexrays_plugin():
            return {"error": "Hex-Rays decompiler plugin is not available"}
        try:
            cfunc = ida_hexrays.decompile(addr)
            if not cfunc:
                return {"error": f"Hex-Rays could not decompile function at {hex(addr)}"}
            return {
                "addr": addr,
                "name": ida_name.get_name(addr) or f"sub_{addr:x}",
                "code": str(cfunc),
                "annotations": []
            }
        except Exception as e:
            return {"error": f"Hex-Rays exception: {e}"}
            
    elif method == "rename":
        addr = params.get("addr", 0)
        name = params.get("name", "")
        success = bool(ida_name.set_name(addr, name, ida_name.SN_NOWARN))
        return {"success": success}

    elif method == "strings":
        limit = params.get("limit", 10000)
        strs = []
        try:
            s_list = idautils.Strings(default_setup=True)
            try:
                s_list.setup(strtypes=[ida_nalt.STRTYPE_C, ida_nalt.STRTYPE_C_16, ida_nalt.STRTYPE_LEN2], minlen=3, only_7bit=False)
            except Exception:
                pass
            total = getattr(s_list, "size", 0) or ida_strlist.get_strlist_qty()
            for s in s_list:
                if len(strs) >= limit:
                    break
                try:
                    strbytes = ida_bytes.get_strlit_contents(s.ea, s.length, s.strtype)
                    val = strbytes.decode("utf-8", errors="replace") if strbytes else str(s)
                    strs.append({
                        "addr": s.ea,
                        "value": val,
                        "length": getattr(s, "length", len(val))
                    })
                except Exception:
                    continue
            return {"strings": strs, "total": total}
        except Exception as e:
            return {"strings": [], "total": 0, "error": str(e)}

    elif method == "resolve":
        name = params.get("name", "")
        ea = ida_name.get_name_ea(ida_idaapi.BADADDR, name)
        if ea != ida_idaapi.BADADDR:
            return {"addr": ea}
        return {"addr": None}

    elif method == "write_byte":
        addr = params.get("addr", 0)
        value = params.get("value", 0)
        if not isinstance(value, int) or not 0 <= value <= 255:
            return {"error": "write_byte value must be an integer byte"}
        return {"success": bool(ida_bytes.patch_byte(addr, value))}

    elif method == "raw":
        return {"error": "raw Python execution is disabled"}

    elif method == "quit":
        return {"quit": True}
        
    else:
        return {"error": f"Unknown method: {method}"}

def main():
    try:
        # Determine port from environment or fallback
        port_env = os.environ.get("RECURSE_IDA_PORT")
        if port_env and port_env.isdigit():
            port = int(port_env)
        else:
            port = 9876
            
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.connect(("127.0.0.1", port))
        
        # Notify connected
        s.sendall(json.dumps({"event": "connected"}).encode("utf-8") + b"\n")
        
        # Wait for auto-analysis
        ida_auto.auto_wait()
        ida_hexrays.init_hexrays_plugin()
        
        # Send ready
        s.sendall(json.dumps({"event": "ready"}).encode("utf-8") + b"\n")
        
        buf = b""
        while True:
            data = s.recv(4096)
            if not data:
                break
            buf += data
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                if not line.strip():
                    continue
                try:
                    req = json.loads(line.decode("utf-8"))
                    req_id = req.get("id")
                    res = handle_request(req)
                    resp = {"id": req_id, "result": res}
                    if res and res.get("quit"):
                        s.sendall(json.dumps(resp).encode("utf-8") + b"\n")
                        s.close()
                        ida_pro.qexit(0)
                        return
                except Exception as e:
                    resp = {"id": req.get("id"), "error": str(e), "trace": traceback.format_exc()}
                
                s.sendall(json.dumps(resp).encode("utf-8") + b"\n")
                
        s.close()
        ida_pro.qexit(0)
    except Exception as e:
        try:
            err_file = os.path.join(os.environ.get("TEMP", "/tmp"), "ida_bridge_error.log")
            with open(err_file, "w") as f:
                f.write(traceback.format_exc())
        except Exception:
            pass
        ida_pro.qexit(1)

if __name__ == "__main__":
    main()
