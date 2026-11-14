//! Xiaomi's private health protocol. Adapted from Aaron-gx/mihealth-api (MIT),
//! commit 05edd1308025795e124f8958b20f8408c41b1c82. See licenses/mihealth-api.txt.
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use md5::Md5;
use reqwest::{
    cookie::{CookieStore, Jar},
    header,
    redirect::Policy,
    Client, Method,
};
use serde::Serialize;
use serde_json::Value;
use sha1::Sha1;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use url::Url;

pub const ACCOUNT: &str = "https://account.xiaomi.com";
pub const HEALTH: &str = "https://hlth.io.mi.com";
pub const SID: &str = "miothealth";
pub const AGENT: &str = "XiaomiHealthApi-ABCDE APP/com.xiaomi.mihome APPV/10.5.201";

pub fn allowed_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "小米服务地址无效")?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port_or_known_default() != Some(443)
        || !matches!(
            url.host_str(),
            Some(
                "account.xiaomi.com"
                    | "ak.lp.account.xiaomi.com"
                    | "c3.lp.account.xiaomi.com"
                    | "sts-hlth.io.mi.com"
                    | "hlth.io.mi.com"
            )
        )
    {
        return Err("小米服务返回了范围外的地址，已停止请求".into());
    }
    Ok(url)
}

pub fn json_body(text: &[u8]) -> Result<Value, String> {
    let first = text
        .iter()
        .position(|b| *b == b'{')
        .ok_or("小米服务响应格式尚未识别")?;
    serde_json::from_slice(&text[first..]).map_err(|_| "小米服务响应格式尚未识别".into())
}

pub fn qr_poll_url(address: &str) -> Result<Url, String> {
    let url = allowed_url(address)?;
    if !matches!(
        url.host_str(),
        Some("account.xiaomi.com" | "ak.lp.account.xiaomi.com" | "c3.lp.account.xiaomi.com")
    ) || !matches!(url.path(), "/lp/s" | "/longPolling/login")
    {
        return Err("小米扫码等待地址无效".into());
    }
    Ok(url)
}

pub struct Session {
    client: Client,
    jar: Arc<Jar>,
    identity_device: String,
    pub login_user_hint: Option<String>,
    pub user: String,
    pub login: LoginArtifacts,
    pub trace: Vec<LoginTrace>,
    #[cfg(test)]
    allow_network_in_test: bool,
    #[cfg(test)]
    pub test_transport: Option<
        fn(&mut Session, Method, &str, &[(&str, String)], bool) -> Result<AccountReply, String>,
    >,
}

/// Only fixed step names, numeric statuses and presence flags may be persisted.
/// Never add request/response text, URLs, account identifiers or credential values.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginTrace {
    step: &'static str,
    method: String,
    http_status: u16,
    code: Option<i64>,
    json_response: bool,
    security_in_header: bool,
    security_in_body: bool,
    has_sign: bool,
    has_location: bool,
    has_notification: bool,
    has_captcha: bool,
    has_service_token: bool,
    has_pass_token: bool,
}

/// Login artifacts can arrive on different hops of the verification redirect.
/// They stay in memory; never format this object into errors or diagnostics.
#[derive(Default)]
pub struct LoginArtifacts {
    pub security: String,
    pub health_token: String,
    pub user_id: String,
    pub cuser_id: String,
    pub pass_token: String,
}

pub struct AccountReply {
    pub body: Vec<u8>,
    pub location: Option<String>,
}

impl Session {
    #[cfg(test)]
    pub fn enable_anonymous_probe(&mut self) {
        assert_eq!(std::env::var("XIAOMI_ANONYMOUS_PROBE").as_deref(), Ok("1"));
        self.allow_network_in_test = true;
    }

