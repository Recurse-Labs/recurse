//! GDB Remote Serial Protocol (RSP) wire codec — packet framing,
//! checksums, hex payload encode/decode, and stop-reply parsing.
//!
//! # Scope, stated honestly (same policy `crate::target`'s module doc
//! already applies to this crate's Linux/macOS backends)
//!
//! This module is the **protocol codec only**: pure, deterministic
//! functions over bytes/strings, every one of them unit-tested below
//! with no process, no socket, no target attached. It does **not**
//! include a live `Target` implementation that opens a TCP connection to
//! a real `gdbserver`/QEMU `-s` stub and drives it — this sandbox has no
//! `gdbserver`, `qemu-system-*`, or `gdb` available to verify one end to
//! end against (checked: none are on `PATH`), and shipping a
//! never-executed socket-driving backend as if it were tested would be
//! exactly the "plausible-looking but unverified" code `crate::target`'s
//! own doc comment refuses to ship for the same reason. What is real and
//! tested here: RFC-accurate packet framing (`$...#<2-hex-checksum>`),
//! the modulo-256 checksum, the `}`-escape (XOR 0x20) for `$`/`#`/`}`/`*`
//! inside a payload, hex-encoded memory read/write payloads, and parsing
//! `S`/`T` stop-reply packets (signal, and `T`'s `reg:value;` pairs and
//! optional `thread:`).
//!
//! A future `GdbRemoteTarget: crate::target::Target` implementation over
//! a `TcpStream` is real, scoped follow-up work — it would compose
//! directly on top of the functions here (`encode_packet`/`read_packet`
//! for the wire, `parse_stop_reply` for `Target::wait`, `encode_hex`/
//! `decode_hex` for `Target::read`/`Target::write`) once it can be
//! verified against a real remote stub.

/// The RSP escape character: an escaped byte is transmitted as `0x7d`
/// followed by `byte ^ 0x20`.
const ESCAPE: u8 = 0x7d;
const ESCAPE_XOR: u8 = 0x20;

/// Bytes RSP requires (or conventionally chooses) to escape inside a
/// packet payload: `$`, `#`, the escape character itself, and `*` (the
/// run-length-encoding marker this codec never emits, but a byte value
/// equal to it in payload data must still be escaped to avoid being
/// misread as one on the wire).
fn needs_escape(b: u8) -> bool {
    matches!(b, b'$' | b'#' | ESCAPE | b'*')
}

/// Sum of `payload`'s bytes, modulo 256 — RSP's whole checksum algorithm.
#[must_use]
pub fn checksum(payload: &[u8]) -> u8 {
    payload.iter().fold(0u8, |acc, &b| acc.wrapping_add(b))
}

/// Frame `payload` as a complete RSP packet: `$<escaped payload>#<cksum>`,
/// with the two-digit lowercase hex checksum computed over the
/// *unescaped* payload (per the spec — the checksum covers the logical
/// bytes, not the wire encoding).
#[must_use]
pub fn encode_packet(payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(payload.len() + 4);
    out.push(b'$');
    for &b in payload {
        if needs_escape(b) {
            out.push(ESCAPE);
            out.push(b ^ ESCAPE_XOR);
        } else {
            out.push(b);
        }
    }
    out.push(b'#');
    out.extend_from_slice(format!("{:02x}", checksum(payload)).as_bytes());
    out
}

/// Result of decoding one complete `$...#cc` packet from the wire.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DecodedPacket {
    /// The unescaped payload bytes.
    pub payload: Vec<u8>,
    /// Whether the transmitted checksum matched the payload's own —
    /// callers should `+`-acknowledge only when this is `true` and
    /// `-`-request a retransmit otherwise, per the protocol.
    pub checksum_ok: bool,
}

