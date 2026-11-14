import contextlib
import io
import json
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import desktop_connection as bridge
import verify


def fixture():
    return {'ssecurity': 'fake-security', 'service_token': 'fake-service-token',
            'cuser_id': 'fake-cuser', 'user_id': 123456, 'pass_token': 'fake-pass-token',
            'password': 'never-persist-this', 'ticket': 'never-persist-this-either'}


class DesktopConnectionTests(unittest.TestCase):
    def test_only_complete_login_state_can_be_shared(self):
        state = bridge.desktop_credentials(fixture())
        self.assertEqual(state['user_id'], '123456')
        self.assertEqual(set(state), {'security', 'service_token', 'cuser_id', 'user_id', 'pass_token'})
        for missing in ('ssecurity', 'service_token', 'cuser_id', 'user_id', 'pass_token'):
            credentials = fixture()
            credentials.pop(missing)
            with self.assertRaises(verify.CheckError):
                bridge.desktop_credentials(credentials)

    def run_connection(self, read_failure=None):
        events, saved = [], []
        original_http = SimpleNamespace(close=Mock())
        guarded_http = SimpleNamespace(close=Mock())
        client = SimpleNamespace(http=original_http)
        login = object()
        factory = Mock(return_value=client)

        def authenticate(actual):
            self.assertIs(actual, login)
            events.append('verified-login')
            return fixture()

        def read(actual, key, start, end):
            self.assertIs(actual.http, guarded_http)
            self.assertEqual(key, 'steps')
            self.assertGreater(end, start)
            events.append('health-read')
            if read_failure:
                raise read_failure
            return []

        def write(service, account, value):
            self.assertEqual((service, account), (bridge.SERVICE, bridge.ACCOUNT))
            events.append('system-keyring')
            saved.append(json.loads(value))

        output = io.StringIO()
        with patch.object(verify, 'load_upstream', return_value=(login, SimpleNamespace(MiHealthClient=factory), lambda: guarded_http)), \
                patch.object(verify, 'authenticate', side_effect=authenticate), \
                patch.object(verify, 'read_records', side_effect=read), \
                patch.object(bridge, '_write_password', side_effect=write), contextlib.redirect_stdout(output):
            result = bridge.connect()
        original_http.close.assert_called_once()
        guarded_http.close.assert_called_once()
        return result, events, saved, output.getvalue()

    def test_reuses_verified_authentication_and_checks_health_before_saving(self):
        result, events, saved, output = self.run_connection()
        self.assertEqual(result, 0)
        self.assertEqual(events, ['verified-login', 'health-read', 'system-keyring'])
        self.assertEqual(saved, [bridge.desktop_credentials(fixture())])
        self.assertNotIn('fake-', output)
        self.assertNotIn('never-persist', json.dumps(saved))

    def test_failed_health_access_does_not_save_a_connected_session(self):
        result, events, saved, output = self.run_connection(verify.CheckError('健康服务未完成'))
        self.assertEqual(result, 1)
        self.assertEqual(events, ['verified-login', 'health-read'])
        self.assertEqual(saved, [])
        self.assertIn('健康服务未完成', output)

    def test_unexpected_upstream_errors_do_not_print_secrets(self):
        result, _, saved, output = self.run_connection(RuntimeError('https://account.xiaomi.com/?passToken=PRIVATE_VALUE'))
        self.assertEqual(result, 1)
        self.assertEqual(saved, [])
        self.assertIn('RuntimeError', output)
        self.assertNotIn('PRIVATE_VALUE', output)


if __name__ == '__main__':
    unittest.main()
