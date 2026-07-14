import { describe, expect, it } from "vitest";

import { Redactor } from "../src/redact.js";

const redactor = new Redactor();

function redacted(text: string): string {
  return redactor.redact(text).text;
}

describe("Redactor", () => {
  it("redacts AWS access key ids", () => {
    const out = redacted("export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE");
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out).toContain("[REDACTED:");
  });

  it("redacts GitHub tokens (classic and fine-grained)", () => {
    const classic = "ghp_" + "a1B2".repeat(9);
    const fine = "github_pat_" + "x".repeat(30);
    const out = redacted(`git clone https://x:${classic}@github.com/a/b && echo ${fine}`);
    expect(out).not.toContain(classic);
    expect(out).not.toContain(fine);
  });

  it("redacts Anthropic keys with the specific rule (not the generic sk- rule)", () => {
    const key = "sk-ant-api03-" + "Z".repeat(24);
    const result = redactor.redact(`ANTHROPIC_API_KEY=${key}`);
    expect(result.text).toContain("[REDACTED:anthropic-api-key]");
    expect(result.text).not.toContain(key);
  });

  it("redacts OpenAI-style keys", () => {
    const key = "sk-proj-" + "A1b2C3d4".repeat(4);
    const out = redacted(`curl -H "Authorization: Bearer ${key}"`);
    expect(out).not.toContain(key);
  });

  it("redacts Slack, Stripe, npm, Google, HF and GitLab tokens", () => {
    const samples = [
      "xoxb-123456789012-abcDEFghiJKL",
      "sk_live_" + "a1B2c3D4".repeat(3),
      "npm_" + "a".repeat(36),
      "AIza" + "0aB-cDeF".repeat(4) + "0aB",
      "hf_" + "b".repeat(32),
      "glpat-" + "c".repeat(20),
    ];
    for (const s of samples) {
      const out = redacted(`token is ${s} end`);
      expect(out, s).not.toContain(s);
      expect(out).toContain("[REDACTED:");
    }
  });

  it("redacts JWTs", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9." +
      "eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ." +
      "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c";
    const out = redacted(`header: ${jwt}`);
    expect(out).not.toContain(jwt);
    expect(out).toContain("[REDACTED:jwt]");
  });

  it("redacts PEM private key blocks including their body", () => {
    const pem =
      "-----BEGIN OPENSSH PRIVATE KEY-----\n" +
      "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ==\n" +
      "-----END OPENSSH PRIVATE KEY-----";
    const out = redacted(`cat id_ed25519\n${pem}\n`);
    expect(out).not.toContain("b3BlbnNzaC1rZXktdjE");
    expect(out).toContain("[REDACTED:private-key-block]");
  });

  it("masks only the password in URLs, keeping the rest", () => {
    const out = redacted("psql postgres://admin:hunter2secret@db.internal:5432/app");
    expect(out).toContain("postgres://admin:[REDACTED:url-credentials]@db.internal:5432/app");
    expect(out).not.toContain("hunter2secret");
  });

  it("masks Authorization header values but keeps the scheme", () => {
    const out = redacted("Authorization: Bearer abc123def456ghi789");
    expect(out).toContain("Authorization: Bearer [REDACTED:authorization-header]");
    expect(out).not.toContain("abc123def456ghi789");
  });

  it("masks values assigned to secret-looking variables", () => {
    const out = redacted("export DATABASE_PASSWORD=supersecret123 OTHER=fine");
    expect(out).toContain("DATABASE_PASSWORD=[REDACTED:generic-assignment]");
    expect(out).toContain("OTHER=fine");
  });

  it("handles yaml-style assignments", () => {
    const out = redacted("api_key: 9f8e7d6c5b4a3210\nregion: us-east-1");
    expect(out).toContain("api_key: [REDACTED:generic-assignment]");
    expect(out).toContain("region: us-east-1");
  });

  it("is idempotent (re-redacting changes nothing)", () => {
    const input =
      "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG PASSWORD=hunter2secret " +
      "Authorization: Bearer tok_abc123def456 https://u:pw12345678@h/";
    const once = redactor.redact(input).text;
    const twice = redactor.redact(once);
    expect(twice.text).toBe(once);
    expect(twice.total).toBe(0);
  });

  it("does not fire on harmless look-alikes", () => {
    const benign = [
      "risk-assessment of the sk-learn model",
      "ls -la /home/user",
      "git checkout -b feature/task-1234",
      "the words token and password alone",
      "AKIA is a prefix", // too short to be a key
    ];
    for (const text of benign) {
      const result = redactor.redact(text);
      expect(result.total, text).toBe(0);
      expect(result.text).toBe(text);
    }
  });

  it("counts redactions per rule", () => {
    const result = redactor.redact(
      "AKIAIOSFODNN7EXAMPLE and AKIAJ4EXAMPLEKEY99AB plus PASSWORD=abcdef123",
    );
    expect(result.total).toBe(3);
    expect(result.counts["aws-access-key-id"]).toBe(2);
    expect(result.counts["generic-assignment"]).toBe(1);
  });

  it("supports disabling rules", () => {
    const r = new Redactor({ disable: ["generic-assignment"] });
    const out = r.redact("PASSWORD=abcdef123");
    expect(out.total).toBe(0);
  });

  it("supports custom rules", () => {
    const r = new Redactor({
      custom: [
        {
          id: "acme-internal",
          description: "ACME internal tokens",
          pattern: /\bacme_[0-9a-f]{16}\b/g,
        },
      ],
    });
    const out = r.redact("using acme_0123456789abcdef here");
    expect(out.text).toContain("[REDACTED:acme-internal]");
    expect(out.counts["acme-internal"]).toBe(1);
  });

  it("can be disabled entirely", () => {
    const r = new Redactor({ enabled: false });
    const input = "AKIAIOSFODNN7EXAMPLE";
    expect(r.redact(input).text).toBe(input);
  });
});