/// Decode one complete packet already extracted from the wire (bytes
/// from `$` through the two checksum hex digits, `$`/leading bytes and
/// the checksum both included). Returns `None` when `raw` is not shaped
/// like a packet at all (missing `$`, missing `#`, or fewer than two
/// checksum digits after it) — a genuinely malformed frame, distinct
/// from a well-formed frame whose checksum merely does not match
/// ([`DecodedPacket::checksum_ok`] covers that case).
#[must_use]
pub fn decode_packet(raw: &[u8]) -> Option<DecodedPacket> {
    let start = raw.iter().position(|&b| b == b'$')? + 1;
    let hash_pos = raw.iter().rposition(|&b| b == b'#')?;
    if hash_pos < start || raw.len() < hash_pos + 3 {
        return None;
    }
    let escaped = &raw[start..hash_pos];
    let cksum_hex = std::str::from_utf8(&raw[hash_pos + 1..hash_pos + 3]).ok()?;
    let transmitted = u8::from_str_radix(cksum_hex, 16).ok()?;

    let mut payload = Vec::with_capacity(escaped.len());
    let mut i = 0;
    while i < escaped.len() {
        if escaped[i] == ESCAPE && i + 1 < escaped.len() {
            payload.push(escaped[i + 1] ^ ESCAPE_XOR);
            i += 2;
        } else {
            payload.push(escaped[i]);
            i += 1;
        }
    }

    Some(DecodedPacket {
        checksum_ok: checksum(&payload) == transmitted,
        payload,
    })
}

/// Lowercase hex-encode `bytes` — the wire form RSP uses for memory
/// read/write payloads (`m<addr>,<len>` replies, `M<addr>,<len>:<hex>`
/// requests).
#[must_use]
pub fn encode_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        use std::fmt::Write as _;
        let _ = write!(out, "{b:02x}");
    }
    out
}

/// Decode a hex string back to bytes. `None` for an odd length or any
/// non-hex-digit character — a malformed reply, not a value to guess at.
#[must_use]
pub fn decode_hex(s: &str) -> Option<Vec<u8>> {
    if !s.len().is_multiple_of(2) {
        return None;
    }
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(s.len() / 2);
    let mut i = 0;
    while i < bytes.len() {
        let pair = std::str::from_utf8(&bytes[i..i + 2]).ok()?;
        out.push(u8::from_str_radix(pair, 16).ok()?);
        i += 2;
    }
    Some(out)
}

/// A parsed `S`/`T` stop-reply packet — what a real `Target::wait` would
/// build its `WaitEvent`/`Stop` from, once a live backend exists.
#[derive(Clone, Debug, PartialEq, Eq, Default)]
pub struct StopReply {
    /// The Unix signal number the reply reports (`SIGTRAP` = 5 for a
    /// normal breakpoint/step stop, matching this crate's own
    /// `session::SIGTRAP` convention).
    pub signal: u8,
    /// `T`-packet `n:r;` register pairs (register number in GDB's own
    /// numbering, as a hex string — mapping that to an architecture's
    /// named registers is a `Target` implementation's job, not this
    /// codec's), in the order they appeared.
    pub registers: Vec<(String, String)>,
    /// The `T`-packet `thread:` field, when present.
    pub thread: Option<String>,
}

