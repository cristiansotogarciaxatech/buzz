//! HTTP client for the optional Mastra persistent-memory sidecar.
//!
//! The sidecar (`services/mastra-memory`) exposes three routes: `GET /health`,
//! `POST /context`, and `POST /memory`. This module is a thin, bounded client
//! for those routes. It holds no policy about *when* memory is fetched or
//! written — that belongs to the prompt lifecycle in `pool.rs`.
//!
//! Two properties this module is responsible for:
//!
//! 1. **Secrets never reach a log.** The bearer token is wrapped in
//!    [`RedactedSecret`], whose `Debug` prints a placeholder, so neither the
//!    config summary nor a `tracing` field can spill it.
//! 2. **Requests are bounded before they leave.** Every field is clamped to the
//!    limit the sidecar's zod contract enforces, so a large turn degrades into a
//!    truncated write rather than a 400 the caller has to interpret.
//!
//! Every failure here is non-fatal by construction: the caller treats any `Err`
//! as "no memory this turn" and continues the ACP turn unchanged.

// Nothing in the prompt lifecycle calls this module yet, so its surface is
// reachable only from the tests below. Remove this attribute in the patch that
// wires retrieval and persistence into `pool.rs` — at that point an unused item
// here is a real signal again.
#![allow(dead_code)]

use std::fmt;
use std::time::Duration;

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Contract bounds — these mirror `services/mastra-memory/src/contracts.ts`.
// Keep them in sync with the zod schemas; a mismatch shows up as a 400.
// ---------------------------------------------------------------------------

/// `scopeId`: trimmed, 1..=512 characters.
const SCOPE_ID_MAX_CHARS: usize = 512;
/// `boundedText`: at most 262_144 characters.
const BOUNDED_TEXT_MAX_CHARS: usize = 262_144;
/// `toolEventSchema.name`: trimmed, 1..=256 characters.
const TOOL_NAME_MAX_CHARS: usize = 256;
/// `toolEventSchema.status`: trimmed, 1..=64 characters.
const TOOL_STATUS_MAX_CHARS: usize = 64;
/// `toolEventSchema.summary`: at most 2_048 characters.
const TOOL_SUMMARY_MAX_CHARS: usize = 2_048;
/// `memoryRequestSchema.toolEvents`: at most 64 entries.
const TOOL_EVENTS_MAX: usize = 64;

/// Bytes of a non-2xx response body retained for diagnostics. The sidecar's
/// error bodies are a single short `{"error":"..."}` object; anything larger is
/// not ours and is not worth logging.
const ERROR_BODY_MAX_BYTES: usize = 256;

/// Default per-request timeout. The sidecar runs an LLM observer on the write
/// path, so this is deliberately generous relative to a plain REST call while
/// still far below any ACP turn budget.
pub const DEFAULT_TIMEOUT_SECS: u64 = 10;

/// Default client-side ceiling on retrieved context. The sidecar's own
/// `totalTokenBudget` maxes out at 6_000; this is the harness refusing to inject
/// more than it asked for even if a misconfigured sidecar returns more.
pub const DEFAULT_MAX_CONTEXT_TOKENS: u32 = 6_000;

// ---------------------------------------------------------------------------
// Secret wrapper
// ---------------------------------------------------------------------------

/// A string that must never appear in `Debug` output, a config summary, or a
/// `tracing` field.
#[derive(Clone, PartialEq, Eq)]
pub struct RedactedSecret(String);

impl RedactedSecret {
    pub fn new(value: impl Into<String>) -> Self {
        Self(value.into())
    }

    /// The only way to read the secret. Call sites are auditable by grepping
    /// for this method.
    pub fn expose(&self) -> &str {
        &self.0
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl fmt::Debug for RedactedSecret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("RedactedSecret(<redacted>)")
    }
}

impl fmt::Display for RedactedSecret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("<redacted>")
    }
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/// Resolved, validated sidecar configuration. Its presence in
/// [`crate::config::Config`] *is* the enable flag: `None` means the integration
/// is off and no code path below this module runs.
#[derive(Debug, Clone)]
pub struct MastraMemoryConfig {
    /// Base URL with any trailing slash removed.
    pub url: String,
    /// Bearer token. Required unless `url` resolves to loopback, mirroring the
    /// sidecar's own `superRefine` rule.
    pub auth_token: Option<RedactedSecret>,
    /// Per-request timeout.
    pub timeout: Duration,
    /// Client-side ceiling on `estimatedTokens` in a `/context` response.
    pub max_context_tokens: u32,
    /// Operator-owned project id used only when no authoritative NIP-MP project
    /// coordinate is available for the channel.
    pub fallback_project_id: Option<String>,
}

