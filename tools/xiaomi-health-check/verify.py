"""Read-only, memory-only Xiaomi login and seven-day local comparison report."""
from __future__ import annotations

import argparse
import getpass
import hashlib
import html
import importlib
import json
import math
import os
from pathlib import Path
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from urllib.parse import urljoin, urlparse

ROOT = Path(__file__).resolve().parent
LOCAL = ROOT / '.local'
TZ = timezone(timedelta(hours=8))
ALLOWED_HOSTS = {'account.xiaomi.com', 'sts-hlth.io.mi.com', 'hlth.io.mi.com'}


class CheckError(Exception):
    """Only explicitly safe messages may be displayed to the user."""


def check_url(url):
    parsed = urlparse(url)
    if (parsed.scheme != 'https' or parsed.hostname not in ALLOWED_HOSTS
            or parsed.username or parsed.password or parsed.port not in (None, 443)):
        raise CheckError('请求地址不在本次小米验证范围内，已停止。')


def load_upstream():
    manifest = json.loads((ROOT / 'upstream.json').read_text(encoding='utf-8'))
    for name, digest in manifest['files'].items():
        path = LOCAL / 'vendor' / name
        if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != digest:
            raise CheckError('验证工具文件缺失或校验不符，请让 Codex 重新准备。')
    sys.path[:0] = [str(LOCAL / 'vendor'), str(LOCAL / 'runtime')]
    requests = importlib.import_module('requests')

    class XiaomiSession(requests.Session):
        def send(self, request, **kwargs):
            check_url(request.url)
            if kwargs.get('verify') is False:
                raise CheckError('证书校验必须开启。')
            return super().send(request, **kwargs)

    login = importlib.import_module('login')
    # Do not invoke upstream's command-line entry point or save_session().
    login.requests = SimpleNamespace(Session=XiaomiSession,
                                    RequestException=requests.RequestException)
    client_module = importlib.import_module('mihealth_client')
    return login, client_module, XiaomiSession


def authenticate(login):
    if not sys.stdin.isatty():
        raise CheckError('请双击 run.cmd，在本机交互窗口输入账号。')
    username = input('小米账号（手机号、邮箱或 ID）：').strip()
    password = getpass.getpass('小米账号密码（输入时不显示）：')
    if not username or not password:
        raise CheckError('账号和密码不能为空。')
    session = login.new_login_session()
    captcha = None
    try:
        for attempt in range(3):
            try:
                return login.login_with_password(username, password,
                                                 session=session, captcha=captcha)
            except login.Need2FA as challenge:
                context = login.start_2fa(session, challenge.notification_url)
                channel = '邮箱' if context['method'] == 'Email' else '短信'
                print(f'小米要求验证，请查看{channel}。')
                code = getpass.getpass('验证码（仅在本机输入）：')
                return login.finish_2fa(session, code, context['context'],
                                        flag=context['flag'])
            except login.LoginError as error:
                if error.captcha_url and attempt < 2:
                    url = urljoin(login.ACCOUNT_HOST, error.captcha_url)
                    check_url(url)
                    response = session.get(url, timeout=25)
                    response.raise_for_status()
                    if len(response.content) > 2_000_000:
                        raise CheckError('验证码图片异常，已停止。')
                    LOCAL.mkdir(parents=True, exist_ok=True)
                    with tempfile.TemporaryDirectory(prefix='captcha-', dir=LOCAL.resolve()) as folder:
                        image = Path(folder) / 'captcha.jpg'
                        image.write_bytes(response.content)
                        os.startfile(str(image))
                        captcha = input('已打开验证码图片，请输入图中字符：').strip()
                    continue
                code = error.code if isinstance(error.code, int) else '未提供'
                raise CheckError(f'小米账号登录未完成（错误码 {code}）。请核对账号或稍后重试。') from None
        raise CheckError('验证码尝试次数已用完，请稍后重新打开。')
    finally:
        password = None
        session.close()


def timestamp(value):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise CheckError('接口返回了无法识别的时间字段，需检查格式。')
    if not math.isfinite(value) or not 946684800 <= value <= 4102444800:
        raise CheckError('接口时间超出预期范围，需检查秒/毫秒单位。')
    return float(value)


def number(value):
    return (isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value) and value >= 0)


def payload(record):
    value = record.get('value')
    if isinstance(value, str):
        try:
            value = json.loads(value)
        except (ValueError, TypeError):
            raise CheckError('健康数据内容格式尚未识别，需检查接口字段。') from None
    if not isinstance(value, dict):
        raise CheckError('健康数据内容格式尚未识别，需检查接口字段。')
    return value


