"""Reuse the verified login flow and hand its result to the desktop keyring."""
from __future__ import annotations

import ctypes
from ctypes import wintypes
import json
import os
import sys
from datetime import datetime, timedelta

import verify

SERVICE = 'com.muyuxiaoluo.life-strategy-library'
ACCOUNT = 'xiaomi_health_session'


def desktop_credentials(credentials):
    result = {
        'security': credentials.get('ssecurity'),
        'service_token': credentials.get('service_token'),
        'cuser_id': credentials.get('cuser_id'),
        'user_id': str(credentials.get('user_id') or ''),
        'pass_token': credentials.get('pass_token'),
    }
    if not all(isinstance(value, str) and value and value not in ('null', 'undefined')
               for value in result.values()):
        raise verify.CheckError('小米未返回完整的应用登录状态，本次没有保存，请保留此窗口并反馈这行提示。')
    return result


def _write_password(service, account, value):
    """Match keyring 3's Windows target and UTF-16LE blob exactly."""
    if os.name != 'nt':
        raise verify.CheckError('此连接工具仅支持 Windows。')

    class Credential(ctypes.Structure):
        _fields_ = [
            ('Flags', wintypes.DWORD), ('Type', wintypes.DWORD),
            ('TargetName', wintypes.LPWSTR), ('Comment', wintypes.LPWSTR),
            ('LastWritten', wintypes.FILETIME), ('CredentialBlobSize', wintypes.DWORD),
            ('CredentialBlob', ctypes.POINTER(ctypes.c_ubyte)), ('Persist', wintypes.DWORD),
            ('AttributeCount', wintypes.DWORD), ('Attributes', ctypes.c_void_p),
            ('TargetAlias', wintypes.LPWSTR), ('UserName', wintypes.LPWSTR),
        ]

    encoded = bytearray(value, 'utf-16-le')
    if len(encoded) > 2560:
        raise verify.CheckError('登录状态超出 Windows 凭据保存上限，本次没有保存。')
    blob = (ctypes.c_ubyte * len(encoded)).from_buffer(encoded)
    credential = Credential()
    credential.Type = 1  # CRED_TYPE_GENERIC
    credential.TargetName = f'{account}.{service}'
    credential.UserName = account
    credential.Comment = 'Xiaomi health desktop connection'
    credential.Persist = 3  # CRED_PERSIST_ENTERPRISE, same as keyring 3
    credential.CredentialBlobSize = len(encoded)
    credential.CredentialBlob = blob
    api = ctypes.WinDLL('Advapi32.dll', use_last_error=True)
    api.CredWriteW.argtypes = (ctypes.POINTER(Credential), wintypes.DWORD)
    api.CredWriteW.restype = wintypes.BOOL
    try:
        if not api.CredWriteW(ctypes.byref(credential), 0):
            raise verify.CheckError('无法将登录状态交给 Windows 凭据管理器，请保持以当前用户运行。')
    finally:
        ctypes.memset(blob, 0, len(encoded))


def connect():
    print('连接小米运动健康\n使用已经验证的终端登录流程。\n'
          '密码和验证码仅用于本次登录；成功后将登录状态保存到 Windows 凭据管理器，供工作台自动同步。\n', flush=True)
    credentials = {}
    client = None
    stage = '环境检查'
    try:
        login, module, session_type = verify.load_upstream()
        stage = '账号验证'
        credentials = verify.authenticate(login)
        result = desktop_credentials(credentials)
        client = module.MiHealthClient(ssecurity=result['security'],
                                      service_token=result['service_token'],
                                      cuser_id=result['cuser_id'], min_interval=0.6, max_retries=1)
        client.http.close()
        client.http = session_type()
        end = datetime.now(verify.TZ)
        start = end - timedelta(days=1)
        print('正在确认健康服务可读取…', flush=True)
        stage = '健康服务读取'
        verify.read_records(client, 'steps', int(start.timestamp() * 1000), int(end.timestamp() * 1000))
        stage = '保存登录状态'
        _write_password(SERVICE, ACCOUNT, json.dumps(result, ensure_ascii=False, separators=(',', ':')))
        print('已连接并安全交给工作台。请返回健康页，应用会自动开始首次同步。此窗口可以关闭。', flush=True)
        return 0
    except verify.CheckError as error:
        print(f'连接未完成：{error}', flush=True)
    except (KeyboardInterrupt, EOFError):
        print('\n已取消本次连接。', flush=True)
    except Exception as error:
        # Never print upstream exception text, request URLs or response bodies.
        code = getattr(error, 'code', None)
        detail = f'；错误码 {code}' if type(code) is int else ''
        print(f'{stage}未完成（{type(error).__name__}{detail}），请只反馈这一行提示。', flush=True)
    finally:
        credentials.clear()
        if client is not None:
            client.http.close()
    return 1


if __name__ == '__main__':
    if not sys.stdin.isatty():
        print('登录窗口未取得交互输入，请双击工具目录中的 connect-desktop.cmd。')
        raise SystemExit(1)
    raise SystemExit(connect())
