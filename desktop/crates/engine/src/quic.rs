//! QUIC file transfer between desktop apps (ADR 0009): the sockets and the bytes. The rules with no
//! I/O (addresses, paths, STUN messages, hex) are in `rtc_core::quic`.
//!
//! The sender runs a QUIC server with a certificate made for this one transfer; the receiver
//! connects and accepts only that certificate (its SHA-256 came in the `quic-offer`, over the
//! encrypted data channel). The receiver then proves it's the one the offer went to by sending the
//! offer's one-time token first on the stream, with the offset to start from (resume). Both sides
//! punch holes in their routers first by sending a few small packets to each other's addresses.
//!
//! Files are read and written in 1 MB blocks (never the whole file in memory); the receiver checks
//! the SHA-256 of the whole file at the end.

use std::io;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use quinn::crypto::rustls::{QuicClientConfig, QuicServerConfig};
use quinn::rustls;
use quinn::rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use quinn::rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName, UnixTime};
use quinn::rustls::{DigitallySignedStruct, SignatureScheme};
use quinn::{Endpoint, EndpointConfig, TokioRuntime, TransportConfig, VarInt};
use rtc_core::quic::{same_secret, stun_mapped_address, stun_request};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio::net::UdpSocket;
use tokio::time::{sleep, timeout};

/// ALPN of the transfer protocol.
const ALPN: &[u8] = b"3rtc-file/1";
/// Read and write size.
const BLOCK: usize = 1024 * 1024;
/// Hole punching: this many small packets, this far apart, to each of the peer's addresses.
const PUNCHES: u32 = 12;
const PUNCH_GAP: Duration = Duration::from_millis(120);
/// The receiver must connect within this (else the file goes over the data channel).
pub(crate) const CONNECT_WAIT: Duration = Duration::from_secs(8);
/// One address tried this long.
const DIAL_EACH: Duration = Duration::from_secs(4);
/// STUN answer wait.
const STUN_WAIT: Duration = Duration::from_millis(1500);
/// STUN servers (as ICE uses).
const STUN_SERVERS: [&str; 2] = ["stun.l.google.com:19302", "stun1.l.google.com:19302"];
/// The bytes of a punch packet (not QUIC: the other side's QUIC drops it).
const PUNCH: &[u8] = b"3rtc-punch";

/// What went wrong, in words for the log.
#[derive(Debug)]
pub(crate) struct QuicError(pub(crate) String);

impl std::fmt::Display for QuicError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}

fn err(what: &str, e: impl std::fmt::Display) -> QuicError {
    QuicError(format!("{what}: {e}"))
}

// ---- the socket and its addresses -------------------------------------------------------------

/// A UDP socket for one transfer, and the addresses the other side can try.
pub(crate) struct Socket {
    socket: UdpSocket,
    /// LAN and public (STUN) addresses, `ip:port`.
    pub(crate) addrs: Vec<SocketAddr>,
}

impl Socket {
    /// Opens a socket on `bind` (`0.0.0.0` normally; a test uses `127.0.0.1`) and finds its
    /// addresses: the LAN one, and with `stun` the public one.
    pub(crate) async fn open(bind: IpAddr, stun: bool) -> Result<Self, QuicError> {
        let socket = UdpSocket::bind(SocketAddr::new(bind, 0))
            .await
            .map_err(|e| err("bind", e))?;
        let local = socket.local_addr().map_err(|e| err("local address", e))?;
        let mut addrs = Vec::new();
        if bind.is_unspecified() {
            if let Some(ip) = lan_ip() {
                addrs.push(SocketAddr::new(ip, local.port()));
            }
        } else {
            addrs.push(local);
        }
        if stun
            && let Some(public) = stun_public(&socket).await
            && !addrs.contains(&public)
        {
            addrs.push(public);
        }
        Ok(Self { socket, addrs })
    }

    /// Sends small packets to each of `peer` for a moment, so both routers let the other side in.
    async fn punch(&self, peer: &[SocketAddr]) {
        for _ in 0..PUNCHES {
            for addr in peer {
                let _ = self.socket.send_to(PUNCH, addr).await;
            }
            sleep(PUNCH_GAP).await;
        }
    }