    pub fn new() -> Result<Self, String> {
        let device = uuid::Uuid::new_v4().simple().to_string()[..16].to_uppercase();
        let jar = Arc::new(Jar::default());
        for (host, domain) in [(ACCOUNT, "xiaomi.com"), (HEALTH, "mi.com")] {
            let url = allowed_url(host)?;
            jar.add_cookie_str(
                &format!("sdkVersion=accountsdk-18.8.15; Domain={domain}; Path=/; Secure"),
                &url,
            );
            jar.add_cookie_str(
                &format!("deviceId={device}; Domain={domain}; Path=/; Secure"),
                &url,
            );
        }
        Ok(Self {
            client: Client::builder()
                .redirect(Policy::none())
                .cookie_provider(jar.clone())
                .timeout(Duration::from_secs(25))
                .build()
                .map_err(|_| "无法初始化小米连接")?,
            jar,
            identity_device: hex::encode_upper(Md5::digest(
                uuid::Uuid::new_v4().simple().to_string().as_bytes(),
            )),
            login_user_hint: None,
            user: String::new(),
            login: LoginArtifacts::default(),
            trace: Vec::new(),
            #[cfg(test)]
            allow_network_in_test: false,
            #[cfg(test)]
            test_transport: None,
        })
    }

    fn capture_login_headers(
        &mut self,
        url: &Url,
        headers: &header::HeaderMap,
        cookies: &[(String, String)],
    ) -> Result<bool, String> {
        allowed_url(url.as_str())?;
        let mut security_in_header = false;
        if let Some(value) = headers.get("extension-pragma") {
            let metadata =
                json_body(value.as_bytes()).map_err(|_| "小米验证响应中的登录密钥格式尚未识别")?;
            if let Some(security) = metadata
                .get("ssecurity")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            {
                self.login.security = security.to_owned();
                security_in_header = true;
            }
        }
        for (name, value) in cookies.iter().filter(|(_, value)| !value.is_empty()) {
            match name.as_str() {
                "userId" => self.login.user_id = value.clone(),
                "cUserId" => self.login.cuser_id = value.clone(),
                "passToken" => self.login.pass_token = value.clone(),
                "serviceToken" if value != "miothealth" => self.login.health_token = value.clone(),
                _ => {}
            }
        }
        Ok(security_in_header)
    }

    fn capture_login_body(&mut self, url: &Url, body: &[u8]) -> Result<Value, String> {
        allowed_url(url.as_str())?;
        let value = json_body(body).unwrap_or(Value::Null);
        if value["code"].as_i64() == Some(0) {
            for (name, target) in [
                ("ssecurity", &mut self.login.security),
                ("userId", &mut self.login.user_id),
                ("cUserId", &mut self.login.cuser_id),
                ("passToken", &mut self.login.pass_token),
                ("serviceToken", &mut self.login.health_token),
            ] {
                if let Some(text) = value[name].as_str().filter(|s| !s.is_empty()) {
                    if name != "serviceToken" || text != SID {
                        *target = text.to_owned();
                    }
                }
            }
        }
        Ok(value)
    }

    fn record_login_trace(
        &mut self,
        url: &Url,
        method: &Method,
        http_status: u16,
        security_in_header: bool,
        has_location: bool,
        value: &Value,
    ) {
        if self.trace.len() >= 40 {
            self.trace.remove(0);
        }
        let present = |name: &str| value[name].as_str().is_some_and(|s| !s.is_empty());
        let step = match (url.host_str(), url.path()) {
            (Some("account.xiaomi.com"), "/longPolling/loginUrl") => "qr-start",
            (
                Some(
                    "account.xiaomi.com" | "ak.lp.account.xiaomi.com" | "c3.lp.account.xiaomi.com",
                ),
                "/lp/s" | "/longPolling/login",
            ) => "qr-poll",
            (Some("account.xiaomi.com"), "/pass/serviceLogin") => "service-login",
            (Some("account.xiaomi.com"), "/pass/serviceLoginAuth2") => "password-auth",
            (
                Some("account.xiaomi.com"),
                "/identity/auth/verifyPhone" | "/identity/auth/verifyEmail",
            ) => "identity-verify",
            (Some("account.xiaomi.com"), "/identity/list") => "identity-list",
            (Some("account.xiaomi.com"), _) => "account-other",
            (Some("sts-hlth.io.mi.com"), _) => "health-sts",
            _ => "health-other",
        };
        self.trace.push(LoginTrace {
            step,
            method: method.as_str().to_owned(),
            http_status,
            code: value["code"].as_i64(),
            json_response: value.is_object(),
            security_in_header,
            security_in_body: present("ssecurity"),
            has_sign: present("_sign"),
            has_location: has_location || present("location"),
            has_notification: present("notificationUrl"),
            has_captcha: present("captchaUrl"),
            has_service_token: !self.login.health_token.is_empty(),
            has_pass_token: !self.login.pass_token.is_empty(),
        });
    }

