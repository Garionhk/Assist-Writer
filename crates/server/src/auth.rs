//! Access rules for the web version:
//! - A browser on this PC (loopback address AND a localhost Host header) needs no login.
//! - Any other device must log in with the password set from this PC. Until a password is
//!   set, network access is refused.
//! - Requests whose Host header isn't this machine are rejected (blocks DNS-rebinding).
//! The password file is compatible with the earlier Node version (scrypt N=16384, r=8, p=1,
//! 64-byte key, the hex salt string used as the salt bytes).
use anyhow::{bail, Result};
use rand::RngCore;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use subtle::ConstantTimeEq;

const SESSION_DAYS: u64 = 30;
const LOCAL_HOSTS: &[&str] = &["localhost", "127.0.0.1", "[::1]"];

fn access_file() -> PathBuf {
    assist_core::paths::data_dir().join("web-access.json")
}

fn hash(password: &str, salt: &str) -> Vec<u8> {
    let params = scrypt::Params::new(14, 8, 1, 64).expect("scrypt params");
    let mut out = vec![0u8; 64];
    scrypt::scrypt(password.as_bytes(), salt.as_bytes(), &params, &mut out).expect("scrypt");
    out
}

fn read_stored() -> Option<(String, String)> {
    let text = std::fs::read_to_string(access_file()).ok()?;
    let v: Value = serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()?;
    Some((v["salt"].as_str()?.to_string(), v["hash"].as_str()?.to_string()))
}

pub fn password_set() -> bool {
    read_stored().is_some()
}

/// Checks a password against a stored salt/hash pair (constant-time comparison).
pub fn verify(password: &str, salt: &str, hash_hex: &str) -> bool {
    match hex::decode(hash_hex) {
        Ok(expected) => hash(password, salt).ct_eq(&expected).into(),
        Err(_) => false,
    }
}

/// The Host header's host name, lowercased, without the port.
pub fn host_of(host_header: &str) -> String {
    let host = host_header.to_lowercase();
    if host.starts_with('[') {
        host[..host.find(']').map(|i| i + 1).unwrap_or(host.len())].to_string()
    } else {
        host.split(':').next().unwrap_or_default().to_string()
    }
}