    /// The socket for quinn.
    fn into_std(self) -> Result<std::net::UdpSocket, QuicError> {
        self.socket.into_std().map_err(|e| err("socket", e))
    }
}

/// This PC's LAN address (the one a packet to the internet would leave from). Nothing is sent.
fn lan_ip() -> Option<IpAddr> {
    let s = std::net::UdpSocket::bind(SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), 0)).ok()?;
    s.connect("8.8.8.8:80").ok()?;
    let ip = s.local_addr().ok()?.ip();
    (!ip.is_unspecified()).then_some(ip)
}

/// The socket's public address, from a STUN server.
async fn stun_public(socket: &UdpSocket) -> Option<SocketAddr> {
    for server in STUN_SERVERS {
        let Ok(mut found) = tokio::net::lookup_host(server).await else {
            continue;
        };
        let Some(target) = found.find(SocketAddr::is_ipv4) else {
            continue;
        };
        let txid: [u8; 12] = rand::random();
        if socket.send_to(&stun_request(txid), target).await.is_err() {
            continue;
        }
        let mut buf = [0u8; 512];
        let answer = timeout(STUN_WAIT, async {
            loop {
                let (n, from) = socket.recv_from(&mut buf).await.ok()?;
                if from == target
                    && let Some(addr) = stun_mapped_address(&buf[..n], txid)
                {
                    return Some(addr);
                }
            }
        })
        .await;
        if let Ok(Some(addr)) = answer {
            return Some(addr);
        }
    }
    None
}

// ---- TLS: a certificate per transfer, pinned by its hash ----------------------------------------

fn provider() -> Arc<rustls::crypto::CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

/// QUIC settings for a fast bulk transfer: big windows, a keep-alive.
fn transport() -> Arc<TransportConfig> {
    let mut t = TransportConfig::default();
    t.stream_receive_window(VarInt::from_u32(16 * 1024 * 1024));
    t.receive_window(VarInt::from_u32(32 * 1024 * 1024));
    t.send_window(64 * 1024 * 1024);
    t.max_idle_timeout(Some(VarInt::from_u32(30_000).into()));
    t.keep_alive_interval(Some(Duration::from_secs(5)));
    Arc::new(t)
}

/// Accepts exactly one certificate: the one whose SHA-256 the offer named.
#[derive(Debug)]
struct Pinned {
    sha256: [u8; 32],
    provider: Arc<rustls::crypto::CryptoProvider>,
}

impl ServerCertVerifier for Pinned {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let hash: [u8; 32] = Sha256::digest(end_entity.as_ref()).into();
        if same_secret(&hash, &self.sha256) {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::InvalidCertificate(
                rustls::CertificateError::ApplicationVerificationFailure,
            ))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

// ---- sending ------------------------------------------------------------------------------------

/// One file offered to one peer: its socket, certificate and token, until the peer answers.
pub(crate) struct Sender {
    socket: Socket,
    cert: CertificateDer<'static>,
    key: Vec<u8>,
    /// SHA-256 of the certificate, for the offer.
    pub(crate) cert_sha256: [u8; 32],
    /// The one-time token, for the offer.
    pub(crate) token: [u8; 32],
    path: PathBuf,
    size: u64,
}

impl Sender {
    /// Gets ready to send `path` (`size` bytes) from `socket`.
    pub(crate) fn new(socket: Socket, path: PathBuf, size: u64) -> Result<Self, QuicError> {
        let made =
            rcgen::generate_simple_self_signed(vec!["3rtc".to_owned()]).map_err(|e| err("certificate", e))?;
        let cert = CertificateDer::from(made.cert.der().to_vec());
        let cert_sha256: [u8; 32] = Sha256::digest(cert.as_ref()).into();
        Ok(Self {
            socket,
            cert,
            key: made.signing_key.serialize_der(),
            cert_sha256,
            token: rand::random(),
            path,
            size,
        })
    }

    /// Where the receiver can reach us.
    pub(crate) fn addrs(&self) -> &[SocketAddr] {
        &self.socket.addrs
    }