def read_records(client, key, start, end):
    records, cursor, seen = [], None, set()
    for page in range(60):
        response = client.get_fitness_data_by_time(
            key, max(start, end - 86_400_000), end, next_key=cursor)
        if not isinstance(response, dict) or response.get('code') != 0:
            code = response.get('code') if isinstance(response, dict) else None
            safe_code = code if isinstance(code, int) else '未提供'
            raise CheckError(f'{key} 查询未成功（错误码 {safe_code}）。')
        result = response.get('result')
        if not isinstance(result, dict) or not isinstance(result.get('data_list'), list):
            raise CheckError(f'{key} 响应格式尚未识别，不能当作没有数据。')
        batch = result['data_list']
        if not all(isinstance(row, dict) for row in batch):
            raise CheckError(f'{key} 记录格式尚未识别。')
        for row in batch:
            stamp = timestamp(row.get('time')) * 1000
            if start <= stamp < end:
                records.append(row)
        if not result.get('has_more'):
            return records
        if batch and max(timestamp(row.get('time')) * 1000 for row in batch) < start:
            return records
        cursor = result.get('next_key')
        if not isinstance(cursor, str) or not cursor or cursor in seen:
            raise CheckError(f'{key} 分页没有前进，结果不完整，已停止。')
        seen.add(cursor)
        print(f'  {key}：已读取 {page + 1} 页…', flush=True)
    raise CheckError(f'{key} 超过本次分页上限，结果尚不完整。')


def normalize(step_records, sleep_records, dates):
    # Keep sources separate until a real phone comparison establishes precedence.
    unique_steps = {}
    for row in step_records:
        stamp = timestamp(row.get('time'))
        value = payload(row).get('steps')
        if not number(value) or int(value) != value:
            raise CheckError('步数字段缺失或无效，不能替换成 0。')
        key = (str(row.get('sid') or '未提供来源'), stamp)
        candidate = (row.get('update_time') or 0, value)
        if key not in unique_steps or candidate > unique_steps[key]:
            unique_steps[key] = candidate
    steps = {}
    for (source, stamp), (_, value) in unique_steps.items():
        date = datetime.fromtimestamp(stamp, TZ).date().isoformat()
        if date in dates:
            steps[(date, source)] = steps.get((date, source), 0) + int(value)
    sleeps = {}
    for row in sleep_records:
        value = payload(row)
        begin = timestamp(value.get('bedtime'))
        end = timestamp(value.get('device_wake_up_time'))
        if not 0 < end - begin <= 172800:
            raise CheckError('睡眠起止时间异常，需检查原始字段。')
        duration = value.get('duration')
        interval = (end - begin) / 60
        # Confirmed against this phone's real records: duration is in minutes.
        if duration is not None and (not number(duration) or duration > interval + 1):
            raise CheckError('睡眠时长与起止时间不符，需检查时长单位。')
        date = datetime.fromtimestamp(end, TZ).date().isoformat()
        if date not in dates:
            continue
        source = str(row.get('sid') or '未提供来源')
        item = {
            'date': date, 'source': source,
            'start': datetime.fromtimestamp(begin, TZ).isoformat(timespec='minutes'),
            'end': datetime.fromtimestamp(end, TZ).isoformat(timespec='minutes'),
            'intervalMinutes': round(interval, 1),
            'reportedDurationMinutes': duration,
        }
        identity = (source, begin, end)
        revision = row.get('update_time') or 0
        if identity not in sleeps or revision >= sleeps[identity][0]:
            sleeps[identity] = (revision, item)
    return {
        'timezone': 'Asia/Shanghai', 'dates': dates,
        'steps': [{'date': day, 'source': source, 'steps': count}
                  for (day, source), count in sorted(steps.items())],
        'sleep': sorted([item for _, item in sleeps.values()], key=lambda x: (x['end'], x['source'])),
    }