    pub fn set_account_cookie(&self, name: &str, value: &str) {
        self.jar.add_cookie_str(
            &format!("{name}={value}; Domain=account.xiaomi.com; Path=/; Secure"),
            &Url::parse(ACCOUNT).unwrap(),
        );
    }

    pub fn account_cookie(&self, name: &str) -> Option<String> {
        self.jar
            .cookies(&Url::parse(ACCOUNT).unwrap())
            .and_then(|header| {
                header
                    .to_str()
                    .ok()?
                    .split(';')
                    .filter_map(|part| part.trim().split_once('='))
                    .find(|(key, _)| *key == name)
                    .map(|(_, value)| value.to_string())
            })
    }

    pub fn clear_device_cookies(&self) {
        for (host, domain) in [(ACCOUNT, "xiaomi.com"), (HEALTH, "mi.com")] {
            self.jar.add_cookie_str(
                &format!("deviceId=; Domain={domain}; Path=/; Max-Age=0"),
                &Url::parse(host).unwrap(),
            );
        }
    }

    fn request_cookie_header(
        &self,
        url: &Url,
        identity: bool,
        user_hint: Option<&str>,
    ) -> Option<String> {
        if !identity && user_hint.is_none() {
            return None;
        }
        let header = self
            .jar
            .cookies(url)
            .and_then(|h| h.to_str().ok().map(str::to_owned))
            .unwrap_or_default();
        let mut parts = header
            .split(';')
            .filter(|part| !part.trim().is_empty())
            .filter(|part| {
                let name = part.trim().split('=').next().unwrap_or("");
                !(user_hint.is_some() && name == "userId")
            })
            .map(|part| part.trim().to_owned())
            .collect::<Vec<_>>();
        if identity {
            // The validated account SDK appends this request-only cookie after
            // the session's domain-scoped deviceId; preserve that wire format.
            parts.push(format!("deviceId={}", self.identity_device));
        }
        if let Some(user) = user_hint {
            parts.push(format!("userId={user}"));
        }
        Some(parts.join("; "))
    }

    pub async fn request(
        &mut self,
        method: Method,
        address: &str,
        fields: &[(&str, String)],
        query: bool,
        follow: bool,
        identity: bool,
    ) -> Result<Vec<u8>, String> {
        Ok(self
            .request_response(method, address, fields, query, follow, identity)
            .await?
            .body)
    }

