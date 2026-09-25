/**
 * Security Headers Middleware
 * Comprehensive security headers for production deployment.
 * Covers HSTS, CSP, X-Frame-Options, and more.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

export interface SecurityHeadersConfig {
  /** Enable HSTS (default: true in production) */
  hsts?: boolean;
  /** HSTS max-age in seconds (default: 31536000 = 1 year) */
  hstsMaxAge?: number;
  /** Include subdomains in HSTS */
  hstsIncludeSubDomains?: boolean;
  /** HSTS preload */
  hstsPreload?: boolean;
  /** Content Security Policy */
  csp?: string;
  /** X-Frame-Options */
  frameOptions?: "DENY" | "SAMEORIGIN";
  /** Enable X-Content-Type-Options */
  contentTypeOptions?: boolean;
  /** Referrer Policy */
  referrerPolicy?: string;
  /** Permissions Policy */
  permissionsPolicy?: string;
  /** X-XSS-Protection (legacy but still useful) */
  xssProtection?: boolean;
  /** Cross-Origin policies */
  crossOrigin?: {
    openerPolicy?: string;
    embedderPolicy?: string;
    resourcePolicy?: string;
  };
}

const DEFAULT_CONFIG: Required<SecurityHeadersConfig> = {
  hsts: process.env.NODE_ENV === "production",
  hstsMaxAge: 31536000, // 1 year
  hstsIncludeSubDomains: true,
  hstsPreload: false,
  csp: "default-src 'self'; connect-src 'self' wss: ws:; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  frameOptions: "DENY",
  contentTypeOptions: true,
  referrerPolicy: "strict-origin-when-cross-origin",
  permissionsPolicy: "camera=(), microphone=(), geolocation=(), payment=()",
  xssProtection: true,
  crossOrigin: {
    openerPolicy: "same-origin",
    embedderPolicy: "require-corp",
    resourcePolicy: "same-origin",
  },
};

export function createSecurityHeaders(config: Partial<SecurityHeadersConfig> = {}) {
  const merged = { ...DEFAULT_CONFIG, ...config };
  const crossOrigin = { ...DEFAULT_CONFIG.crossOrigin, ...config.crossOrigin };

  return async function securityHeadersHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    // HSTS - only on HTTPS
    if (merged.hsts) {
      let hstsValue = `max-age=${merged.hstsMaxAge}`;
      if (merged.hstsIncludeSubDomains) hstsValue += "; includeSubDomains";
      if (merged.hstsPreload) hstsValue += "; preload";
      reply.header("strict-transport-security", hstsValue);
    }

    // Content Security Policy
    if (merged.csp) {
      reply.header("content-security-policy", merged.csp);
    }

    // X-Frame-Options
    if (merged.frameOptions) {
      reply.header("x-frame-options", merged.frameOptions);
    }

    // X-Content-Type-Options
    if (merged.contentTypeOptions) {
      reply.header("x-content-type-options", "nosniff");
    }

    // Referrer Policy
    if (merged.referrerPolicy) {
      reply.header("referrer-policy", merged.referrerPolicy);
    }

    // Permissions Policy
    if (merged.permissionsPolicy) {
      reply.header("permissions-policy", merged.permissionsPolicy);
    }

    // X-XSS-Protection (legacy)
    if (merged.xssProtection) {
      reply.header("x-xss-protection", "1; mode=block");
    }

    // Cross-Origin policies
    if (crossOrigin.openerPolicy) {
      reply.header("cross-origin-opener-policy", crossOrigin.openerPolicy);
    }
    if (crossOrigin.embedderPolicy) {
      reply.header("cross-origin-embedder-policy", crossOrigin.embedderPolicy);
    }
    if (crossOrigin.resourcePolicy) {
      reply.header("cross-origin-resource-policy", crossOrigin.resourcePolicy);
    }

    // Remove server identifier
    reply.removeHeader("x-powered-by");
  };
}

/**
 * Register security headers on a Fastify instance
 */
export async function registerSecurityHeaders(app: FastifyInstance, config?: Partial<SecurityHeadersConfig>): Promise<void> {
  app.addHook("onSend", async (request, reply, payload) => {
    await createSecurityHeaders(config)(request, reply);
    return payload;
  });
}
