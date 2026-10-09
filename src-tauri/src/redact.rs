//! 日志脱敏：遮蔽 URL 凭据、token、密钥等敏感信息。
//! 采用启发式字节扫描，不依赖正则，避免误伤与崩溃。

const SENSITIVE_KEYS: &[&str] = &[
    "token",
    "access_token",
    "refresh_token",
    "api_key",
    "apikey",
    "api-key",
    "password",
    "passwd",
    "pwd",
    "secret",
    "client_secret",
    "auth",
    "authorization",
    "credential",
];

pub fn redact_line(line: &str) -> String {
    let mut out = redact_url_credentials(line);
    out = redact_key_values(&out);
    out = redact_bearer(&out);
    out
}

/// 在字节切片中做大小写不敏感的 ASCII 子串查找。
fn find_ci(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    (0..=haystack.len() - needle.len())
        .find(|&i| haystack[i..i + needle.len()].eq_ignore_ascii_case(needle))
}

/// 遮蔽 URL 中的 `scheme://user:password@host` 部分。
fn redact_url_credentials(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < bytes.len() {
        if i + 3 <= bytes.len() && &bytes[i..i + 3] == b"://" {
            out.push_str("://");
            i += 3;
            let start = i;
            while i < bytes.len()
                && !matches!(
                    bytes[i],
                    b'/' | b'?' | b'#' | b' ' | b'\t' | b'\r' | b'\n' | b'"' | b'\'' | b')' | b','
                )
            {
                i += 1;
            }
            let authority = &input[start..i];
            if let Some(at) = authority.find('@') {
                if !authority[..at].is_empty() {
                    out.push_str("***@");
                }
                out.push_str(&authority[at + 1..]);
            } else {
                out.push_str(authority);
            }
        } else {
            let ch = input[i..].chars().next().unwrap();
            out.push(ch);
            i += ch.len_utf8();
        }
    }
    out
}

/// 遮蔽形如 `key=value` 的敏感键值（键命中 SENSITIVE_KEYS）。
fn redact_key_values(input: &str) -> String {
    let mut out = input.to_string();
    for key in SENSITIVE_KEYS {
        let needle = format!("{key}=").into_bytes();
        let mut search_from = 0usize;
        loop {
            let hay = out.as_bytes();
            let Some(rel) = find_ci(&hay[search_from..], &needle) else {
                break;
            };
            let eq = search_from + rel + key.len();
            let end = out[eq + 1..]
                .find(|c: char| {
                    c.is_whitespace() || c == '&' || c == '"' || c == '\'' || c == ';' || c == ','
                })
                .map(|n| eq + 1 + n)
                .unwrap_or(out.len());
            if end > eq + 1 {
                out.replace_range(eq + 1..end, "***");
            }
            search_from = eq + 4;
        }
    }
    out
}

/// 遮蔽 `Authorization: Bearer <token>` / `bearer <token>` 形式的令牌。
fn redact_bearer(input: &str) -> String {
    let mut out = input.to_string();
    let needle = b"bearer ";
    let mut search_from = 0usize;
    loop {
        let hay = out.as_bytes();
        let Some(rel) = find_ci(&hay[search_from..], needle) else {
            break;
        };
        let abs = search_from + rel + needle.len();
        let end = out[abs..]
            .find(|c: char| {
                c == ',' || c == ';' || c == '"' || c == '\'' || c == '\r' || c == '\n' || c.is_whitespace()
            })
            .map(|n| abs + n)
            .unwrap_or(out.len());
        if end > abs {
            out.replace_range(abs..end, "***");
        }
        search_from = abs + 3;
    }
    out
}
