//! Versioned, bounded NDJSON protocol for the Koni-owned Pi host.

use std::io::{BufRead, Write};

use serde::{Deserialize, Serialize};

use crate::agent_runtime::{RuntimeCommand, RuntimeEvent, RuntimeResponse};
use crate::agent_tool_broker::{AgentToolCall, AgentToolOutcome};
use crate::error::{KoniError, Result};

pub const PI_PROTOCOL_VERSION: u16 = 1;
pub const DEFAULT_MAX_PI_FRAME_BYTES: usize = 1024 * 1024;
/// Public tool arguments are measured after JSON escaping. Keeping 128 KiB
/// below the complete frame ceiling leaves deterministic room for the
/// protocol/session/call envelope while admitting the worker write contract.
pub const MAX_PI_TOOL_ARGUMENT_JSON_BYTES: usize = 896 * 1024;
const MAX_PROTOCOL_IDENTIFIER_BYTES: usize = 128;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PiFrameHeader {
    pub protocol_version: u16,
    pub session_id: String,
    pub sequence: u64,
}

impl PiFrameHeader {
    pub fn new(session_id: impl Into<String>, sequence: u64) -> Self {
        Self {
            protocol_version: PI_PROTOCOL_VERSION,
            session_id: session_id.into(),
            sequence,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "frame", rename_all = "snake_case")]
pub enum PiFrame {
    Request {
        #[serde(flatten)]
        header: PiFrameHeader,
        request_id: String,
        command: RuntimeCommand,
    },
    Response {
        #[serde(flatten)]
        header: PiFrameHeader,
        request_id: String,
        response: RuntimeResponse,
    },
    Event {
        #[serde(flatten)]
        header: PiFrameHeader,
        event: RuntimeEvent,
    },
    ToolCall {
        #[serde(flatten)]
        header: PiFrameHeader,
        call: AgentToolCall,
    },
    ToolResult {
        #[serde(flatten)]
        header: PiFrameHeader,
        call_id: String,
        outcome: AgentToolOutcome,
    },
}

impl PiFrame {
    pub fn header(&self) -> &PiFrameHeader {
        match self {
            Self::Request { header, .. }
            | Self::Response { header, .. }
            | Self::Event { header, .. }
            | Self::ToolCall { header, .. }
            | Self::ToolResult { header, .. } => header,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PiProtocolSequenceValidator {
    session_id: String,
    next_sequence: u64,
}

impl PiProtocolSequenceValidator {
    pub fn new(session_id: impl Into<String>) -> Self {
        Self {
            session_id: session_id.into(),
            next_sequence: 1,
        }
    }

    pub fn next_sequence(&self) -> u64 {
        self.next_sequence
    }

    /// Validate and advance one directional stream. State changes only after
    /// the complete frame is accepted, so a rejected frame cannot consume a
    /// sequence number.
    pub fn validate(&mut self, frame: &PiFrame) -> Result<()> {
        validate_pi_frame(frame)?;
        let header = frame.header();
        if header.session_id != self.session_id {
            return Err(protocol_error(format!(
                "cross-session frame: expected {}, received {}",
                self.session_id, header.session_id
            )));
        }
        if header.sequence != self.next_sequence {
            return Err(protocol_error(format!(
                "out-of-order frame for {}: expected sequence {}, received {}",
                self.session_id, self.next_sequence, header.sequence
            )));
        }
        self.next_sequence = self.next_sequence.checked_add(1).ok_or_else(|| {
            protocol_error(format!(
                "protocol sequence exhausted for session {}",
                self.session_id
            ))
        })?;
        Ok(())
    }
}

pub fn read_pi_frame(reader: &mut impl BufRead, max_frame_bytes: usize) -> Result<Option<PiFrame>> {
    if max_frame_bytes == 0 {
        return Err(protocol_error("frame limit must be positive"));
    }
    let Some(line) = read_bounded_line(reader, max_frame_bytes)? else {
        return Ok(None);
    };
    if line.is_empty() {
        return Err(protocol_error("blank protocol frame"));
    }
    let frame = serde_json::from_slice::<PiFrame>(&line)
        .map_err(|error| protocol_error(format!("invalid protocol JSON: {error}")))?;
    validate_pi_frame(&frame)?;
    Ok(Some(frame))
}

pub fn write_pi_frame(
    writer: &mut impl Write,
    frame: &PiFrame,
    max_frame_bytes: usize,
) -> Result<()> {
    if max_frame_bytes == 0 {
        return Err(protocol_error("frame limit must be positive"));
    }
    validate_pi_frame(frame)?;
    let encoded = serde_json::to_vec(frame)
        .map_err(|error| protocol_error(format!("could not encode protocol frame: {error}")))?;
    if encoded.len() > max_frame_bytes {
        return Err(protocol_error(format!(
            "protocol frame is {} bytes, exceeding the {max_frame_bytes}-byte limit",
            encoded.len()
        )));
    }
    writer
        .write_all(&encoded)
        .and_then(|_| writer.write_all(b"\n"))
        .and_then(|_| writer.flush())
        .map_err(|error| protocol_error(format!("could not write protocol frame: {error}")))
}

pub(crate) fn validate_pi_identifier(name: &str, value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > MAX_PROTOCOL_IDENTIFIER_BYTES
        || value.trim() != value
        || value.chars().any(char::is_control)
    {
        return Err(protocol_error(format!(
            "{name} must be 1..={MAX_PROTOCOL_IDENTIFIER_BYTES} bytes with no surrounding whitespace or control characters"
        )));
    }
    Ok(())
}

fn validate_pi_frame(frame: &PiFrame) -> Result<()> {
    let header = frame.header();
    if header.protocol_version != PI_PROTOCOL_VERSION {
        return Err(protocol_error(format!(
            "unsupported Pi protocol version {}; expected {}",
            header.protocol_version, PI_PROTOCOL_VERSION
        )));
    }
    validate_pi_identifier("session_id", &header.session_id)?;
    if header.sequence == 0 {
        return Err(protocol_error("protocol sequence must be positive"));
    }
    match frame {
        PiFrame::Request { request_id, .. } | PiFrame::Response { request_id, .. } => {
            validate_pi_identifier("request_id", request_id)
        }
        PiFrame::ToolCall { call, .. } => {
            validate_pi_identifier("call_id", &call.call_id)?;
            validate_pi_identifier("tool name", &call.name)
        }
        PiFrame::ToolResult { call_id, .. } => validate_pi_identifier("call_id", call_id),
        PiFrame::Event { .. } => Ok(()),
    }
}

pub(crate) fn read_bounded_line(
    reader: &mut impl BufRead,
    max_frame_bytes: usize,
) -> Result<Option<Vec<u8>>> {
    let mut line = Vec::with_capacity(max_frame_bytes.min(8192));
    loop {
        let available = reader
            .fill_buf()
            .map_err(|error| protocol_error(format!("could not read protocol frame: {error}")))?;
        if available.is_empty() {
            return if line.is_empty() {
                Ok(None)
            } else {
                Err(protocol_error("unterminated protocol frame at EOF"))
            };
        }

        if let Some(newline) = available.iter().position(|byte| *byte == b'\n') {
            if line.len().saturating_add(newline) > max_frame_bytes {
                return Err(protocol_error(format!(
                    "protocol frame exceeds the {max_frame_bytes}-byte limit"
                )));
            }
            line.extend_from_slice(&available[..newline]);
            reader.consume(newline + 1);
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            return Ok(Some(line));
        }

        if line.len().saturating_add(available.len()) > max_frame_bytes {
            return Err(protocol_error(format!(
                "protocol frame exceeds the {max_frame_bytes}-byte limit"
            )));
        }
        let consumed = available.len();
        line.extend_from_slice(available);
        reader.consume(consumed);
    }
}

fn protocol_error(message: impl Into<String>) -> KoniError {
    KoniError::Process(format!("Pi runtime protocol error: {}", message.into()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{BufReader, Cursor};

    fn response(session_id: &str, sequence: u64) -> PiFrame {
        PiFrame::Response {
            header: PiFrameHeader::new(session_id, sequence),
            request_id: "request-1".to_owned(),
            response: RuntimeResponse::Accepted,
        }
    }

    #[test]
    fn frame_round_trips_as_one_ndjson_record() {
        let frame = response("session-1", 1);
        let mut encoded = Vec::new();
        write_pi_frame(&mut encoded, &frame, 4096).unwrap();
        assert_eq!(encoded.iter().filter(|byte| **byte == b'\n').count(), 1);

        let mut reader = BufReader::new(Cursor::new(encoded));
        assert_eq!(read_pi_frame(&mut reader, 4096).unwrap(), Some(frame));
        assert_eq!(read_pi_frame(&mut reader, 4096).unwrap(), None);
    }

    #[test]
    fn bounded_reader_rejects_oversized_input_before_a_record_is_accepted() {
        let input = format!("{}\n", "x".repeat(65));
        let mut reader = BufReader::new(Cursor::new(input));
        let error = read_pi_frame(&mut reader, 64).unwrap_err().to_string();
        assert!(error.contains("exceeds the 64-byte limit"));
    }

    #[test]
    fn sequence_validator_rejects_replay_gap_and_cross_session_without_advancing() {
        let mut validator = PiProtocolSequenceValidator::new("session-1");
        validator.validate(&response("session-1", 1)).unwrap();
        assert_eq!(validator.next_sequence(), 2);

        let replay = validator
            .validate(&response("session-1", 1))
            .unwrap_err()
            .to_string();
        assert!(replay.contains("expected sequence 2, received 1"));
        assert_eq!(validator.next_sequence(), 2);

        let cross_session = validator
            .validate(&response("session-2", 2))
            .unwrap_err()
            .to_string();
        assert!(cross_session.contains("cross-session frame"));
        assert_eq!(validator.next_sequence(), 2);

        validator.validate(&response("session-1", 2)).unwrap();
        assert_eq!(validator.next_sequence(), 3);
    }

    #[test]
    fn parser_rejects_blank_malformed_and_unsupported_frames() {
        for input in [
            "\n".to_owned(),
            "not-json\n".to_owned(),
            serde_json::to_string(&PiFrame::Response {
                header: PiFrameHeader {
                    protocol_version: 99,
                    session_id: "session-1".to_owned(),
                    sequence: 1,
                },
                request_id: "request-1".to_owned(),
                response: RuntimeResponse::Accepted,
            })
            .unwrap()
                + "\n",
        ] {
            let mut reader = BufReader::new(Cursor::new(input));
            assert!(read_pi_frame(&mut reader, 4096).is_err());
        }
    }
}