    /// The receiver answered from `peer`: punch, wait for it to connect, check its token, and
    /// send the file from the offset it asks for. Returns the bytes sent.
    pub(crate) async fn serve(
        self,
        peer: &[SocketAddr],
        progress: impl Fn(u64) + Send,
    ) -> Result<u64, QuicError> {
        let Self {
            socket,
            cert,
            key,
            token,
            path,
            size,
            ..
        } = self;
        socket.punch(peer).await;
        let mut tls = rustls::ServerConfig::builder_with_provider(provider())
            .with_protocol_versions(&[&rustls::version::TLS13])
            .map_err(|e| err("tls", e))?
            .with_no_client_auth()
            .with_single_cert(vec![cert], PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(key)))
            .map_err(|e| err("tls", e))?;
        tls.alpn_protocols = vec![ALPN.to_vec()];
        let mut server = quinn::ServerConfig::with_crypto(Arc::new(
            QuicServerConfig::try_from(tls).map_err(|e| err("quic tls", e))?,
        ));
        server.transport_config(transport());
        let endpoint = Endpoint::new(
            EndpointConfig::default(),
            Some(server),
            socket.into_std()?,
            Arc::new(TokioRuntime),
        )
        .map_err(|e| err("endpoint", e))?;

        let result = async {
            let incoming = timeout(CONNECT_WAIT, endpoint.accept())
                .await
                .map_err(|_| QuicError("the receiver didn't connect".to_owned()))?
                .ok_or_else(|| QuicError("closed".to_owned()))?;
            let conn = incoming.await.map_err(|e| err("connection", e))?;
            let (mut send, mut recv) = timeout(CONNECT_WAIT, conn.accept_bi())
                .await
                .map_err(|_| QuicError("no request".to_owned()))?
                .map_err(|e| err("stream", e))?;
            // the token, then where to start
            let mut hello = [0u8; 40];
            recv.read_exact(&mut hello).await.map_err(|e| err("request", e))?;
            if !same_secret(&hello[..32], &token) {
                conn.close(VarInt::from_u32(1), b"wrong token");
                return Err(QuicError("wrong token".to_owned()));
            }
            let mut offset_bytes = [0u8; 8];
            offset_bytes.copy_from_slice(&hello[32..40]);
            let offset = u64::from_be_bytes(offset_bytes).min(size);

            let mut file = tokio::fs::File::open(&path).await.map_err(|e| err("open", e))?;
            file.seek(io::SeekFrom::Start(offset))
                .await
                .map_err(|e| err("seek", e))?;
            let mut buf = vec![0u8; BLOCK];
            let mut sent = offset;
            while sent < size {
                let want = usize::try_from((size - sent).min(BLOCK as u64)).unwrap_or(BLOCK);
                let n = file.read(&mut buf[..want]).await.map_err(|e| err("read", e))?;
                if n == 0 {
                    return Err(QuicError("the file got shorter".to_owned()));
                }
                send.write_all(&buf[..n]).await.map_err(|e| err("send", e))?;
                sent += n as u64;
                progress(sent);
            }
            send.finish().map_err(|e| err("finish", e))?;
            // the receiver closes once it has it all
            let _ = timeout(Duration::from_secs(60), conn.closed()).await;
            Ok(sent - offset)
        }
        .await;
        endpoint.close(VarInt::from_u32(0), b"done");
        result
    }
}

// ---- receiving ----------------------------------------------------------------------------------

/// What the receiver needs from the offer.
pub(crate) struct Offer {
    /// Where the sender listens.
    pub(crate) addrs: Vec<SocketAddr>,
    /// The only certificate accepted.
    pub(crate) cert_sha256: [u8; 32],
    /// Presented first.
    pub(crate) token: [u8; 32],
    /// The whole file's size.
    pub(crate) size: u64,
    /// The whole file's SHA-256.
    pub(crate) sha256: [u8; 32],
}