/// Parse a stop-reply packet payload (`S05`, or `T05thread:1234;06:...;`).
/// `None` for anything that is not an `S`/`T` reply at all (`W`/`X` exit
/// packets, `OK`, error replies, …) — a caller checks those separately.
#[must_use]
pub fn parse_stop_reply(payload: &str) -> Option<StopReply> {
    let rest = payload
        .strip_prefix('T')
        .or_else(|| payload.strip_prefix('S'))?;
    if payload.starts_with('S') {
        let signal = u8::from_str_radix(rest.get(0..2)?, 16).ok()?;
        return Some(StopReply {
            signal,
            ..Default::default()
        });
    }
    let signal = u8::from_str_radix(rest.get(0..2)?, 16).ok()?;
    let mut reply = StopReply {
        signal,
        ..Default::default()
    };
    for field in rest[2..].split(';') {
        if field.is_empty() {
            continue;
        }
        let Some((key, value)) = field.split_once(':') else {
            continue;
        };
        if key == "thread" {
            reply.thread = Some(value.to_string());
        } else {
            reply.registers.push((key.to_string(), value.to_string()));
        }
    }
    Some(reply)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic)]
    use super::*;

    #[test]
    fn checksum_matches_the_documented_algorithm() {
        // "OK" = 0x4f + 0x4b = 0x9a.
        assert_eq!(checksum(b"OK"), 0x9a);
        assert_eq!(checksum(b""), 0);
    }

    #[test]
    fn encode_then_decode_round_trips_a_plain_payload() {
        let packet = encode_packet(b"qSupported");
        assert_eq!(packet[0], b'$');
        let decoded = decode_packet(&packet).expect("well-formed packet");
        assert!(decoded.checksum_ok);
        assert_eq!(decoded.payload, b"qSupported");
    }

    #[test]
    fn encode_matches_a_known_reference_packet() {
        // $OK#9a is the textbook example used in every RSP write-up.
        let packet = encode_packet(b"OK");
        assert_eq!(packet, b"$OK#9a");
    }

    #[test]
    fn escapes_and_unescapes_special_bytes_in_the_payload() {
        let payload = b"a$b#c}d*e";
        let packet = encode_packet(payload);
        // None of the raw special bytes should appear unescaped between
        // the framing '$' and the final '#'.
        let body = &packet[1..packet.len() - 3];
        for &b in b"$#}" {
            assert!(
                !body.contains(&b) || body.windows(2).any(|w| w == [ESCAPE, b ^ ESCAPE_XOR]),
                "special byte {b:#x} must only appear as part of an escape sequence"
            );
        }
        let decoded = decode_packet(&packet).expect("well-formed packet");
        assert!(decoded.checksum_ok);
        assert_eq!(decoded.payload, payload);
    }

    #[test]
    fn decode_flags_a_corrupted_checksum_without_panicking() {
        let mut packet = encode_packet(b"OK");
        // Flip the checksum's last hex digit.
        let last = packet.len() - 1;
        packet[last] = if packet[last] == b'a' { b'b' } else { b'a' };
        let decoded = decode_packet(&packet).expect("still a well-formed frame shape");
        assert!(!decoded.checksum_ok);
    }

    #[test]
    fn decode_rejects_a_frame_with_no_checksum_digits() {
        assert!(decode_packet(b"$OK#").is_none());
        assert!(decode_packet(b"OK#9a").is_none());
        assert!(decode_packet(b"$OK").is_none());
    }

    #[test]
    fn hex_round_trips_arbitrary_bytes() {
        let bytes = [0x00, 0xff, 0x7d, 0x24, 0x23, 0xde, 0xad, 0xbe, 0xef];
        let hex = encode_hex(&bytes);
        assert_eq!(hex, "00ff7d2423deadbeef");
        assert_eq!(decode_hex(&hex).expect("valid hex"), bytes);
    }

    #[test]
    fn decode_hex_rejects_odd_length_and_non_hex() {
        assert!(decode_hex("abc").is_none());
        assert!(decode_hex("zz").is_none());
    }

    #[test]
    fn parses_a_bare_signal_stop_reply() {
        let reply = parse_stop_reply("S05").expect("S-reply");
        assert_eq!(reply.signal, 5);
        assert!(reply.registers.is_empty());
        assert!(reply.thread.is_none());
    }

    #[test]
    fn parses_a_t_reply_with_registers_and_thread() {
        let reply = parse_stop_reply("T05thread:p1.1;06:0010000000000000;07:0020000000000000;")
            .expect("T-reply");
        assert_eq!(reply.signal, 5);
        assert_eq!(reply.thread.as_deref(), Some("p1.1"));
        assert_eq!(
            reply.registers,
            vec![
                ("06".to_string(), "0010000000000000".to_string()),
                ("07".to_string(), "0020000000000000".to_string()),
            ]
        );
    }

    #[test]
    fn non_stop_reply_payloads_return_none() {
        assert!(parse_stop_reply("OK").is_none());
        assert!(parse_stop_reply("W00").is_none());
        assert!(parse_stop_reply("E01").is_none());
    }
}