/// Why a supplied sidecar configuration cannot be used.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum MastraConfigError {
    #[error("MASTRA_MEMORY_URL is required when MASTRA_MEMORY_ENABLED is set")]
    MissingUrl,

    #[error("MASTRA_MEMORY_URL is not a valid URL: {0}")]
    InvalidUrl(String),

    #[error("MASTRA_MEMORY_URL must use http or https, got '{0}'")]
    UnsupportedScheme(String),

    #[error(
        "MASTRA_MEMORY_AUTH_TOKEN is required when MASTRA_MEMORY_URL is not loopback (host '{0}')"
    )]
    MissingAuthToken(String),

    #[error("MASTRA_MEMORY_TIMEOUT_SECS must be greater than zero")]
    ZeroTimeout,

    #[error("MASTRA_MEMORY_MAX_CONTEXT_TOKENS must be greater than zero")]
    ZeroContextTokens,
}

impl MastraMemoryConfig {
    /// Validate raw operator input into a usable configuration.
    ///
    /// Rejects a non-loopback URL without a token, so the default-off
    /// integration cannot be turned on in a way that ships turn text to a
    /// remote host unauthenticated.
    pub fn resolve(
        url: Option<String>,
        auth_token: Option<String>,
        timeout_secs: u64,
        max_context_tokens: u32,
        fallback_project_id: Option<String>,
    ) -> Result<Self, MastraConfigError> {
        let raw = url
            .map(|u| u.trim().to_string())
            .filter(|u| !u.is_empty())
            .ok_or(MastraConfigError::MissingUrl)?;

        let parsed =
            url::Url::parse(&raw).map_err(|e| MastraConfigError::InvalidUrl(e.to_string()))?;
        let scheme = parsed.scheme().to_string();
        if scheme != "http" && scheme != "https" {
            return Err(MastraConfigError::UnsupportedScheme(scheme));
        }

        let host = parsed.host_str().unwrap_or_default().to_string();
        let token = auth_token
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
            .map(RedactedSecret::new);
        if token.is_none() && !is_loopback_host(&host) {
            return Err(MastraConfigError::MissingAuthToken(host));
        }

        if timeout_secs == 0 {
            return Err(MastraConfigError::ZeroTimeout);
        }
        if max_context_tokens == 0 {
            return Err(MastraConfigError::ZeroContextTokens);
        }

        Ok(Self {
            url: raw.trim_end_matches('/').to_string(),
            auth_token: token,
            timeout: Duration::from_secs(timeout_secs),
            max_context_tokens,
            fallback_project_id: fallback_project_id
                .map(|p| p.trim().to_string())
                .filter(|p| !p.is_empty()),
        })
    }

    /// One-line operator-facing summary. Never includes the token.
    pub fn summary(&self) -> String {
        format!(
            "url={} auth={} timeout={}s max_context_tokens={} fallback_project={}",
            self.url,
            if self.auth_token.is_some() {
                "bearer"
            } else {
                "none (loopback)"
            },
            self.timeout.as_secs(),
            self.max_context_tokens,
            self.fallback_project_id.as_deref().unwrap_or("(none)"),
        )
    }
}

/// Reduce a relay URL to `host:port`, filling in the scheme's default port so
/// that `wss://relay.example` and `wss://relay.example:443` are the same
/// community rather than two silently separate memory scopes.
fn community_id_from_relay_url(relay_url: &str) -> Option<String> {
    let parsed = url::Url::parse(relay_url.trim()).ok()?;
    let host = parsed.host_str()?;
    if host.is_empty() {
        return None;
    }
    let port = parsed.port().or_else(|| match parsed.scheme() {
        "wss" | "https" => Some(443),
        "ws" | "http" => Some(80),
        _ => None,
    })?;
    Some(format!("{host}:{port}"))
}

/// Whether a URL host is loopback, and therefore exempt from the token
/// requirement. Mirrors `isLoopback` in the sidecar's `config.ts`.
fn is_loopback_host(host: &str) -> bool {
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if host.eq_ignore_ascii_case("localhost") {
        return true;
    }
    match host.parse::<std::net::IpAddr>() {
        Ok(ip) => ip.is_loopback(),
        Err(_) => false,
    }
}

// ---------------------------------------------------------------------------
// Wire types — mirror `services/mastra-memory/src/contracts.ts`.
// ---------------------------------------------------------------------------

/// The five scope fields every sidecar request carries. Together they isolate
/// one agent's memory for one project inside one community.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryScope {
    pub community_id: String,
    pub project_id: String,
    pub channel_id: String,
    pub agent_id: String,
    pub session_id: String,
}

impl MemoryScope {
    /// Build the scope for one turn.
    ///
    /// The two isolating fields are derived, never taken from event content:
    ///
    /// - `community_id` comes from the operator-configured relay URL, reduced
    ///   to host plus effective port. Two agents pointed at different relays
    ///   can never read each other's memory, and the value cannot be influenced
    ///   by anything a channel member publishes.
    /// - `project_id` comes from the authoritative NIP-MP coordinate resolved
    ///   for the channel, or the operator's configured fallback. Returns `None`
    ///   when neither is available, so a channel with no trusted project gets
    ///   no memory at all rather than sharing an implicit default scope.
    pub fn derive(
        relay_url: &str,
        project_coordinate: Option<&str>,
        fallback_project_id: Option<&str>,
        channel_id: &str,
        agent_pubkey_hex: &str,
        session_id: &str,
    ) -> Option<Self> {
        let community_id = community_id_from_relay_url(relay_url)?;
        let project_id = project_coordinate
            .map(str::trim)
            .filter(|c| !c.is_empty())
            .or_else(|| fallback_project_id.map(str::trim).filter(|p| !p.is_empty()))?
            .to_string();

        Some(Self {
            community_id,
            project_id,
            channel_id: channel_id.trim().to_string(),
            agent_id: agent_pubkey_hex.trim().to_string(),
            session_id: session_id.trim().to_string(),
        })
        .filter(|scope| scope.bounded().is_some())
    }