/// Receives `offer` into `partial` (which holds `offset` bytes already, for a resume) from
/// `socket`, and checks the whole file's hash. Returns the bytes received now.
pub(crate) async fn receive(
    socket: Socket,
    offer: &Offer,
    partial: &Path,
    offset: u64,
    progress: impl Fn(u64) + Send,
) -> Result<u64, QuicError> {
    socket.punch(&offer.addrs).await;
    let mut tls = rustls::ClientConfig::builder_with_provider(provider())
        .with_protocol_versions(&[&rustls::version::TLS13])
        .map_err(|e| err("tls", e))?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(Pinned {
            sha256: offer.cert_sha256,
            provider: provider(),
        }))
        .with_no_client_auth();
    tls.alpn_protocols = vec![ALPN.to_vec()];
    let mut client = quinn::ClientConfig::new(Arc::new(
        QuicClientConfig::try_from(tls).map_err(|e| err("quic tls", e))?,
    ));
    client.transport_config(transport());
    let mut endpoint = Endpoint::new(
        EndpointConfig::default(),
        None,
        socket.into_std()?,
        Arc::new(TokioRuntime),
    )
    .map_err(|e| err("endpoint", e))?;
    endpoint.set_default_client_config(client);

    let result = async {
        // the first of the sender's addresses that answers
        let mut conn = None;
        let mut last = String::from("no address");
        for addr in &offer.addrs {
            match endpoint.connect(*addr, "3rtc") {
                Ok(connecting) => match timeout(DIAL_EACH, connecting).await {
                    Ok(Ok(c)) => {
                        conn = Some(c);
                        break;
                    }
                    Ok(Err(e)) => last = format!("{addr}: {e}"),
                    Err(_) => last = format!("{addr}: no answer"),
                },
                Err(e) => last = format!("{addr}: {e}"),
            }
        }
        let conn = conn.ok_or_else(|| QuicError(format!("couldn't reach the sender ({last})")))?;
        let (mut send, mut recv) = conn.open_bi().await.map_err(|e| err("stream", e))?;
        let start = offset.min(offer.size);
        let mut hello = Vec::with_capacity(40);
        hello.extend_from_slice(&offer.token);
        hello.extend_from_slice(&start.to_be_bytes());
        send.write_all(&hello).await.map_err(|e| err("request", e))?;
        send.finish().map_err(|e| err("finish", e))?;

        let mut file = tokio::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .open(partial)
            .await
            .map_err(|e| err("create", e))?;
        file.set_len(start).await.map_err(|e| err("resize", e))?;
        file.seek(io::SeekFrom::Start(start))
            .await
            .map_err(|e| err("seek", e))?;
        let mut buf = vec![0u8; BLOCK];
        let mut have = start;
        loop {
            let read = recv.read(&mut buf).await.map_err(|e| err("receive", e))?;
            let Some(n) = read else { break };
            have += n as u64;
            if have > offer.size {
                return Err(QuicError("more than the file's size".to_owned()));
            }
            file.write_all(&buf[..n]).await.map_err(|e| err("write", e))?;
            progress(have);
        }
        file.flush().await.map_err(|e| err("flush", e))?;
        file.sync_all().await.map_err(|e| err("sync", e))?;
        drop(file);
        if have != offer.size {
            return Err(QuicError(format!("stopped at {have} of {} bytes", offer.size)));
        }
        let hash = sha256_file(partial).await.map_err(|e| err("hash", e))?;
        conn.close(VarInt::from_u32(0), b"ok");
        if !same_secret(&hash, &offer.sha256) {
            return Err(QuicError("the file arrived damaged (hash differs)".to_owned()));
        }
        Ok(have - start)
    }
    .await;
    endpoint.wait_idle().await;
    result
}

