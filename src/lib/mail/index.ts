import '@/lib/server-guard';
import { createTransport, type Transporter } from 'nodemailer';
import { getEnv } from '@/lib/config/env';
import { logger } from '@/lib/logging';
import { ApronError } from '@/lib/errors';

/**
 * Email transport behind one interface (CLAUDE.md §18).
 *
 * Three implementations, chosen by `MAIL_TRANSPORT`:
 *
 *  - **smtp** — real delivery. Locally this points at Mailpit, so a developer sees the
 *    actual rendered message rather than a log line claiming one was sent;
 *  - **log** — writes what it would have sent and returns success. The default, so a bare
 *    checkout never silently tries to reach a mail server;
 *  - **memory** — keeps messages in an array for tests to assert against.
 *
 * Nothing above this interface knows which is active. Swapping in SES for production is a
 * fourth case here and no change anywhere else.
 */

export interface OutboundEmail {
  readonly to: string;
  readonly subject: string;
  /** Plain text. Every operational email we send is legible without HTML. */
  readonly text: string;
  readonly html?: string;
  readonly replyTo?: string;
}

export interface SendResult {
  readonly accepted: boolean;
  /** The transport's own id where it has one — useful when chasing a delivery. */
  readonly messageId: string | null;
}

export interface MailTransport {
  readonly name: 'smtp' | 'log' | 'memory';
  send(message: OutboundEmail): Promise<SendResult>;
}

// ---------------------------------------------------------------------------
// memory — tests
// ---------------------------------------------------------------------------

export interface CapturedEmail extends OutboundEmail {
  readonly sentAt: Date;
}

class MemoryTransport implements MailTransport {
  readonly name = 'memory' as const;
  readonly sent: CapturedEmail[] = [];

  async send(message: OutboundEmail): Promise<SendResult> {
    this.sent.push({ ...message, sentAt: new Date() });
    return { accepted: true, messageId: `memory-${String(this.sent.length)}` };
  }
}

// ---------------------------------------------------------------------------
// log — the default
// ---------------------------------------------------------------------------

class LogTransport implements MailTransport {
  readonly name = 'log' as const;

  async send(message: OutboundEmail): Promise<SendResult> {
    // The body is deliberately not logged: operational emails carry passenger names and
    // phone numbers, and log retention is not the place for them (CLAUDE.md §27).
    logger().info(
      { to: message.to, subject: message.subject, transport: 'log' },
      'email not sent — MAIL_TRANSPORT is log',
    );
    return { accepted: true, messageId: null };
  }
}

// ---------------------------------------------------------------------------
// smtp — real delivery
// ---------------------------------------------------------------------------

class SmtpTransport implements MailTransport {
  readonly name = 'smtp' as const;
  private transporter: Transporter | undefined;

  private get client(): Transporter {
    if (this.transporter === undefined) {
      const env = getEnv();
      if (env.SMTP_HOST === undefined) {
        throw new ApronError(
          'config_invalid',
          'MAIL_TRANSPORT is smtp but SMTP_HOST is not set',
        );
      }

      this.transporter = createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        ...(env.SMTP_USER === undefined
          ? {}
          : { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD ?? '' } }),
      });
    }
    return this.transporter;
  }

  async send(message: OutboundEmail): Promise<SendResult> {
    const env = getEnv();
    const info: unknown = await this.client.sendMail({
      from: env.MAIL_FROM,
      to: message.to,
      subject: message.subject,
      text: message.text,
      ...(message.html === undefined ? {} : { html: message.html }),
      ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
    });

    const messageId =
      typeof info === 'object' && info !== null && 'messageId' in info
        ? String((info as { messageId: unknown }).messageId)
        : null;

    return { accepted: true, messageId };
  }
}

// ---------------------------------------------------------------------------
// selection
// ---------------------------------------------------------------------------

let transport: MailTransport | undefined;

export function getMailTransport(): MailTransport {
  if (transport === undefined) {
    const configured = getEnv().MAIL_TRANSPORT;
    transport =
      configured === 'smtp'
        ? new SmtpTransport()
        : configured === 'memory'
          ? new MemoryTransport()
          : new LogTransport();
  }
  return transport;
}

/** Swaps in the memory transport for a test and hands back the captured array. */
export function useMemoryMailTransportForTests(): CapturedEmail[] {
  const memory = new MemoryTransport();
  transport = memory;
  return memory.sent;
}

/** Installs an arbitrary transport — a failing one, for proving failure behaviour. */
export function setMailTransportForTests(replacement: MailTransport): void {
  transport = replacement;
}

/** Returns to the configured transport. */
export function resetMailTransportForTests(): void {
  transport = undefined;
}