    pub async fn request_response(
        &mut self,
        method: Method,
        address: &str,
        fields: &[(&str, String)],
        query: bool,
        follow: bool,
        identity: bool,
    ) -> Result<AccountReply, String> {
        #[cfg(test)]
        if !self.allow_network_in_test {
            if let Some(transport) = self.test_transport {
                let reply = transport(self, method.clone(), address, fields, query)?;
                let url = allowed_url(address)?;
                let value = self.capture_login_body(&url, &reply.body)?;
                self.record_login_trace(
                    &url,
                    &method,
                    200,
                    false,
                    reply.location.is_some(),
                    &value,
                );
                return Ok(reply);
            }
            return Err("测试不允许发起额外网络请求".into());
        }
        let mut url = allowed_url(address)?;
        if query {
            url.query_pairs_mut()
                .extend_pairs(fields.iter().map(|(k, v)| (*k, v)));
        }
        let mut method = method;
        let user_hint = self.login_user_hint.take();
        for _ in 0..8 {
            allowed_url(url.as_str())?;
            let ua = if identity {
                format!("MiHome/11.3.203 (com.xiaomi.mihome; build:11.3.203; Android 9) APP/com.xiaomi.mihome APPV/11.3.203 DeviceId/{} UserId/{} Platform/Android Region/CN L/zh_CN", self.identity_device, self.user)
            } else {
                AGENT.into()
            };
            let mut builder = self
                .client
                .request(method.clone(), url.clone())
                .header(header::USER_AGENT, ua)
                .header(header::CONTENT_TYPE, "application/x-www-form-urlencoded");
            let hint = if url.host_str() == Some("account.xiaomi.com")
                && url.path() == "/pass/serviceLogin"
            {
                user_hint.as_deref()
            } else {
                None
            };
            if let Some(cookie) = self.request_cookie_header(&url, identity, hint) {
                builder = builder.header(header::COOKIE, cookie);
            }
            if identity {
                builder = builder.header(header::REFERER, format!("{ACCOUNT}/"));
            }
            if method == Method::POST && !query {
                builder = builder.form(fields);
            }
            let response = builder
                .send()
                .await
                .map_err(|_| "小米服务连接失败，请检查网络后重试")?;
            let cookies = response
                .cookies()
                .map(|cookie| (cookie.name().to_owned(), cookie.value().to_owned()))
                .collect::<Vec<_>>();
            let security_in_header =
                self.capture_login_headers(&url, response.headers(), &cookies)?;
            let status = response.status();
            let location = response
                .headers()
                .get(header::LOCATION)
                .and_then(|v| v.to_str().ok())
                .map(str::to_owned);
            if response.content_length().is_some_and(|n| n > 4_000_000) {
                return Err("小米服务响应超过本次读取上限".into());
            }
            let bytes = response.bytes().await.map_err(|_| "无法读取小米服务响应")?;
            if bytes.len() > 4_000_000 {
                return Err("小米服务响应超过本次读取上限".into());
            }
            let value = self.capture_login_body(&url, &bytes)?;
            self.record_login_trace(
                &url,
                &method,
                status.as_u16(),
                security_in_header,
                location.is_some(),
                &value,
            );
            if follow && status.is_redirection() {
                let next = url
                    .join(location.as_deref().ok_or("小米登录跳转缺少地址")?)
                    .map_err(|_| "小米登录跳转地址无效")?;
                allowed_url(next.as_str())?;
                if status.as_u16() != 307 && status.as_u16() != 308 {
                    method = Method::GET;
                }
                url = next;
                continue;
            }
            if status.is_client_error() || status.is_server_error() {
                return Err(format!("小米服务请求未完成（HTTP {}）", status.as_u16()));
            }
            return Ok(AccountReply {
                body: bytes.to_vec(),
                location,
            });
        }
        Err("小米登录跳转次数异常".into())
    }

    pub async fn json(
        &mut self,
        method: Method,
        url: &str,
        fields: &[(&str, String)],
        query: bool,
        identity: bool,
    ) -> Result<Value, String> {
        json_body(
            &self
                .request(method, url, fields, query, true, identity)
                .await?,
        )
    }

