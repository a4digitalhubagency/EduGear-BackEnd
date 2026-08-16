import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import { AppConfig } from '../config/configuration';
import { EmailProvider } from '../config/env.validation';

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/**
 * Thin email boundary. `console` logs the message (development default) and
 * `resend` sends it. Delivery failures never break the request that triggered
 * them — a user must still be created even if the welcome mail bounces.
 */
@Injectable()
export class EmailService implements OnModuleInit {
  private readonly logger = new Logger(EmailService.name);
  private resend?: Resend;

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  onModuleInit(): void {
    const email = this.config.get('email', { infer: true });
    if (email.provider === EmailProvider.Resend && email.resendApiKey) {
      this.resend = new Resend(email.resendApiKey);
    }
  }

  async send(message: EmailMessage): Promise<void> {
    const email = this.config.get('email', { infer: true });

    if (email.provider === EmailProvider.Console || !this.resend) {
      this.logger.log(
        { to: message.to, subject: message.subject },
        `[email:console] ${message.subject} -> ${message.to}\n${message.text}`,
      );
      return;
    }

    try {
      const result = await this.resend.emails.send({
        from: email.from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
      });
      if (result.error) {
        this.logger.error(
          { to: message.to, err: result.error },
          'Email provider rejected message',
        );
      }
    } catch (error) {
      this.logger.error({ to: message.to, err: error }, 'Failed to send email');
    }
  }

  // ---------------------------------------------------------------------------
  // Templates
  // ---------------------------------------------------------------------------

  async sendEmailVerification(
    to: string,
    firstName: string,
    token: string,
  ): Promise<void> {
    const url = `${this.frontendUrl()}/verify-email?token=${encodeURIComponent(token)}`;
    await this.send({
      to,
      subject: 'Verify your EduGear email address',
      text: `Hi ${firstName},\n\nConfirm your email address to activate your EduGear account:\n${url}\n\nIf you did not create this account, ignore this message.`,
      html: this.layout(
        `Hi ${firstName},`,
        'Confirm your email address to activate your EduGear account.',
        'Verify email address',
        url,
      ),
    });
  }

  async sendPasswordReset(
    to: string,
    firstName: string,
    token: string,
  ): Promise<void> {
    const url = `${this.frontendUrl()}/reset-password?token=${encodeURIComponent(token)}`;
    await this.send({
      to,
      subject: 'Reset your EduGear password',
      text: `Hi ${firstName},\n\nUse this link to set a new password:\n${url}\n\nIf you did not request this, you can safely ignore this email.`,
      html: this.layout(
        `Hi ${firstName},`,
        'Use the button below to set a new password. If you did not request this, ignore this email.',
        'Reset password',
        url,
      ),
    });
  }

  async sendStaffInvitation(params: {
    to: string;
    firstName: string;
    schoolName: string;
    roleName: string;
    token: string;
  }): Promise<void> {
    const url = `${this.frontendUrl()}/accept-invitation?token=${encodeURIComponent(params.token)}`;
    await this.send({
      to: params.to,
      subject: `You have been invited to ${params.schoolName} on EduGear`,
      text: `Hi ${params.firstName},\n\nYou have been invited to join ${params.schoolName} on EduGear as ${params.roleName}.\nAccept the invitation here:\n${url}`,
      html: this.layout(
        `Hi ${params.firstName},`,
        `You have been invited to join <strong>${params.schoolName}</strong> on EduGear as <strong>${params.roleName}</strong>.`,
        'Accept invitation',
        url,
      ),
    });
  }

  private frontendUrl(): string {
    return this.config
      .get('app', { infer: true })
      .frontendUrl.replace(/\/$/, '');
  }

  private layout(
    greeting: string,
    body: string,
    ctaLabel: string,
    ctaUrl: string,
  ): string {
    return `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#111;line-height:1.6">
  <p>${greeting}</p>
  <p>${body}</p>
  <p><a href="${ctaUrl}" style="display:inline-block;padding:12px 20px;background:#0f766e;color:#fff;text-decoration:none;border-radius:6px">${ctaLabel}</a></p>
  <p style="font-size:12px;color:#666">If the button does not work, paste this link into your browser:<br>${ctaUrl}</p>
  <p style="font-size:12px;color:#666">EduGear — school management by A4 Technologies</p>
</body></html>`;
  }
}
