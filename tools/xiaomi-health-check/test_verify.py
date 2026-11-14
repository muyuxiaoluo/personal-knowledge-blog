import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from datetime import datetime

import verify


def stamp(value):
    return int(datetime.fromisoformat(value).timestamp())


def record(source, time, value, revision=1):
    return {'sid': source, 'time': stamp(time), 'value': json.dumps(value), 'update_time': revision}


class HealthVerificationTests(unittest.TestCase):
    def test_steps_keep_sources_separate_and_deduplicate_overlapping_pages(self):
        time = '2026-10-24T12:00:00+08:00'
        records = [record('phone', time, {'steps': 12}), record('phone', time, {'steps': 12}),
                   record('phone', time, {'steps': 15}, 2), record('app', time, {'steps': 9})]
        result = verify.normalize(records, [], ['2026-10-24'])
        self.assertEqual({x['source']: x['steps'] for x in result['steps']}, {'phone': 15, 'app': 9})

    def test_missing_days_are_not_invented_as_zero(self):
        result = verify.normalize([], [], ['2026-10-24', '2026-10-25'])
        self.assertEqual(result['steps'], [])
        zero = record('phone', '2026-10-24T12:00:00+08:00', {'steps': 0})
        self.assertEqual(verify.normalize([zero], [], ['2026-10-24'])['steps'][0]['steps'], 0)
        with self.assertRaises(verify.CheckError):
            verify.normalize([record('phone', '2026-10-24T12:00:00+08:00', {})], [], ['2026-10-24'])

    def test_cross_midnight_sleep_belongs_to_wake_day_without_claiming_actual_duration(self):
        sleep = record('phone', '2026-10-23T23:00:00+08:00', {
            'bedtime': stamp('2026-10-23T23:00:00+08:00'),
            'device_wake_up_time': stamp('2026-10-24T07:30:00+08:00')})
        rows = verify.normalize([], [sleep, sleep], ['2026-10-24'])['sleep']
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['date'], '2026-10-24')
        self.assertEqual(rows[0]['intervalMinutes'], 510)
        self.assertIsNone(rows[0]['reportedDurationMinutes'])

    def test_reported_sleep_duration_uses_minutes_and_is_not_replaced_by_interval(self):
        sleep = record('phone', '2026-10-24T07:30:00+08:00', {
            'bedtime': stamp('2026-10-23T23:00:00+08:00'),
            'device_wake_up_time': stamp('2026-10-24T07:30:00+08:00'),
            'duration': 450, 'sleep_awake_duration': 60})
        summary = verify.normalize([], [sleep], ['2026-10-24'])
        item = summary['sleep'][0]
        self.assertEqual(item['reportedDurationMinutes'], 450)
        self.assertEqual(item['intervalMinutes'], 510)
        self.assertNotIn('reportedDurationSeconds', item)
        self.assertIn('小米报告时长（分钟）', verify.report_html(summary))
        self.assertIn('<td>450</td>', verify.report_html(summary))
        value = json.loads(sleep['value'])
        value['duration'] = 450 * 60
        sleep['value'] = json.dumps(value)
        with self.assertRaises(verify.CheckError):
            verify.normalize([], [sleep], ['2026-10-24'])

    def test_cloud_errors_and_repeated_cursor_do_not_look_like_empty_success(self):
        class Client:
            def get_fitness_data_by_time(self, *args, **kwargs):
                return {'code': -8, 'message': 'private response'}
        with self.assertRaises(verify.CheckError):
            verify.read_records(Client(), 'sleep', 1, 2)

        class Repeated:
            def get_fitness_data_by_time(self, *args, **kwargs):
                return {'code': 0, 'result': {'data_list': [], 'has_more': True, 'next_key': 'same'}}
        with self.assertRaises(verify.CheckError):
            verify.read_records(Repeated(), 'steps', 1, 2)

    def test_millisecond_payload_time_is_rejected(self):
        with self.assertRaises(verify.CheckError):
            verify.timestamp(1792800000000)

    def test_host_restriction_and_html_escape(self):
        verify.check_url('https://account.xiaomi.com/pass/serviceLogin')
        for url in ('http://hlth.io.mi.com', 'https://hlth.io.mi.com.evil.test/',
                    'https://example.com/', 'https://user:password@hlth.io.mi.com/'):
            with self.assertRaises(verify.CheckError):
                verify.check_url(url)
        summary = {'dates': ['2026-10-24'], 'steps': [
            {'date': '2026-10-24', 'source': '<script>secret</script>', 'steps': 3}], 'sleep': []}
        rendered = verify.report_html(summary)
        self.assertNotIn('<script>secret</script>', rendered)

    def test_unexpected_errors_do_not_print_credential_urls(self):
        output = io.StringIO()
        with patch('sys.argv', ['verify.py']), patch.object(verify, 'load_upstream',
                side_effect=RuntimeError('https://example.test/?token=TOP_SECRET')), contextlib.redirect_stdout(output):
            self.assertEqual(verify.main(), 1)
        self.assertNotIn('TOP_SECRET', output.getvalue())
        self.assertIn('RuntimeError', output.getvalue())

    def test_reports_stay_in_the_local_results_directory(self):
        verify.LOCAL.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=verify.LOCAL.resolve()) as folder, patch.object(verify, 'LOCAL', Path(folder)):
            raw_folder = verify.save_raw({'steps': [], 'sleep': []})
            report = verify.save_report({'dates': ['2026-10-24'], 'steps': [], 'sleep': []}, raw_folder)
            self.assertTrue(report.is_file())
            self.assertEqual(sorted(x.name for x in raw_folder.iterdir()), ['raw.json', 'report.html', 'summary.json'])


if __name__ == '__main__':
    unittest.main()
