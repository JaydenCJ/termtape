/**
 * Secret redaction.
 *
 * Everything termtape stores flows through the redactor first — secrets are
 * scrubbed *before* they ever touch the database, so a leaked termtape.db
 * never contains a live credential that the redactor knows how to recognize.
 *
 * Rules are ordered: high-confidence, provider-specific token formats run
 * first; broader contextual rules (URLs with passwords, `FOO_SECRET=...`
 * assignments) run last so specific rule IDs win the attribution.
 */

export interface RedactionRule {
  /** Stable identifier, used in the replacement text and in config. */
  id: string;
  /** Human description shown by `termtape redact --list`. */
  description: string;
  /** Must be a global regex. */
  pattern: RegExp;
  /**
   * Optional custom replacer receiving the regex match groups. Default
   * replaces the whole match with `[REDACTED:<id>]`.
   */
  replace?: (...groups: string[]) => string;
}

export interface RedactionResult {
  text: string;
  /** Total number of substitutions performed. */
  total: number;
  /** Substitution count per rule id (only rules that fired). */
  counts: Record<string, number>;
}

const R = (id: string): string => `[REDACTED:${id}]`;

export const DEFAULT_RULES: RedactionRule[] = [
  {
    id: "private-key-block",
    description: "PEM private key blocks (RSA/EC/OpenSSH/PGP...)",
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY( BLOCK)?-----/g,
  },
  {
    id: "aws-access-key-id",
    description: "AWS access key IDs (AKIA/ASIA/...)",
    pattern: /\b(?:AKIA|ASIA|ABIA|ACCA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA)[A-Z0-9]{16}\b/g,
  },
  {
    id: "github-token",
    description: "GitHub tokens (ghp_/gho_/ghu_/ghs_/ghr_ and fine-grained PATs)",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g,
  },
  {
    id: "gitlab-token",
    description: "GitLab personal access tokens (glpat-...)",
    pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: "slack-token",
    description: "Slack tokens (xoxb-/xoxp-/xoxa-/xoxr-/xoxs-)",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  },
  {
    id: "anthropic-api-key",
    description: "Anthropic API keys (sk-ant-...)",
    pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: "openai-api-key",
    description: "OpenAI-style API keys (sk-...)",
    pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g,
  },
  {
    id: "stripe-key",
    description: "Stripe secret/restricted keys (sk_live_/rk_test_/...)",
    pattern: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  },
  {
    id: "npm-token",
    description: "npm access tokens (npm_...)",
    pattern: /\bnpm_[A-Za-z0-9]{36}\b/g,
  },
  {
    id: "google-api-key",
    description: "Google API keys (AIza...)",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
  },
  {
    id: "huggingface-token",
    description: "Hugging Face tokens (hf_...)",
    pattern: /\bhf_[A-Za-z0-9]{30,}\b/g,
  },
  {
    id: "sendgrid-key",
    description: "SendGrid API keys (SG.xxx.yyy)",
    pattern: /\bSG\.[A-Za-z0-9_-]{16,32}\.[A-Za-z0-9_-]{16,64}\b/g,
  },
  {
    id: "jwt",
    description: "JSON Web Tokens (eyJ...eyJ...sig)",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  {
    id: "url-credentials",
    description: "Passwords embedded in URLs (scheme://user:pass@host)",
    pattern: /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/\s:@]+:)(?!\[REDACTED)([^@\s/]{1,256})@/g,
    replace: (_m, p1) => `${p1}${R("url-credentials")}@`,
  },
  {
    id: "authorization-header",
    description: "Authorization header values (Bearer/Basic/token ...)",
    pattern:
      /\b((?:Authorization|Proxy-Authorization)\s*:\s*)(Bearer|Basic|token|OAuth)(\s+)(?!\[REDACTED)([A-Za-z0-9._~+/=-]{8,})/gi,
    replace: (_m, p1, p2, p3) => `${p1}${p2}${p3}${R("authorization-header")}`,
  },
  {
    id: "generic-assignment",
    description:
      "Values assigned to secret-looking names (PASSWORD=..., api_key: ..., --token=...)",
    pattern:
      /\b([A-Za-z0-9_-]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|auth[_-]?token|credentials?)[A-Za-z0-9_-]*)(\s*[=:]\s*["']?)(?!\[REDACTED)([^\s"']{6,})/gi,
    replace: (_m, p1, p2) => `${p1}${p2}${R("generic-assignment")}`,
  },
];

export interface RedactorOptions {
  /** Rule ids from DEFAULT_RULES to disable. */
  disable?: string[];
  /** Extra rules, applied after the defaults. */
  custom?: RedactionRule[];
  /** Disable redaction entirely (not recommended). */
  enabled?: boolean;
}

export class Redactor {
  private readonly rules: RedactionRule[];
  private readonly enabled: boolean;

  constructor(options: RedactorOptions = {}) {
    const disabled = new Set(options.disable ?? []);
    this.rules = [
      ...DEFAULT_RULES.filter((r) => !disabled.has(r.id)),
      ...(options.custom ?? []),
    ];
    this.enabled = options.enabled ?? true;
  }

  listRules(): RedactionRule[] {
    return [...this.rules];
  }

  redact(text: string): RedactionResult {
    if (!this.enabled || text.length === 0) {
      return { text, total: 0, counts: {} };
    }
    let out = text;
    let total = 0;
    const counts: Record<string, number> = {};
    for (const rule of this.rules) {
      let fired = 0;
      out = out.replace(rule.pattern, (...args) => {
        fired++;
        if (rule.replace) {
          // args = [match, ...groups, offset, string]; pass match + groups.
          const groups = args.slice(0, -2) as string[];
          return rule.replace(...groups);
        }
        return R(rule.id);
      });
      if (fired > 0) {
        counts[rule.id] = (counts[rule.id] ?? 0) + fired;
        total += fired;
      }
    }
    return { text: out, total, counts };
  }
}
