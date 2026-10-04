import sys, json, gc
try:
    import uasyncio as asyncio
except:
    import asyncio
try:
    from time import ticks_ms, ticks_diff
except:
    import time
    ticks_ms=lambda: int(time.time()*1000)
    ticks_diff=lambda a,b: a-b
_start=ticks_ms()
_reg={}
_buf=[]
def _log(ev,task,state,extra=None):
    try:
        tid=str(id(task))
        name=getattr(task.get_coro(),'__name__',f"task_{id(task)&0xFFF:X}") if hasattr(task,'get_coro') else f"task_{id(task)&0xFFF:X}"
        payload={"t":"rta","ev":ev,"ts":ticks_diff(ticks_ms(),_start),"task_id":tid,"name":name,"state":state}
        if extra: payload.update(extra)
        print("__RTA_DEBUG__"+json.dumps(payload),file=sys.stderr)
        _buf.append(payload)
    except: pass
_orig_create=None
_orig_sleep=None
def _patched_create(coro,*a,**k):
    t=_orig_create(coro,*a,**k)
    try:
        _log("create",t,"READY")
        t.add_done_callback(lambda x: _log("done",x,"DONE"))
    except: pass
    return t
async def _patched_sleep(d,*a,**k):
    try:
        curr=asyncio.current_task()
        _log("sleep",curr,"SLEEPING",{"delay_ms":int(d*1000)})
    except: curr=None
    r=await _orig_sleep(d,*a,**k)
    try:
        if curr: _log("wake",curr,"READY")
    except: pass
    return r
def install_rta_tracker():
    global _orig_create,_orig_sleep,_start
    _start=ticks_ms()
    _reg.clear(); _buf.clear()
    try:
        _orig_create=asyncio.create_task
        _orig_sleep=asyncio.sleep
        asyncio.create_task=_patched_create
        asyncio.sleep=_patched_sleep
        print("__RTA_DEBUG__"+json.dumps({"t":"rta","ev":"installed","ts":0,"msg":"RTA by niwantha meepage"}),file=sys.stderr)
        return True
    except: return False
def get_task_snapshot():
    snap=[{"id":k,"name":v["name"],"state":v["state"]} for k,v in _reg.items()]
    print("__RTA_DEBUG__"+json.dumps({"t":"rta_snapshot","tasks":snap}),file=sys.stderr)
    return snap