def report_html(summary):
    esc = lambda value: html.escape(str(value))
    step_rows = ''.join(f'<tr><td>{esc(x["date"])}</td><td>{esc(x["source"])}</td><td>{x["steps"]}</td></tr>'
                        for x in summary['steps'])
    sleep_rows = ''.join(f'<tr><td>{esc(x["date"])}</td><td>{esc(x["source"])}</td><td>{esc(x["start"])}</td>'
                         f'<td>{esc(x["end"])}</td><td>{x["intervalMinutes"]}</td>'
                         f'<td>{esc(x["reportedDurationMinutes"]) if x["reportedDurationMinutes"] is not None else "未提供"}</td></tr>'
                         for x in summary['sleep'])
    empty = '<tr><td colspan="6">接口未返回该时间段内的记录；尚未确认原因。</td></tr>'
    return ('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>小米健康七天核对</title>'
            '<style>body{font:16px/1.6 "Microsoft YaHei",sans-serif;margin:36px;color:#243129;max-width:1200px}'
            'table{border-collapse:collapse;width:100%;margin-bottom:28px}td,th{border:1px solid #ccd5ce;padding:9px;text-align:left}'
            'th{background:#edf4ee}p{max-width:900px}</style><h1>小米健康七天核对</h1>'
            f'<p>{esc(summary["dates"][0])} 至 {esc(summary["dates"][-1])}，北京时间，已排除今天未结束的数据。</p>'
            '<p>请与小米运动健康逐日对照。多个来源分开显示，请先确认对应关系。缺少记录不代表 0 步。</p>'
            '<h2>步数</h2><table><tr><th>日期</th><th>来源</th><th>步数</th></tr>' + (step_rows or empty) + '</table>'
            '<h2>睡眠</h2><p>按起床日期归档，保留每段睡眠。小米报告时长直接读取接口 duration（本次手机数据单位为分钟）；'
            '起止间隔可能包含清醒时间。两列分别保留，未提供的时长不推算。</p>'
            '<table><tr><th>日期</th><th>来源</th><th>入睡</th><th>起床</th><th>起止间隔（分钟）</th><th>小米报告时长（分钟）</th></tr>'
            + (sleep_rows or empty) + '</table><p>结果仅保存在本机，尚未写入工作台或同步服务器。</p></html>')


def save_raw(raw):
    folder = LOCAL / 'results' / datetime.now(TZ).strftime('%Y%m%d-%H%M%S-%f')
    folder.mkdir(parents=True, exist_ok=False)
    (folder / 'raw.json').write_text(json.dumps(raw, ensure_ascii=False, indent=2), encoding='utf-8')
    return folder


def save_report(summary, folder):
    (folder / 'summary.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding='utf-8')
    report = folder / 'report.html'
    report.write_text(report_html(summary), encoding='utf-8')
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--check', action='store_true', help='检查本机环境，不联网、不登录')
    args = parser.parse_args()
    stage = '环境检查'
    try:
        login, module, session_type = load_upstream()
        if args.check:
            print('本机工具和文件校验通过；尚未登录或读取健康数据。')
            return 0
        print('小米健康七天读取验证\n仅连接小米服务；密码、验证码和登录凭据不写入文件。\n')
        print('请先在手机打开小米运动健康，确认登录账号一致，并完成云同步。\n')
        stage = '账号登录'
        credentials = authenticate(login)
        required = ('ssecurity', 'service_token', 'cuser_id')
        if not all(credentials.get(key) for key in required):
            raise CheckError('小米没有返回完整健康服务凭据，暂不能读取。')
        client = module.MiHealthClient(**{key: credentials[key] for key in required},
                                       min_interval=0.6, max_retries=1)
        client.http.close()
        client.http = session_type()
        credentials.clear()
        end = datetime.now(TZ).replace(hour=0, minute=0, second=0, microsecond=0)
        start = end - timedelta(days=7)
        dates = [(start + timedelta(days=i)).date().isoformat() for i in range(7)]
        raw = {}
        try:
            for key in ('steps', 'sleep'):
                stage = f'{key} 数据读取'
                # One extra sleep day covers a night beginning before the window.
                begin = start - timedelta(days=1) if key == 'sleep' else start
                print(f'正在读取 {key}…', flush=True)
                raw[key] = read_records(client, key, int(begin.timestamp() * 1000), int(end.timestamp() * 1000))
        finally:
            client.http.close()
        stage = '数据整理'
        folder = save_raw(raw)
        print(f'原始健康数据已保存在本机：{folder / "raw.json"}')
        summary = normalize(raw['steps'], raw['sleep'], dates)
        report = save_report(summary, folder)
        print(f'本机报告已生成：{report}\n请对照手机核对七天步数及睡眠起止时间。')
        if not summary['steps'] or not summary['sleep']:
            print('部分类型没有返回记录，请先确认手机云同步；目前不能判断这些数据可自动同步。')
        os.startfile(str(report))
        return 0
    except CheckError as error:
        print(f'验证未完成：{error}')
    except (KeyboardInterrupt, EOFError):
        print('\n已结束本次验证。')
    except Exception as error:
        # Never print upstream exceptions: their URLs or bodies can include secrets.
        print(f'{stage}未完成（{type(error).__name__}）。请只反馈这一行，不要发送密码或验证码。')
    return 1


if __name__ == '__main__':
    raise SystemExit(main())