    /// Clamp every field to the sidecar's `scopeId` bound. Returns `None` when
    /// any field is empty after trimming: the sidecar requires `min(1)`, and an
    /// empty scope field would silently widen the blast radius of a read.
    fn bounded(&self) -> Option<Self> {
        let fields = [
            &self.community_id,
            &self.project_id,
            &self.channel_id,
            &self.agent_id,
            &self.session_id,
        ];
        let mut out = Vec::with_capacity(fields.len());
        for field in fields {
            let trimmed = field.trim();
            if trimmed.is_empty() {
                return None;
            }
            out.push(truncate_chars(trimmed, SCOPE_ID_MAX_CHARS));
        }
        Some(Self {
            community_id: out[0].clone(),
            project_id: out[1].clone(),
            channel_id: out[2].clone(),
            agent_id: out[3].clone(),
            session_id: out[4].clone(),
        })
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ContextRequestBody {
    #[serde(flatten)]
    scope: MemoryScope,
    message: String,
}

/// One retrieved memory. Every string here is sidecar-supplied and must be
/// escaped before it reaches a prompt.
#[derive(Debug, Clone, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RelevantMemory {
    pub text: String,
    #[serde(default)]
    pub source_channel_id: Option<String>,
    #[serde(default)]
    pub source_agent_id: Option<String>,
    #[serde(default)]
    pub source_session_id: Option<String>,
    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub score: Option<f64>,
}

#[derive(Debug, Clone, Deserialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ContextResponse {
    #[serde(default)]
    pub project_memory: String,
    #[serde(default)]
    pub channel_memory: String,
    #[serde(default)]
    pub relevant_memories: Vec<RelevantMemory>,
    #[serde(default)]
    pub estimated_tokens: u32,
}

impl ContextResponse {
    /// True when the sidecar returned nothing worth injecting.
    pub fn is_empty(&self) -> bool {
        self.project_memory.trim().is_empty()
            && self.channel_memory.trim().is_empty()
            && self.relevant_memories.is_empty()
    }