    pub async fn poll_qr(
        &mut self,
        address: &str,
        timeout: Duration,
    ) -> Result<Option<Value>, String> {
        let url = qr_poll_url(address)?;
        #[cfg(test)]
        if !self.allow_network_in_test {
            return self
                .json(Method::GET, address, &[], false, false)
                .await
                .map(Some);
        }
        let response = match self
            .client
            .get(url.clone())
            .header(header::USER_AGENT, AGENT)
            .timeout(timeout)
            .send()
            .await
        {
            Ok(response) => response,
            Err(error) if error.is_timeout() => return Ok(None),
            Err(_) => return Err("扫码登录连接失败，请检查网络后刷新二维码".into()),
        };
        let status = response.status();
        if response
            .content_length()
            .is_some_and(|size| size > 1_000_000)
        {
            return Err("扫码登录响应超过读取上限".into());
        }
        let cookies = response
            .cookies()
            .map(|cookie| (cookie.name().to_owned(), cookie.value().to_owned()))
            .collect::<Vec<_>>();
        let security_in_header = self.capture_login_headers(&url, response.headers(), &cookies)?;
        let bytes = match response.bytes().await {
            Ok(bytes) => bytes,
            Err(error) if error.is_timeout() => return Ok(None),
            Err(_) => return Err("无法读取扫码登录结果".into()),
        };
        if bytes.len() > 1_000_000 {
            return Err("扫码登录响应超过读取上限".into());
        }
        self.finish_qr_response(&url, status.as_u16(), security_in_header, &bytes)
            .map(Some)
    }

    fn finish_qr_response(
        &mut self,
        url: &Url,
        status: u16,
        security_in_header: bool,
        bytes: &[u8],
    ) -> Result<Value, String> {
        // Preserve only safe metadata for failed HTTP responses. A rejected
        // reply must never promote any body fields into accepted credentials.
        let value = if (200..300).contains(&status) {
            self.capture_login_body(url, bytes)?
        } else {
            json_body(bytes).unwrap_or(Value::Null)
        };
        self.record_login_trace(url, &Method::GET, status, security_in_header, false, &value);
        if !(200..300).contains(&status) {
            let code = value["code"]
                .as_i64()
                .map(|code| format!("；错误码 {code}"))
                .unwrap_or_default();
            return Err(format!(
                "扫码等待未完成（HTTP {status}{code}），请刷新二维码"
            ));
        }
        Ok(value)
    }
}

struct Rc4 {
    state: [u8; 256],
    i: u8,
    j: u8,
}
impl Rc4 {
    fn new(key: &[u8]) -> Self {
        let mut state = [0u8; 256];
        for (i, value) in state.iter_mut().enumerate() {
            *value = i as u8;
        }
        let mut j = 0usize;
        for i in 0..256 {
            j = (j + state[i] as usize + key[i % key.len()] as usize) & 255;
            state.swap(i, j);
        }
        let mut result = Self { state, i: 0, j: 0 };
        result.crypt(&[0u8; 1024]);
        result
    }
    fn crypt(&mut self, bytes: &[u8]) -> Vec<u8> {
        bytes
            .iter()
            .map(|byte| {
                self.i = self.i.wrapping_add(1);
                self.j = self.j.wrapping_add(self.state[self.i as usize]);
                self.state.swap(self.i as usize, self.j as usize);
                let index = self.state[self.i as usize].wrapping_add(self.state[self.j as usize]);
                byte ^ self.state[index as usize]
            })
            .collect()
    }
}

fn session_key(security: &str, nonce: &str) -> Result<Vec<u8>, String> {
    let mut data = B64
        .decode(security)
        .map_err(|_| "小米登录状态无效，请重新连接")?;
    data.extend(B64.decode(nonce).map_err(|_| "小米请求随机值无效")?);
    Ok(Sha256::digest(data).to_vec())
}

pub fn nonce() -> String {
    let mut bytes = uuid::Uuid::new_v4().as_bytes()[..8].to_vec();
    bytes.extend(((chrono::Utc::now().timestamp() / 60) as i32).to_be_bytes());
    B64.encode(bytes)
}

