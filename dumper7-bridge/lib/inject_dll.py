"""Minimal LoadLibrary injector (x64) for Dumper-7.dll.

Usage: inject_dll.py <pid> <dll-path>
Prints one JSON object to stdout: {"ok":bool,"pid":int,"dll":str,"threadExit":int,"error":str|null}
Exit code is 0 only when the remote thread reported a non-zero module handle.
"""
import ctypes
import json
import sys
from ctypes import wintypes

k32 = ctypes.WinDLL("kernel32", use_last_error=True)

k32.OpenProcess.restype = wintypes.HANDLE
k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
k32.VirtualAllocEx.restype = ctypes.c_void_p
k32.VirtualAllocEx.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.c_size_t, wintypes.DWORD, wintypes.DWORD]
k32.WriteProcessMemory.restype = wintypes.BOOL
k32.WriteProcessMemory.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t, ctypes.POINTER(ctypes.c_size_t)]
k32.GetModuleHandleW.restype = ctypes.c_void_p
k32.GetModuleHandleW.argtypes = [wintypes.LPCWSTR]
k32.GetProcAddress.restype = ctypes.c_void_p
k32.GetProcAddress.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
k32.CreateRemoteThread.restype = wintypes.HANDLE
k32.CreateRemoteThread.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p,
                                   ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD)]
k32.WaitForSingleObject.restype = wintypes.DWORD
k32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
k32.GetExitCodeThread.restype = wintypes.BOOL
k32.GetExitCodeThread.argtypes = [wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD)]
k32.VirtualFreeEx.restype = wintypes.BOOL
k32.VirtualFreeEx.argtypes = [wintypes.HANDLE, ctypes.c_void_p, ctypes.c_size_t, wintypes.DWORD]
k32.CloseHandle.restype = wintypes.BOOL
k32.CloseHandle.argtypes = [wintypes.HANDLE]

PROCESS_ALL_ACCESS = 0x1F0FFF
MEM_COMMIT_RESERVE = 0x3000
PAGE_READWRITE = 0x04
INFINITE = 0xFFFFFFFF


def main() -> int:
    result = {"ok": False, "pid": None, "dll": None, "threadExit": 0, "error": None}
    try:
        pid = int(sys.argv[1])
        dll = sys.argv[2]
        result["pid"] = pid
        result["dll"] = dll

        buf = (dll + "\x00").encode("utf-16-le")
        size = len(buf)

        h = k32.OpenProcess(PROCESS_ALL_ACCESS, False, pid)
        if not h:
            result["error"] = "OpenProcess failed: %d" % ctypes.get_last_error()
            return 1
        try:
            addr = k32.VirtualAllocEx(h, None, size, MEM_COMMIT_RESERVE, PAGE_READWRITE)
            if not addr:
                result["error"] = "VirtualAllocEx failed: %d" % ctypes.get_last_error()
                return 1
            written = ctypes.c_size_t(0)
            if not k32.WriteProcessMemory(h, addr, buf, size, ctypes.byref(written)) or written.value != size:
                result["error"] = "WriteProcessMemory failed: %d" % ctypes.get_last_error()
                return 1
            hmod = k32.GetModuleHandleW("kernel32.dll")
            load_library = k32.GetProcAddress(hmod, b"LoadLibraryW")
            if not load_library:
                result["error"] = "GetProcAddress(LoadLibraryW) failed"
                return 1
            tid = wintypes.DWORD(0)
            thread = k32.CreateRemoteThread(h, None, 0, load_library, addr, 0, ctypes.byref(tid))
            if not thread:
                result["error"] = "CreateRemoteThread failed: %d" % ctypes.get_last_error()
                return 1
            try:
                k32.WaitForSingleObject(thread, 30000)
                code = wintypes.DWORD(0)
                k32.GetExitCodeThread(thread, ctypes.byref(code))
                result["threadExit"] = int(code.value)
                if code.value == 0:
                    result["error"] = "LoadLibraryW returned NULL in the target (wrong bitness or blocked DLL?)"
                    return 1
                result["ok"] = True
                return 0
            finally:
                k32.CloseHandle(thread)
                k32.VirtualFreeEx(h, addr, 0, 0x8000)
        finally:
            k32.CloseHandle(h)
    except Exception as exc:  # noqa: BLE001 - report everything to the caller
        result["error"] = "%s: %s" % (type(exc).__name__, exc)
        return 1
    finally:
        print(json.dumps(result))


if __name__ == "__main__":
    sys.exit(main())