/// SHA-256 of a file, read in blocks off the async threads.
pub(crate) async fn sha256_file(path: &Path) -> io::Result<[u8; 32]> {
    let path = path.to_owned();
    tokio::task::spawn_blocking(move || {
        use std::io::Read as _;
        let mut file = std::fs::File::open(path)?;
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; BLOCK];
        loop {
            let n = file.read(&mut buf)?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
        }
        Ok(hasher.finalize().into())
    })
    .await
    .map_err(io::Error::other)?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("3rtc-quic-{}-{name}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        dir.join(name)
    }

    /// A file of `size` pseudo-random bytes.
    fn sample(path: &Path, size: usize) {
        let mut x: u32 = 2_463_534_242;
        let bytes: Vec<u8> = (0..size)
            .map(|_| {
                x ^= x << 13;
                x ^= x >> 17;
                x ^= x << 5;
                x.to_le_bytes()[0]
            })
            .collect();
        std::fs::write(path, bytes).unwrap();
    }

    /// What the sender returned, what the receiver returned, the source and the copy.
    type Outcome = (Result<u64, QuicError>, Result<u64, QuicError>, PathBuf, PathBuf);

    async fn transfer(size: usize, resume_at: u64, wrong_token: bool) -> Outcome {
        let src = temp(&format!("src-{size}-{resume_at}-{wrong_token}"));
        let dst = temp(&format!("dst-{size}-{resume_at}-{wrong_token}"));
        sample(&src, size);
        let _ = std::fs::remove_file(&dst);
        if resume_at > 0 {
            let all = std::fs::read(&src).unwrap();
            std::fs::write(&dst, &all[..usize::try_from(resume_at).unwrap()]).unwrap();
        }
        let local = IpAddr::V4(Ipv4Addr::LOCALHOST);
        let send_socket = Socket::open(local, false).await.unwrap();
        let recv_socket = Socket::open(local, false).await.unwrap();
        let receiver_addrs = recv_socket.addrs.clone();
        let sender = Sender::new(send_socket, src.clone(), size as u64).unwrap();
        let mut token = sender.token;
        if wrong_token {
            token[0] ^= 1;
        }
        let offer = Offer {
            addrs: sender.addrs().to_vec(),
            cert_sha256: sender.cert_sha256,
            token,
            size: size as u64,
            sha256: sha256_file(&src).await.unwrap(),
        };
        let serving = tokio::spawn(async move { sender.serve(&receiver_addrs, |_| {}).await });
        let got = receive(recv_socket, &offer, &dst, resume_at, |_| {}).await;
        let sent = serving.await.unwrap();
        (sent, got, src, dst)
    }

    #[tokio::test]
    async fn a_file_arrives_whole() {
        let (sent, got, src, dst) = transfer(3 * BLOCK + 12_345, 0, false).await;
        assert_eq!(sent.unwrap(), (3 * BLOCK + 12_345) as u64);
        assert_eq!(got.unwrap(), (3 * BLOCK + 12_345) as u64);
        assert_eq!(std::fs::read(&src).unwrap(), std::fs::read(&dst).unwrap());
    }

    #[tokio::test]
    async fn a_transfer_resumes_where_it_stopped() {
        let size = 2 * BLOCK + 777;
        let (sent, got, src, dst) = transfer(size, 1_500_000, false).await;
        assert_eq!(sent.unwrap(), (size - 1_500_000) as u64, "only the rest is sent");
        assert_eq!(got.unwrap(), (size - 1_500_000) as u64);
        assert_eq!(std::fs::read(&src).unwrap(), std::fs::read(&dst).unwrap());
    }

    #[tokio::test]
    async fn the_wrong_token_gets_nothing() {
        let (sent, got, _, dst) = transfer(BLOCK, 0, true).await;
        assert!(sent.is_err());
        assert!(got.is_err());
        assert_eq!(
            std::fs::metadata(&dst).map(|m| m.len()).unwrap_or(0),
            0,
            "no bytes were sent"
        );
    }

    #[tokio::test]
    async fn another_certificate_is_refused() {
        let local = IpAddr::V4(Ipv4Addr::LOCALHOST);
        let src = temp("cert-src");
        sample(&src, 1000);
        let send_socket = Socket::open(local, false).await.unwrap();
        let recv_socket = Socket::open(local, false).await.unwrap();
        let receiver_addrs = recv_socket.addrs.clone();
        let sender = Sender::new(send_socket, src.clone(), 1000).unwrap();
        let mut pinned = sender.cert_sha256;
        pinned[5] ^= 0xff;
        let offer = Offer {
            addrs: sender.addrs().to_vec(),
            cert_sha256: pinned,
            token: sender.token,
            size: 1000,
            sha256: [0; 32],
        };
        let serving = tokio::spawn(async move { sender.serve(&receiver_addrs, |_| {}).await });
        let got = receive(recv_socket, &offer, &temp("cert-dst"), 0, |_| {}).await;
        assert!(got.is_err(), "a different certificate must not be accepted");
        let _ = serving.await;
    }
}
