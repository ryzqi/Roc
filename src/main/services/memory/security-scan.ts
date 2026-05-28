import type { MemorySecurityScanSettings, SecurityScanIssue } from '../../../shared/types';

export type SecurityScanCategory =
  | 'prompt_injection'
  | 'credential'
  | 'ssh_backdoor'
  | 'invisible_unicode';

type Rule = {
  category: SecurityScanCategory;
  pattern: RegExp;
  label: string;
};

const PROMPT_INJECTION_RULES: Rule[] = [
  {
    category: 'prompt_injection',
    label: 'ignore_previous',
    pattern: /ignore\s+(previous|prior|above|all)\s+instructions?/i
  },
  {
    category: 'prompt_injection',
    label: 'disregard_system',
    pattern: /disregard\s+(the\s+)?((above|previous|prior)\s+)?(system\s+)?(prompt|instructions?)/i
  },
  {
    category: 'prompt_injection',
    label: 'you_are_now',
    pattern: /you\s+are\s+now\s+[^\n]{0,60}(developer|admin|root|jailbroken|DAN|unrestricted)/i
  },
  {
    category: 'prompt_injection',
    label: 'forget_everything',
    pattern: /forget\s+(everything|all|your\s+training|your\s+rules)/i
  },
  {
    category: 'prompt_injection',
    label: 'system_tag_forgery',
    pattern: /<\|?system\|?>|<\/?system\b/i
  },
  {
    category: 'prompt_injection',
    label: 'jailbreak_mode',
    pattern: /\b(jailbreak|DAN\s+mode|developer\s+mode)\b/i
  },
  {
    category: 'prompt_injection',
    label: 'new_directive',
    pattern: /new\s+(instructions?|rules?|persona|directive)\s*[:=-]/i
  }
];

const CREDENTIAL_RULES: Rule[] = [
  { category: 'credential', label: 'aws_access_key', pattern: /AKIA[0-9A-Z]{16}/ },
  { category: 'credential', label: 'slack_token', pattern: /xox[baprs]-[0-9a-zA-Z-]{10,}/ },
  { category: 'credential', label: 'github_pat_v1', pattern: /gh[psoru]_[A-Za-z0-9]{36,}/ },
  { category: 'credential', label: 'github_pat_v2', pattern: /github_pat_[A-Za-z0-9_]{82,}/ },
  { category: 'credential', label: 'openai_anthropic_key', pattern: /sk-(ant-)?[A-Za-z0-9_-]{20,}/ },
  {
    category: 'credential',
    label: 'private_key_header',
    pattern: /-----BEGIN\s+(RSA\s+|DSA\s+|EC\s+|OPENSSH\s+)?PRIVATE\s+KEY-----/
  },
  { category: 'credential', label: 'bearer_token', pattern: /\b[Bb]earer\s+[A-Za-z0-9_.=-]{20,}/ },
  {
    category: 'credential',
    label: 'generic_key_assignment',
    pattern: /(api[_-]?key|secret|password|passwd|access[_-]?token)\s*[:=]\s*['"]?[A-Za-z0-9_-]{16,}['"]?/i
  }
];

const SSH_BACKDOOR_RULES: Rule[] = [
  {
    category: 'ssh_backdoor',
    label: 'authorized_keys_line',
    pattern: /\bssh-(rsa|ed25519|dss|ecdsa)\s+AAAA[0-9A-Za-z+/=]{200,}/
  },
  { category: 'ssh_backdoor', label: 'permit_root', pattern: /PermitRootLogin\s+yes/i },
  { category: 'ssh_backdoor', label: 'pubkey_auth_yes', pattern: /PubkeyAuthentication\s+yes/i },
  { category: 'ssh_backdoor', label: 'ssh_config_identity', pattern: /Host\s+[^\n]+[\s\S]{0,200}IdentityFile\s+/i }
];

const INVISIBLE_UNICODE_RE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]|[\u{E0000}-\u{E007F}]/u;
const INVISIBLE_UNICODE_RE_GLOBAL = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]|[\u{E0000}-\u{E007F}]/gu;

const RULES_BY_CATEGORY: Record<Exclude<SecurityScanCategory, 'invisible_unicode'>, Rule[]> = {
  prompt_injection: PROMPT_INJECTION_RULES,
  credential: CREDENTIAL_RULES,
  ssh_backdoor: SSH_BACKDOOR_RULES
};

export class SecurityScanService {
  constructor(private readonly settings: MemorySecurityScanSettings) {}

  scan(content: string): SecurityScanIssue[] {
    const issues: SecurityScanIssue[] = [];
    if (this.settings.promptInjection) {
      this.scanRules(content, PROMPT_INJECTION_RULES, issues);
    }
    if (this.settings.credential) {
      this.scanRules(content, CREDENTIAL_RULES, issues);
    }
    if (this.settings.sshBackdoor) {
      this.scanRules(content, SSH_BACKDOOR_RULES, issues);
    }
    if (this.settings.invisibleUnicode) {
      this.scanInvisibleUnicode(content, issues);
    }
    return issues;
  }

  formatIssues(issues: SecurityScanIssue[]): string {
    const lines = [`Write blocked: security scan found ${issues.length} issue(s).`];
    for (const issue of issues.slice(0, 6)) {
      lines.push(`  [${issue.category}] ${issue.pattern} near "${issue.matchExcerpt}"`);
    }
    if (issues.length > 6) {
      lines.push(`  ... and ${issues.length - 6} more`);
    }
    lines.push('Remove or scrub the offending content, then retry.');
    const out = lines.join('\n');
    return out.length <= 500 ? out : `${out.slice(0, 497)}...`;
  }

  private scanRules(content: string, rules: Rule[], issues: SecurityScanIssue[]): void {
    for (const rule of rules) {
      const match = rule.pattern.exec(content);
      if (match !== null) {
        issues.push({
          category: rule.category,
          pattern: rule.label,
          matchExcerpt: this.makeExcerpt(content, match.index, match[0].length, rule.category === 'credential')
        });
      }
    }
  }

  private scanInvisibleUnicode(content: string, issues: SecurityScanIssue[]): void {
    const match = INVISIBLE_UNICODE_RE.exec(content);
    if (match !== null) {
      issues.push({
        category: 'invisible_unicode',
        pattern: 'invisible_or_bidi_codepoint',
        matchExcerpt: this.makeExcerpt(content, match.index, match[0].length, false)
      });
    }
  }

  private makeExcerpt(content: string, index: number, length: number, redactMatch: boolean): string {
    const start = Math.max(0, index - 16);
    const end = Math.min(content.length, index + length + 16);
    const rawExcerpt = redactMatch
      ? `${content.slice(start, index)}[redacted credential]${content.slice(index + length, end)}`
      : content.slice(start, end);
    let excerpt = rawExcerpt.replace(/\s+/g, ' ');
    excerpt = excerpt.replace(INVISIBLE_UNICODE_RE_GLOBAL, '?');
    if (excerpt.length > 60) {
      excerpt = `${excerpt.slice(0, 57)}...`;
    }
    return excerpt;
  }
}

export const SECURITY_SCAN_RULES = RULES_BY_CATEGORY;