pub fn lan_addresses() -> Vec<String> {
    local_ip_address::list_afinet_netifas()
        .map(|list| {
            list.into_iter()
                .filter_map(|(_, ip)| match ip {
                    IpAddr::V4(v4) if !v4.is_loopback() && !v4.is_link_local() => Some(v4.to_string()),
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Host names this server answers to.
pub fn allowed_host(host_header: &str) -> bool {
    let host = host_of(host_header);
    if LOCAL_HOSTS.contains(&host.as_str()) {
        return true;
    }
    let name = gethostname::gethostname().to_string_lossy().to_lowercase();
    lan_addresses().contains(&host) || host == name || host == format!("{name}.local") || host == format!("{name}.lan")
}

pub fn is_local(peer: &SocketAddr, host_header: &str) -> bool {
    peer.ip().to_canonical().is_loopback() && LOCAL_HOSTS.contains(&host_of(host_header).as_str())
}

fn cookie_token(cookie_header: &str) -> Option<String> {
    cookie_header.split(';').map(str::trim).find_map(|kv| {
        let token = kv.strip_prefix("aw_session=")?;
        (token.len() == 64 && token.chars().all(|c| c.is_ascii_hexdigit())).then(|| token.to_string())
    })
}

#[derive(Default)]
pub struct Auth {
    sessions: Mutex<HashMap<String, Instant>>, // token -> expiry
    failures: Mutex<HashMap<IpAddr, (u32, Option<Instant>)>>,
}

impl Auth {
    pub fn set_password(&self, password: &str) -> Result<()> {
        if password.chars().count() < 6 {
            bail!("Use at least 6 characters.");
        }
        let mut salt = [0u8; 16];
        rand::rng().fill_bytes(&mut salt);
        let salt = hex::encode(salt);
        let body = json!({ "salt": salt, "hash": hex::encode(hash(password, &salt)) });
        let file = access_file();
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        std::fs::write(file, body.to_string())?;
        self.sessions.lock().unwrap().clear(); // everyone logs in again with the new password
        Ok(())
    }

    pub fn is_authenticated(&self, peer: &SocketAddr, host: &str, cookie: &str) -> bool {
        if is_local(peer, host) {
            return true;
        }
        let Some(token) = cookie_token(cookie) else { return false };
        let mut sessions = self.sessions.lock().unwrap();
        match sessions.get(&token) {
            Some(expiry) if *expiry > Instant::now() => true,
            Some(_) => {
                sessions.remove(&token);
                false
            }
            None => false,
        }
    }

    /// Returns a Set-Cookie value on success, or an error message for the user.
    pub fn login(&self, peer: &SocketAddr, password: &str) -> Result<String> {
        let ip = peer.ip().to_canonical();
        if let Some((_, Some(until))) = self.failures.lock().unwrap().get(&ip) {
            if *until > Instant::now() {
                bail!("Too many attempts. Try again in {} s.", (*until - Instant::now()).as_secs() + 1);
            }
        }
        let Some((salt, stored)) = read_stored() else {
            bail!("No password has been set yet. Set one in Settings on the PC running Assist Writer.");
        };
        if !verify(password, &salt, &stored) {
            let mut failures = self.failures.lock().unwrap();
            let entry = failures.entry(ip).or_insert((0, None));
            entry.0 += 1;
            if entry.0 >= 5 {
                let wait = 30 * 2u64.pow((entry.0 - 5).min(5));
                entry.1 = Some(Instant::now() + Duration::from_secs(wait));
            }
            bail!("Wrong password.");
        }
        self.failures.lock().unwrap().remove(&ip);
        let mut token = [0u8; 32];
        rand::rng().fill_bytes(&mut token);
        let token = hex::encode(token);
        self.sessions.lock().unwrap().insert(token.clone(), Instant::now() + Duration::from_secs(SESSION_DAYS * 86_400));
        Ok(format!("aw_session={token}; HttpOnly; SameSite=Strict; Path=/; Max-Age={}", SESSION_DAYS * 86_400))
    }

    pub fn logout(&self, cookie: &str) -> String {
        if let Some(token) = cookie_token(cookie) {
            self.sessions.lock().unwrap().remove(&token);
        }
        "aw_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0".to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_node_scrypt_hashes() {
        // Produced by Node: crypto.scryptSync('testpass123', salt, 64).toString('hex')
        let salt = "0123456789abcdef0123456789abcdef";
        let node_hash = "f8afb19418dccf46212d9c3c5a8135f4b3c47d40bf6e1ef095dbce2519e689156b6be4db55be5cef62cee2a4728fe3f8fcc63cea8a6584078899ac55519ae711";
        assert!(verify("testpass123", salt, node_hash));
        assert!(!verify("wrong", salt, node_hash));
        // Round trip within Rust.
        let h = hex::encode(hash("pässwörd 密码", "abc"));
        assert!(verify("pässwörd 密码", "abc", &h));
        assert!(!verify("password", "abc", &h));
    }

    #[test]
    fn host_rules() {
        assert_eq!(host_of("LocalHost:5178"), "localhost");
        assert_eq!(host_of("[::1]:5178"), "[::1]");
        assert!(allowed_host("localhost:5178"));
        assert!(!allowed_host("evil.example.com:5178"));
        let loop4: SocketAddr = "127.0.0.1:5000".parse().unwrap();
        let lan: SocketAddr = "192.168.0.50:5000".parse().unwrap();
        assert!(is_local(&loop4, "localhost:5178"));
        assert!(!is_local(&loop4, "evil.example.com")); // DNS-rebinding attempt
        assert!(!is_local(&lan, "localhost:5178"));
    }

    #[test]
    fn reads_session_cookie() {
        let t = "a".repeat(64);
        assert_eq!(cookie_token(&format!("x=1; aw_session={t}")), Some(t));
        assert_eq!(cookie_token("aw_session=short"), None);
    }
}