    /// Render the three memory kinds as labelled prose for the prompt.
    ///
    /// Each kind is labelled because they carry different authority: project
    /// memory is long-lived working state, channel memory is what happened in
    /// this room, and recalled items are semantic hits that may be from an
    /// unrelated thread. Collapsing them into one blob would invite the agent
    /// to treat a loose semantic match as settled project state.
    ///
    /// Returns `None` when there is nothing to show, so the caller never
    /// renders an empty labelled block.
    pub fn render(&self) -> Option<String> {
        if self.is_empty() {
            return None;
        }

        let mut parts: Vec<String> = Vec::with_capacity(3);
        if !self.project_memory.trim().is_empty() {
            parts.push(format!("Project memory:
{}", self.project_memory.trim()));
        }
        if !self.channel_memory.trim().is_empty() {
            parts.push(format!("This channel:
{}", self.channel_memory.trim()));
        }

        let recalled: Vec<&str> = self
            .relevant_memories
            .iter()
            .map(|m| m.text.trim())
            .filter(|t| !t.is_empty())
            .collect();
        if !recalled.is_empty() {
            let items = recalled
                .iter()
                .map(|t| format!("- {t}"))
                .collect::<Vec<_>>()
                .join("
");
            parts.push(format!("Possibly related, from elsewhere in this project:
{items}"));
        }

        if parts.is_empty() {
            return None;
        }
        Some(parts.join("

"))
    }
}

/// A tool invocation observed during a turn. Only the name and terminal status
/// are ever sent — never tool arguments or output.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolEvent {
    pub name: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct MemoryRequestBody {
    #[serde(flatten)]
    scope: MemoryScope,
    user_message: String,
    agent_response: String,
    tool_events: Vec<ToolEvent>,
    metadata: serde_json::Map<String, serde_json::Value>,
}

/// What the caller wants persisted for a completed turn.
#[derive(Debug, Clone, Default)]
pub struct MemoryWrite {
    pub user_message: String,
    pub agent_response: String,
    pub tool_events: Vec<ToolEvent>,
    pub metadata: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryWriteResponse {
    #[serde(default)]
    pub stored: bool,
    #[serde(default)]
    pub observed: bool,
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

#[derive(Debug, thiserror::Error)]
pub enum MastraMemoryError {
    #[error("mastra memory transport error: {0}")]
    Transport(String),

    #[error("mastra memory returned HTTP {status}: {body}")]
    Status { status: u16, body: String },

    #[error("mastra memory response could not be decoded: {0}")]
    Decode(String),

    #[error("mastra memory scope is incomplete; refusing to send an unscoped request")]
    IncompleteScope,

    #[error("mastra memory context of {estimated} tokens exceeds the client cap of {cap}")]
    ContextTooLarge { estimated: u32, cap: u32 },
}

impl MastraMemoryError {
    /// Whether the sidecar answered with an authentication failure. Worth
    /// surfacing distinctly because it is an operator misconfiguration that
    /// will never self-heal, unlike a transport blip.
    pub fn is_unauthorized(&self) -> bool {
        matches!(self, Self::Status { status: 401, .. })
    }
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

/// Thin client over the sidecar's three routes.
///
/// Cheap to clone: `reqwest::Client` is internally `Arc`-ed, matching the
/// `RestClient` pattern in `relay.rs`.
#[derive(Clone)]
pub struct MastraMemoryClient {
    http: reqwest::Client,
    config: MastraMemoryConfig,
}

impl fmt::Debug for MastraMemoryClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("MastraMemoryClient")
            .field("url", &self.config.url)
            .field("auth", &self.config.auth_token.is_some())
            .field("timeout", &self.config.timeout)
            .finish()
    }
}

impl MastraMemoryClient {
    pub fn new(config: MastraMemoryConfig) -> Result<Self, MastraMemoryError> {
        let http = reqwest::Client::builder()
            .timeout(config.timeout)
            .connect_timeout(std::cmp::min(config.timeout, Duration::from_secs(5)))
            .build()
            .map_err(|e| {
                MastraMemoryError::Transport(format!("failed to build HTTP client: {e}"))
            })?;
        Ok(Self { http, config })
    }

    pub fn config(&self) -> &MastraMemoryConfig {
        &self.config
    }

    /// `GET /health`. Used for an optional startup probe; a failure here is
    /// logged and does not prevent the harness from starting.
    pub async fn health(&self) -> Result<serde_json::Value, MastraMemoryError> {
        let response = self
            .request(reqwest::Method::GET, "/health")
            .send()
            .await
            .map_err(transport_error)?;
        let response = check_status(response).await?;
        response
            .json::<serde_json::Value>()
            .await
            .map_err(|e| MastraMemoryError::Decode(e.to_string()))
    }

    /// `POST /context`. `message` should be the accepted batch's raw user text
    /// only — never the expanded Buzz prompt, which would make the retrieval
    /// query a function of previously retrieved memory.
    pub async fn context(
        &self,
        scope: &MemoryScope,
        message: &str,
    ) -> Result<ContextResponse, MastraMemoryError> {
        let scope = scope.bounded().ok_or(MastraMemoryError::IncompleteScope)?;
        let body = ContextRequestBody {
            scope,
            message: truncate_chars(message, BOUNDED_TEXT_MAX_CHARS),
        };

        let response = self
            .request(reqwest::Method::POST, "/context")
            .json(&body)
            .send()
            .await
            .map_err(transport_error)?;
        let response = check_status(response).await?;
        let context = response
            .json::<ContextResponse>()
            .await
            .map_err(|e| MastraMemoryError::Decode(e.to_string()))?;

        // The client enforces its own ceiling rather than trusting the
        // sidecar's budget. Over the cap we inject nothing at all: a turn with
        // no memory is always safe, a turn with an unbounded prefix is not.
        if context.estimated_tokens > self.config.max_context_tokens {
            return Err(MastraMemoryError::ContextTooLarge {
                estimated: context.estimated_tokens,
                cap: self.config.max_context_tokens,
            });
        }
        Ok(context)
    }

    /// `POST /memory`. Best-effort: the caller warns on failure and never
    /// changes the ACP outcome or requeue behavior because of it.
    pub async fn remember(
        &self,
        scope: &MemoryScope,
        write: &MemoryWrite,
    ) -> Result<MemoryWriteResponse, MastraMemoryError> {
        let scope = scope.bounded().ok_or(MastraMemoryError::IncompleteScope)?;
        let body = MemoryRequestBody {
            scope,
            user_message: truncate_chars(&write.user_message, BOUNDED_TEXT_MAX_CHARS),
            agent_response: truncate_chars(&write.agent_response, BOUNDED_TEXT_MAX_CHARS),
            tool_events: bound_tool_events(&write.tool_events),
            metadata: write.metadata.clone(),
        };

        let response = self
            .request(reqwest::Method::POST, "/memory")
            .json(&body)
            .send()
            .await
            .map_err(transport_error)?;
        let response = check_status(response).await?;
        response
            .json::<MemoryWriteResponse>()
            .await
            .map_err(|e| MastraMemoryError::Decode(e.to_string()))
    }

    fn request(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        let builder = self
            .http
            .request(method, format!("{}{}", self.config.url, path));
        match &self.config.auth_token {
            Some(token) => builder.header(
                reqwest::header::AUTHORIZATION,
                format!("Bearer {}", token.expose()),
            ),
            None => builder,
        }
    }
}

fn transport_error(e: reqwest::Error) -> MastraMemoryError {
    // `reqwest::Error`'s Display can include the request URL but never a
    // header, so the bearer token cannot leak through this path.
    MastraMemoryError::Transport(e.to_string())
}

async fn check_status(response: reqwest::Response) -> Result<reqwest::Response, MastraMemoryError> {
    let status = response.status();
    if status.is_success() {
        return Ok(response);
    }
    let body = response.text().await.unwrap_or_default();
    Err(MastraMemoryError::Status {
        status: status.as_u16(),
        body: truncate_bytes(body.trim(), ERROR_BODY_MAX_BYTES),
    })
}

/// Clamp tool events to the sidecar's contract: at most 64 entries, each with a
/// non-empty bounded name and status. Entries that cannot satisfy `min(1)` are
/// dropped rather than sent as an invalid batch that would fail the whole write.
fn bound_tool_events(events: &[ToolEvent]) -> Vec<ToolEvent> {
    events
        .iter()
        .filter_map(|event| {
            let name = event.name.trim();
            let status = event.status.trim();
            if name.is_empty() || status.is_empty() {
                return None;
            }
            Some(ToolEvent {
                name: truncate_chars(name, TOOL_NAME_MAX_CHARS),
                status: truncate_chars(status, TOOL_STATUS_MAX_CHARS),
                summary: event
                    .summary
                    .as_deref()
                    .map(|s| truncate_chars(s, TOOL_SUMMARY_MAX_CHARS)),
            })
        })
        .take(TOOL_EVENTS_MAX)
        .collect()
}

/// Truncate on a character boundary. The sidecar counts characters, not bytes.
fn truncate_chars(value: &str, max_chars: usize) -> String {
    if value.chars().count() <= max_chars {
        return value.to_string();
    }
    value.chars().take(max_chars).collect()
}

/// Truncate on a UTF-8 boundary for diagnostics that are byte-bounded.
fn truncate_bytes(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut end = max_bytes;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::{Arc, Mutex};

    /// A recorded inbound request: method, path, authorization header, body.
    #[derive(Debug, Clone)]
    struct RecordedRequest {
        method: String,
        path: String,
        authorization: Option<String>,
        body: String,
    }

    /// Minimal loopback HTTP server, matching the hand-rolled style in
    /// `relay.rs` (no mocking crate is a dependency of this crate).
    async fn test_server(
        responses: HashMap<String, (u16, String)>,
    ) -> (String, Arc<Mutex<Vec<RecordedRequest>>>, tokio::task::JoinHandle<()>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mastra test server");
        let base_url = format!("http://{}", listener.local_addr().expect("server address"));
        let recorded = Arc::new(Mutex::new(Vec::new()));
        let server_recorded = recorded.clone();

        let handle = tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut buf = vec![0; 16384];
                let read = socket.read(&mut buf).await.unwrap_or_default();
                let raw = String::from_utf8_lossy(&buf[..read]).to_string();

                let mut lines = raw.lines();
                let request_line = lines.next().unwrap_or_default().to_string();
                let mut parts = request_line.split_whitespace();
                let method = parts.next().unwrap_or_default().to_string();
                let path = parts.next().unwrap_or("/").to_string();
                let authorization = raw
                    .lines()
                    .find(|l| l.to_ascii_lowercase().starts_with("authorization:"))
                    .map(|l| l["authorization:".len()..].trim().to_string());
                let body = raw.split("\r\n\r\n").nth(1).unwrap_or_default().to_string();

                server_recorded
                    .lock()
                    .expect("lock recorded requests")
                    .push(RecordedRequest {
                        method,
                        path: path.clone(),
                        authorization,
                        body,
                    });

                let (status, response_body) = responses
                    .get(&path)
                    .cloned()
                    .unwrap_or_else(|| (404, "{\"error\":\"not_found\"}".to_string()));
                let reason = match status {
                    200 => "OK",
                    401 => "Unauthorized",
                    _ => "Error",
                };
                let response = format!(
                    "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    response_body.len(),
                    response_body
                );
                let _ = socket.write_all(response.as_bytes()).await;
            }
        });

        (base_url, recorded, handle)
    }

    fn scope() -> MemoryScope {
        MemoryScope {
            community_id: "relay.example:443".to_string(),
            project_id: "30023:owner:slug".to_string(),
            channel_id: "f5c91c95-6a35-481e-a267-e95b78c0f3d5".to_string(),
            agent_id: "abc123".to_string(),
            session_id: "sess-1".to_string(),
        }
    }

    fn client_for(base_url: &str, max_context_tokens: u32, token: Option<&str>) -> MastraMemoryClient {
        let config = MastraMemoryConfig::resolve(
            Some(base_url.to_string()),
            token.map(|t| t.to_string()),
            DEFAULT_TIMEOUT_SECS,
            max_context_tokens,
            None,
        )
        .expect("resolve test config");
        MastraMemoryClient::new(config).expect("build client")
    }

    // -- configuration ------------------------------------------------------

    #[test]
    fn resolve_requires_a_url_when_enabled() {
        assert_eq!(
            MastraMemoryConfig::resolve(None, None, 10, 100, None).unwrap_err(),
            MastraConfigError::MissingUrl
        );
        assert_eq!(
            MastraMemoryConfig::resolve(Some("   ".into()), None, 10, 100, None).unwrap_err(),
            MastraConfigError::MissingUrl,
            "a whitespace-only URL is the same operator mistake as an absent one"
        );
    }

    #[test]
    fn resolve_rejects_a_non_http_scheme() {
        assert_eq!(
            MastraMemoryConfig::resolve(Some("ws://127.0.0.1:4112".into()), None, 10, 100, None)
                .unwrap_err(),
            MastraConfigError::UnsupportedScheme("ws".into())
        );
    }

    #[test]
    fn resolve_requires_a_token_off_loopback() {
        let err = MastraMemoryConfig::resolve(
            Some("https://memory.example.com".into()),
            None,
            10,
            100,
            None,
        )
        .unwrap_err();
        assert_eq!(err, MastraConfigError::MissingAuthToken("memory.example.com".into()));

        MastraMemoryConfig::resolve(
            Some("https://memory.example.com".into()),
            Some("a-token-long-enough-for-the-sidecar".into()),
            10,
            100,
            None,
        )
        .expect("a token satisfies the off-loopback requirement");
    }

    #[test]
    fn resolve_allows_loopback_without_a_token() {
        for url in [
            "http://127.0.0.1:4112",
            "http://localhost:4112",
            "http://[::1]:4112",
        ] {
            MastraMemoryConfig::resolve(Some(url.into()), None, 10, 100, None)
                .unwrap_or_else(|e| panic!("{url} should be loopback-exempt, got {e}"));
        }
    }

    #[test]
    fn resolve_strips_a_trailing_slash_so_paths_do_not_double_up() {
        let config =
            MastraMemoryConfig::resolve(Some("http://127.0.0.1:4112/".into()), None, 10, 100, None)
                .expect("resolve");
        assert_eq!(config.url, "http://127.0.0.1:4112");
    }

    #[test]
    fn resolve_rejects_zero_bounds() {
        assert_eq!(
            MastraMemoryConfig::resolve(Some("http://127.0.0.1:4112".into()), None, 0, 100, None)
                .unwrap_err(),
            MastraConfigError::ZeroTimeout
        );
        assert_eq!(
            MastraMemoryConfig::resolve(Some("http://127.0.0.1:4112".into()), None, 10, 0, None)
                .unwrap_err(),
            MastraConfigError::ZeroContextTokens
        );
    }

    // -- scope derivation ---------------------------------------------------

    #[test]
    fn the_default_port_is_filled_in_so_one_relay_is_one_community() {
        assert_eq!(
            community_id_from_relay_url("wss://relay.example"),
            Some("relay.example:443".into())
        );
        assert_eq!(
            community_id_from_relay_url("wss://relay.example:443"),
            Some("relay.example:443".into()),
            "an explicit default port must not fork the community scope"
        );
        assert_eq!(
            community_id_from_relay_url("ws://localhost:3000"),
            Some("localhost:3000".into())
        );
        assert_eq!(
            community_id_from_relay_url("ws://relay.example"),
            Some("relay.example:80".into())
        );
        assert_eq!(
            community_id_from_relay_url("wss://relay.example:8443"),
            Some("relay.example:8443".into()),
            "a non-default port is a distinct community"
        );
    }

    #[test]
    fn a_relay_url_that_cannot_be_reduced_yields_no_scope() {
        assert_eq!(community_id_from_relay_url(""), None);
        assert_eq!(community_id_from_relay_url("not a url"), None);
        assert_eq!(
            community_id_from_relay_url("file:///tmp/relay"),
            None,
            "a scheme with no default port must not collapse into a shared scope"
        );
    }

    #[test]
    fn derive_prefers_the_authoritative_coordinate_over_the_fallback() {
        let scope = MemoryScope::derive(
            "wss://relay.example",
            Some("30023:owner:slug"),
            Some("operator-fallback"),
            "channel-1",
            "agent-hex",
            "sess-1",
        )
        .expect("scope");
        assert_eq!(scope.project_id, "30023:owner:slug");
        assert_eq!(scope.community_id, "relay.example:443");
    }

    #[test]
    fn derive_uses_the_operator_fallback_only_when_no_coordinate_exists() {
        let scope = MemoryScope::derive(
            "wss://relay.example",
            None,
            Some("operator-fallback"),
            "channel-1",
            "agent-hex",
            "sess-1",
        )
        .expect("scope");
        assert_eq!(scope.project_id, "operator-fallback");

        let blank_coordinate = MemoryScope::derive(
            "wss://relay.example",
            Some("   "),
            Some("operator-fallback"),
            "channel-1",
            "agent-hex",
            "sess-1",
        )
        .expect("scope");
        assert_eq!(
            blank_coordinate.project_id, "operator-fallback",
            "a blank coordinate is the same as an absent one"
        );
    }

    #[test]
    fn derive_yields_nothing_when_no_project_is_authoritative() {
        assert!(
            MemoryScope::derive(
                "wss://relay.example",
                None,
                None,
                "channel-1",
                "agent-hex",
                "sess-1",
            )
            .is_none(),
            "an untrusted channel must get no memory, not an implicit shared scope"
        );
    }

    #[test]
    fn derive_yields_nothing_when_any_remaining_field_is_blank() {
        for (channel, agent, session) in [
            ("", "agent-hex", "sess-1"),
            ("channel-1", "  ", "sess-1"),
            ("channel-1", "agent-hex", ""),
        ] {
            assert!(
                MemoryScope::derive(
                    "wss://relay.example",
                    Some("30023:owner:slug"),
                    None,
                    channel,
                    agent,
                    session,
                )
                .is_none(),
                "blank scope field ({channel:?}, {agent:?}, {session:?}) must block the scope"
            );
        }
    }

    #[test]
    fn two_relays_never_share_a_community_scope() {
        let one = MemoryScope::derive(
            "wss://relay-a.example",
            Some("30023:owner:slug"),
            None,
            "channel-1",
            "agent-hex",
            "sess-1",
        )
        .expect("scope");
        let two = MemoryScope::derive(
            "wss://relay-b.example",
            Some("30023:owner:slug"),
            None,
            "channel-1",
            "agent-hex",
            "sess-1",
        )
        .expect("scope");
        assert_ne!(one.community_id, two.community_id);
    }

    // -- secret redaction ---------------------------------------------------

    #[test]
    fn the_auth_token_never_appears_in_debug_or_summary_output() {
        let secret = "super-secret-token-value-1234567890";
        let config = MastraMemoryConfig::resolve(
            Some("https://memory.example.com".into()),
            Some(secret.into()),
            10,
            100,
            None,
        )
        .expect("resolve");

        let debug = format!("{config:?}");
        assert!(!debug.contains(secret), "Debug leaked the token: {debug}");
        assert!(debug.contains("<redacted>"), "Debug should mark the redaction: {debug}");

        let summary = config.summary();
        assert!(!summary.contains(secret), "summary leaked the token: {summary}");

        let client = MastraMemoryClient::new(config).expect("build client");
        let client_debug = format!("{client:?}");
        assert!(
            !client_debug.contains(secret),
            "client Debug leaked the token: {client_debug}"
        );
    }

    // -- request bounding ---------------------------------------------------

    #[test]
    fn an_empty_scope_field_blocks_the_request() {
        let mut incomplete = scope();
        incomplete.project_id = "   ".to_string();
        assert!(
            incomplete.bounded().is_none(),
            "an empty scope field must not be sent; it would widen the read"
        );
    }

    #[test]
    fn scope_fields_are_clamped_to_the_contract_bound() {
        let mut long = scope();
        long.project_id = "p".repeat(SCOPE_ID_MAX_CHARS + 50);
        let bounded = long.bounded().expect("bounded scope");
        assert_eq!(bounded.project_id.chars().count(), SCOPE_ID_MAX_CHARS);
    }

    #[test]
    fn tool_events_are_clamped_and_invalid_entries_dropped() {
        let mut events: Vec<ToolEvent> = (0..TOOL_EVENTS_MAX + 10)
            .map(|i| ToolEvent {
                name: format!("tool-{i}"),
                status: "completed".to_string(),
                summary: None,
            })
            .collect();
        events.insert(
            0,
            ToolEvent {
                name: "  ".to_string(),
                status: "completed".to_string(),
                summary: None,
            },
        );
        events.insert(
            1,
            ToolEvent {
                name: "n".repeat(TOOL_NAME_MAX_CHARS + 10),
                status: "s".repeat(TOOL_STATUS_MAX_CHARS + 10),
                summary: Some("x".repeat(TOOL_SUMMARY_MAX_CHARS + 10)),
            },
        );

        let bounded = bound_tool_events(&events);
        assert_eq!(bounded.len(), TOOL_EVENTS_MAX, "entry count must respect max(64)");
        assert!(
            bounded.iter().all(|e| !e.name.trim().is_empty()),
            "an entry with an empty name would fail the whole write"
        );
        let oversized = &bounded[0];
        assert_eq!(oversized.name.chars().count(), TOOL_NAME_MAX_CHARS);
        assert_eq!(oversized.status.chars().count(), TOOL_STATUS_MAX_CHARS);
        assert_eq!(
            oversized.summary.as_ref().expect("summary").chars().count(),
            TOOL_SUMMARY_MAX_CHARS
        );
    }

    #[test]
    fn truncation_lands_on_character_boundaries() {
        let multibyte = "é".repeat(10);
        let truncated = truncate_chars(&multibyte, 4);
        assert_eq!(truncated.chars().count(), 4);
        assert_eq!(truncated, "éééé");

        let bytes = truncate_bytes(&multibyte, 5);
        assert_eq!(bytes, "éé", "must not split a multi-byte character");
    }

    // -- transport ----------------------------------------------------------

    #[tokio::test]
    async fn context_posts_the_bounded_query_and_decodes_the_response() {
        let body = serde_json::json!({
            "projectMemory": "project notes",
            "channelMemory": "channel notes",
            "relevantMemories": [{"text": "a memory", "score": 0.5}],
            "estimatedTokens": 120
        })
        .to_string();
        let responses = HashMap::from([("/context".to_string(), (200, body))]);
        let (base_url, recorded, server) = test_server(responses).await;

        let client = client_for(&base_url, 1_000, Some("token-value"));
        let context = client.context(&scope(), "what is the status?").await.expect("context");

        assert_eq!(context.project_memory, "project notes");
        assert_eq!(context.channel_memory, "channel notes");
        assert_eq!(context.relevant_memories.len(), 1);
        assert_eq!(context.estimated_tokens, 120);
        assert!(!context.is_empty());

        let requests = recorded.lock().expect("lock");
        let request = requests.first().expect("one request");
        assert_eq!(request.method, "POST");
        assert_eq!(request.path, "/context");
        assert_eq!(request.authorization.as_deref(), Some("Bearer token-value"));

        let sent: serde_json::Value = serde_json::from_str(&request.body).expect("json body");
        assert_eq!(sent["message"], "what is the status?");
        assert_eq!(sent["communityId"], "relay.example:443");
        assert_eq!(sent["sessionId"], "sess-1");
        server.abort();
    }

    #[tokio::test]
    async fn context_over_the_client_cap_is_refused_rather_than_injected() {
        let body = serde_json::json!({
            "projectMemory": "huge",
            "channelMemory": "",
            "relevantMemories": [],
            "estimatedTokens": 9_000
        })
        .to_string();
        let responses = HashMap::from([("/context".to_string(), (200, body))]);
        let (base_url, _recorded, server) = test_server(responses).await;

        let client = client_for(&base_url, 5_500, None);
        let err = client.context(&scope(), "hi").await.expect_err("must refuse");
        assert!(
            matches!(
                err,
                MastraMemoryError::ContextTooLarge {
                    estimated: 9_000,
                    cap: 5_500
                }
            ),
            "unexpected error: {err}"
        );
        server.abort();
    }

    #[tokio::test]
    async fn a_loopback_client_sends_no_authorization_header() {
        let body = serde_json::json!({"stored": true, "observed": true}).to_string();
        let responses = HashMap::from([("/memory".to_string(), (200, body))]);
        let (base_url, recorded, server) = test_server(responses).await;

        let client = client_for(&base_url, 1_000, None);
        let result = client
            .remember(
                &scope(),
                &MemoryWrite {
                    user_message: "u".to_string(),
                    agent_response: "a".to_string(),
                    tool_events: vec![ToolEvent {
                        name: "Bash".to_string(),
                        status: "completed".to_string(),
                        summary: None,
                    }],
                    metadata: serde_json::Map::new(),
                },
            )
            .await
            .expect("remember");
        assert_eq!(result, MemoryWriteResponse { stored: true, observed: true });

        let requests = recorded.lock().expect("lock");
        let request = requests.first().expect("one request");
        assert_eq!(request.path, "/memory");
        assert!(
            request.authorization.is_none(),
            "no token configured means no Authorization header"
        );
        let sent: serde_json::Value = serde_json::from_str(&request.body).expect("json body");
        assert_eq!(sent["toolEvents"][0]["name"], "Bash");
        assert_eq!(sent["userMessage"], "u");
        assert!(sent["metadata"].is_object());
        server.abort();
    }

    #[tokio::test]
    async fn a_401_is_reported_as_unauthorized_with_a_bounded_body() {
        let responses = HashMap::from([(
            "/context".to_string(),
            (401, "{\"error\":\"unauthorized\"}".to_string()),
        )]);
        let (base_url, _recorded, server) = test_server(responses).await;

        let client = client_for(&base_url, 1_000, Some("wrong-token"));
        let err = client.context(&scope(), "hi").await.expect_err("must fail");
        assert!(err.is_unauthorized(), "unexpected error: {err}");
        match err {
            MastraMemoryError::Status { status, body } => {
                assert_eq!(status, 401);
                assert!(body.contains("unauthorized"));
                assert!(body.len() <= ERROR_BODY_MAX_BYTES);
            }
            other => panic!("expected a status error, got {other}"),
        }
        server.abort();
    }

    #[tokio::test]
    async fn an_unreachable_sidecar_is_a_transport_error_not_a_panic() {
        // Bind and immediately drop, so the port is almost certainly closed.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        drop(listener);

        let client = client_for(&format!("http://{addr}"), 1_000, None);
        let err = client.context(&scope(), "hi").await.expect_err("must fail");
        assert!(
            matches!(err, MastraMemoryError::Transport(_)),
            "unexpected error: {err}"
        );
    }

    #[tokio::test]
    async fn an_incomplete_scope_never_reaches_the_wire() {
        let responses = HashMap::from([("/context".to_string(), (200, "{}".to_string()))]);
        let (base_url, recorded, server) = test_server(responses).await;

        let client = client_for(&base_url, 1_000, None);
        let mut incomplete = scope();
        incomplete.session_id = String::new();
        let err = client.context(&incomplete, "hi").await.expect_err("must fail");
        assert!(matches!(err, MastraMemoryError::IncompleteScope));
        assert!(
            recorded.lock().expect("lock").is_empty(),
            "no request should have been sent"
        );
        server.abort();
    }
}
