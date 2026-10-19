/**
 * Hybrid Redaction Engine
 * Sub-millisecond deterministic exact env-var scan + entropy detector + regex patterns
 * Optional on-demand local ONNX NER for sensitive document tasks
 */

// Deterministic exact env-var patterns (sub-millisecond)
const ENV_VAR_PATTERNS = [
  /[A-Z_]+_API_KEY/gi,
  /[A-Z_]+_SECRET/gi,
  /[A-Z_]+_TOKEN/gi,
  /[A-Z_]+_PASSWORD/gi,
  /[A-Z_]+_PRIVATE_KEY/gi,
  /AWS_ACCESS_KEY_ID/gi,
  /AWS_SECRET_ACCESS_KEY/gi,
  /GOOGLE_API_KEY/gi,
  /ANTHROPIC_API_KEY/gi,
  /OPENAI_API_KEY/gi,
  /NVIDIA_API_KEY/gi,
  /AZURE_FOUNDRY_API_KEY/gi,
  /OPENROUTER_API_KEY/gi
];

// Entropy-based detector for high-entropy strings (API keys, tokens)
function calculateEntropy(str: string): number {
  const freq = new Map<string, number>();
  for (const char of str) {
    freq.set(char, (freq.get(char) || 0) + 1);
  }
  let entropy = 0;
  const len = str.length;
  for (const count of freq.values()) {
    const p = count / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function isHighEntropy(str: string): boolean {
  // Base64-encoded secrets typically have entropy > 4.0
  return str.length >= 20 && calculateEntropy(str) > 4.0;
}

// Regex patterns for common secret formats
const SECRET_REGEX_PATTERNS = [
  // AWS keys
  /AKIA[0-9A-Z]{16}/g,
  // Generic API keys (sk-*, ghp_*, etc.)
  /sk-[a-zA-Z0-9]{32,}/g,
  /ghp_[a-zA-Z0-9]{36,}/g,
  /glpat-[a-zA-Z0-9_-]{20,}/g,
  // JWT tokens
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  // Private keys
  /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
  // Connection strings
  /(mongodb|postgres|mysql|redis):\/\/[^\s]+/g,
  // Bearer tokens
  /Bearer\s+[A-Za-z0-9_-]{20,}/g
];

// PII regex patterns (deterministic, no ML)
const PII_REGEX_PATTERNS = [
  // Email addresses
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
  // Phone numbers (various formats)
  /(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g,
  // Credit card numbers (Luhn check would be better but regex is fast)
  /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
  // SSN (US)
  /\b\d{3}-\d{2}-\d{4}\b/g,
  // IP addresses
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/g
];

interface RedactionResult {
  redacted: unknown;
  redactions: Array<{ path: string; type: string; originalLength: number }>;
}

function redactValue(value: unknown, path: string = '$'): RedactionResult {
  if (value === null || value === undefined) {
    return { redacted: value, redactions: [] };
  }

  if (typeof value === 'string') {
    let redacted = value;
    const redactions: Array<{ path: string; type: string; originalLength: number }> = [];

    // 1. Exact env-var scan
    for (const pattern of ENV_VAR_PATTERNS) {
      const matches = [...value.matchAll(pattern)];
      for (const match of matches) {
        const start = match.index || 0;
        const end = start + match[0].length;
        redacted = redacted.slice(0, start) + '[REDACTED]' + redacted.slice(end);
        redactions.push({ path, type: 'env_var', originalLength: match[0].length });
      }
    }

    // 2. High-entropy detector
    if (isHighEntropy(value)) {
      redacted = '[REDACTED_HIGH_ENTROPY]';
      redactions.push({ path, type: 'high_entropy', originalLength: value.length });
    }

    // 3. Secret regex patterns
    for (const pattern of SECRET_REGEX_PATTERNS) {
      const matches = [...value.matchAll(pattern)];
      for (const match of matches) {
        const start = match.index || 0;
        const end = start + match[0].length;
        redacted = redacted.slice(0, start) + '[REDACTED_SECRET]' + redacted.slice(end);
        redactions.push({ path, type: 'secret_pattern', originalLength: match[0].length });
      }
    }

    // 4. PII regex patterns
    for (const pattern of PII_REGEX_PATTERNS) {
      const matches = [...value.matchAll(pattern)];
      for (const match of matches) {
        const start = match.index || 0;
        const end = start + match[0].length;
        redacted = redacted.slice(0, start) + '[REDACTED_PII]' + redacted.slice(end);
        redactions.push({ path, type: 'pii', originalLength: match[0].length });
      }
    }

    return { redacted, redactions };
  }

  if (Array.isArray(value)) {
    const allRedactions: Array<{ path: string; type: string; originalLength: number }> = [];
    const redacted = value.map((item, index) => {
      const result = redactValue(item, `${path}[${index}]`);
      allRedactions.push(...result.redactions);
      return result.redacted;
    });
    return { redacted, redactions: allRedactions };
  }

  if (typeof value === 'object') {
    const allRedactions: Array<{ path: string; type: string; originalLength: number }> = [];
    const redacted: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      const result = redactValue(val, `${path}.${key}`);
      allRedactions.push(...result.redactions);
      redacted[key] = result.redacted;
    }
    return { redacted, redactions: allRedactions };
  }

  return { redacted: value, redactions: [] };
}

export function redactToolCall(toolCall: { name: string; arguments: Record<string, unknown>; id: string }): typeof toolCall {
  const { redacted, redactions } = redactValue(toolCall.arguments, '$.arguments');
  if (redactions.length > 0) {
    console.log(`[RedactionEngine] Tool call ${toolCall.id} (${toolCall.name}): ${redactions.length} redactions`);
  }
  return { ...toolCall, arguments: redacted as Record<string, unknown> };
}

export function redactToolResult(result: { toolCallId: string; content: unknown; isError?: boolean }): typeof result {
  const { redacted, redactions } = redactValue(result.content, '$.content');
  if (redactions.length > 0) {
    console.log(`[RedactionEngine] Tool result ${result.toolCallId}: ${redactions.length} redactions`);
  }
  return { ...result, content: redacted };
}

export function sanitizeEnvironment(env: Record<string, string>): Record<string, string> {
  const sanitized: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const upperKey = key.toUpperCase();
    const isSecret = ENV_VAR_PATTERNS.some(p => p.test(upperKey)) || 
                     upperKey.includes('SECRET') || 
                     upperKey.includes('KEY') || 
                     upperKey.includes('TOKEN') || 
                     upperKey.includes('PASSWORD');
    sanitized[key] = isSecret ? '[REDACTED]' : value;
  }
  return sanitized;
}

// Optional: ONNX NER integration point (lazy-loaded)
export async function redactWithONNXNER(text: string): Promise<string> {
  // Placeholder for optional ONNX NER integration
  // Would load @xenova/transformers or onnxruntime-node on demand
  return text;
}