pub fn encrypted_query(
    path: &str,
    data: &Value,
    nonce: &str,
    security: &str,
) -> Result<BTreeMap<String, String>, String> {
    let key = session_key(security, nonce)?;
    let key64 = B64.encode(&key);
    let data = serde_json::to_string(data).map_err(|_| "无法构建小米查询")?;
    let hash = B64.encode(Sha1::digest(format!("GET&{path}&data={data}&{key64}")));
    let mut rc4 = Rc4::new(&key);
    let mut result = BTreeMap::from([
        ("data".into(), B64.encode(rc4.crypt(data.as_bytes()))),
        ("rc4_hash__".into(), B64.encode(rc4.crypt(hash.as_bytes()))),
    ]);
    let parts = result
        .iter()
        .map(|(k, v)| format!("{k}={v}"))
        .collect::<Vec<_>>()
        .join("&");
    result.insert(
        "signature".into(),
        B64.encode(Sha1::digest(format!("GET&{path}&{parts}&{key64}"))),
    );
    result.insert("_nonce".into(), nonce.into());
    Ok(result)
}

pub fn decode_health(bytes: &[u8], nonce: &str, security: &str) -> Result<Value, String> {
    if let Ok(value) = serde_json::from_slice(bytes) {
        return Ok(value);
    }
    let encoded = std::str::from_utf8(bytes).map_err(|_| "小米健康响应编码无效")?;
    let encrypted = B64
        .decode(encoded.trim())
        .map_err(|_| "小米健康响应格式尚未识别")?;
    let plain = Rc4::new(&session_key(security, nonce)?).crypt(&encrypted);
    serde_json::from_slice(&plain).map_err(|_| "小米健康响应内容尚未识别".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejected_qr_http_reply_keeps_safe_evidence_without_accepting_its_credentials() {
        let mut session = Session::new().unwrap();
        let error = session
            .finish_qr_response(
                &Url::parse("https://ak.lp.account.xiaomi.com/lp/s?ticket=private-ticket").unwrap(),
                403,
                false,
                br#"{"code":70001,"ssecurity":"private-security","desc":"private-description"}"#,
            )
            .err()
            .unwrap();
        assert!(error.contains("HTTP 403"));
        assert!(error.contains("70001"));
        assert!(!error.contains("private-"));
        assert!(session.login.security.is_empty());
        let trace = serde_json::to_value(&session.trace).unwrap();
        assert_eq!(trace[0]["httpStatus"], 403);
        assert_eq!(trace[0]["jsonResponse"], true);
        assert_eq!(trace[0]["code"], 70001);
        assert!(!trace.to_string().contains("private-"));
    }
    #[test]
    fn successful_response_body_retains_keys_before_a_redirect_is_followed() {
        let mut session = Session::new().unwrap();
        let callback = Url::parse("https://account.xiaomi.com/pass/identity/callback").unwrap();
        session.capture_login_body(&callback, br#"&&&START&&&{"code":0,"ssecurity":"body-security","passToken":"body-pass-token","userId":"body-user"}"#).unwrap();
        session
            .capture_login_body(
                &Url::parse("https://sts-hlth.io.mi.com/healthapp/sts").unwrap(),
                b"<html>done</html>",
            )
            .unwrap();
        assert_eq!(session.login.security, "body-security");
        assert_eq!(session.login.pass_token, "body-pass-token");
        assert_eq!(session.login.user_id, "body-user");
        session.capture_login_body(&callback, br#"{"code":70016,"ssecurity":"rejected-security","passToken":"rejected-pass-token"}"#).unwrap();
        assert_eq!(session.login.security, "body-security");
        assert_eq!(session.login.pass_token, "body-pass-token");
    }

    #[test]
    fn diagnostic_trace_never_serializes_response_or_url_values() {
        let mut session = Session::new().unwrap();
        let address = Url::parse("https://account.xiaomi.com/identity/auth/verifyPhone?ticket=private-ticket&context=private-context").unwrap();
        let value = serde_json::json!({"code": 0, "ssecurity": "private-security", "passToken": "private-pass", "userId": "private-user", "description": "private-description", "_sign": "private-sign", "location": "https://account.xiaomi.com/callback?token=private-token"});
        for _ in 0..50 {
            session.record_login_trace(&address, &Method::POST, 200, false, false, &value);
        }
        let saved = serde_json::to_value(&session.trace).unwrap();
        assert_eq!(saved.as_array().unwrap().len(), 40);
        assert_eq!(saved[0]["step"], "identity-verify");
        assert_eq!(saved[0]["code"], 0);
        assert_eq!(saved[0]["securityInBody"], true);
        assert_eq!(saved[0]["hasSign"], true);
        let text = saved.to_string();
        assert!(!text.contains("private-"));
        assert!(!text.contains("https://"));
        assert!(!text.contains("ticket="));
    }

    #[test]
    fn preserves_login_artifacts_from_all_verification_redirect_hops() {
        let mut session = Session::new().unwrap();
        let mut headers = header::HeaderMap::new();
        headers.insert(
            "Extension-Pragma",
            header::HeaderValue::from_static("{\"ssecurity\":\"test-header-security\"}"),
        );
        session
            .capture_login_headers(
                &Url::parse("https://account.xiaomi.com/pass/identity/callback").unwrap(),
                &headers,
                &[("passToken".into(), "test-pass-token".into())],
            )
            .unwrap();
        session
            .capture_login_headers(
                &Url::parse("https://sts-hlth.io.mi.com/healthapp/sts").unwrap(),
                &header::HeaderMap::new(),
                &[
                    ("userId".into(), "test-user".into()),
                    ("cUserId".into(), "test-cuser".into()),
                    ("serviceToken".into(), "test-health-token".into()),
                ],
            )
            .unwrap();
        // A later generic marker must not replace the health service token.
        session
            .capture_login_headers(
                &Url::parse("https://hlth.io.mi.com/").unwrap(),
                &header::HeaderMap::new(),
                &[("serviceToken".into(), "miothealth".into())],
            )
            .unwrap();
        assert_eq!(session.login.security, "test-header-security");
        assert_eq!(session.login.pass_token, "test-pass-token");
        assert_eq!(session.login.user_id, "test-user");
        assert_eq!(session.login.cuser_id, "test-cuser");
        assert_eq!(session.login.health_token, "test-health-token");
    }

    #[test]
    fn accepts_service_credentials_on_the_trusted_account_callback() {
        let mut session = Session::new().unwrap();
        let mut headers = header::HeaderMap::new();
        headers.insert(
            "Extension-Pragma",
            header::HeaderValue::from_static("{\"ssecurity\":\"callback-key\"}"),
        );
        session
            .capture_login_headers(
                &Url::parse("https://account.xiaomi.com/pass/identity/callback").unwrap(),
                &headers,
                &[("serviceToken".into(), "callback-service-token".into())],
            )
            .unwrap();
        assert_eq!(session.login.health_token, "callback-service-token");
        assert_eq!(session.login.security, "callback-key");
    }

    #[test]
    fn login_cookies_keep_domain_and_path_scopes_after_verification() {
        let session = Session::new().unwrap();
        let pass = Url::parse("https://account.xiaomi.com/pass/serviceLogin").unwrap();
        let identity = Url::parse("https://account.xiaomi.com/identity/auth/verifyPhone").unwrap();
        session
            .jar
            .add_cookie_str("verification=pass-scope; Path=/pass; Secure", &pass);
        session.jar.add_cookie_str(
            "verification=identity-scope; Path=/identity; Secure",
            &identity,
        );
        let pass_cookies = session
            .jar
            .cookies(&pass)
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();
        let identity_cookies = session
            .jar
            .cookies(&identity)
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();
        assert!(pass_cookies.contains("verification=pass-scope"));
        assert!(!pass_cookies.contains("verification=identity-scope"));
        assert!(identity_cookies.contains("verification=identity-scope"));
        assert!(!identity_cookies.contains("verification=pass-scope"));
        session.set_account_cookie("passToken", "test-only-token");
        assert_eq!(
            session.account_cookie("passToken").as_deref(),
            Some("test-only-token")
        );
        assert!(!session
            .jar
            .cookies(&Url::parse("https://sts-hlth.io.mi.com/healthapp/sts").unwrap())
            .unwrap()
            .to_str()
            .unwrap()
            .contains("passToken"));
    }

    #[test]
    fn identity_requests_use_the_validated_device_override_without_changing_login_cookies() {
        let session = Session::new().unwrap();
        let original = session.account_cookie("deviceId").unwrap();
        let url = Url::parse("https://account.xiaomi.com/identity/list").unwrap();
        let header = session.request_cookie_header(&url, true, None).unwrap();
        assert_eq!(header.matches("deviceId=").count(), 2);
        assert!(header.contains(&format!("deviceId={original}")));
        assert!(header.ends_with(&format!("deviceId={}", session.identity_device)));
        assert!(header.contains(&format!("deviceId={}", session.identity_device)));
        assert_eq!(session.identity_device.len(), 32);
        assert_eq!(session.account_cookie("deviceId").unwrap(), original);
        let hint = session
            .request_cookie_header(
                &Url::parse(ACCOUNT).unwrap(),
                false,
                Some("test-login-hint"),
            )
            .unwrap();
        assert!(hint.contains("userId=test-login-hint"));
        assert!(session.account_cookie("userId").is_none());
        session.clear_device_cookies();
        assert!(session.account_cookie("deviceId").is_none());
    }

    #[test]
    fn restricts_destinations_and_understands_prefixed_account_json() {
        assert!(allowed_url("https://account.xiaomi.com/pass/serviceLogin").is_ok());
        assert!(allowed_url("https://ak.lp.account.xiaomi.com/longPolling/login").is_ok());
        assert!(qr_poll_url("https://ak.lp.account.xiaomi.com/lp/s?ticket=local-fixture").is_ok());
        assert!(qr_poll_url("https://c3.lp.account.xiaomi.com/lp/s?ticket=local-fixture").is_ok());
        assert!(qr_poll_url("https://hlth.io.mi.com/lp/s").is_err());
        assert!(qr_poll_url("https://ak.lp.account.xiaomi.com/pass/serviceLoginAuth2").is_err());
        for url in [
            "http://hlth.io.mi.com",
            "https://hlth.io.mi.com.evil.test",
            "https://user:pass@hlth.io.mi.com",
            "https://hlth.io.mi.com:444",
            "https://ak.lp.account.xiaomi.com.evil.test/longPolling/login",
        ] {
            assert!(allowed_url(url).is_err());
        }
        assert_eq!(json_body(b"&&&START&&&{\"code\":0}").unwrap()["code"], 0);
    }
    #[test]
    fn encrypted_queries_match_the_validated_python_client() {
        let query = encrypted_query("/app/v1/data/get_fitness_data_by_time", &serde_json::json!({"key":"steps","startTime":1792339200000i64,"endTime":1792944000000i64,"reverse":true,"next_key":null}), "AAECAwQFBgcBxWcw", "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=").unwrap();
        // Independent fixture generated with the already-validated upstream client.
        assert_eq!(query["signature"], "5UcJms+vq/xYDMj5tr3thbvFhbA=");
    }

    #[test]
    fn decrypts_the_validated_python_response_fixture() {
        let value = decode_health(
            b"p4UZ9WwZismZqNDzXCxFttyj940tiS1j8EstK52QlraZeiHrtJ8PiqA0Bcj0FRluPmA+/dI=",
            "AAECAwQFBgcBxWcw",
            "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
        )
        .unwrap();
        assert_eq!(value["code"], 0);
        assert_eq!(value["result"]["has_more"], false);
        assert_eq!(value["result"]["data_list"], serde_json::json!([]));
    }
}
