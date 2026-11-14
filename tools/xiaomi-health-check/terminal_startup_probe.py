"""Local startup regression fixture; never imports login code or reads input."""
import ctypes
from ctypes import wintypes
import getpass
import json
import msvcrt
from pathlib import Path
import sys


class Coord(ctypes.Structure):
    _fields_ = [('x', ctypes.c_short), ('y', ctypes.c_short)]


kernel = ctypes.WinDLL('kernel32', use_last_error=True)
kernel.GetConsoleMode.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
kernel.GetConsoleMode.restype = wintypes.BOOL
kernel.CreateFileW.argtypes = (wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                              ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE)
kernel.CreateFileW.restype = wintypes.HANDLE
kernel.ReadConsoleOutputCharacterW.argtypes = (wintypes.HANDLE, wintypes.LPWSTR,
                                              wintypes.DWORD, Coord, ctypes.POINTER(wintypes.DWORD))
kernel.ReadConsoleOutputCharacterW.restype = wintypes.BOOL
kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
kernel.CloseHandle.restype = wintypes.BOOL


def console_stream(stream):
    mode = wintypes.DWORD()
    return bool(stream.isatty() and kernel.GetConsoleMode(
        msvcrt.get_osfhandle(stream.fileno()), ctypes.byref(mode)))


result = {name: console_stream(stream) for name, stream in (
    ('stdinReady', sys.stdin), ('stdoutReady', sys.stdout), ('stderrReady', sys.stderr))}
result['hiddenPasswordReader'] = sys.stdin is sys.__stdin__ and getpass.getpass is getpass.win_getpass
print('XIAOMI_LOGIN_STARTUP_PROBE', flush=True)
handle = kernel.CreateFileW('CONOUT$', 0x80000000 | 0x40000000, 3, None, 3, 0, None)
try:
    text = ctypes.create_unicode_buffer(1024)
    count = wintypes.DWORD()
    read = kernel.ReadConsoleOutputCharacterW(handle, text, len(text) - 1, Coord(0, 0), ctypes.byref(count))
    result['promptInOwnWindow'] = bool(read and 'XIAOMI_LOGIN_STARTUP_PROBE' in text.value)
finally:
    if handle not in (None, ctypes.c_void_p(-1).value):
        kernel.CloseHandle(handle)
Path(sys.argv[1]).write_text(json.dumps(result), encoding='utf-8')
